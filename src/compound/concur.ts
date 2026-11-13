import type { StrategySpec } from "../engine.ts";
import type { GatePolicy } from "../policy.ts";
import type { Member } from "./ensemble.ts";

/** The strategy `concur` returns: an ensemble pooled by its most cautious member. */
export interface ConcurStrategy {
  readonly ensemble: {
    readonly members: readonly Member[];
    readonly method: "min" | "max";
  };
}

/**
 * Two keys to act: the strategy for one judge question that acts only when every member would.
 * Either member can hold; acting needs all of them. It is the existing ensemble pooled by the
 * most cautious member: `min` of p(yes) when yes means go, `max` when no means go, so the go
 * probability the policy reads is the smallest any member gave. Pass the gate's own policy as
 * `opts` (`concur(members, policy)`), so the polarity cannot drift from the one the policy
 * rules by: on a no-is-go gate, `min` would be the permissive member instead.
 *
 * - A failed member fails the ensemble open (`minMembers` defaults to every member), so a
 *   missing key means the request is reviewed, never that the other key acts alone (e2e T4-04:
 *   a failed 0.30 member left a 0.97 member to act). Do not lower `minMembers`.
 * - Judge questions only. On a pick the engine's `min` takes each option's smallest probability
 *   across members and renormalises, which is not any member's answer and can be more confident
 *   than the member that disagreed (0.6/0.4 and 0.1/0.9 pool to 0.2/0.8, a confident second
 *   option the first member leaned against). A pick has no go side to be cautious about; two
 *   keys there mean every member choosing the same option above the bar, which is not a pool.
 *   Rate is the same.
 * - Fit the bar on the composite, on the gate's own unselected rows. The minimum of calibrated
 *   probabilities is not itself calibrated: two calibrated members with independent errors that
 *   both say 0.9 are worth about 0.99 at an even base rate, and the minimum says 0.9.
 * - With a `refuseBelow`, either member alone can also refuse. Leave it unset unless one
 *   model's confident no should end the request.
 * - The keys are worth having only when they err in different places: a second model of a
 *   different family, not a replica or another pin of one model (two jev pins shared 33 of
 *   jev-1.13's 37 errors, e2e T5-03). Measure their error correlation (`memberCorrelation`) on
 *   the composite's rows; the pool takes none, since `min` and `max` read no correlation.
 *
 * This is one-out-of-two voting on the hold side, the arrangement safety systems use when the
 * dangerous failure must need both channels to fail: a wrong act needs every member to be
 * wrongly confident at once, where a wrong hold needs only one, so it trades availability for
 * safety. It adds no strategy: it returns the value of `StrategySpec` that does this.
 */
export function concur(
  members: readonly Member[],
  opts: Pick<GatePolicy, "goIsYes">,
): ConcurStrategy {
  if (members.length < 2) {
    throw new Error(
      `concur needs at least two members, not ${members.length}: one key is a single opinion`,
    );
  }
  const method = opts.goIsYes === false ? "max" : "min";
  // Copied, so a later edit to the caller's array cannot change a registered gate's keys.
  return { ensemble: { members: [...members], method } } satisfies StrategySpec;
}
