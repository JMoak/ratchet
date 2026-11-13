import { anytimeLowerBound } from "./anytime.ts";
import { actWasRight, recordedGoIsYes } from "./ledger/calibration.ts";
import { adjudicateRows, isLabelRule, type LabelRule, readLabel } from "./ledger/labels.ts";
import { type DecisionRecord, hashState, settledWithoutAnswer } from "./ledger/ledger.ts";
import {
  admits,
  DEFAULT_TRUST,
  type FitClass,
  isTrustClass,
  TRUST_CLASSES,
  TRUSTED_SOURCES,
  type TrustRegistry,
} from "./ledger/sources.ts";
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
  /**
   * Trust classes whose labels the evaluation reads. Default `TRUSTED_SOURCES`: blind, census
   * and unsourced labels. An act labelled only from another source stays in the sample and
   * counts as unlabelled. Consequence is refused outright: what happened next depends on what
   * the gate did, so it cannot certify the gate. So is unregistered: a label whose source is
   * present but unreadable or unnamed is not known to be blind (register the source instead).
   */
  readonly sources?: readonly FitClass[];
  /**
   * How an act's labels are read (`labels.ts`). `latest`, the default, reads its latest label, as
   * always. `confirm-wrong` reads the labels `sources` admits as one vote per reviewer and counts
   * an act wrong only once a second reviewer confirms the "wrong" (a third breaks a tie); until
   * then the act is unlabelled to the test, so the sample can neither pass nor be rejected on a
   * disputed label. The test assumes correct labels, and a reviewer who marks a right act wrong
   * 1.25% of the time already lets a perfect gate pass the 149-act zero-error plan only about 15%
   * of the time; confirmation cuts that rate to about 0.03% if reviewers err independently. Part
   * of the plan's identity only when it is `confirm-wrong`, so every plan written before it keeps
   * its hash.
   */
  readonly adjudication?: LabelRule;
}

/** What a plan resolves to once validated: every default filled and the sample size fixed. */
export interface ResolvedPlan {
  readonly target: number;
  readonly confidence: number;
  readonly maxErrors: number;
  readonly sampleSize: number;
  readonly group?: { readonly tagPrefix: string; readonly maxPerGroup: number };
  /** The classes read, in `TRUST_CLASSES` order. */
  readonly sources: readonly FitClass[];
  /** Present only when labels are read under `confirm-wrong`; absent is `latest`. */
  readonly adjudication?: "confirm-wrong";
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
      /** Of the unlabelled, acts whose only label came from a source the plan does not read. */
      readonly untrusted?: number;
      /**
       * Under `confirm-wrong` only, and only when not zero: of the unlabelled, acts whose "wrong"
       * label awaits a second review or a tie-break.
       */
      readonly awaitingAdjudication?: number;
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
 * A planned sample read while it fills (`acceptanceProgress`). Plain data, and a readout only:
 * nothing in it promotes, rejects or changes a phase.
 */
export interface AcceptanceProgress {
  readonly plan: ResolvedPlan;
  /** Acts drawn into the planned sample so far, at most `sampleSize`. */
  readonly acts: number;
  /** The plan's sample size: the acts the one evaluation reads. */
  readonly sampleSize: number;
  /** The ids of the acts drawn so far, in sample order. */
  readonly sample: readonly string[];
  /**
   * The contiguous labelled prefix: the first `acts` acts in sample order that each carry a
   * label the plan reads, and how many of them were right and wrong to act on. It ends at the
   * first act without such a label, however many acts after it are labelled.
   */
  readonly prefix: { readonly acts: number; readonly right: number; readonly wrong: number };
  /** Acts anywhere in the sample so far that carry a label the plan reads. */
  readonly labelled: number;
  /** Of those, the acts that were wrong to act on; an unreadable label counts as wrong. */
  readonly wrong: number;
  /** Acts whose only label came from a source the plan does not read: unlabelled here. */
  readonly untrusted: number;
  /**
   * Under `confirm-wrong` only, and only when not zero: acts whose "wrong" label awaits a second
   * review or a tie-break. Unlabelled here, as in the evaluation.
   */
  readonly awaitingAdjudication?: number;
  /**
   * True once `wrong` exceeds the plan's `maxErrors`: however the remaining acts are labelled,
   * the completed sample is rejected unless a label already read is corrected. Information
   * only: reviewer error can be as large as the error budget, so the planned sample still
   * completes and is evaluated once, where a wrong label can be adjudicated first.
   */
  readonly cannotPass: boolean;
  /**
   * A lower confidence bound on the accuracy of acting, at the plan's confidence, valid at
   * every look (`anytimeLowerBound` over the prefix). It decides nothing.
   */
  readonly lowerBound: number;
}

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

/** The plan's trust classes, deduplicated in canonical order. Throws on an empty or unknown set. */
function planSources(sources: readonly FitClass[] | undefined): readonly FitClass[] {
  if (sources === undefined) return TRUSTED_SOURCES;
  if (sources.length === 0) throw new Error("sources must name at least one trust class");
  for (const c of sources as readonly unknown[]) {
    if (!isTrustClass(c)) throw new Error(`unknown trust class "${String(c)}"`);
    if (c === "consequence") throw new Error("consequence labels never feed acceptance");
    if (c === "unregistered") {
      throw new Error(
        "unregistered labels never feed acceptance: register their source in labelTrust",
      );
    }
  }
  return TRUST_CLASSES.filter((c): c is FitClass => (sources as readonly string[]).includes(c));
}

/**
 * The plan's label rule. Read as untyped, since plans often arrive as parsed JSON: a misspelled
 * rule would otherwise read as the default without a word.
 */
function planRule(rule: unknown): LabelRule {
  if (rule === undefined) return "latest";
  if (!isLabelRule(rule)) {
    throw new Error(
      `adjudication must be "latest" or "confirm-wrong", got ${JSON.stringify(rule)}`,
    );
  }
  return rule;
}

/**
 * Validate a plan and fix its sample size. Throws on a target, confidence, group, sources or
 * adjudication out of range.
 */
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
  const sources = planSources(plan.sources);
  // The latest-label rule is the default and stays out of the plan, as the default sources do.
  const confirm = planRule(plan.adjudication) === "confirm-wrong";
  const adjudication = confirm ? { adjudication: "confirm-wrong" as const } : {};
  const sampleSize = requiredActs(plan.target, confidence, maxErrors);
  // The default sources stay out of the identity, so a plan written before sources existed
  // keeps its hash, and with it every rollout checkpoint scoped to it; so does the default
  // label rule, for plans written before rules existed.
  const identity = {
    target: plan.target,
    confidence,
    maxErrors,
    sampleSize,
    group: group ?? null,
    ...(sources.join() === TRUSTED_SOURCES.join() ? {} : { sources }),
    ...adjudication,
  };
  return {
    target: plan.target,
    confidence,
    maxErrors,
    sampleSize,
    ...(group !== undefined ? { group: { ...group } } : {}),
    sources,
    ...adjudication,
    hash: hashState(JSON.stringify(identity)),
  };
}

/**
 * Rows as the plan's label rule reads them, and how many of them await adjudication: under
 * `confirm-wrong`, through `adjudicateRows` with the plan's sources and `trust`; otherwise the
 * rows themselves and none. Every reader of labels in this module reads through it at one place,
 * so the rest of each reader is the same under either rule.
 */
function underRule(
  rows: readonly DecisionRecord[],
  plan: ResolvedPlan,
  trust: TrustRegistry,
): { readonly rows: readonly DecisionRecord[]; readonly awaiting: number } {
  const rule = plan.adjudication;
  if (rule === undefined) return { rows, awaiting: 0 };
  const filter = { sources: plan.sources, trust };
  const awaiting = rows.filter((r) => readLabel(r, rule, filter).status === "awaiting").length;
  return { rows: adjudicateRows(rows, rule, filter), awaiting };
}

/**
 * The planned sample: the first eligible acts in ledger order, chosen without reading a single
 * label, so labelling only the easy ones or stopping on a good run cannot shape it. An act is a
 * row the policy would have acted on and an oracle actually answered (floors, bypasses and
 * failed-open rows decide nothing about the oracle). A repeated state is a retry and counts
 * once; past `maxPerGroup` acts, a group's further acts are skipped. The plan's `sources` are
 * not read here either: a label's source is part of the label, so it applies at evaluation.
 */
export function acceptanceSample(
  rows: readonly DecisionRecord[],
  plan: ResolvedPlan,
  from = 0,
): DecisionRecord[] {
  const seenStates = new Set<string>();
  const perGroup = new Map<string, number>();
  const sample: DecisionRecord[] = [];
  for (let i = Math.max(0, from); i < rows.length; i++) {
    const r = rows[i] as DecisionRecord;
    if (sample.length === plan.sampleSize) break;
    if (!isPlannedAct(r)) continue;
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
 * complete and fully labelled by sources the plan reads, classified by `trust`. An act whose
 * correctness cannot be read from its label counts as wrong, so an unreadable label can never
 * help a gate pass.
 *
 * A label from a source the plan does not read is no label here, and its act stays in the
 * sample: dropping it would let the route a label arrived by choose the sample, and a revert is
 * a consequence label that lands on wrong acts.
 */
export function evaluateAcceptance(
  rows: readonly DecisionRecord[],
  plan: AcceptancePlan | ResolvedPlan,
  trust: TrustRegistry = DEFAULT_TRUST,
): AcceptanceResult {
  const resolved = "hash" in plan ? plan : resolvePlan(plan);
  return judgeSample(acceptanceSample(rows, resolved), resolved, trust);
}

/**
 * The one evaluation of a planned sample already drawn (`acceptanceSample`), its labels read
 * under the plan's rule. Under `confirm-wrong` an act whose "wrong" is unconfirmed or tied is
 * unlabelled, so a disputed label holds the sample awaiting labels rather than rejecting it.
 */
function judgeSample(
  drawn: readonly DecisionRecord[],
  resolved: ResolvedPlan,
  trust: TrustRegistry,
): AcceptanceResult {
  if (drawn.length < resolved.sampleSize) {
    return { status: "collecting", plan: resolved, acts: drawn.length };
  }
  const ids = drawn.map((r) => r.id);
  const { rows: sample, awaiting } = underRule(drawn, resolved, trust);
  const filter = { sources: resolved.sources, trust };
  const unread = sample.filter((r) => r.outcome === undefined || !admits(filter, r.outcome.source));
  if (unread.length > 0) {
    const untrusted = unread.filter((r) => r.outcome !== undefined).length;
    return {
      status: "awaiting-labels",
      plan: resolved,
      unlabelled: unread.length,
      ...(untrusted > 0 ? { untrusted } : {}),
      ...(awaiting > 0 ? { awaitingAdjudication: awaiting } : {}),
      sample: ids,
    };
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

/**
 * Read a planned sample while it fills, without evaluating it: over rows scoped as for
 * `evaluateAcceptance`, the same sample `acceptanceSample` draws (retries once, groups capped),
 * its labels read exactly as the evaluation reads them (the plan's `sources` through `trust`,
 * an unreadable label counting as wrong, a label from another source counting as none).
 *
 * `lowerBound` is safe to watch where a fixed-sample bound is not. A Clopper-Pearson bound is
 * exact only at the size planned: read after every label and acted on the first time it clears
 * the promise, it is optional stopping and overstates the gate. This one is
 * `anytimeLowerBound(right, wrong, 1 - confidence)`: a mixture of likelihood-ratio bets against
 * each candidate accuracy x is a test supermartingale while every act, given those before it,
 * is right with probability at most x, so by Ville's inequality the chance that the bound ever
 * exceeds x, over every look at once, is at most 1 - confidence (a confidence sequence).
 *
 * It is computed on the labelled prefix in sample order, never on labels in the order they
 * arrived. When a label's arrival depends on its outcome (wrong acts take longer to review),
 * arrival order inflates the evidence (the research measured false promotion at 29% and 90%
 * against 3.8% in ledger order), so an unlabelled act holds the bound where it stands until it
 * is labelled, whatever is labelled after it.
 *
 * Nothing here decides. The planned test alone promotes or rejects (`evaluateAcceptance`), once,
 * at its planned size; `cannotPass` is an early notice that the evaluation will reject unless a
 * label is corrected. Stopping a configuration because its readout looks poor removes only
 * promotions; starting over under a new version until one passes is multiple testing, as before.
 */
export function acceptanceProgress(
  rows: readonly DecisionRecord[],
  plan: AcceptancePlan | ResolvedPlan,
  trust: TrustRegistry = DEFAULT_TRUST,
): AcceptanceProgress {
  const resolved = "hash" in plan ? plan : resolvePlan(plan);
  const { rows: sample, awaiting } = underRule(acceptanceSample(rows, resolved), resolved, trust);
  const filter = { sources: resolved.sources, trust };
  let open = true;
  let right = 0;
  let prefixWrong = 0;
  let labelled = 0;
  let wrong = 0;
  let untrusted = 0;
  for (const r of sample) {
    if (r.outcome === undefined || !admits(filter, r.outcome.source)) {
      if (r.outcome !== undefined) untrusted++;
      open = false;
      continue;
    }
    const ok = rightToAct(r);
    labelled++;
    if (!ok) wrong++;
    if (open) {
      if (ok) right++;
      else prefixWrong++;
    }
  }
  return {
    plan: resolved,
    acts: sample.length,
    sampleSize: resolved.sampleSize,
    sample: sample.map((r) => r.id),
    prefix: { acts: right + prefixWrong, right, wrong: prefixWrong },
    labelled,
    wrong,
    untrusted,
    ...(awaiting > 0 ? { awaitingAdjudication: awaiting } : {}),
    // Labels the plan reads never change on completion, so these wrong acts stay in the
    // evaluated sample; with at most `maxErrors` the plan's own sample size guarantees the bound.
    cannotPass: wrong > resolved.maxErrors,
    lowerBound: anytimeLowerBound(right, prefixWrong, 1 - resolved.confidence),
  };
}

/** An act a planned sample may hold: the policy acted, and an oracle answered. */
export const isPlannedAct = (r: DecisionRecord): boolean =>
  r.soft === "act" && !r.failedOpen && !settledWithoutAnswer(r);

/**
 * True when a complete planned sample can no longer pass, whatever its unread labels turn out
 * to be: its read labels already hold more wrong acts than the plan allows (an unreadable
 * label counts as wrong, as in `evaluateAcceptance`). An incomplete sample cannot fail yet.
 */
export function cannotPass(
  sample: readonly DecisionRecord[],
  plan: ResolvedPlan,
  trust: TrustRegistry = DEFAULT_TRUST,
): boolean {
  if (sample.length < plan.sampleSize) return false;
  return doomed(underRule(sample, plan, trust).rows, plan, trust);
}

/** `cannotPass` on a complete sample whose labels are already read under the plan's rule. */
function doomed(
  sample: readonly DecisionRecord[],
  plan: ResolvedPlan,
  trust: TrustRegistry,
): boolean {
  const filter = { sources: plan.sources, trust };
  const wrong = sample.filter(
    (r) => r.outcome !== undefined && admits(filter, r.outcome.source) && !rightToAct(r),
  ).length;
  if (wrong > plan.maxErrors) return true;
  return exactLowerBound(sample.length - wrong, sample.length, plan.confidence) < plan.target;
}

/**
 * The first planned window among `rows` that can no longer pass, as its sample, or undefined.
 * A window is the planned sample drawn from one act on, as a phase starting there would draw
 * it; one is checked for every act before the act `before` names (default: every act). This
 * is what makes a rejection outlast its checkpoint: a configuration whose own evidence already
 * holds a failed planned sample cannot have a later, luckier one chosen in its place, however
 * the phase start is set (e2e V1, T4-10). Pass rows scoped as for `evaluateAcceptance`.
 */
export function failedWindow(
  scoped: readonly DecisionRecord[],
  plan: ResolvedPlan,
  trust: TrustRegistry = DEFAULT_TRUST,
  before?: string,
): readonly DecisionRecord[] | undefined {
  const rows = underRule(scoped, plan, trust).rows;
  const filter = { sources: plan.sources, trust };
  // A window fails only on a wrong (or unreadable) label, so none can start after the last one.
  let last = -1;
  rows.forEach((r, i) => {
    if (isPlannedAct(r) && r.outcome !== undefined && admits(filter, r.outcome.source)) {
      if (!rightToAct(r)) last = i;
    }
  });
  for (let i = 0; i <= last; i++) {
    const r = rows[i] as DecisionRecord;
    if (r.id === before) break;
    if (!isPlannedAct(r)) continue;
    const sample = acceptanceSample(rows, plan, i);
    // Later windows hold no more acts than this one: none of them is complete either.
    if (sample.length < plan.sampleSize) return undefined;
    if (doomed(sample, plan, trust)) return sample;
  }
  return undefined;
}

/**
 * The earliest planned window among `rows` that the ledger accepts, or undefined: the sample
 * of a phase that could have started at each act, in order, until one is complete, fully read
 * and passes. Used to verify a checkpoint written before checkpoints named their sample.
 */
export function earliestAccepted(
  rows: readonly DecisionRecord[],
  plan: ResolvedPlan,
  trust: TrustRegistry = DEFAULT_TRUST,
): readonly DecisionRecord[] | undefined {
  for (let i = 0; i < rows.length; i++) {
    if (!isPlannedAct(rows[i] as DecisionRecord)) continue;
    const sample = acceptanceSample(rows, plan, i);
    if (sample.length < plan.sampleSize) return undefined;
    if (judgeSample(sample, plan, trust).status === "accepted") return sample;
  }
  return undefined;
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

/**
 * Was acting right on this labelled act? Judge rows read the go side the row was ruled with; an
 * unlabelled or unreadable act is not right. Demotion reads audits the same way (`Rollout`).
 */
export function rightToAct(r: DecisionRecord): boolean {
  const polarity = recordedGoIsYes(r);
  if (r.verdict.kind === "judge" && polarity === undefined) return false;
  return actWasRight(r, polarity ?? true) === true;
}

function assertProbability(x: number, name: string): void {
  if (!(x > 0 && x < 1)) throw new Error(`${name} must be strictly between 0 and 1`);
}
