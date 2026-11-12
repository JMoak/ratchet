import {
  type ActBar,
  type BatteryReadout,
  describeActBar,
  describeBattery,
  SATURATION_WARN,
} from "../ledger/bars.ts";
import { brier, ece, expectedAccuracy, scoredFromLedger } from "../ledger/calibration.ts";
import {
  currentConfiguration,
  describeGrade,
  describeStray,
  type EvidenceGrade,
  gradeWord,
  REPORT_DEFAULTS,
  type StrayQuestion,
  strayQuestions,
} from "../ledger/evidence.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import type { CalibrationProfile } from "../ledger/profile.ts";
import { COUNTED_SOURCES, type TrustClass, trustOf, trustRegistry } from "../ledger/sources.ts";
import { mean } from "../math.ts";
import { ledgerPath, numberFlag, parseArgs, trustFlag } from "./args.ts";
import {
  type CommandResult,
  countBy,
  dec,
  errorClass,
  findGate,
  type GateGroup,
  groupEvidence,
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
import { type OfferedProfile, offered, offeredLine, readProfiles } from "./profile.ts";

export const REPORT_USAGE = `Usage: ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30] [--min-estimated 30] [--trust <prefix>=<class> ...] [--profile <file> ...] [--json]

Per gate: the evidence grade, rows, rows of an older configuration, then for the current
configuration labelled, unselected, consequence, observed accuracy,
expected accuracy (mean stated confidence on the labelled rows), posture, ECE, Brier, the
act bar (conservative, and the point estimate's) and its coverage, models seen, failed-open
rows by error class, cost and mean latency; then one line per gate saying what its grade
rests on, one saying where to act, and for a battery how often its verdicts saturate.

  --gate <id>          Only this gate (and its battery members, if any).
  --target <p>         What acting above the bar must deliver, and the promise a planned
                       sample is read against for a measured grade. Default 0.98.
  --min-support <n>    Labelled rows the bar needs at or above it. Default 30.
  --min-estimated <n>  Labelled unselected rows an estimated grade needs. Default 30.
  --trust <p>=<c>      Read labels whose source starts <p> (channel:kind or channel:*) as
                       trust class <c>: blind, census, moment, consequence or unknown.
                       Repeatable; laid over the defaults.
  --profile <file>     A calibration profile ("ratchet profile build") a gate may borrow a
                       bar from until its own labels grade it estimated: the first that
                       matches the model of its newest answered row and its question kind.
                       Repeatable.
  --json               JSON instead of markdown tables.

The defaults are the ones Gate.report() and Engine.report() use (REPORT_DEFAULTS).

Labels are read by the trust class of their source. Only blind, census and unsourced
labels fit the bar; moment labels (given after seeing the model's answer) count toward
accuracy and calibration; consequence labels (inferred from what happened next) are
counted in their own column and read by nothing else.

The grade is the strongest the rows support. measured: the first acts of the gate's
current shadow phase, fixed before their labels were read, reached --target by an exact
95% lower bound with no wrong act; the only grade that can promote a gate. estimated: a
95% Wilson interval on at least --min-estimated labelled unselected rows of trusted
sources recorded under the gate's current policy, rubric and evidence version, read again
at every look, so not a promise. borrowed: a profile's bar for --target, lent until the
gate's own labels grade it estimated; shadow only, and "borrowed (stale)" when the gate's
rows name that profile as their bar's source and no longer match its model or kind. none:
too few rows, and why.

The act bar is the policy's actAbove: it is fitted on the probability that acting is
right (for a judge gate, p(yes) or 1 - p(yes) by the side its policy acted on) against
whether acting was right, and conservatively, at the lowest bar where the lower end of the
95% Wilson interval (a one-sided 97.5% bound) of acting right on the rows at or above it reaches --target. The point column is the
same fit on the point estimate, which a lucky run on a few rows clears: read it, do not act
on it. Both read the current configuration's unselected rows (shadow rows and blind audits)
when there are at least --min-support of them, else all its trusted labelled rows, marked
in the output as biased. Observed, expected, ECE and Brier are of the leading answer.
Code-only floor and allowlist rows stay in operational counts, not calibration or fitting.
Posture: underconfident when observed accuracy beats expected by more than 2 points,
overconfident when it falls short by more than 2, calibrated otherwise.
`;

/** Observed accuracy this far from mean confidence, in either direction, earns a posture. */
const POSTURE_MARGIN = 0.02;

export type Posture = "underconfident" | "overconfident" | "calibrated";

/** The levers a report reads every gate with; unset, each is `REPORT_DEFAULTS`. */
export interface ReportOptions {
  /** What acting above the bar must deliver, and the promise a measured grade is read against. */
  readonly target?: number;
  /** Labelled rows the bar needs at or above it. */
  readonly minSupport?: number;
  /** Labelled unselected rows of the current configuration an estimated grade needs. */
  readonly minEstimated?: number;
  /** Trust classes laid over `DEFAULT_TRUST`, as `--trust` gives them. */
  readonly labelTrust?: Readonly<Record<string, TrustClass>>;
  /** Profiles a gate may borrow from until it grades estimated, as `--profile` gives them. */
  readonly profiles?: readonly CalibrationProfile[];
}

export interface GateReport extends ActBar {
  readonly gate: string;
  /** Set on a battery member's rows: the gate whose battery it belongs to. */
  readonly memberOf?: string;
  readonly rows: number;
  /**
   * Of `rows`, those recorded under an older configuration (policy, rubric or evidence version;
   * `currentConfiguration`). The calibration counts and figures (labelled to Brier, and the
   * bar and the grade) read only the current one; the operations columns read every row.
   */
  readonly older: number;
  /** Distinct request ids, when rows carry them; fewer than rows when questions were batched. */
  readonly requests: number;
  /**
   * Labelled oracle answers, excluding failed-open and code-only placeholder rows and labels
   * from consequence sources.
   */
  readonly labelled: number;
  /** Labelled rows from trusted sources that the oracle's confidence did not select. */
  readonly unselected: number;
  /** Labelled answers inferred from what happened next; counted here and nowhere else. */
  readonly consequence: number;
  /**
   * Labelled answers whose source is present but malformed or unregistered: counted and named
   * so a typo in a source cannot make labels vanish silently, read by nothing else (e2e T4-09).
   */
  readonly unregistered: number;
  readonly unregisteredSources: readonly string[];
  readonly accuracy?: number;
  /** Mean stated confidence on the labelled rows, so its gap from `accuracy` is miscalibration alone. */
  readonly expectedAccuracy?: number;
  /** Label-free estimate: mean stated confidence over every answered row. */
  readonly expectedAllRows?: number;
  readonly posture?: Posture;
  readonly ece?: number;
  readonly brier?: number;
  /*
   * From `ActBar`: `fitted` is the act bar (conservative, on the act side: the policy's
   * `actAbove`), `pointFitted` the point estimate's bar, `fittedFrom` and `fitRows` the rows
   * both were fitted on (absent when no label from a trusted source exists).
   */
  /**
   * What kind of evidence stands behind the gate (`gradeOf`): measured against `--target`,
   * else estimated, borrowed or none. A battery member grades no better than estimated, since
   * its rows are features of the battery's decision.
   */
  readonly grade: EvidenceGrade;
  /** On a battery gate: how often its combined verdicts saturate. */
  readonly battery?: BatteryReadout;
  /**
   * On a gate whose newest request asked one question: other questions whose rows still read
   * as current (a renamed question's old rows) until the evidence version moves.
   */
  readonly strays?: readonly StrayQuestion[];
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
  readonly minEstimated: number;
  /** The `--trust` overrides the report was read with, when any were given. */
  readonly labelTrust?: Readonly<Record<string, TrustClass>>;
  /** The profiles `--profile` offered, when any were given. */
  readonly profiles?: readonly OfferedProfile[];
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
  const trust = trustRegistry(opts.labelTrust);
  // Calibration counts and figures read the current configuration, as the bar and the grade
  // do; operations read every row, and an unregistered source is flagged wherever it appears.
  const { current, older } = currentConfiguration(rows);
  const strays = group.memberOf === undefined ? strayQuestions(rows) : [];
  // Moment labels grade the oracle but fit nothing; consequence labels are only counted.
  const scored = scoredFromLedger(current, { sources: COUNTED_SOURCES, trust });
  const consequence = scoredFromLedger(current, { sources: ["consequence"], trust }).length;
  const unregistered = scoredFromLedger(rows, { sources: ["unregistered"], trust }).length;
  const unregisteredSources = [
    ...new Set(
      rows.flatMap((r) =>
        r.outcome?.source !== undefined && trustOf(r.outcome.source, trust) === "unregistered"
          ? [r.outcome.source]
          : [],
      ),
    ),
  ].sort();
  const unselected = scoredFromLedger(current, { unselectedOnly: true, trust });
  const { bar, grade, battery } = groupEvidence(group, trust, {
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.minSupport !== undefined ? { minSupport: opts.minSupport } : {}),
    ...(opts.minEstimated !== undefined ? { minEstimated: opts.minEstimated } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  });
  const accuracy = scored.length > 0 ? mean(scored.map((s) => (s.correct ? 1 : 0))) : undefined;
  const expected = scored.length > 0 ? mean(scored.map((s) => s.confidence)) : undefined;
  const expectedAll = expectedAccuracy(current.filter((r) => !isFixed(r)));
  const failed = rows.filter((r) => r.failedOpen);
  const called = rows.filter((r) => !isFixed(r));
  return {
    gate: group.key,
    ...(group.memberOf !== undefined ? { memberOf: group.memberOf } : {}),
    rows: rows.length,
    older: older.length,
    requests: new Set(rows.map(requestIdOf)).size,
    labelled: scored.length,
    unselected: unselected.length,
    consequence,
    unregistered,
    unregisteredSources,
    ...(accuracy !== undefined ? { accuracy } : {}),
    ...(expected !== undefined ? { expectedAccuracy: expected } : {}),
    ...(expectedAll !== undefined ? { expectedAllRows: expectedAll } : {}),
    ...(accuracy !== undefined && expected !== undefined
      ? { posture: postureOf(accuracy, expected) }
      : {}),
    ...(scored.length > 0 ? { ece: ece(scored), brier: brier(scored) } : {}),
    ...bar,
    grade,
    ...(battery !== undefined ? { battery } : {}),
    ...(strays.length > 0 ? { strays } : {}),
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
    target: opts.target ?? REPORT_DEFAULTS.target,
    minSupport: opts.minSupport ?? REPORT_DEFAULTS.minSupport,
    minEstimated: opts.minEstimated ?? REPORT_DEFAULTS.minEstimated,
    ...(opts.labelTrust !== undefined ? { labelTrust: opts.labelTrust } : {}),
    ...(opts.profiles !== undefined ? { profiles: offered(opts.profiles) } : {}),
    gates: groups.map((g) => summariseGate(g, opts)),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The markdown rendering: one calibration table, one operations table, and how to read them. */
export function renderReport(r: LedgerReport): string {
  const out: string[] = [];
  out.push(`# ratchet report: ${r.ledger}`, "");
  out.push(
    `${plural(r.rows, "row")} in ${plural(r.gates.length, "gate")}. Act bars keep a ${pct(r.target)} promise at the lower end of a 95% Wilson interval, with at least ${r.minSupport} labelled rows at or above them.`,
    r.target < 1
      ? `Grades: measured on a planned sample for a ${pct(r.target)} promise (exact 95% bound, no wrong act allowed); estimated on at least ${r.minEstimated} labelled unselected rows of the current configuration (95% Wilson interval).`
      : `Grades: no planned sample can bound a 100% promise, so none is measured; estimated on at least ${r.minEstimated} labelled unselected rows of the current configuration (95% Wilson interval).`,
  );
  const overrides = Object.entries(r.labelTrust ?? {});
  if (overrides.length > 0) {
    out.push(
      `Label sources read with --trust: ${overrides.map(([p, c]) => `${p}=${c}`).join(", ")}.`,
    );
  }
  if (r.profiles !== undefined) out.push(offeredLine(r.profiles));
  if (r.gates.length === 0) return `${out.join("\n")}\n`;
  const name = (g: GateReport) => (g.memberOf !== undefined ? `${g.gate} (member)` : g.gate);
  out.push("", "## Calibration and fitted bar", "");
  out.push(
    table(
      [
        "gate",
        "grade",
        "rows",
        "older",
        "labelled",
        "unselected",
        "consequence",
        "observed",
        "expected",
        "posture",
        "ECE",
        "Brier",
        "act bar",
        "point",
        "coverage",
        "fitted on",
      ],
      r.gates.map((g) => [
        name(g),
        // The word alone: each grade's numbers are of a different kind, so they go below.
        gradeWord(g.grade),
        String(g.rows),
        String(g.older),
        String(g.labelled),
        String(g.unselected),
        String(g.consequence),
        pct(g.accuracy),
        pct(g.expectedAccuracy),
        g.posture ?? "-",
        dec(g.ece),
        dec(g.brier),
        g.fitted ? dec(g.fitted.threshold) : g.fittedFrom ? "none" : "-",
        g.pointFitted ? dec(g.pointFitted.threshold) : g.fittedFrom ? "none" : "-",
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
  out.push("", "## Evidence", "");
  for (const g of r.gates) out.push(`- ${name(g)}: ${describeGrade(g.grade)}`);
  const levers = { target: r.target, minSupport: r.minSupport, minEstimated: r.minEstimated };
  out.push("", "## Act bars", "");
  for (const g of r.gates) out.push(`- ${name(g)}: ${describeActBar(g, levers)}`);
  const strayed = r.gates.filter((g) => (g.strays?.length ?? 0) > 0);
  if (strayed.length > 0) {
    out.push("", "## Questions not in the newest request", "");
    for (const g of strayed) {
      for (const q of g.strays ?? []) out.push(`- ${name(g)}: ${describeStray(q)}`);
    }
  }
  const batteries = r.gates.flatMap((g) => (g.battery !== undefined ? [{ g, b: g.battery }] : []));
  if (batteries.length > 0) {
    out.push("", "## Batteries", "");
    for (const { g, b } of batteries) out.push(`- ${name(g)}: ${describeBattery(b)}`);
  }
  const strays = r.gates.filter((g) => g.unregisteredSources.length > 0);
  if (strays.length > 0) {
    out.push("", "## Unregistered label sources", "");
    for (const g of strays) {
      const sources = g.unregisteredSources.map((x) => JSON.stringify(x)).join(", ");
      const answers = g.unregistered === 1 ? "answer" : "answers";
      out.push(
        `- ${name(g)}: ${g.unregistered} labelled ${answers} from ${sources}, which fit, grade ` +
          "and promote nothing. If a source is trusted, register it with " +
          "--trust <channel>:<kind>=<class>.",
      );
    }
  }
  out.push(
    "",
    "Grade is the kind of evidence behind a gate: measured (a planned sample reached the " +
      "promise by an exact bound, the only grade that can promote a gate), estimated (an " +
      "interval on labelled unselected rows of the current policy, rubric and evidence " +
      "version, looked at again with every label, so not a promise), borrowed (evidence that " +
      "is not this gate's labels, shadow only) or none. " +
      "Observed is accuracy of the leading answer on labelled rows; expected is their mean " +
      "stated confidence. The act bar is the actAbove to rule with: the lowest probability " +
      "that acting is right at which acting was right often enough, by the lower end of a 95% " +
      "Wilson interval (a one-sided 97.5% bound), on " +
      "the rows at or above it; point is where the point estimate alone would put it, which " +
      "is not a bar to act at; coverage is the share of the fitted rows at or above the act " +
      'bar; "none" means no bar held. ' +
      'Rows fitted on "all" were selected by the engine\'s own confidence, so treat that bar ' +
      "as a fallback. Only blind, census and unsourced labels fit a bar; consequence counts " +
      "labels inferred from what happened next, which no other column reads. " +
      "Fixed rows were decided by a floor or an allowlist without a call; " +
      "they remain in operational counts but never in calibration or fitted thresholds." +
      (batteries.some(({ b }) => b.share >= SATURATION_WARN)
        ? " A saturated verdict sits beyond 0.001 or 0.999, where no bar can tell one from another."
        : "") +
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
      {
        values: ["gate", "target", "min-support", "min-estimated"],
        booleans: ["json", "help"],
        lists: ["trust", "profile"],
      },
      "report",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: REPORT_USAGE };
    const path = ledgerPath(p, "report");
    const target =
      numberFlag(p, "target", { min: 0, max: 1, above: true }, "report") ?? REPORT_DEFAULTS.target;
    const minSupport =
      numberFlag(p, "min-support", { min: 1, integer: true }, "report") ??
      REPORT_DEFAULTS.minSupport;
    const minEstimated =
      numberFlag(p, "min-estimated", { min: 1, integer: true }, "report") ??
      REPORT_DEFAULTS.minEstimated;
    const gate = p.values.get("gate");
    const labelTrust = trustFlag(p, "report");
    const profiles = await readProfiles(p, "report");
    const rows = await loadLedger(path, "report");
    const r = buildReport(path, rows, {
      target,
      minSupport,
      minEstimated,
      ...(labelTrust !== undefined ? { labelTrust } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(gate ? { gate } : {}),
    });
    const output = p.booleans.has("json") ? `${JSON.stringify(r, null, 2)}\n` : renderReport(r);
    return { exitCode: 0, output };
  });
}
