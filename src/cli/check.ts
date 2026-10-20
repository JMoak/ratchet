import {
  actWasRight,
  ece,
  inferGoIsYes,
  isUnselected,
  recordedGoIsYes,
  scoredFromLedger,
} from "../ledger/calibration.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import { ledgerPath, numberFlag, parseArgs, requiredNumber, requiredString } from "./args.ts";
import {
  answered,
  byTime,
  type CommandResult,
  countBy,
  dec,
  findGate,
  type GateGroup,
  groupGates,
  loadLedger,
  modelOf,
  pct,
  requestIdOf,
  runCommand,
} from "./common.ts";

export const CHECK_USAGE = `Usage: ratchet check <ledger> --gate <id> --promise <p> [--min-rows 30] [--max-ece <e>] [--model <id>] [--window 500]

The CI gate. Looks at the most recent --window rows of one gate and fails when:

  - accuracy on the rows the policy acted on, among unselected rows (shadow rows and
    blind audits), is below --promise, with at least --min-rows such rows;
  - ECE is above --max-ece, with at least --min-rows labelled rows (unselected rows
    when there are enough, else all labelled rows);
  - a model other than --model answered any row in the window.

  --gate <id>        The gate to check. Required.
  --promise <p>      Accuracy promised on acted rows, e.g. 0.98. Required.
  --min-rows <n>     Rows needed before accuracy or ECE is judged. Default 30.
  --max-ece <e>      ECE bound. Not checked when omitted.
  --model <id>       The pinned model version. Every row in the window that a model
                     answered must report exactly this one; rows that failed open or
                     were fixed by a floor or an allowlist are skipped, and a row that
                     answered without reporting a model, shown as (none), fails.
  --window <n>       Most recent rows of the gate to judge. Default 500.

Prints one line, PASS or FAIL with the reason, and exits 0 on pass, 1 on fail,
2 on a usage error or an unreadable ledger.
`;

export interface CheckOptions {
  readonly gate: string;
  readonly promise: number;
  readonly minRows: number;
  readonly maxEce?: number;
  readonly model?: string;
  readonly window: number;
}

export interface CheckResult {
  readonly gate: string;
  readonly pass: boolean;
  /** One line, PASS or FAIL first. */
  readonly line: string;
  /** Why it failed; empty on a pass. */
  readonly failures: readonly string[];
  readonly windowRows: number;
  readonly gateRows: number;
  readonly acted: {
    readonly n: number;
    readonly shadow: number;
    readonly audit: number;
    readonly accuracy?: number;
    readonly judged: boolean;
  };
  readonly ece?: {
    readonly value: number;
    readonly n: number;
    readonly from: "unselected" | "labelled";
    readonly judged: boolean;
  };
  readonly model?: {
    readonly pinned: string;
    readonly answered: number;
    readonly foreign: readonly { readonly model: string; readonly rows: number }[];
  };
}

/** Describe the acted slice by where its labels came from. */
function actedSlice(n: number, shadow: number, audit: number): string {
  if (audit === 0) return `${n} shadow acted rows`;
  if (shadow === 0) return `${n} audited acted rows`;
  return `${n} unselected acted rows (${shadow} shadow, ${audit} audit)`;
}

/** Judge one gate against its promise. Pure: the ledger rows in, the verdict out. */
export function checkGate(groups: readonly GateGroup[], opts: CheckOptions): CheckResult {
  const group = findGate(groups, opts.gate, "check");
  const ordered = byTime(group.rows);
  const recent = ordered.slice(-opts.window);
  const failures: string[] = [];
  const notes: string[] = [];

  // Accuracy on the rows the policy acted on, among rows its confidence did not select.
  const fallback = inferGoIsYes(group.rows).goIsYes;
  const acted = recent.filter(
    (r) => r.outcome && !r.failedOpen && isUnselected(r) && r.soft === "act",
  );
  const audit = acted.filter((r) => r.tags.includes("audit")).length;
  const shadow = acted.length - audit;
  const right = acted.filter((r) => actWasRight(r, recordedGoIsYes(r) ?? fallback)).length;
  const accuracy = acted.length > 0 ? right / acted.length : undefined;
  const judged = acted.length >= opts.minRows;
  const slice = actedSlice(acted.length, shadow, audit);
  if (judged && accuracy !== undefined && accuracy < opts.promise) {
    failures.push(
      `acted accuracy ${pct(accuracy)} on ${slice} is below the promise ${pct(opts.promise)}`,
    );
  } else if (judged) {
    notes.push(`acted accuracy ${pct(accuracy)} on ${slice} (promise ${pct(opts.promise)})`);
  } else {
    notes.push(`acted accuracy not judged: ${slice}, need ${opts.minRows}`);
  }

  // Calibration: unselected rows when there are enough of them, else every labelled row.
  const unselected = scoredFromLedger(recent, { unselectedOnly: true });
  const labelled = scoredFromLedger(recent);
  const useUnselected = unselected.length >= opts.minRows;
  const eceRows = useUnselected ? unselected : labelled;
  const eceFrom = useUnselected ? ("unselected" as const) : ("labelled" as const);
  const eceJudged = eceRows.length >= opts.minRows;
  const eceValue = eceRows.length > 0 ? ece(eceRows) : undefined;
  if (eceValue !== undefined && opts.maxEce !== undefined && eceJudged) {
    const where = `on ${eceRows.length} ${eceFrom} rows`;
    if (eceValue > opts.maxEce) {
      failures.push(`ECE ${dec(eceValue)} ${where} exceeds ${opts.maxEce}`);
    } else notes.push(`ECE ${dec(eceValue)} ${where} (max ${opts.maxEce})`);
  } else if (opts.maxEce !== undefined) {
    notes.push(`ECE not judged: ${labelled.length} labelled rows, need ${opts.minRows}`);
  } else if (eceValue !== undefined) {
    notes.push(`ECE ${dec(eceValue)} on ${eceRows.length} ${eceFrom} rows`);
  }

  // Model pin: every row that a model answered, including a battery's members.
  let model: CheckResult["model"];
  if (opts.model !== undefined) {
    const requests = new Set(recent.map(requestIdOf));
    const members = groups
      .filter((g) => g.memberOf === group.key)
      .flatMap((g) => g.rows.filter((r) => requests.has(requestIdOf(r))));
    const callers: DecisionRecord[] = [...recent, ...members].filter(answered);
    const foreign = countBy(
      callers.filter((r) => r.model !== opts.model),
      modelOf,
    ).map((m) => ({ model: m.key, rows: m.rows }));
    model = { pinned: opts.model, answered: callers.length, foreign };
    if (foreign.length > 0) {
      const n = foreign.reduce((s, f) => s + f.rows, 0);
      const who = foreign.map((f) => `${f.model} (${f.rows})`).join(", ");
      failures.push(
        `${n} of ${callers.length} answered rows came from models other than the pinned ${opts.model}: ${who}`,
      );
    } else if (callers.length === 0) {
      notes.push(`model ${opts.model} pinned; no row in the window was answered by a model`);
    } else notes.push(`model ${opts.model} on all ${callers.length} answered rows`);
  }

  const windowNote = `window ${recent.length} of ${ordered.length} rows`;
  const pass = failures.length === 0;
  const line = pass
    ? `PASS ${group.key}: ${[...notes, windowNote].join("; ")}`
    : `FAIL ${group.key}: ${[...failures, windowNote].join("; ")}`;
  return {
    gate: group.key,
    pass,
    line,
    failures,
    windowRows: recent.length,
    gateRows: ordered.length,
    acted: {
      n: acted.length,
      shadow,
      audit,
      ...(accuracy !== undefined ? { accuracy } : {}),
      judged,
    },
    ...(eceValue !== undefined
      ? { ece: { value: eceValue, n: eceRows.length, from: eceFrom, judged: eceJudged } }
      : {}),
    ...(model ? { model } : {}),
  };
}

export function check(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("check", async () => {
    const p = parseArgs(
      argv,
      {
        values: ["gate", "promise", "min-rows", "max-ece", "model", "window"],
        booleans: ["help"],
      },
      "check",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: CHECK_USAGE };
    const path = ledgerPath(p, "check");
    const gate = requiredString(p, "gate", "check");
    const promise = requiredNumber(p, "promise", { min: 0, max: 1, above: true }, "check");
    const minRows = numberFlag(p, "min-rows", { min: 1, integer: true }, "check") ?? 30;
    const maxEce = numberFlag(p, "max-ece", { min: 0, max: 1 }, "check");
    const window = numberFlag(p, "window", { min: 1, integer: true }, "check") ?? 500;
    const model = p.values.get("model");
    const rows = await loadLedger(path, "check");
    const r = checkGate(groupGates(rows), {
      gate,
      promise,
      minRows,
      window,
      ...(maxEce !== undefined ? { maxEce } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    return { exitCode: r.pass ? 0 : 1, output: `${r.line}\n` };
  });
}
