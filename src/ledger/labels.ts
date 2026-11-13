/**
 * Reading a row's label under a rule. Every reader of labels has read the latest one, and that
 * stays the default. A reviewer is wrong about as often as a 98% promise may be: a blind relabel
 * disagreed with the original label on 4 of 157 slots, about 1.3% per reviewer. A reviewer who
 * marks a right act wrong 1.25% of the time lets a perfect gate pass the 149-act zero-error plan
 * only about 15% of the time, and at 2% no valid test passes a perfect gate above its
 * false-acceptance level at any sample size. Having a second blind reviewer confirm every "wrong"
 * label, with a third to break a tie, cuts that false-wrong rate to about 0.03% for roughly five
 * extra reviews per 149 labels, if the reviewers err independently. `confirm-wrong` is that
 * protocol, read from the history a row keeps (`DecisionRecord.labels`).
 *
 * Pure: nothing here reads a ledger or writes one.
 */
import { actWasRight, recordedGoIsYes } from "./calibration.ts";
import { type DecisionRecord, labelHistory, type Outcome } from "./ledger.ts";
import { admits, type TrustFilter } from "./sources.ts";

/**
 * - `latest`: the row's `outcome`, if the trust filter admits its source. Today's reading.
 * - `confirm-wrong`: the labels the filter admits, read as one vote per reviewer; a "wrong" counts
 *   only once a second reviewer confirms it, and a third breaks a tie (`readLabel`).
 */
export type LabelRule = "latest" | "confirm-wrong";

export const LABEL_RULES: readonly LabelRule[] = ["latest", "confirm-wrong"];

export const isLabelRule = (x: unknown): x is LabelRule =>
  typeof x === "string" && (LABEL_RULES as readonly string[]).includes(x);

/** Reviewers whose vote says acting was right, and those whose vote says it was wrong. */
export interface Votes {
  readonly right: number;
  readonly wrong: number;
}

/**
 * How a row reads under a rule:
 * - `unlabelled`: no label the filter admits;
 * - `settled`: whether acting was right, with the label that settles it and the votes behind it;
 * - `awaiting`: a "wrong" vote not yet confirmed (`second-review`), or as many "right" votes as
 *   "wrong" ones (`tie-break`). Until then the row is unlabelled to a reader under the rule.
 */
export type LabelReading =
  | { readonly status: "unlabelled" }
  | {
      readonly status: "settled";
      readonly right: boolean;
      /** The latest label on the winning side: what a reader under the rule sees as `outcome`. */
      readonly outcome: Outcome;
      readonly votes: Votes;
    }
  | {
      readonly status: "awaiting";
      readonly needs: "second-review" | "tie-break";
      readonly votes: Votes;
    };

/**
 * Was acting right under this one label? Read exactly as the acceptance test reads a label
 * (`rightToAct`): a judge row through the go side it was ruled with (`recordedGoIsYes`), any
 * other kind through the label's `correct`; a label whose correctness cannot be read (a failed-
 * open or exactly-even judge row records no polarity) counts as wrong, so it can never help a
 * gate pass. Kept here rather than imported, so this module does not depend on the test that
 * reads through it.
 */
export function actRightUnder(r: DecisionRecord, outcome: Outcome): boolean {
  const polarity = recordedGoIsYes(r);
  if (r.verdict.kind === "judge" && polarity === undefined) return false;
  return actWasRight({ ...r, outcome }, polarity ?? true) === true;
}

/**
 * Who gave a label: its full source string. One source is one reviewer, so labels from
 * `review:blind:ana` and `review:blind:ben` are two votes. A source without a name part
 * (`review:blind`, `keywork:person`), and an absent one, cannot be told apart from itself: every
 * label from it is one reviewer, so an anonymous second review confirms nothing. Give reviewers
 * names (`ratchet review --reviewer`).
 */
function reviewerOf(o: Outcome): string | undefined {
  const s: unknown = o.source;
  if (s === undefined || typeof s === "string") return s;
  // A non-string source is unregistered and admitted only by a filter that names it.
  return `\u0000${JSON.stringify(s) ?? String(s)}`;
}

/**
 * Read one row's label under a rule. Under `latest`, the row's `outcome` when the filter admits
 * its source (one vote), else unlabelled: exactly as every reader has read a label.
 *
 * Under `confirm-wrong`, each reviewer's latest admitted label is their vote (a reviewer may
 * correct themselves), and a vote is right or wrong by whether acting was right under it
 * (`actRightUnder`). With w wrong and r right votes: no votes is unlabelled; w = 0 is settled
 * right; otherwise fewer than two votes in all awaits a second review; then the majority settles
 * it, and a tie awaits a tie-break. This is review protocol P1 of the foundations review: a
 * right act is settled wrong with probability e1·(1 − (1 − e1)²), about 2·e1², if reviewers err
 * independently, which a shared blind spot ("routine-looking, not routine") defeats.
 */
export function readLabel(
  r: DecisionRecord,
  rule: LabelRule,
  filter: TrustFilter = {},
): LabelReading {
  if (rule === "latest") {
    const o = r.outcome;
    if (o === undefined || !admits(filter, o.source)) return { status: "unlabelled" };
    const right = actRightUnder(r, o);
    return {
      status: "settled",
      right,
      outcome: o,
      votes: { right: right ? 1 : 0, wrong: right ? 0 : 1 },
    };
  }
  const votes = new Map<
    string | undefined,
    { readonly outcome: Outcome; readonly right: boolean }
  >();
  for (const o of labelHistory(r)) {
    if (!admits(filter, o.source)) continue;
    const reviewer = reviewerOf(o);
    // Delete first, so the map's order is the order of each reviewer's latest vote.
    votes.delete(reviewer);
    votes.set(reviewer, { outcome: o, right: actRightUnder(r, o) });
  }
  const cast = [...votes.values()];
  const right = cast.filter((v) => v.right).length;
  const wrong = cast.length - right;
  const counts = { right, wrong };
  if (cast.length === 0) return { status: "unlabelled" };
  const latest = (side: boolean): Outcome =>
    (cast.findLast((v) => v.right === side) as { readonly outcome: Outcome }).outcome;
  if (wrong === 0) return { status: "settled", right: true, outcome: latest(true), votes: counts };
  if (cast.length < 2) return { status: "awaiting", needs: "second-review", votes: counts };
  if (wrong === right) return { status: "awaiting", needs: "tie-break", votes: counts };
  const winner = right > wrong;
  return { status: "settled", right: winner, outcome: latest(winner), votes: counts };
}

/**
 * The rows a reader should see under a rule, in the same order. Under `latest`, the rows as they
 * are, which every reader treats exactly as before. Under `confirm-wrong`, a settled row's
 * `outcome` is the label that settles it, and a row awaiting a second review or a tie-break has
 * no `outcome`, so a reader that reads only `outcome` sees it unlabelled. A row with no vote the
 * filter admits is left as it is: any `outcome` it has is one the filter does not admit, so a
 * reader through the same filter sees it unlabelled too, and can still count it as labelled only
 * from a source it does not read. `labels` is kept on every row: it is the history, not a reading.
 */
export function adjudicateRows(
  rows: readonly DecisionRecord[],
  rule: LabelRule,
  filter: TrustFilter = {},
): DecisionRecord[] {
  if (rule === "latest") return rows.slice();
  return rows.map((r) => {
    const reading = readLabel(r, rule, filter);
    if (reading.status === "settled") {
      return reading.outcome === r.outcome ? r : { ...r, outcome: reading.outcome };
    }
    if (reading.status === "awaiting") {
      const { outcome: _disputed, ...rest } = r;
      return rest;
    }
    return r;
  });
}
