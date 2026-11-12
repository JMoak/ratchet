import { stat } from "node:fs/promises";
import { type ActBar, fitActBar, type GateEvidence, gateEvidence } from "../ledger/bars.ts";
import type { BorrowedVia, EvidenceGrade } from "../ledger/evidence.ts";
import {
  type DecisionRecord,
  JsonlLedger,
  type LedgerHealth,
  settledWithoutAnswer,
} from "../ledger/ledger.ts";
import type { CalibrationProfile } from "../ledger/profile.ts";
import type { TrustRegistry } from "../ledger/sources.ts";
import type { Action } from "../types.ts";
import { CliError } from "./args.ts";

/** What every command returns, so tests can run commands without spawning a process. */
export interface CommandResult {
  /** 0 ok, 1 a check failed, 2 usage error or unreadable input. */
  readonly exitCode: 0 | 1 | 2;
  readonly output: string;
}

/**
 * Run a command body and turn errors into exit code 2. A crash must never read as exit 1,
 * which CI takes to mean "the gate broke its promise".
 */
export async function runCommand(
  command: string,
  body: () => Promise<CommandResult>,
): Promise<CommandResult> {
  try {
    return await body();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const internal = e instanceof CliError ? "" : "internal error: ";
    return {
      exitCode: 2,
      output: `ratchet ${command}: ${internal}${message}\nRun "ratchet help ${command}" for usage.\n`,
    };
  }
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/**
 * Fields that differ between ledger versions (gate ids, request ids, battery flags) are read
 * through this, never through the static type, so the CLI keeps working on ledgers written
 * before and after they existed.
 */
const extra = (r: DecisionRecord, key: string): unknown =>
  (r as unknown as Record<string, unknown>)[key];

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export const gateIdOf = (r: DecisionRecord): string => nonEmpty(extra(r, "gateId")) ?? r.questionId;
export const requestIdOf = (r: DecisionRecord): string => nonEmpty(extra(r, "requestId")) ?? r.id;
export const isCombined = (r: DecisionRecord): boolean => extra(r, "combined") === true;

const ACTIONS: readonly Action[] = ["act", "review", "refuse"];
export const isAction = (v: unknown): v is Action => ACTIONS.includes(v as Action);

/** A line that names itself a decision row: an id, a question id and a verdict of a known kind. */
const isRow = (r: unknown): r is DecisionRecord => {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  const v = o.verdict as Record<string, unknown> | undefined;
  return (
    typeof o.id === "string" &&
    typeof o.questionId === "string" &&
    typeof v === "object" &&
    v !== null &&
    (v.kind === "judge" || v.kind === "pick" || v.kind === "rate")
  );
};

const probability = (x: unknown): boolean => typeof x === "number" && x >= 0 && x <= 1;

/**
 * True when a verdict's numbers are numbers: a probability where every command does arithmetic
 * on one. A row whose p(yes) was written as a string crashed `trail` on its first `toFixed`.
 */
function verdictReadable(v: Record<string, unknown>): boolean {
  if (!probability(v.confidence)) return false;
  if (v.kind === "judge") return probability(v.pYes);
  const ps = v.probabilities;
  if (typeof ps !== "object" || ps === null) return false;
  const values = Array.isArray(ps) ? ps : Object.values(ps);
  const named = v.kind === "pick" ? typeof v.choice === "string" : typeof v.level === "string";
  return named && values.every(probability);
}

/** A decision row whose verdict, members' verdicts and stated numbers can be read. */
function readable(r: DecisionRecord): boolean {
  const o = r as unknown as Record<string, unknown>;
  const finiteOrAbsent = (x: unknown) =>
    x === undefined || (typeof x === "number" && Number.isFinite(x));
  if (!verdictReadable(r.verdict as unknown as Record<string, unknown>)) return false;
  if (!finiteOrAbsent(o.go) || !finiteOrAbsent(o.confidence)) return false;
  const members = o.members;
  if (members === undefined) return true;
  if (!Array.isArray(members)) return false;
  return members.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const v = (m as Record<string, unknown>).verdict;
    if ((m as Record<string, unknown>).failedOpen === true && v === undefined) return true;
    return typeof v === "object" && v !== null && verdictReadable(v as Record<string, unknown>);
  });
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Fill the fields older or hand-written rows may lack, so arithmetic never meets undefined. */
function normalise(r: DecisionRecord): DecisionRecord {
  return {
    ...r,
    at: typeof r.at === "string" ? r.at : "",
    tags: Array.isArray(r.tags) ? r.tags : [],
    cost: finite(r.cost, 0),
    latencyMs: finite(r.latencyMs, 0),
    confidence: finite(r.confidence, finite(r.verdict.confidence, 0)),
    go: finite(r.go, finite(r.confidence, 0)),
    failedOpen: r.failedOpen === true,
    soft: isAction(r.soft) ? r.soft : "review",
    action: isAction(r.action) ? r.action : "review",
  };
}

/** Load a JSONL ledger written by `JsonlLedger`, joining outcomes onto their decisions. */
export async function loadLedger(path: string, command: string): Promise<DecisionRecord[]> {
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new CliError(`ledger is not a file: ${path}`, command);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`ledger not found: ${path}`, command);
  }
  let rows: readonly unknown[];
  const ledger = new JsonlLedger(path);
  try {
    rows = await ledger.all();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CliError(`could not read ledger ${path}: ${message}`, command);
  }
  // The ledger reads past damage rather than failing every command (e2e T4-02); say what it
  // left out, on stderr, so a damaged file is never read in silence and stdout stays the report.
  const read = readLedgerRows(rows);
  const note = describeHealth(ledger.health, read.malformed);
  if (note !== undefined) process.stderr.write(`ratchet ${command}: ${path}: ${note}\n`);
  return read.rows;
}

/**
 * One sentence on what a ledger read left out, or undefined when it read everything: lines the
 * ledger could not parse, duplicate ids, a torn final line, and `malformed` decision rows whose
 * verdict numbers were not numbers (`readLedgerRows`).
 */
export function describeHealth(h: LedgerHealth, malformed = 0): string | undefined {
  const parts: string[] = [];
  if (malformed > 0) {
    parts.push(
      `skipped ${malformed} decision ${malformed === 1 ? "row" : "rows"} whose verdict numbers are not numbers`,
    );
  }
  if (h.skipped > 0)
    parts.push(`skipped ${h.skipped} unreadable ${h.skipped === 1 ? "line" : "lines"}`);
  if (h.duplicates > 0) {
    parts.push(
      `kept the first record of ${h.duplicates} duplicate ${h.duplicates === 1 ? "id" : "ids"}`,
    );
  }
  if (h.torn) parts.push("ignored a torn final line (an append cut short or still in progress)");
  return parts.length > 0 ? `${parts.join("; ")}.` : undefined;
}

/**
 * The parsed lines that are decision rows with readable verdicts, older rows' missing fields
 * filled, and how many decision rows were skipped because a verdict number (p(yes), a
 * confidence, a probability, a member's) or a stated go or confidence was not a number.
 */
export function readLedgerRows(rows: readonly unknown[]): {
  readonly rows: DecisionRecord[];
  readonly malformed: number;
} {
  const decisions = rows.filter(isRow);
  const good = decisions.filter(readable);
  return { rows: good.map(normalise), malformed: decisions.length - good.length };
}

/** Keep the parsed lines that are readable decision rows and fill what older rows lack. */
export const readRows = (rows: readonly unknown[]): DecisionRecord[] => readLedgerRows(rows).rows;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface GateGroup {
  /** What `--gate` takes: the gate id, or "<gate>/<question>" for one member of a battery. */
  readonly key: string;
  readonly gateId: string;
  /** Set when these rows are one member of a battery: features, not decisions. */
  readonly memberOf?: string;
  readonly rows: readonly DecisionRecord[];
}

/**
 * Group rows into decision points: by `gateId` when rows carry it, else by question id. A
 * battery's member rows (rows sharing a request with a combined row) form their own groups,
 * keyed "<gate>/<question>", so the gate's numbers come from the rows that carry its ruling
 * and each member can still be calibrated on its own. Gates come in first-seen order, each
 * followed by its members.
 */
export function groupGates(rows: readonly DecisionRecord[]): GateGroup[] {
  const requestKey = (r: DecisionRecord) => `${gateIdOf(r)}\u0000${requestIdOf(r)}`;
  const batteries = new Set(rows.filter(isCombined).map(requestKey));
  const groups = new Map<string, { gateId: string; memberOf?: string; rows: DecisionRecord[] }>();
  for (const r of rows) {
    const gateId = gateIdOf(r);
    const member = !isCombined(r) && batteries.has(requestKey(r));
    const key = member ? `${gateId}/${r.questionId}` : gateId;
    let g = groups.get(key);
    if (!g) {
      g = member ? { gateId, memberOf: gateId, rows: [] } : { gateId, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const all: GateGroup[] = [...groups].map(([key, g]) => ({ key, ...g }));
  const gates = all.filter((g) => g.memberOf === undefined);
  const keys = new Set(gates.map((g) => g.key));
  return [
    ...gates.flatMap((g) => [g, ...all.filter((m) => m.memberOf === g.key)]),
    ...all.filter((m) => m.memberOf !== undefined && !keys.has(m.memberOf)),
  ];
}

/** The group `--gate` names, or a usage error that lists the gates there are. */
export function findGate(groups: readonly GateGroup[], key: string, command: string): GateGroup {
  const g = groups.find((x) => x.key === key);
  if (g) return g;
  const keys = groups.map((x) => x.key);
  const known =
    keys.length === 0
      ? "the ledger has no rows"
      : `gates: ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", ..." : ""}`;
  throw new CliError(`no gate "${key}" in the ledger; ${known}`, command);
}

/**
 * The levers a gate's bar and grade are read with on the command line. Unset levers take
 * `REPORT_DEFAULTS`, the defaults `Gate.report()` and `Engine.report()` use.
 */
export interface GroupGradeOptions {
  /** The promise: what acting above the bar must deliver, and what a planned sample is read against. */
  readonly target?: number;
  /** Labelled unselected rows of the current configuration an estimated grade needs. */
  readonly minEstimated?: number;
  /** Labelled rows the act bar needs at or above it. */
  readonly minSupport?: number;
  /** Only rows this model answered enter the planned sample, as a pinned rollout reads them. */
  readonly model?: string;
  /** Evidence that is not this gate's labels, graded when nothing stronger exists. */
  readonly borrowed?: BorrowedVia;
  /**
   * Profiles to borrow a bar from until the gate's own labels grade it estimated (`borrowFor`),
   * matched against `model` when it is given, else the model its newest answered row recorded.
   */
  readonly profiles?: readonly CalibrationProfile[];
}

/**
 * A gate's act bar and grade as every command reads them (`gateEvidence`, the reader the
 * engine's reports use too), from the gate's whole history in ledger order: the bar and an
 * estimate read only the current configuration's rows; measured when the first acts of its
 * current shadow phase reached `target` (exact 95% bound, no wrong act), else estimated,
 * borrowed or none. A battery member's rows are features of its battery's decision, and no
 * finite sample bounds a promise of 1, so neither is ever measured; nor does a member borrow,
 * since a profile describes a gate's decisions.
 */
export function groupEvidence(
  group: GateGroup,
  trust: TrustRegistry,
  opts: GroupGradeOptions = {},
): GateEvidence {
  return gateEvidence(group.rows, {
    levers: {
      ...(opts.target !== undefined ? { target: opts.target } : {}),
      ...(opts.minSupport !== undefined ? { minSupport: opts.minSupport } : {}),
      ...(opts.minEstimated !== undefined ? { minEstimated: opts.minEstimated } : {}),
    },
    trust,
    measurable: group.memberOf === undefined,
    ...(opts.model !== undefined ? { model: opts.model, pin: opts.model } : {}),
    ...(opts.borrowed !== undefined ? { borrowed: opts.borrowed } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  });
}

/** A gate's grade alone, as `groupEvidence` reads it. */
export const gradeGroup = (
  group: GateGroup,
  trust: TrustRegistry,
  opts: GroupGradeOptions = {},
): EvidenceGrade => groupEvidence(group, trust, opts).grade;

/** A gate's own act bar, and which of its labelled rows it was fitted on. */
export type GroupFit = ActBar;

/**
 * The act bar a gate's own labels support, as `report` fits it (`fitActBar`): on the act side,
 * conservatively, on the current configuration's unselected rows (shadow rows and blind audits)
 * when there are at least `minSupport` of them, else on every trusted labelled row, which the
 * oracle's confidence selected, so it is marked "all" and biased.
 */
export function fitGroup(
  rows: readonly DecisionRecord[],
  trust: TrustRegistry,
  target: number,
  minSupport: number,
): GroupFit {
  return fitActBar(rows, { trust, target, minSupport });
}

/** Oldest first; rows written in the same instant keep their file order. */
export const byTime = (rows: readonly DecisionRecord[]): DecisionRecord[] =>
  rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/** Rows whose action no oracle answer decided: a floor fixed it, or an allowlist bypassed the call. */
export const isFixed = settledWithoutAnswer;

/** Rows where a model actually answered: not failed open, not fixed, not a battery's combined row. */
export const answered = (r: DecisionRecord): boolean =>
  !r.failedOpen && !isFixed(r) && !isCombined(r);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * A short, stable class for a failed-open error message, so a report can count them:
 * "HTTP 402", "timeout", "malformed", or the message with numbers masked.
 */
export function errorClass(error: string | undefined): string {
  if (error === undefined || error.trim() === "") return "unrecorded";
  const http = /\bHTTP\s+(\d{3})\b/i.exec(error);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out|timeout/i.test(error)) return "timeout";
  if (/abort/i.test(error)) return "aborted";
  if (/answered \d+ of \d+/.test(error)) return "short batch";
  if (/malformed|expected \w+, got|no answer|empty completion|json/i.test(error)) {
    return "malformed";
  }
  return error
    .replace(/^[^:\s]{1,80}:\s*/, "")
    .replace(/\d+/g, "N")
    .slice(0, 60);
}

/** Count by key, most frequent first, ties in first-seen order. */
export function countBy<T>(
  items: readonly T[],
  key: (t: T) => string,
): { readonly key: string; readonly rows: number }[] {
  const counts = new Map<string, number>();
  for (const t of items) {
    const k = key(t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, rows]) => ({ key: k, rows })).sort((a, b) => b.rows - a.rows);
}

/** The model a row reports, or a marker saying why there is none. */
export const modelOf = (r: DecisionRecord): string => r.model ?? "(none)";

// ---------------------------------------------------------------------------
// Formatting: plain text and markdown, no colour.
// ---------------------------------------------------------------------------

export const pct = (x: number | undefined, digits = 1): string =>
  x === undefined ? "-" : `${(100 * x).toFixed(digits)}%`;

export const dec = (x: number | undefined, digits = 3): string =>
  x === undefined ? "-" : x.toFixed(digits);

export const usd = (x: number): string =>
  x === 0 ? "$0" : x < 1 ? `$${x.toPrecision(3)}` : `$${x.toFixed(2)}`;

export const msec = (x: number): string => `${Math.round(x)} ms`;

/** A markdown table with padded columns, readable raw in a terminal and rendered in a doc. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const all = [headers.map(esc), ...rows.map((r) => r.map(esc))];
  const widths = headers.map((_, i) => Math.max(3, ...all.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    `| ${widths.map((w, i) => (cells[i] ?? "").padEnd(w)).join(" | ")} |`;
  const [head, ...body] = all;
  return [
    line(head ?? []),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}
