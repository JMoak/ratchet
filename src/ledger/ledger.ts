import { createHash, randomUUID } from "node:crypto";
import { appendFile, type FileHandle, open, stat } from "node:fs/promises";
import { memberKey } from "../compound/compound.ts";
import type { Action, Question, QuestionKind, Verdict } from "../types.ts";

export type Mode = "shadow" | "enforce";

export interface Outcome {
  readonly at: string;
  /** Was the verdict's leading answer right? */
  readonly correct: boolean;
  /** The true answer when known: option name, level name, or boolean for judge. */
  readonly truth?: string | boolean;
  readonly note?: string;
  /**
   * Who or what produced the label, as `<channel>:<kind>[:<name>]`: "keywork:person" for an
   * answer given in the moment, "review:blind" for a careful review made before the reviewer
   * saw the model's answer. Labels that arrive by different routes are not the same evidence,
   * so each source has a trust class (`sources.ts`) and fitting and acceptance read only the
   * trusted ones. An absent source reads as it always has (`unknown`); a present source that is
   * malformed or unregistered is `unregistered` and fits, grades and promotes nothing.
   */
  readonly source?: string;
  /**
   * Set on a battery member's outcome: the id of the combined row whose label it was derived
   * from. The member's `truth` is its own from `memberTruths` when the battery's label gave one,
   * else the battery's truth, and `correct` is re-scored against the member's own lean, so a
   * member that disagreed with its truth is not marked right.
   */
  readonly inheritedFrom?: string;
  /**
   * On a battery's label: each member's own truth, by member question id. A member asks its own
   * question, which is the battery's only when the members are evidence for one answer. In a
   * disjunction ("does any of these risks apply?") a threat member is right to say no on a spam
   * post the battery must flag: scored against the battery's truth, a member right 99.1% of
   * the time on its own question read 59.0%, and the members' measured error correlation 0.488
   * against -0.013 on their own questions. A member the map does not name stays unlabelled
   * rather than taking the battery's truth: in a map, a missing member is unknown, and mixing
   * its own truth with the composite's on one question would read a member that is right on
   * its own question as wrong (harass, right on every spam post, read 0 of 20). Without the
   * map every member inherits the battery's truth. Read only by `inheritOutcome`; member rows
   * never carry it.
   */
  readonly memberTruths?: Readonly<Record<string, boolean>>;
}

/**
 * One member's answer inside a compound decision (an ensemble vote, a cascade tier, a
 * sequential sample), kept on the row that pooled it. A battery's members are rows of their
 * own instead, because each takes a label; these do not.
 */
export interface MemberRecord {
  /**
   * The member's identity across rows: its `Member` or `Tier` label, else `memberKey(oracle,
   * position)`. Pairing one member's answers across rows by key, not position, is what lets
   * member error correlation be measured when a cascade stops early or a member is added.
   */
  readonly key: string;
  readonly oracle: string;
  readonly model?: string;
  readonly verdict: Verdict;
  readonly cost: number;
  readonly latencyMs: number;
  readonly failedOpen?: true;
  readonly error?: string;
  /** On the member whose answer settled the run: a cascade's tier, a sequential run's last sample. */
  readonly settled?: true;
}

/**
 * One row of the decision ledger: what was asked, what the oracle said, what the policy
 * would do, what the application actually did, and later, what turned out to be true.
 * Everything the engine learns (calibration, thresholds, correlation, shadow agreement)
 * is computed from these rows. Nothing is learned from anywhere else.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly at: string;
  /** The decision point this row belongs to; "adhoc:<questionId>" for asks outside a gate. */
  readonly gateId: string;
  /**
   * Shared by every row produced by one engine request, which includes every row answered
   * from one oracle call. A battery's members and its combined row share one.
   */
  readonly requestId: string;
  /** True on a battery's combined row: the row that carries the ruling and takes the label. */
  readonly combined?: true;
  readonly questionId: string;
  readonly kind: QuestionKind;
  readonly prompt: string;
  /** Hash of the full question (prompt, options or levels in order, criteria): the rubric version. */
  readonly questionHash: string;
  /** Effective numeric policy and defaults; absent on legacy rows. Does not version code. */
  readonly policyHash?: string;
  /** Caller-owned version of model/configuration, strategy, floors and state semantics. */
  readonly evidenceVersion?: string;
  /** Hash of the whole rendered state the oracle saw. */
  readonly stateHash: string;
  /** Hash of the trusted fields alone; equal to `stateHash` for a plain string state. */
  readonly trustedHash: string;
  /** Names of the untrusted spans in the state; empty for a plain string state. */
  readonly untrusted: readonly string[];
  readonly state?: string;
  readonly oracle: string;
  readonly model?: string;
  readonly strategy: string;
  readonly verdict: Verdict;
  /** Probability that acting is right, as the policy read it. */
  readonly go: number;
  readonly confidence: number;
  readonly agreement: number;
  /**
   * For a compound strategy (ensemble, cascade, sequential): every member's answer in the
   * order it was bought, so the path to the verdict can be read back and member error
   * correlation measured. Single, floored, bypass and battery rows carry none.
   */
  readonly members?: readonly MemberRecord[];
  /** The strategy's own account of how it settled: the tier, the sample count, what was pooled. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** What the engine's policy said to do. */
  readonly soft: Action;
  /** What the application did: in shadow mode, the baseline; in enforce mode, `soft` floored. */
  readonly action: Action;
  readonly mode: Mode;
  /** The hard floor that bounded this ruling, when one other than act applied. */
  readonly floor?: Action;
  /**
   * USD this row charged against the budgets: the cost the oracle reported, unless
   * `costEstimate` is set, when it is the conservative estimate charged in its place.
   */
  readonly cost: number;
  /**
   * Set when the reported cost could not be counted as given: the call timed out and may still
   * be billed, or the oracle reported something that is not a finite non-negative number of USD.
   * Budgets never count such a row as free, and a negative or NaN cost never lowers or freezes
   * recorded spend; this says why `cost` is an estimate and what it was based on.
   */
  readonly costEstimate?: CostEstimate;
  readonly latencyMs: number;
  readonly failedOpen: boolean;
  readonly error?: string;
  /** Questions that shared the request this answer came from, when the adapter reports it. */
  readonly batch?: number;
  readonly tags: readonly string[];
  /** The latest label attached to the row. Every reader of a single label reads this one. */
  readonly outcome?: Outcome;
  /**
   * Every outcome attached to the row, oldest first in ledger order, present only once more than
   * one has been attached; `outcome` is the last of them. A row labelled once, or never, carries
   * none, exactly as before. The JSONL file always kept every outcome line and the row showed only
   * the last; this is that history on the row, so a second review can confirm a first instead of
   * silently replacing it. Reviewer error is the size of a 98% promise's whole error budget (a
   * blind relabel disagreed on 4 of 157 slots), so the acceptance test may read these as votes
   * (`labels.ts`, "confirm-wrong"); nothing that reads the latest label reads them.
   */
  readonly labels?: readonly Outcome[];
  /**
   * On a row the engine wrote in enforce mode whose ruling, before the audit draw, was act: the
   * probability that the draw sends it to a blind audit, the gate's audit rate at that moment,
   * whether or not this row was drawn. Absent on every other row. It is what lets a later reader
   * weight audited acts by the inverse of their inclusion probability (Horvitz-Thompson) if the
   * rate ever changes, or comes to depend on the verdict; a rate reconstructed afterwards from
   * configuration is fragile once it has changed.
   */
  readonly auditProbability?: number;
}

/**
 * Where a row's `cost` came from when the reported cost could not be used:
 * - `reserve`: the engine's `reserveUsd`, the most a request was declared to cost;
 * - `largest`: the costliest fully priced request on record;
 * - `none`: nothing to price it by (no reservation, no priced request yet). `cost` is then 0,
 *   and an engine with a budget stops buying until a price is known, rather than spend blind.
 */
export type CostBasis = "reserve" | "largest" | "none";

/** Why a row's cost is an estimate (`DecisionRecord.costEstimate`). */
export interface CostEstimate {
  /** What was wrong with the reported cost: a timeout, or the value reported. */
  readonly reason: string;
  readonly basis: CostBasis;
}

/**
 * What a read could not use, so a reader can say so instead of silently reading less. A line
 * is skipped when it is not JSON, not an object, not a well-formed decision or outcome line, or
 * an outcome for an id the ledger never read.
 */
export interface LedgerHealth {
  readonly skipped: number;
  /** Decision lines that reused an id already read: the first record wins; labels attach to it. */
  readonly duplicates: number;
  /**
   * True when the last line has no newline and does not parse: a crash mid-append, or an append
   * still in progress. It is ignored until it is completed.
   */
  readonly torn: boolean;
}

export interface Ledger {
  append(record: DecisionRecord): Promise<void>;
  /** Attach an outcome to a record. Returns false if the id is unknown. */
  label(id: string, outcome: Outcome): Promise<boolean>;
  /** Decision insertion order, stable across labels and reloads; rollout uses it as a boundary. */
  all(): Promise<readonly DecisionRecord[]>;
  /** One row by id. Optional: the engine falls back to scanning `all()`. */
  get?(id: string): Promise<DecisionRecord | undefined>;
  /** Every row of one request. Optional: the engine falls back to scanning `all()`. */
  request?(requestId: string): Promise<readonly DecisionRecord[]>;
  /** What the latest read skipped, when the ledger can say. Optional. */
  readonly health?: LedgerHealth;
  /**
   * Attach several outcomes at once; returns how many ids were known. Optional: the engine
   * labels a battery's members through it when present (one write for the lot), else one by one.
   */
  labelAll?(labels: readonly { readonly id: string; readonly outcome: Outcome }[]): Promise<number>;
}

export const hashState = (state: string): string =>
  createHash("sha256").update(state).digest("hex").slice(0, 16);

/** Same rubric identity that engine decision rows record. */
export const hashQuestion = (question: Question): string => hashState(JSON.stringify(question));

export const newRecordId = (): string => randomUUID();

export const newRequestId = (): string => randomUUID();

const requestKey = (r: DecisionRecord): string => `${r.gateId}\u0000${r.requestId}`;

/** Code-only decisions carry placeholder confidence, not evidence of oracle performance. */
export const settledWithoutAnswer = (r: DecisionRecord): boolean =>
  r.strategy === "floored" || r.strategy === "bypass";

/** True when `row` is a member of the battery whose combined row is `combined`. */
export const isMemberOf = (combined: DecisionRecord, row: DecisionRecord): boolean =>
  row.combined !== true &&
  row.id !== combined.id &&
  row.requestId === combined.requestId &&
  row.gateId === combined.gateId;

/**
 * The rows that are decisions: everything except battery members. A member is a feature of
 * its battery's decision, not a decision of its own, so rollout, shadow agreement and replay
 * should read the combined row instead. Calibration of a member (how well it predicts the
 * battery's truth) is the one use that wants the member rows, and reads them directly.
 */
export function decisionRows(rows: readonly DecisionRecord[]): DecisionRecord[] {
  const batteries = new Set(rows.filter((r) => r.combined === true).map(requestKey));
  if (batteries.size === 0) return rows.slice();
  return rows.filter((r) => r.combined === true || !batteries.has(requestKey(r)));
}

/**
 * The outcome a battery member inherits when its combined row is labelled, or undefined when
 * no truth for it can be recovered: the label carries `memberTruths` and it does not name this
 * member (a missing member is unknown, never the composite's), or there is no member map, no
 * boolean battery truth, and the combined row failed open so its lean means nothing. The truth
 * is the member's own when the map names it, else, with no map, the battery's; `correct` is
 * re-scored against the member's own lean. Without member truths, the members of an any/all battery are scored against the
 * composite, which is not the question they were asked. With the battery's truth, each member
 * row becomes a (feature, label) pair for the battery's question, which is what a learned
 * combiner is fitted on; with member truths, each member is calibrated on its own question.
 */
export function inheritOutcome(
  combined: DecisionRecord,
  member: DecisionRecord,
  outcome: Outcome,
): Outcome | undefined {
  if (combined.verdict.kind !== "judge" || member.verdict.kind !== "judge") return undefined;
  const own = outcome.memberTruths;
  const mapped = own !== null && typeof own === "object";
  const mine = mapped && Object.hasOwn(own, member.questionId) ? own[member.questionId] : undefined;
  let truth: boolean;
  if (typeof mine === "boolean") truth = mine;
  else if (mapped) return undefined;
  else if (typeof outcome.truth === "boolean") truth = outcome.truth;
  else if (combined.failedOpen) return undefined;
  else {
    const leanYes = combined.verdict.pYes >= 0.5;
    truth = outcome.correct ? leanYes : !leanYes;
  }
  return {
    at: outcome.at,
    correct: member.verdict.pYes >= 0.5 === truth,
    truth,
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    ...(outcome.source !== undefined ? { source: outcome.source } : {}),
    inheritedFrom: combined.id,
  };
}

/**
 * Every label attached to a row, oldest first: its `labels` when it carries a history, else its
 * one `outcome`, else none. Entries that are not objects (a hand-edited row) are left out, so a
 * reader of the history never dereferences one.
 */
export function labelHistory(r: DecisionRecord): readonly Outcome[] {
  const labels: unknown = r.labels;
  if (Array.isArray(labels) && labels.length > 1) {
    return labels.filter((o): o is Outcome => typeof o === "object" && o !== null);
  }
  return r.outcome === undefined ? [] : [r.outcome];
}

/**
 * The row with `outcome` attached as its latest label: `outcome` becomes the latest, and once the
 * row holds more than one label, `labels` holds them all in order. Both ledgers, and the pending
 * last line a JSONL read lays over its row, attach labels through this one function, so every
 * reader sees the same history.
 */
function withLabel(row: DecisionRecord, outcome: Outcome): DecisionRecord {
  const { labels: _earlier, ...rest } = row;
  const history = [...labelHistory(row), outcome];
  return { ...rest, outcome, ...(history.length > 1 ? { labels: history } : {}) };
}

/**
 * Decisions by id in first-read order, each with its latest outcome and, once it has more than
 * one, its label history: the core of both ledgers. A decision whose id was already read is a
 * duplicate: the first record wins, so a second line reusing a labelled row's id can neither
 * replace the row nor drop its label (e2e T4-17).
 */
class RowIndex {
  readonly rows = new Map<string, DecisionRecord>();
  readonly byRequest = new Map<string, string[]>();
  skipped = 0;
  duplicates = 0;

  decide(record: DecisionRecord): void {
    if (this.rows.has(record.id)) {
      this.duplicates++;
      return;
    }
    this.rows.set(record.id, record);
    const ids = this.byRequest.get(record.requestId);
    if (ids) ids.push(record.id);
    else this.byRequest.set(record.requestId, [record.id]);
  }

  label(id: string, outcome: Outcome): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    this.rows.set(id, withLabel(row, outcome));
    return true;
  }

  /**
   * One line of a JSONL ledger: blank lines are nothing, unreadable ones are counted. Returns
   * false for an unreadable line.
   */
  ingest(raw: string): boolean {
    if (raw.trim() === "") return true;
    const line = parseLine(raw);
    if (line === undefined) {
      this.skipped++;
      return false;
    }
    this.apply(line);
    return true;
  }

  apply(line: Line): void {
    if (line.type === "decision") this.decide(line.record);
    else if (!this.label(line.id, line.outcome)) this.skipped++;
  }

  request(requestId: string): DecisionRecord[] {
    return (this.byRequest.get(requestId) ?? []).flatMap((id) => {
      const r = this.rows.get(id);
      return r ? [r] : [];
    });
  }
}

export class MemoryLedger implements Ledger {
  private readonly index = new RowIndex();

  /** Appends that reused an id already held: the first record was kept (`LedgerHealth`). */
  get duplicates(): number {
    return this.index.duplicates;
  }

  get health(): LedgerHealth {
    return { skipped: 0, duplicates: this.index.duplicates, torn: false };
  }

  async append(record: DecisionRecord): Promise<void> {
    this.index.decide(record);
  }

  async label(id: string, outcome: Outcome): Promise<boolean> {
    return this.index.label(id, outcome);
  }

  async all(): Promise<readonly DecisionRecord[]> {
    return [...this.index.rows.values()];
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    return this.index.rows.get(id);
  }

  async request(requestId: string): Promise<readonly DecisionRecord[]> {
    return this.index.request(requestId);
  }
}

type Line =
  | { readonly type: "decision"; readonly record: DecisionRecord }
  | { readonly type: "outcome"; readonly id: string; readonly outcome: Outcome };

/** A member as rows written before member keys stored it. */
type StoredMember = Omit<MemberRecord, "key"> & { readonly key?: string };

/** A row as older ledgers wrote it, before gates, request ids, state provenance and member keys. */
type StoredRecord = Omit<
  DecisionRecord,
  "gateId" | "requestId" | "trustedHash" | "untrusted" | "members"
> &
  Partial<Pick<DecisionRecord, "gateId" | "requestId" | "trustedHash" | "untrusted">> & {
    readonly members?: readonly StoredMember[];
  };

/** Key each unkeyed member as it would be keyed today; anything else is kept as found. */
const keyed = (members: readonly StoredMember[]): MemberRecord[] =>
  members.map((m, i) =>
    typeof m === "object" && m !== null && typeof m.key !== "string"
      ? { ...m, key: memberKey(m.oracle, i) }
      : (m as MemberRecord),
  );

/** A finite, non-negative number of USD: the only cost a budget may count as reported. */
export const isValidCost = (cost: unknown): cost is number =>
  typeof cost === "number" && Number.isFinite(cost) && cost >= 0;

/**
 * Read older rows as if each had been its own anonymous request with a plain string state,
 * so ledgers written before gates existed still load, report and replay; and give the members
 * of rows written before member keys their keys, so they pair across rows like new ones. A
 * row whose cost is not a finite non-negative number (a NaN written as `null`, a string, a
 * negative) reads as cost 0 with a `costEstimate` that says so, so no reader sums a string or
 * subtracts spend, and a daily cap prices it conservatively (e2e T4-06).
 */
function upgrade(r: StoredRecord): DecisionRecord {
  const { members, ...rest } = r;
  const cost: unknown = r.cost;
  return {
    ...rest,
    gateId: r.gateId ?? `adhoc:${r.questionId}`,
    requestId: r.requestId ?? r.id,
    trustedHash: r.trustedHash ?? r.stateHash,
    untrusted: r.untrusted ?? [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    ...(members !== undefined
      ? { members: Array.isArray(members) ? keyed(members) : (members as readonly MemberRecord[]) }
      : {}),
    ...(isValidCost(cost)
      ? {}
      : {
          cost: 0,
          costEstimate: {
            reason: `recorded cost ${describeValue(cost)} is not a finite non-negative number`,
            basis: "none" as const,
          },
        }),
  };
}

const describeValue = (v: unknown): string =>
  v === undefined ? "undefined" : (JSON.stringify(v) ?? String(v)).slice(0, 40);

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const VERDICT_KINDS: ReadonlySet<unknown> = new Set(["judge", "pick", "rate"]);

/** A decision record every reader can dereference: an id, a question id and a typed verdict. */
function readRecord(v: unknown): DecisionRecord | undefined {
  if (!isObject(v)) return undefined;
  if (typeof v.id !== "string" || v.id === "" || typeof v.questionId !== "string") {
    return undefined;
  }
  if (!isObject(v.verdict) || !VERDICT_KINDS.has(v.verdict.kind)) return undefined;
  return upgrade(v as unknown as StoredRecord);
}

/**
 * One line as a decision or an outcome, or undefined when it is neither: not JSON, not an
 * object, a decision without a readable record, an outcome without an id or a boolean
 * `correct`, or a type this ledger does not write. A bare row (no `type` wrapper, as a
 * downloaded in-memory ledger is written) is a decision.
 */
function parseLine(raw: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (!Object.hasOwn(value, "type")) {
    const record = readRecord(value);
    return record && { type: "decision", record };
  }
  if (value.type === "decision") {
    const record = readRecord(value.record);
    return record && { type: "decision", record };
  }
  if (
    value.type === "outcome" &&
    typeof value.id === "string" &&
    value.id !== "" &&
    isObject(value.outcome) &&
    typeof value.outcome.correct === "boolean"
  ) {
    return { type: "outcome", id: value.id, outcome: value.outcome as unknown as Outcome };
  }
  return undefined;
}

const BOM = "\uFEFF";
const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

/** The rows of a JSONL ledger's text and what reading it could not use (`LedgerHealth`). */
export interface LedgerScan extends LedgerHealth {
  readonly rows: DecisionRecord[];
}

/**
 * Read the text of a JSONL ledger: rows in first-read order with their latest outcomes, and
 * what could not be read. A leading byte-order mark is dropped (editors add one). A last line
 * with no newline is read when it parses and counted as torn when it does not (a crash
 * mid-append). Any other line that is not a decision or an outcome is skipped and counted, so
 * one bad line no longer makes every later ask, label and report throw (e2e T4-02). A second
 * decision with an id already read is counted, and the first record keeps its labels.
 */
export function scanJsonlLedger(text: string): LedgerScan {
  return scan(text, false);
}

/**
 * The text of a JSONL ledger as rows with their outcomes joined, for text from outside a
 * ledger file (an upload, a paste). A byte-order mark is dropped and a duplicate id keeps its
 * first record, as `scanJsonlLedger` reads them, but a line that is neither a decision nor an
 * outcome, a torn last line included, throws naming the line: there is no one to tell what
 * was skipped. `JsonlLedger` reads its file with `scanJsonlLedger`'s tolerance instead.
 */
export function parseJsonlLedger(text: string): DecisionRecord[] {
  return scan(text, true).rows;
}

function scan(text: string, strict: boolean): LedgerScan {
  const index = new RowIndex();
  const body = stripBom(text);
  const end = body.lastIndexOf("\n") + 1;
  const lines = body.slice(0, end).split("\n");
  lines.pop(); // the empty string after the last newline
  const rest = body.slice(end);
  if (rest !== "") lines.push(rest);
  let torn = false;
  for (const [i, raw] of lines.entries()) {
    const last = i === lines.length - 1 && rest !== "";
    const before = index.skipped;
    if (index.ingest(raw)) continue;
    if (strict) throw new Error(`ledger line ${i + 1} is not a decision or an outcome`);
    if (last) {
      // A torn last line is reported as torn, not as a skipped line.
      index.skipped = before;
      torn = true;
    }
  }
  return {
    rows: [...index.rows.values()],
    skipped: index.skipped,
    duplicates: index.duplicates,
    torn,
  };
}

/** Read `length` bytes at `position`, or fewer if the file ends first. */
async function readRange(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(Math.max(0, length));
  let done = 0;
  while (done < out.length) {
    const { bytesRead } = await handle.read(out, done, out.length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return out.subarray(0, done);
}

const NEWLINE = 0x0a;

/** A file's size and modification time, enough to tell that it has not changed. */
interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

/** The file's stamp, or undefined when it does not exist (or cannot be read). */
async function statOf(path: string): Promise<FileStamp | undefined> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Append-only JSON Lines file. Decisions and outcomes are separate lines, so labelling never
 * rewrites history; reads replay the file and join them. A battery label is one outcome line
 * per row it reaches, written by the engine in one append (`labelAll`).
 *
 * The file is indexed by id on first read and read incrementally after that: each read parses
 * only the bytes appended since the last one (by this process or another), and a read finds
 * nothing new from the file's size and modification time alone. This process's own appends are
 * indexed as they are written when the file's new size proves no other writer came between, so
 * labelling n rows no longer reads the file n times (e2e T2-11: 125 s to label 432 battery
 * requests). If the file shrank or no longer ends a line where the last read stopped, it was
 * rewritten rather than appended to, and the index is rebuilt from the start. The index holds
 * every row in memory for the ledger's lifetime, as a full read did for the length of one call.
 *
 * Reading never throws on content: a byte-order mark is dropped, a torn last line is ignored
 * until it is completed, and lines that are not decisions or outcomes are skipped and counted
 * (`skipped`, `duplicates`, `torn`, `health`), so a reader can say what it left out.
 */
export class JsonlLedger implements Ledger {
  private index = new RowIndex();
  /** Bytes read through the last newline: where the next read starts. */
  private offset = 0;
  /** The file's size and modification time when it was last read or written whole. */
  private seen: { readonly size: number; readonly mtimeMs: number } | undefined;
  /** The file's stamp right after this ledger's own append left it ending a line. */
  private lineEnd: FileStamp | undefined;
  /** The last line while it has no newline but parses: shown by reads, not yet indexed. */
  private tail: Line | undefined;
  private tornTail = false;
  /** Reads and writes run one at a time, so the index always follows the file's order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  /** Lines the reads so far skipped (`LedgerHealth`). */
  get skipped(): number {
    return this.index.skipped;
  }

  /** Decision lines whose id an earlier line used; the first record was kept. */
  get duplicates(): number {
    return this.index.duplicates;
  }

  /** True when the latest read found a torn last line, which it ignored. */
  get torn(): boolean {
    return this.tornTail;
  }

  get health(): LedgerHealth {
    return { skipped: this.skipped, duplicates: this.duplicates, torn: this.torn };
  }

  async append(record: DecisionRecord): Promise<void> {
    await this.serial(() => this.writeNow([{ type: "decision", record }]));
  }

  async label(id: string, outcome: Outcome): Promise<boolean> {
    return (await this.labelAll([{ id, outcome }])) === 1;
  }

  async labelAll(
    labels: readonly { readonly id: string; readonly outcome: Outcome }[],
  ): Promise<number> {
    return this.serial(async () => {
      await this.readNew();
      const known = labels.filter((l) => this.find(l.id) !== undefined);
      if (known.length > 0) {
        await this.writeNow(known.map((l) => ({ type: "outcome", id: l.id, outcome: l.outcome })));
      }
      return known.length;
    });
  }

  async all(): Promise<readonly DecisionRecord[]> {
    await this.refresh();
    const rows = [...this.index.rows.values()];
    const t = this.tail;
    if (t?.type === "decision") {
      if (!this.index.rows.has(t.record.id)) rows.push(t.record);
    } else if (t?.type === "outcome") {
      const at = rows.findIndex((r) => r.id === t.id);
      const row = rows[at];
      if (row) rows[at] = withLabel(row, t.outcome);
    }
    return rows;
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    await this.refresh();
    return this.find(id);
  }

  async request(requestId: string): Promise<readonly DecisionRecord[]> {
    await this.refresh();
    const rows = this.index.request(requestId).map((r) => this.find(r.id) ?? r);
    const t = this.tail;
    if (
      t?.type === "decision" &&
      t.record.requestId === requestId &&
      !this.index.rows.has(t.record.id)
    ) {
      rows.push(t.record);
    }
    return rows;
  }

  /** A row with the pending last line laid over it. */
  private find(id: string): DecisionRecord | undefined {
    const row = this.index.rows.get(id);
    const t = this.tail;
    if (row) return t?.type === "outcome" && t.id === id ? withLabel(row, t.outcome) : row;
    return t?.type === "decision" && t.record.id === id ? t.record : undefined;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Read what was appended since the last read. */
  private refresh(): Promise<void> {
    return this.serial(() => this.readNew());
  }

  private reset(): void {
    this.index = new RowIndex();
    this.offset = 0;
    this.seen = undefined;
    this.tail = undefined;
    this.tornTail = false;
  }

  /**
   * Append lines. When the index had read the whole file and the file grew by exactly these
   * bytes, nobody else wrote in between, so the lines are indexed here (parsed back, as a read
   * would) without reading the file again; otherwise the next read picks them up.
   */
  private async writeNow(lines: readonly Line[]): Promise<void> {
    const parts = lines.map((l) => `${JSON.stringify(l)}\n`);
    const current = await statOf(this.path);
    // A file whose last line has no newline (a crash mid-append) would swallow this append into
    // its fragment, and the new rows would be lost to every reader. End that line first: the
    // fragment stays one skipped line and these lines stay whole (e2e V1, T4-02).
    const midLine = current !== undefined && current.size > 0 && !(await this.endsLine(current));
    const text = `${midLine ? "\n" : ""}${parts.join("")}`;
    const before = this.seen;
    const whole =
      !midLine &&
      this.tail === undefined &&
      !this.tornTail &&
      (current === undefined || current.size === 0
        ? this.offset === 0 && this.index.rows.size === 0
        : before !== undefined &&
          current.size === before.size &&
          current.mtimeMs === before.mtimeMs &&
          before.size === this.offset);
    await appendFile(this.path, text, "utf8");
    const after = await statOf(this.path);
    const bytes = new TextEncoder().encode(text).byteLength;
    // Only these bytes were added, so the file ends where this append ended: on a newline.
    if (after !== undefined && after.size === (current?.size ?? 0) + bytes) this.lineEnd = after;
    if (!whole || after?.size !== this.offset + bytes) return;
    for (const raw of parts) this.index.ingest(raw);
    this.offset = after.size;
    this.seen = { size: after.size, mtimeMs: after.mtimeMs };
  }

  /** True when the file, at the size and time `found` gives, ends with a newline. */
  private async endsLine(found: FileStamp): Promise<boolean> {
    const end = this.lineEnd;
    if (end !== undefined && end.size === found.size && end.mtimeMs === found.mtimeMs) return true;
    const seen = this.seen;
    // The last read stopped right after a newline at exactly this size and time.
    if (
      seen !== undefined &&
      seen.size === found.size &&
      seen.mtimeMs === found.mtimeMs &&
      seen.size === this.offset
    ) {
      return true;
    }
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch {
      return true;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return true;
      const [last] = await readRange(handle, size - 1, 1);
      return last === NEWLINE;
    } finally {
      await handle.close();
    }
  }

  private async readNew(): Promise<void> {
    let found: { readonly size: number; readonly mtimeMs: number };
    try {
      found = await stat(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.reset();
        return;
      }
      throw e;
    }
    // Nothing appended or rewritten since the last read: no need to open the file.
    if (this.seen?.size === found.size && this.seen.mtimeMs === found.mtimeMs) return;
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.reset();
        return;
      }
      throw e;
    }
    try {
      const { size, mtimeMs } = await handle.stat();
      if (size < this.offset) this.reset();
      else if (this.offset > 0) {
        const [last] = await readRange(handle, this.offset - 1, 1);
        if (last !== NEWLINE) this.reset();
      }
      const start = this.offset;
      const bytes = await readRange(handle, start, size - start);
      const end = bytes.lastIndexOf(NEWLINE) + 1;
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      let complete = decoder.decode(bytes.subarray(0, end));
      let rest = decoder.decode(bytes.subarray(end));
      if (start === 0) {
        if (end > 0) complete = stripBom(complete);
        else rest = stripBom(rest);
      }
      for (const raw of complete.split("\n")) this.index.ingest(raw);
      this.offset = start + end;
      this.seen = { size: start + bytes.length, mtimeMs };
      this.tail = undefined;
      this.tornTail = false;
      if (rest.trim() !== "") {
        const line = parseLine(rest);
        if (line === undefined) this.tornTail = true;
        else this.tail = line;
      }
    } finally {
      await handle.close();
    }
  }
}
