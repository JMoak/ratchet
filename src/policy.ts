import { hashState } from "./ledger/ledger.ts";
import { borrowedBar, type CalibrationProfile } from "./ledger/profile.ts";
import { round, thresholdFromCosts } from "./math.ts";
import { show } from "./questions.ts";
import { type Action, type Decision, moreCautious, type Verdict } from "./types.ts";

/**
 * How a verdict becomes an action. Thresholds are per question and per action, because the
 * right bar depends on what a wrong act costs here; a model's confidence number means
 * nothing until it meets a cost.
 */
export interface GatePolicy {
  /** Act automatically when the probability that acting is right reaches this. */
  readonly actAbove: number;
  /** Refuse (fail closed) when that probability is at or below this. Omit to review instead. */
  readonly refuseBelow?: number;
  /** For judge questions: does "yes" mean go? Default true. */
  readonly goIsYes?: boolean;
  /** Action when the oracle failed open. Default review. */
  readonly onFailOpen?: Action;
}

/** Hash only effective policy fields; opaque rules and strategies need a caller version. */
export function hashPolicy(policy: GatePolicy): string {
  // JSON turns every nonfinite number into null; keep even those distinct from "unset".
  const number = (value: number): number | string =>
    Number.isFinite(value) ? value : String(value);
  return hashState(
    JSON.stringify({
      actAbove: number(policy.actAbove),
      refuseBelow: policy.refuseBelow === undefined ? null : number(policy.refuseBelow),
      goIsYes: policy.goIsYes ?? true,
      onFailOpen: policy.onFailOpen ?? "review",
    }),
  );
}

export interface Ruling {
  readonly action: Action;
  /** The probability that acting is right, as the policy read it from the verdict. */
  readonly go: number;
  /** The soft action before any hard floor was applied. */
  readonly soft: Action;
  /** The hard floor that was applied, if any. */
  readonly floor?: Action;
  readonly reason: string;
}

/**
 * Derive a policy from the two costs that matter: acting when you should not, and holding
 * when you could have acted. actAbove = costWrongAct / (costWrongAct + costWrongHold) is the
 * Bayes-optimal bar for a calibrated probability. A wrong act 99x costlier than a wrong hold
 * means acting only above 0.99.
 */
export function policyFromCosts(
  costWrongAct: number,
  costWrongHold: number,
  extra: Omit<GatePolicy, "actAbove"> = {},
): GatePolicy {
  return { actAbove: thresholdFromCosts(costWrongAct, costWrongHold), ...extra };
}

/**
 * Probability that acting on this verdict is right. NaN when the verdict carries no number to
 * read (a missing verdict, a string or null where a probability belongs), never a coerced one.
 */
export function goProbability(v: Verdict, goIsYes = true): number {
  if (typeof v !== "object" || v === null) return Number.NaN;
  switch (v.kind) {
    case "judge":
      if (typeof v.pYes !== "number") return Number.NaN;
      return goIsYes ? v.pYes : 1 - v.pYes;
    case "pick":
    case "rate":
      return typeof v.confidence === "number" ? v.confidence : Number.NaN;
    default:
      return Number.NaN;
  }
}

const usable = (go: number): boolean => Number.isFinite(go) && go >= 0 && go <= 1;

/** True for the three actions, and nothing else (not "REFUSE", not "deny", not undefined). */
export function isAction(x: unknown): x is Action {
  return x === "act" || x === "review" || x === "refuse";
}

/** Strings that mean "no" in someone else's vocabulary: read as refuse rather than review. */
const REFUSE_SHAPED = /refus|deny|denied|block|reject|forbid|halt|stop/i;

/**
 * An action as given, or the cautious reading of one outside the vocabulary: a refuse-shaped
 * string ("REFUSE", "deny", "blocked") is refuse, anything else ("ACT", undefined, a number) is
 * review. Never act: `moreCautious` orders only the three actions, and a stray value would
 * otherwise lose every comparison and be read as permission.
 */
export function readAction(x: unknown): Action {
  if (isAction(x)) return x;
  return typeof x === "string" && REFUSE_SHAPED.test(x) ? "refuse" : "review";
}

/**
 * Turn one decision into a ruling under a policy, optionally under a hard floor. A go
 * probability that is not a probability (NaN, infinite, outside [0, 1]) is read as a failed
 * answer and gets the policy's fail-open action: `failOpen` rejects such verdicts before they
 * get here, and this guard keeps one that took another path (a raw verifier in a chain, a
 * broken combiner) from ever clearing an act bar.
 */
export function rule(decision: Decision, policy: GatePolicy, floor?: Action): Ruling {
  // A missing decision (a verifier that returned nothing usable) is read as a failed answer.
  const present = typeof decision === "object" && decision !== null;
  const go = present ? goProbability(decision.verdict, policy.goIsYes ?? true) : Number.NaN;
  // A fail-open action outside the vocabulary is read cautiously, never as act.
  const onFailOpen = policy.onFailOpen === undefined ? "review" : readAction(policy.onFailOpen);
  let soft: Action;
  let reason: string;
  if (!present) {
    soft = onFailOpen;
    reason = `no decision to rule on; policy says ${soft}`;
  } else if (decision.failedOpen) {
    soft = onFailOpen;
    const by = typeof decision.oracle === "string" ? decision.oracle : show(decision.oracle);
    reason = `oracle ${by} failed open; policy says ${soft}`;
  } else if (!usable(go)) {
    soft = onFailOpen;
    reason = `go ${String(go)} is not a probability; read as failed open, policy says ${soft}`;
  } else if (go >= policy.actAbove) {
    soft = "act";
    reason = `go ${go.toFixed(3)} >= actAbove ${policy.actAbove}`;
  } else if (policy.refuseBelow !== undefined && go <= policy.refuseBelow) {
    soft = "refuse";
    reason = `go ${go.toFixed(3)} <= refuseBelow ${policy.refuseBelow}`;
  } else {
    soft = "review";
    reason = `go ${go.toFixed(3)} below actAbove ${policy.actAbove}`;
  }
  if (floor === undefined) return { action: soft, go, soft, reason };
  // A floor outside the vocabulary still binds, read cautiously (`readAction`).
  const bound = readAction(floor);
  const unread = isAction(floor) ? "" : `; floor ${show(floor)} is not an action, read as ${bound}`;
  const action = moreCautious(bound, soft);
  const floored = action !== soft ? `; floor ${bound} overrides` : "";
  return { action, go, soft, floor: bound, reason: reason + unread + floored };
}

/** x rounded to six significant digits: a stable figure to hash that never rounds to 0. */
const sig6 = (x: number): number => Number(x.toPrecision(6));

/** Slack for the knee test, so 1 - 2 * 0.05 reads as 0.9. */
const KNEE_SLACK = 1e-12;

/**
 * The upper edge of a review band of half-width `w` around `bar`. While the band takes no more
 * than half the headroom above the bar (bar <= 1 - 2w) the edge is bar + w, as it always was.
 * Above that knee the edge keeps the log-odds distance the band spans at the knee, so it
 * approaches 1 and never reaches it: in odds, the bar's odds times r = 2(1 - w) / (1 - 2w),
 * which is continuous with bar + w at the knee (both give 1 - w) and rises with the bar.
 * An additive band capped at 1 would act above 1, on nothing, for every bar of 1 - w or more;
 * a pooled battery's bars sit there (0.99999991 at log-odds pooling).
 */
function upperEdge(bar: number, w: number): number {
  if (bar <= 1 - 2 * w + KNEE_SLACK) return Math.min(1, round(bar + w, 6));
  if (bar >= 1) return 1;
  const r = (2 * (1 - w)) / (1 - 2 * w);
  return 1 - sig6((1 - bar) / (1 - bar + bar * r));
}

/** The lower edge, mirrored: bar - w while bar >= 2w, else the bar's odds divided by r. */
function lowerEdge(bar: number, w: number): number {
  if (bar >= 2 * w - KNEE_SLACK) return Math.max(0, round(bar - w, 6));
  if (bar <= 0) return 0;
  const r = (2 * (1 - w)) / (1 - 2 * w);
  return sig6(bar / (bar + (1 - bar) * r));
}

/**
 * A policy whose review band is sized to measured drift. How far identical requests move a
 * decision model's probability depends on the pin (live, e2e T1 and T2: jev-1.13 at most 0.11
 * over 414 repeats, jev-1.14 more than 0.12 on 11% of 924 and up to 0.51), reorderings move it
 * further, and decisions within about 0.1 of a bar are the ones adversarial context flips.
 * Measure the spread for the pinned model and size the half-width from it. So act only when the
 * probability clears the bar by the half-width, and (optionally) refuse only when it falls
 * short by the same amount; everything between is reviewed.
 *
 * The half-width is added in probability while that leaves at least half the headroom beyond
 * the bar (bar <= 1 - 2 * halfWidth for the act edge, bar >= 2 * halfWidth for the refuse
 * edge), which keeps every such policy, and its hash, as it was. Nearer certainty the band is
 * applied in log-odds, the width it has at that knee, so a high bar gets an act bar above it and
 * below 1 instead of "act above 1", which acts on nothing: with half-width 0.05, a bar of 0.92
 * acts above 0.9604396 (not 0.97), 0.95 above 0.9756757 (not 1) and 0.9999 above 0.9999526.
 * The half-width must be at least 0 and below 0.5, and the bar a probability.
 */
export function policyWithBand(
  bar: number,
  halfWidth: number,
  extra: Omit<GatePolicy, "actAbove" | "refuseBelow"> & { readonly refuse?: boolean } = {},
): GatePolicy {
  if (!(Number.isFinite(bar) && bar >= 0 && bar <= 1)) {
    throw new Error(`bar ${String(bar)} must be a probability`);
  }
  if (!(Number.isFinite(halfWidth) && halfWidth >= 0 && halfWidth < 0.5)) {
    throw new Error(`halfWidth ${String(halfWidth)} must be at least 0 and below 0.5`);
  }
  const { refuse, ...rest } = extra;
  return {
    actAbove: upperEdge(bar, halfWidth),
    ...(refuse ? { refuseBelow: lowerEdge(bar, halfWidth) } : {}),
    ...rest,
  };
}

export interface ProfilePolicyOptions extends Omit<GatePolicy, "actAbove" | "refuseBelow"> {
  /** Half the review band around the borrowed bar. Default 0.05. */
  readonly halfWidth?: number;
  /** Refuse at or below the band's lower edge, the borrowed bar less the half-width. */
  readonly refuse?: boolean;
}

/**
 * The policy for a gate starting from a calibration profile, to put in its spec with
 * `barSource: { profileHash: profile.hash }` beside it. It is an ordinary policy, hashed like
 * any other, so a gate built this way starts a fresh evidence phase and its rows say where its
 * bar came from. The borrowed bar is the centre of a review band 0.05 wide on each side, so the
 * act bar sits at the band's upper edge, the borrowed bar plus 0.05 (for a borrowed bar above
 * 0.9, the same band in log-odds, so it stays below 1: see `policyWithBand`): the borrowed bar
 * is where other gates' questions kept the promise, read at bin resolution, and identical
 * requests move a decision model's probability (by up to 0.11 on jev-1.13 and further on
 * jev-1.14, e2e T1 and T2), so a call scored near it is reviewed. Throws when the profile has no bar for `target`.
 */
export function policyFromProfile(
  profile: CalibrationProfile,
  target: number,
  opts: ProfilePolicyOptions = {},
): GatePolicy {
  const { halfWidth = 0.05, ...rest } = opts;
  if (!(Number.isFinite(halfWidth) && halfWidth >= 0)) {
    throw new Error("halfWidth must be a non-negative number");
  }
  const bar = borrowedBar(profile, target);
  if (bar === undefined) {
    throw new Error(
      `profile ${profile.hash.slice(0, 8)} supports no bar for a ${target} promise: no confidence cleared it on every donor gate`,
    );
  }
  return policyWithBand(bar, halfWidth, rest);
}
