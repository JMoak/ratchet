import { hashState } from "./ledger/ledger.ts";
import { round, thresholdFromCosts } from "./math.ts";
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

/** Probability that acting on this verdict is right. */
export function goProbability(v: Verdict, goIsYes = true): number {
  switch (v.kind) {
    case "judge":
      return goIsYes ? v.pYes : 1 - v.pYes;
    case "pick":
    case "rate":
      return v.confidence;
  }
}

/** Turn one decision into a ruling under a policy, optionally under a hard floor. */
export function rule(decision: Decision, policy: GatePolicy, floor?: Action): Ruling {
  const go = goProbability(decision.verdict, policy.goIsYes ?? true);
  let soft: Action;
  let reason: string;
  if (decision.failedOpen) {
    soft = policy.onFailOpen ?? "review";
    reason = `oracle ${decision.oracle} failed open; policy says ${soft}`;
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
  const action = moreCautious(floor, soft);
  const floored = action !== soft ? `; floor ${floor} overrides` : "";
  return { action, go, soft, floor, reason: reason + floored };
}

/**
 * A policy whose review band is sized to measured drift. Identical requests move a decision
 * model's probability by up to 0.08 to 0.12 and reorderings by 0.13 to 0.16, and decisions
 * within about 0.1 of a bar are the ones adversarial context flips. So act only when the
 * probability clears the bar by the half-width, and (optionally) refuse only when it falls
 * short by the same amount; everything between is reviewed.
 */
export function policyWithBand(
  bar: number,
  halfWidth: number,
  extra: Omit<GatePolicy, "actAbove" | "refuseBelow"> & { readonly refuse?: boolean } = {},
): GatePolicy {
  const { refuse, ...rest } = extra;
  const actAbove = Math.min(1, round(bar + halfWidth, 6));
  return {
    actAbove,
    ...(refuse ? { refuseBelow: Math.max(0, round(bar - halfWidth, 6)) } : {}),
    ...rest,
  };
}
