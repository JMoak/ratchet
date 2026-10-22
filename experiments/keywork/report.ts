import { type AcceptanceResult, evaluateAcceptance, resolvePlan } from "../../src/acceptance.ts";
import type { Gate } from "../../src/gate.ts";
import {
  brier,
  coverageAt,
  ece,
  fitThreshold,
  type Scored,
  scoredForYes,
  wilsonLower,
} from "../../src/ledger/calibration.ts";
import { type DecisionRecord, settledWithoutAnswer } from "../../src/ledger/ledger.ts";
import { hashPolicy } from "../../src/policy.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import { KEYWORK_EVIDENCE, KEYWORK_FIT_ROWS, KEYWORK_GATE, KEYWORK_PLAN } from "./gate.ts";
import { type AnswerWindow, withinWindow } from "./ingest.ts";
import { currentPhase, type Phase, type PhaseBounds, phaseSpec } from "./phase.ts";
import type { ToolDecision } from "./record.ts";

const DAY_MS = 86_400_000;
const CANDIDATE_BARS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const;
/** Acts a fitted bar must have above it; fewer cannot show 98% at all. */
const FIT_SUPPORT = 20;

/** Rows that are evidence for the current gate configuration: same rubric, policy and version. */
export function scopedRows(
  rows: readonly DecisionRecord[],
  gate: Gate<JudgeVerdict>,
): DecisionRecord[] {
  const policyHash = hashPolicy(gate.spec.policy);
  return rows.filter(
    (r) =>
      r.gateId === KEYWORK_GATE &&
      r.mode === "shadow" &&
      r.evidenceVersion === KEYWORK_EVIDENCE &&
      r.questionHash === gate.questionHash &&
      r.policyHash === policyHash,
  );
}

/**
 * The acceptance verdict, or the reason it cannot be reached. Evidence that spans two models is
 * not one sample: pin the model and bump the evidence version instead of mixing them.
 */
export function keyworkAcceptance(
  rows: readonly DecisionRecord[],
): AcceptanceResult | { readonly status: "mixed-models"; readonly models: readonly string[] } {
  const models = answeredModels(rows);
  if (models.length > 1) return { status: "mixed-models", models };
  return evaluateAcceptance(rows, KEYWORK_PLAN);
}

export interface ReportOptions {
  /** Which phase the ledger belongs to. Default: the phase a plain run is in. */
  readonly phase?: Phase;
  readonly bounds?: PhaseBounds;
  /** The export the ledger was fed from; it gives the pace people answer at. */
  readonly decisions?: readonly ToolDecision[];
}

/**
 * A plain-text report: what the gate saw, what it would have done, and where the phase stands.
 * The smoke set and fit rows are not evidence, so their labels are read freely: the fit needs
 * them, and nothing fitted there is validated there. On evidence, anything that reads a label's
 * value (how the person answered the suggested acts, and calibration) stays sealed until the
 * planned sample has been evaluated: an interim accuracy is an invitation to stop on a good run
 * or change the configuration on a bad one.
 */
export function keyworkReport(
  ledger: readonly DecisionRecord[],
  gate: Gate<JudgeVerdict>,
  options: ReportOptions = {},
): string {
  const phase = options.phase ?? currentPhase(options.bounds);
  const spec = phaseSpec(phase, options.bounds);
  const rows = scopedRows(ledger, gate);
  const answered = rows.filter((r) => !r.failedOpen && !settledWithoutAnswer(r));
  const labelled = answered.filter((r) => r.outcome !== undefined);
  const acceptance = keyworkAcceptance(rows);
  const open =
    phase !== "evidence" || acceptance.status === "accepted" || acceptance.status === "rejected";
  const lines = [
    heading(phase),
    "",
    intro(phase, spec.window),
    "",
    "## Evidence",
    "",
    `- Rows: ${rows.length} (${answered.length} answered by the model, ` +
      `${rows.filter(settledWithoutAnswer).length} settled by a floor, ` +
      `${rows.filter((r) => r.failedOpen).length} failed open)`,
    `- Labels by source: ${formatCounts(countBy(rows, (r) => r.outcome?.source ?? "unlabelled"))}`,
    `- Models: ${answeredModels(rows).join(", ") || "none yet"}`,
    `- Suggested: ${formatCounts(countBy(rows, (r) => r.soft))}`,
    ...(open
      ? outcomeLines(answered, labelled)
      : [
          `- Accuracy and calibration: sealed until the planned sample is evaluated ` +
            `(${labelled.length} labelled answers so far)`,
        ]),
  ];
  const answers = personAnswers(options.decisions ?? [], spec.window);
  if (phase === "fit") {
    lines.push("", ...fitLines(rows, answered, labelled, answers));
  }
  if (phase === "evidence") {
    const plan = resolvePlan(KEYWORK_PLAN);
    lines.push(
      "",
      "## Acceptance",
      "",
      `Plan: ${plan.sampleSize} acts, exact one-sided ${pct(plan.confidence)} bound at ` +
        `${pct(plan.target)}, at most ${plan.maxErrors} wrong, at most ` +
        `${plan.group?.maxPerGroup ?? "any"} acts per session. Evaluated once, when the sample is complete.`,
      "",
      `- ${describeAcceptance(acceptance)}`,
      ...paceLines(answers, rows, acceptance, plan.sampleSize),
    );
  }
  return `${lines.join("\n")}\n`;
}

function heading(phase: Phase): string {
  switch (phase) {
    case "smoke":
      return `# keywork tool gate smoke run (${KEYWORK_EVIDENCE})`;
    case "fit":
      return `# keywork tool gate fit phase (${KEYWORK_EVIDENCE})`;
    case "evidence":
      return `# keywork tool gate (${KEYWORK_EVIDENCE})`;
  }
}

function intro(phase: Phase, window: AnswerWindow): string {
  switch (phase) {
    case "smoke":
      return (
        `Not evidence: answers before ${window.before ?? "the fit phase"} were read while this loop ` +
        "was built. They show that the loop works and what the gate does with real calls; none of them enters the plan."
      );
    case "fit":
      return (
        "Not evidence: these rows fit the bar the freeze will fix, so their labels are read freely. " +
        "Nothing fitted here is validated here; validation starts at the freeze, on fresh rows."
      );
    case "evidence":
      return "Shadow only: these are the gate's suggestions next to the answers a person gave in keywork.";
  }
}

/** The lines that read labels' values: how the person answered the acts, and calibration. */
function outcomeLines(
  answered: readonly DecisionRecord[],
  labelled: readonly DecisionRecord[],
): string[] {
  const acts = answered.filter((r) => r.soft === "act");
  const approvedActs = acts.filter((r) => r.outcome?.truth === true).length;
  const deniedActs = acts.filter((r) => r.outcome?.truth === false).length;
  const scored = scoredForYes(labelled);
  return [
    `- Suggested acts the person approved: ${approvedActs}; denied: ${deniedActs}`,
    scored.length >= 10
      ? `- Calibration on ${scored.length} labelled answers: ECE ${ece(scored).toFixed(3)}, ` +
        `Brier ${brier(scored).toFixed(3)}`
      : `- Calibration: ${scored.length} labelled answers; at least 10 are needed to report it`,
  ];
}

/**
 * What each candidate bar would have done on the fit rows, the bar the fit picks for the
 * promise, and what it would take to validate it. The fit reads the yes-probability against
 * the person's answer, so "wrong" is an act the person would have denied. The point estimate on
 * fit rows is never the promise: the plan validates the frozen bar on fresh acts.
 */
function fitLines(
  rows: readonly DecisionRecord[],
  answered: readonly DecisionRecord[],
  labelled: readonly DecisionRecord[],
  answers: readonly number[],
): string[] {
  const scored = scoredForYes(labelled);
  const fitted = fitThreshold(scored, KEYWORK_PLAN.target, FIT_SUPPORT);
  const sampleSize = resolvePlan(KEYWORK_PLAN).sampleSize;
  const lines = [
    "## Fit",
    "",
    `- Fit rows: ${scored.length} labelled model answers of ${KEYWORK_FIT_ROWS} wanted before a freeze.`,
    "",
    "| Act above | Acts | Share of answers | Wrong | Accuracy | 95% lower bound |",
    "| --- | --- | --- | --- | --- | --- |",
    ...CANDIDATE_BARS.map((bar) => barRow(scored, bar)),
    "",
    fitted === undefined
      ? `- No bar reaches ${pct(KEYWORK_PLAN.target)} with at least ${FIT_SUPPORT} acts above it yet.`
      : `- Fitted for ${pct(KEYWORK_PLAN.target)} with at least ${FIT_SUPPORT} acts above the bar: ` +
        `act above ${fitted.threshold.toFixed(2)} (${fitted.n} acts, ${pct(fitted.coverage)} of answers, ` +
        `${Math.round(fitted.n * (1 - fitted.accuracy))} wrong). The plan validates it on ${sampleSize} fresh acts.`,
  ];
  if (fitted !== undefined && answers.length >= 2 && rows.length > 0) {
    const days = Math.max(1, (Math.max(...answers) - Math.min(...answers)) / DAY_MS);
    const share = fitted.coverage * (answered.length / rows.length);
    const actsPerDay = (answers.length / days) * share;
    lines.push(
      `- At that bar about ${pct(share)} of asked calls become acts; at ${(answers.length / days).toFixed(1)} ` +
        `answers a day, ${sampleSize} acts take roughly ${Math.ceil(sampleSize / actsPerDay)} days.`,
    );
  }
  lines.push(
    "",
    "To freeze: set KEYWORK_FREEZE in experiments/keywork/gate.ts to { at: <now, ISO 8601>, " +
      "actAbove: <bar> } in one commit. From then on a plain run collects evidence into its own " +
      "ledger, sealed until the planned sample is complete, and the bar does not change again " +
      "under this evidence version.",
  );
  return lines;
}

function barRow(scored: readonly Scored[], bar: number): string {
  const at = coverageAt(scored, bar);
  const wrong = Math.round(at.n * (1 - at.accuracy));
  const accuracy = at.n === 0 ? "-" : pct(at.accuracy);
  const bound = at.n === 0 ? "-" : pct(wilsonLower(at.accuracy, at.n));
  return `| ${bar.toFixed(2)} | ${at.n} | ${pct(at.coverage)} | ${wrong} | ${accuracy} | ${bound} |`;
}

function describeAcceptance(a: ReturnType<typeof keyworkAcceptance>): string {
  switch (a.status) {
    case "mixed-models":
      return `Not evaluated: the evidence spans models ${a.models.join(", ")}. Pin one and bump the evidence version.`;
    case "collecting":
      return `Collecting: ${a.acts} of ${a.plan.sampleSize} acts. Results stay sealed until the sample is complete.`;
    case "awaiting-labels":
      return `Sample complete; waiting for ${a.unlabelled} labels before the one evaluation.`;
    case "accepted":
      return `Accepted: ${a.errors} wrong of ${a.sample.length}; lower bound ${pct(a.lowerBound, 2)} >= ${pct(a.plan.target)}. Enforcement is still a separate, deliberate step.`;
    case "rejected":
      return `Rejected: ${a.errors} wrong of ${a.sample.length}; lower bound ${pct(a.lowerBound, 2)} < ${pct(a.plan.target)}. A new configuration needs a new evidence version and fresh acts.`;
  }
}

/** When the people answered the asks of this phase, as timestamps: the pace of the phase. */
function personAnswers(decisions: readonly ToolDecision[], window: AnswerWindow): number[] {
  return decisions
    .filter((d) => d.answer.by === "person" && withinWindow(d, window))
    .map((d) => Date.parse(d.answer.at));
}

/** How long the plan takes at the pace people actually answer keywork's asks. */
function paceLines(
  answers: readonly number[],
  rows: readonly DecisionRecord[],
  acceptance: ReturnType<typeof keyworkAcceptance>,
  sampleSize: number,
): string[] {
  if (answers.length < 2 || acceptance.status !== "collecting") return [];
  const days = Math.max(1, (Math.max(...answers) - Math.min(...answers)) / DAY_MS);
  const actShare = rows.length === 0 ? 0 : acceptance.acts / rows.length;
  const actsPerDay = (answers.length / days) * actShare;
  const remaining = sampleSize - acceptance.acts;
  return [
    "",
    "## Pace",
    "",
    `- ${answers.length} person answers over ${days.toFixed(0)} days: ${(answers.length / days).toFixed(1)} a day.`,
    actsPerDay > 0
      ? `- About ${pct(actShare)} of them become acts, so ${remaining} more acts take roughly ${Math.ceil(remaining / actsPerDay)} days at this pace.`
      : "- No acts yet, so the time to complete the sample cannot be estimated.",
  ];
}

function answeredModels(rows: readonly DecisionRecord[]): string[] {
  const models = rows
    .filter((r) => !r.failedOpen && !settledWithoutAnswer(r))
    .map((r) => r.model ?? r.oracle);
  return [...new Set(models)].sort();
}

function countBy(
  rows: readonly DecisionRecord[],
  key: (r: DecisionRecord) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: ReadonlyMap<string, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

function pct(x: number, places = 0): string {
  return `${(100 * x).toFixed(places)}%`;
}
