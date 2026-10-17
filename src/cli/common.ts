import { stat } from "node:fs/promises";
import { type DecisionRecord, JsonlLedger } from "../ledger/ledger.ts";
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
  try {
    rows = await new JsonlLedger(path).all();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CliError(`could not read ledger ${path}: ${message}`, command);
  }
  return rows.filter(isRow).map(normalise);
}

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

/** Oldest first; rows written in the same instant keep their file order. */
export const byTime = (rows: readonly DecisionRecord[]): DecisionRecord[] =>
  rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/** Rows whose action no oracle answer decided: a floor fixed it, or an allowlist bypassed the call. */
export const isFixed = (r: DecisionRecord): boolean =>
  r.strategy === "floored" || r.strategy === "bypass";

/** Rows where a model actually answered: not failed open, not fixed, not a battery's combined row. */
export const answered = (r: DecisionRecord): boolean =>
  !r.failedOpen && !isFixed(r) && !isCombined(r);

// ---------------------------------------------------------------------------
// Was acting right?
// ---------------------------------------------------------------------------

/**
 * Which side of a judge question meant "go" when this row was ruled, read from the row's own
 * `go` (the policy stores the probability it acted on). Undefined when the row cannot tell:
 * not a judge, failed open, or an exact 0.5.
 */
export function recordedGoIsYes(r: DecisionRecord): boolean | undefined {
  if (r.verdict.kind !== "judge" || r.failedOpen) return undefined;
  const p = r.verdict.pYes;
  if (Math.abs(p - 0.5) < 1e-9) return undefined;
  if (Math.abs(r.go - p) < 1e-9) return true;
  if (Math.abs(r.go - (1 - p)) < 1e-9) return false;
  return undefined;
}

/** The polarity most rows of a gate were ruled with; "yes is go" when no row says. */
export function inferGoIsYes(rows: readonly DecisionRecord[]): {
  readonly goIsYes: boolean;
  readonly evidence: number;
} {
  let yes = 0;
  let no = 0;
  for (const r of rows) {
    const g = recordedGoIsYes(r);
    if (g === true) yes++;
    else if (g === false) no++;
  }
  return { goIsYes: yes >= no, evidence: yes + no };
}

/**
 * On a labelled row, would acting have been right? For pick and rate questions acting means
 * taking the leading answer, so it is the recorded `correct`. For judge questions acting means
 * taking the go side, which is the truth when it is recorded and otherwise follows from
 * whether the go side was the leading answer.
 */
export function actWasRight(r: DecisionRecord, goIsYes: boolean): boolean | undefined {
  const o = r.outcome;
  if (!o) return undefined;
  if (r.verdict.kind !== "judge") return o.correct;
  if (typeof o.truth === "boolean") return o.truth === goIsYes;
  const goLeads = r.verdict.pYes >= 0.5 === goIsYes;
  return goLeads ? o.correct : !o.correct;
}

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
