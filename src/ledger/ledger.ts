import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
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
   * Set on a battery member's outcome: the id of the combined row whose label it was derived
   * from. The member's `truth` is the battery's truth and `correct` is re-scored against the
   * member's own lean, so a member that disagreed with the combined verdict is not marked right.
   */
  readonly inheritedFrom?: string;
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
  /** What the engine's policy said to do. */
  readonly soft: Action;
  /** What the application did: in shadow mode, the baseline; in enforce mode, `soft` floored. */
  readonly action: Action;
  readonly mode: Mode;
  /** The hard floor that bounded this ruling, when one other than act applied. */
  readonly floor?: Action;
  readonly cost: number;
  readonly latencyMs: number;
  readonly failedOpen: boolean;
  readonly error?: string;
  /** Questions that shared the request this answer came from, when the adapter reports it. */
  readonly batch?: number;
  readonly tags: readonly string[];
  readonly outcome?: Outcome;
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
 * the battery's truth cannot be recovered (no boolean truth, and the combined row failed open
 * so its lean means nothing). The truth is the battery's; `correct` is re-scored against the
 * member's own lean. This is what makes a learned combiner fittable from the ledger: each
 * member row becomes a (feature, label) pair for the battery's question.
 */
export function inheritOutcome(
  combined: DecisionRecord,
  member: DecisionRecord,
  outcome: Outcome,
): Outcome | undefined {
  if (combined.verdict.kind !== "judge" || member.verdict.kind !== "judge") return undefined;
  let truth: boolean;
  if (typeof outcome.truth === "boolean") truth = outcome.truth;
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
    inheritedFrom: combined.id,
  };
}

export class MemoryLedger implements Ledger {
  private readonly rows = new Map<string, DecisionRecord>();
  private readonly byRequest = new Map<string, string[]>();

  async append(record: DecisionRecord): Promise<void> {
    if (!this.rows.has(record.id)) {
      const ids = this.byRequest.get(record.requestId);
      if (ids) ids.push(record.id);
      else this.byRequest.set(record.requestId, [record.id]);
    }
    this.rows.set(record.id, record);
  }

  async label(id: string, outcome: Outcome): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    this.rows.set(id, { ...row, outcome });
    return true;
  }

  async all(): Promise<readonly DecisionRecord[]> {
    return [...this.rows.values()];
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    return this.rows.get(id);
  }

  async request(requestId: string): Promise<readonly DecisionRecord[]> {
    const ids = this.byRequest.get(requestId) ?? [];
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r ? [r] : [];
    });
  }
}

type Line =
  | { readonly type: "decision"; readonly record: DecisionRecord }
  | { readonly type: "outcome"; readonly id: string; readonly outcome: Outcome };

/** A row as older ledgers wrote it, before gates, request ids and state provenance. */
type StoredRecord = Omit<DecisionRecord, "gateId" | "requestId" | "trustedHash" | "untrusted"> &
  Partial<Pick<DecisionRecord, "gateId" | "requestId" | "trustedHash" | "untrusted">>;

/**
 * Read older rows as if each had been its own anonymous request with a plain string state,
 * so ledgers written before gates existed still load, report and replay.
 */
function upgrade(r: StoredRecord): DecisionRecord {
  return {
    ...r,
    gateId: r.gateId ?? `adhoc:${r.questionId}`,
    requestId: r.requestId ?? r.id,
    trustedHash: r.trustedHash ?? r.stateHash,
    untrusted: r.untrusted ?? [],
  };
}

/**
 * Append-only JSON Lines file. Decisions and outcomes are separate lines, so labelling
 * never rewrites history; `all()` replays the file and joins them. A battery label is one
 * outcome line per row it reaches, written by the engine.
 */
export class JsonlLedger implements Ledger {
  constructor(readonly path: string) {}

  private async write(line: Line): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(line)}\n`, "utf8");
  }

  async append(record: DecisionRecord): Promise<void> {
    await this.write({ type: "decision", record });
  }

  async label(id: string, outcome: Outcome): Promise<boolean> {
    const rows = await this.all();
    if (!rows.some((r) => r.id === id)) return false;
    await this.write({ type: "outcome", id, outcome });
    return true;
  }

  async all(): Promise<readonly DecisionRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const rows = new Map<string, DecisionRecord>();
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const line = JSON.parse(raw) as
        | { readonly type: "decision"; readonly record: StoredRecord }
        | { readonly type: "outcome"; readonly id: string; readonly outcome: Outcome };
      if (line.type === "decision") rows.set(line.record.id, upgrade(line.record));
      else {
        const row = rows.get(line.id);
        if (row) rows.set(line.id, { ...row, outcome: line.outcome });
      }
    }
    return [...rows.values()];
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    return (await this.all()).find((r) => r.id === id);
  }

  async request(requestId: string): Promise<readonly DecisionRecord[]> {
    return (await this.all()).filter((r) => r.requestId === requestId);
  }
}
