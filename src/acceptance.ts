import { actWasRight, recordedGoIsYes } from "./ledger/calibration.ts";
import { type DecisionRecord, hashState, settledWithoutAnswer } from "./ledger/ledger.ts";
import { binomialTail } from "./math.ts";

/**
 * Acceptance: the one test that lets a gate act on its own. A sample of acts, fixed before any
 * of their labels is seen, is evaluated once; the exact one-sided (Clopper-Pearson) lower bound
 * on its accuracy must reach the promise. This replaces reading a point estimate off a moving
 * window at every look: 20 correct acts out of 20 only bound accuracy above about 86%, and
 * looking again after each label until the estimate happens to clear the bar is optional
 * stopping, which inflates false promotions however strict each single look appears.
 *
 * The assumptions are explicit: the gate's rubric, model, strategy and policy are frozen for
 * the sample; acts are independent trials, so retries (a repeated state) count once and a cap
 * per group (a session, a conversation) limits how much one correlated stretch can contribute;
 * and the sample is planned, so the evaluation happens once, at its predetermined size.
 */
export interface AcceptancePlan {
  /** Accuracy promised on the acts the gate takes, in (0, 1). */
  readonly target: number;
  /** One-sided confidence of the lower bound, in (0, 1). Default 0.95. */
  readonly confidence?: number;
  /**
   * Wrong acts the sample may hold and still pass. Each one allowed makes the sample larger,
   * so the bound still reaches the target; zero gives the smallest sample. Default 0.
   */
  readonly maxErrors?: number;
  /**
   * Rows sharing a tag with this prefix (for example "session:") form one group, and a group
   * contributes at most `maxPerGroup` acts. Calls in one session share context and errors, so
   * counting a hundred of them as a hundred independent trials would overstate the evidence.
   */
  readonly group?: { readonly tagPrefix: string; readonly maxPerGroup: number };
}

/** What a plan resolves to once validated: every default filled and the sample size fixed. */
export interface ResolvedPlan {
  readonly target: number;
  readonly confidence: number;
  readonly maxErrors: number;
  readonly sampleSize: number;
  readonly group?: { readonly tagPrefix: string; readonly maxPerGroup: number };
  /** Identity of the plan, so evidence gathered under one plan is never judged by another. */
  readonly hash: string;
}

export type AcceptanceResult =
  | {
      /** Fewer eligible acts than the plan needs. Nothing about their labels is reported. */
      readonly status: "collecting";
      readonly plan: ResolvedPlan;
      readonly acts: number;
    }
  | {
      /** The sample is complete but some of its acts are unlabelled; the result stays sealed. */
      readonly status: "awaiting-labels";
      readonly plan: ResolvedPlan;
      readonly unlabelled: number;
      readonly sample: readonly string[];
    }
  | {
      readonly status: "accepted" | "rejected";
      readonly plan: ResolvedPlan;
      readonly errors: number;
      readonly lowerBound: number;
      readonly sample: readonly string[];
    };

/**
 * Exact one-sided lower confidence bound on a success probability (Clopper-Pearson): the
 * smallest p under which seeing at least `successes` of `trials` is still as likely as
 * 1 - confidence. With every trial a success it is (1 - confidence)^(1 / trials), which is
 * where the 149 acts for 98% at 95% come from.
 */
export function exactLowerBound(successes: number, trials: number, confidence = 0.95): number {
  if (!Number.isSafeInteger(trials) || trials < 0) throw new Error("trials must be a count");
  if (!Number.isSafeInteger(successes) || successes < 0 || successes > trials) {
    throw new Error("successes must be a count no larger than trials");
  }
  assertProbability(confidence, "confidence");
  if (successes === 0) return 0;
  const alpha = 1 - confidence;
  if (successes === trials) return alpha ** (1 / trials);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (binomialTail(trials, successes, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The fewest acts a plan needs: the smallest sample whose bound reaches the target at `maxErrors`. */
export function requiredActs(target: number, confidence = 0.95, maxErrors = 0): number {
  assertProbability(target, "target");
  assertProbability(confidence, "confidence");
  if (!Number.isSafeInteger(maxErrors) || maxErrors < 0) {
    throw new Error("maxErrors must be a non-negative integer");
  }
  const passes = (n: number): boolean =>
    n > maxErrors && exactLowerBound(n - maxErrors, n, confidence) >= target;
  // The zero-error closed form, less one so floating error can only make the search start low.
  const zeroErrors = Math.ceil(Math.log(1 - confidence) / Math.log(target)) - 1;
  const floor = Math.max(maxErrors + 1, zeroErrors);
  let hi = floor;
  while (!passes(hi)) {
    if (hi > 10_000_000) throw new Error("the plan needs an impractically large sample");
    hi *= 2;
  }
  let lo = floor;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Validate a plan and fix its sample size. Throws on a target, confidence or group out of range. */
export function resolvePlan(plan: AcceptancePlan): ResolvedPlan {
  const confidence = plan.confidence ?? 0.95;
  const maxErrors = plan.maxErrors ?? 0;
  const group = plan.group;
  if (group !== undefined) {
    if (group.tagPrefix.trim() === "") throw new Error("group tagPrefix must be non-empty");
    if (!Number.isSafeInteger(group.maxPerGroup) || group.maxPerGroup < 1) {
      throw new Error("group maxPerGroup must be a positive integer");
    }
  }
  const sampleSize = requiredActs(plan.target, confidence, maxErrors);
  const identity = { target: plan.target, confidence, maxErrors, sampleSize, group: group ?? null };
  return {
    target: plan.target,
    confidence,
    maxErrors,
    sampleSize,
    ...(group !== undefined ? { group: { ...group } } : {}),
    hash: hashState(JSON.stringify(identity)),
  };
}

/**
 * The planned sample: the first eligible acts in ledger order, chosen without reading a single
 * label, so labelling only the easy ones or stopping on a good run cannot shape it. An act is a
 * row the policy would have acted on and an oracle actually answered (floors, bypasses and
 * failed-open rows decide nothing about the oracle). A repeated state is a retry and counts
 * once; past `maxPerGroup` acts, a group's further acts are skipped.
 */
export function acceptanceSample(
  rows: readonly DecisionRecord[],
  plan: ResolvedPlan,
): DecisionRecord[] {
  const seenStates = new Set<string>();
  const perGroup = new Map<string, number>();
  const sample: DecisionRecord[] = [];
  for (const r of rows) {
    if (sample.length === plan.sampleSize) break;
    if (r.soft !== "act" || r.failedOpen || settledWithoutAnswer(r)) continue;
    const retry = `${r.gateId}\u0000${r.questionHash}\u0000${r.stateHash}`;
    if (seenStates.has(retry)) continue;
    seenStates.add(retry);
    const group = groupOf(r, plan);
    if (group !== undefined) {
      const used = perGroup.get(group.key) ?? 0;
      if (used >= group.cap) continue;
      perGroup.set(group.key, used + 1);
    }
    sample.push(r);
  }
  return sample;
}

/**
 * Evaluate a plan against rows already scoped by the caller (one gate, one evidence version,
 * shadow rows of one phase, in ledger order). The verdict is reached once the planned sample is
 * complete and fully labelled. An act whose correctness cannot be read from its label counts as
 * wrong, so an unreadable label can never help a gate pass.
 */
export function evaluateAcceptance(
  rows: readonly DecisionRecord[],
  plan: AcceptancePlan | ResolvedPlan,
): AcceptanceResult {
  const resolved = "hash" in plan ? plan : resolvePlan(plan);
  const sample = acceptanceSample(rows, resolved);
  if (sample.length < resolved.sampleSize) {
    return { status: "collecting", plan: resolved, acts: sample.length };
  }
  const ids = sample.map((r) => r.id);
  const unlabelled = sample.filter((r) => r.outcome === undefined).length;
  if (unlabelled > 0) {
    return { status: "awaiting-labels", plan: resolved, unlabelled, sample: ids };
  }
  const errors = sample.filter((r) => !rightToAct(r)).length;
  const lowerBound = exactLowerBound(sample.length - errors, sample.length, resolved.confidence);
  return {
    status: errors <= resolved.maxErrors && lowerBound >= resolved.target ? "accepted" : "rejected",
    plan: resolved,
    errors,
    lowerBound,
    sample: ids,
  };
}

/** A row without the group tag is its own group: nothing ties it to another row. */
function groupOf(
  r: DecisionRecord,
  plan: ResolvedPlan,
): { readonly key: string; readonly cap: number } | undefined {
  if (plan.group === undefined) return undefined;
  const { tagPrefix, maxPerGroup } = plan.group;
  const key = r.tags.find((t) => t.startsWith(tagPrefix));
  return key === undefined ? undefined : { key, cap: maxPerGroup };
}

/** Was acting right on this labelled act? Judge rows read the go side the row was ruled with. */
function rightToAct(r: DecisionRecord): boolean {
  const polarity = recordedGoIsYes(r);
  if (r.verdict.kind === "judge" && polarity === undefined) return false;
  return actWasRight(r, polarity ?? true) === true;
}

function assertProbability(x: number, name: string): void {
  if (!(x > 0 && x < 1)) throw new Error(`${name} must be strictly between 0 and 1`);
}
