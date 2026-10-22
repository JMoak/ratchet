import { type AcceptanceResult, evaluateAcceptance, resolvePlan } from "../../src/acceptance.ts";
import type { Gate } from "../../src/gate.ts";
import { brier, ece, scoredForYes } from "../../src/ledger/calibration.ts";
import { type DecisionRecord, settledWithoutAnswer } from "../../src/ledger/ledger.ts";
import { hashPolicy } from "../../src/policy.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import { KEYWORK_EVIDENCE, KEYWORK_GATE, KEYWORK_PLAN } from "./gate.ts";
import type { ToolDecision } from "./record.ts";

const DAY_MS = 86_400_000;

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

/** A plain-text report: what the gate saw, what it would have done, and how far the plan is. */
export function keyworkReport(
  ledger: readonly DecisionRecord[],
  gate: Gate<JudgeVerdict>,
  decisions: readonly ToolDecision[] = [],
): string {
  const rows = scopedRows(ledger, gate);
  const answered = rows.filter((r) => !r.failedOpen && !settledWithoutAnswer(r));
  const labelled = answered.filter((r) => r.outcome !== undefined);
  const acts = answered.filter((r) => r.soft === "act");
  const approvedActs = acts.filter((r) => r.outcome?.truth === true).length;
  const deniedActs = acts.filter((r) => r.outcome?.truth === false).length;
  const scored = scoredForYes(labelled);
  const plan = resolvePlan(KEYWORK_PLAN);
  const acceptance = keyworkAcceptance(rows);
  const lines = [
    `# keywork tool gate (${KEYWORK_EVIDENCE})`,
    "",
    "Shadow only: these are the gate's suggestions next to the answers a person gave in keywork.",
    "",
    "## Evidence",
    "",
    `- Rows: ${rows.length} (${answered.length} answered by the model, ` +
      `${rows.filter(settledWithoutAnswer).length} settled by a floor, ` +
      `${rows.filter((r) => r.failedOpen).length} failed open)`,
    `- Labels by source: ${formatCounts(countBy(rows, (r) => r.outcome?.source ?? "unlabelled"))}`,
    `- Models: ${answeredModels(rows).join(", ") || "none yet"}`,
    `- Suggested: ${formatCounts(countBy(rows, (r) => r.soft))}`,
    `- Suggested acts the person approved: ${approvedActs}; denied: ${deniedActs}`,
    scored.length >= 10
      ? `- Calibration on ${scored.length} labelled answers: ECE ${ece(scored).toFixed(3)}, ` +
        `Brier ${brier(scored).toFixed(3)}`
      : `- Calibration: ${scored.length} labelled answers; at least 10 are needed to report it`,
    "",
    "## Acceptance",
    "",
    `Plan: ${plan.sampleSize} acts, exact one-sided ${pct(plan.confidence)} bound at ` +
      `${pct(plan.target)}, at most ${plan.maxErrors} wrong, at most ` +
      `${plan.group?.maxPerGroup ?? "any"} acts per session. Evaluated once, when the sample is complete.`,
    "",
    `- ${describeAcceptance(acceptance)}`,
    ...paceLines(decisions, rows, acceptance, plan.sampleSize),
  ];
  return `${lines.join("\n")}\n`;
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

/** How long the plan takes at the pace people actually answer keywork's asks. */
function paceLines(
  decisions: readonly ToolDecision[],
  rows: readonly DecisionRecord[],
  acceptance: ReturnType<typeof keyworkAcceptance>,
  sampleSize: number,
): string[] {
  const answers = decisions
    .filter((d) => d.answer.by === "person")
    .map((d) => Date.parse(d.answer.at));
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
