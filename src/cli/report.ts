import {
  brier,
  ece,
  expectedAccuracy,
  type FittedThreshold,
  fitThreshold,
  scoredFromLedger,
} from "../ledger/calibration.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import { mean } from "../math.ts";
import { ledgerPath, numberFlag, parseArgs } from "./args.ts";
import {
  type CommandResult,
  countBy,
  dec,
  errorClass,
  findGate,
  type GateGroup,
  groupGates,
  isFixed,
  loadLedger,
  modelOf,
  msec,
  pct,
  requestIdOf,
  runCommand,
  table,
  usd,
} from "./common.ts";

export const REPORT_USAGE = `Usage: ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30] [--json]

Per gate: rows, labelled, unselected, observed accuracy, expected accuracy (mean
stated confidence on the labelled rows), posture, ECE, Brier, the fitted bar and its
coverage, models seen, failed-open rows by error class, cost and mean latency.

  --gate <id>          Only this gate (and its battery members, if any).
  --target <p>         Accuracy the fitted bar must deliver. Default 0.98.
  --min-support <n>    Labelled rows the bar needs at or above it. Default 30.
  --json               JSON instead of markdown tables.

The bar is fitted on unselected rows (shadow rows and blind audits) when there are at
least --min-support of them, else on all labelled rows, which the output marks as biased.
Posture: underconfident when observed accuracy beats expected by more than 2 points,
overconfident when it falls short by more than 2, calibrated otherwise.
`;

/** Observed accuracy this far from mean confidence, in either direction, earns a posture. */
const POSTURE_MARGIN = 0.02;

export type Posture = "underconfident" | "overconfident" | "calibrated";

export interface ReportOptions {
  readonly target: number;
  readonly minSupport: number;
}

export interface GateReport {
  readonly gate: string;
  /** Set on a battery member's rows: the gate whose battery it belongs to. */
  readonly memberOf?: string;
  readonly rows: number;
  /** Distinct request ids, when rows carry them; fewer than rows when questions were batched. */
  readonly requests: number;
  /** Labelled rows that did not fail open: the rows every accuracy number is computed on. */
  readonly labelled: number;
  /** Labelled rows the oracle's confidence did not select: shadow rows and blind audits. */
  readonly unselected: number;
  readonly accuracy?: number;
  /** Mean stated confidence on the labelled rows, so its gap from `accuracy` is miscalibration alone. */
  readonly expectedAccuracy?: number;
  /** Label-free estimate: mean stated confidence over every answered row. */
  readonly expectedAllRows?: number;
  readonly posture?: Posture;
  readonly ece?: number;
  readonly brier?: number;
  /** Which rows the bar was fitted on; absent when nothing is labelled. */
  readonly fittedFrom?: "unselected" | "all";
  /** How many rows that was. */
  readonly fitRows?: number;
  readonly fitted?: FittedThreshold;
  readonly models: readonly { readonly model: string; readonly rows: number }[];
  readonly failedOpen: number;
  readonly errors: readonly { readonly class: string; readonly rows: number }[];
  /** Rows a floor or an allowlist decided without asking an oracle. */
  readonly fixed: number;
  readonly cost: number;
  /** Mean latency over the rows that called an oracle. */
  readonly meanLatencyMs: number;
}

export interface LedgerReport {
  readonly ledger: string;
  readonly rows: number;
  readonly target: number;
  readonly minSupport: number;
  readonly gates: readonly GateReport[];
}

export function postureOf(observed: number, expected: number): Posture {
  const gap = observed - expected;
  if (gap > POSTURE_MARGIN) return "underconfident";
  if (gap < -POSTURE_MARGIN) return "overconfident";
  return "calibrated";
}

/** Everything the report says about one gate. */
export function summariseGate(group: GateGroup, opts: ReportOptions): GateReport {
  const rows: readonly DecisionRecord[] = group.rows;
  const scored = scoredFromLedger(rows);
  const unselected = scoredFromLedger(rows, { unselectedOnly: true });
  const fitOnUnselected = unselected.length >= opts.minSupport;
  const fitSet = fitOnUnselected ? unselected : scored;
  const fitted = fitSet.length > 0 ? fitThreshold(fitSet, opts.target, opts.minSupport) : undefined;
  const accuracy = scored.length > 0 ? mean(scored.map((s) => (s.correct ? 1 : 0))) : undefined;
  const expected = scored.length > 0 ? mean(scored.map((s) => s.confidence)) : undefined;
  const expectedAll = expectedAccuracy(rows.filter((r) => !isFixed(r)));
  const failed = rows.filter((r) => r.failedOpen);
  const called = rows.filter((r) => !isFixed(r));
  return {
    gate: group.key,
    ...(group.memberOf !== undefined ? { memberOf: group.memberOf } : {}),
    rows: rows.length,
    requests: new Set(rows.map(requestIdOf)).size,
    labelled: scored.length,
    unselected: unselected.length,
    ...(accuracy !== undefined ? { accuracy } : {}),
    ...(expected !== undefined ? { expectedAccuracy: expected } : {}),
    ...(expectedAll !== undefined ? { expectedAllRows: expectedAll } : {}),
    ...(accuracy !== undefined && expected !== undefined
      ? { posture: postureOf(accuracy, expected) }
      : {}),
    ...(scored.length > 0 ? { ece: ece(scored), brier: brier(scored) } : {}),
    ...(scored.length > 0
      ? { fittedFrom: fitOnUnselected ? ("unselected" as const) : ("all" as const) }
      : {}),
    ...(scored.length > 0 ? { fitRows: fitSet.length } : {}),
    ...(fitted ? { fitted } : {}),
    models: countBy(
      rows.filter((r) => !r.failedOpen && !isFixed(r)),
      modelOf,
    ).map((m) => ({ model: m.key, rows: m.rows })),
    failedOpen: failed.length,
    errors: countBy(failed, (r) => errorClass(r.error)).map((e) => ({
      class: e.key,
      rows: e.rows,
    })),
    fixed: rows.filter(isFixed).length,
    cost: rows.reduce((s, r) => s + r.cost, 0),
    meanLatencyMs: mean(called.map((r) => r.latencyMs)),
  };
}

export function buildReport(
  ledger: string,
  rows: readonly DecisionRecord[],
  opts: ReportOptions & { readonly gate?: string },
): LedgerReport {
  let groups = groupGates(rows);
  if (opts.gate !== undefined) {
    const gate = findGate(groups, opts.gate, "report");
    groups = groups.filter((g) => g.key === gate.key || g.memberOf === gate.key);
  }
  return {
    ledger,
    rows: rows.length,
    target: opts.target,
    minSupport: opts.minSupport,
    gates: groups.map((g) => summariseGate(g, opts)),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The markdown rendering: one calibration table, one operations table, and how to read them. */
export function renderReport(r: LedgerReport): string {
  const out: string[] = [];
  out.push(`# ratchet report: ${r.ledger}`, "");
  out.push(
    `${plural(r.rows, "row")} in ${plural(r.gates.length, "gate")}. Bar target ${pct(r.target)} accuracy with at least ${r.minSupport} labelled rows at or above it.`,
  );
  if (r.gates.length === 0) return `${out.join("\n")}\n`;
  const name = (g: GateReport) => (g.memberOf !== undefined ? `${g.gate} (member)` : g.gate);
  out.push("", "## Calibration and fitted bar", "");
  out.push(
    table(
      [
        "gate",
        "rows",
        "labelled",
        "unselected",
        "observed",
        "expected",
        "posture",
        "ECE",
        "Brier",
        "bar",
        "coverage",
        "fitted on",
      ],
      r.gates.map((g) => [
        name(g),
        String(g.rows),
        String(g.labelled),
        String(g.unselected),
        pct(g.accuracy),
        pct(g.expectedAccuracy),
        g.posture ?? "-",
        dec(g.ece),
        dec(g.brier),
        g.fitted ? dec(g.fitted.threshold) : g.fittedFrom ? "none" : "-",
        g.fitted ? `${pct(g.fitted.coverage)} (${g.fitted.n})` : "-",
        g.fittedFrom === undefined
          ? "-"
          : g.fittedFrom === "unselected"
            ? `unselected (${g.fitRows})`
            : `all (${g.fitRows}), biased`,
      ]),
    ),
  );
  out.push("", "## Operations", "");
  out.push(
    table(
      ["gate", "models", "failed open", "errors", "fixed", "cost", "mean latency"],
      r.gates.map((g) => [
        name(g),
        g.models.map((m) => `${m.model} (${m.rows})`).join(", ") || "-",
        String(g.failedOpen),
        g.errors.map((e) => `${e.class} (${e.rows})`).join(", ") || "-",
        String(g.fixed),
        usd(g.cost),
        msec(g.meanLatencyMs),
      ]),
    ),
  );
  out.push(
    "",
    "Observed is accuracy on labelled rows; expected is their mean stated confidence. " +
      "Bar is the lowest confidence that delivered the target with enough support, and " +
      'coverage is the share of the fitted rows at or above it; "none" means no bar did. ' +
      'Rows fitted on "all" were selected by the engine\'s own confidence, so treat that bar ' +
      "as a fallback. Fixed rows were decided by a floor or an allowlist without a call." +
      (r.gates.some((g) => g.memberOf !== undefined)
        ? " A battery's spend is recorded on its member rows; its own row carries the ruling."
        : ""),
  );
  return `${out.join("\n")}\n`;
}

export function report(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("report", async () => {
    const p = parseArgs(
      argv,
      { values: ["gate", "target", "min-support"], booleans: ["json", "help"] },
      "report",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: REPORT_USAGE };
    const path = ledgerPath(p, "report");
    const target = numberFlag(p, "target", { min: 0, max: 1, above: true }, "report") ?? 0.98;
    const minSupport = numberFlag(p, "min-support", { min: 1, integer: true }, "report") ?? 30;
    const gate = p.values.get("gate");
    const rows = await loadLedger(path, "report");
    const r = buildReport(path, rows, { target, minSupport, ...(gate ? { gate } : {}) });
    const output = p.booleans.has("json") ? `${JSON.stringify(r, null, 2)}\n` : renderReport(r);
    return { exitCode: 0, output };
  });
}
