/**
 * How to measure a panel's dependence and its ceiling from labelled rows.
 *
 * `withinClassCorrelation` is the dependence measure the Gaussian-logit (supra-Bayesian) pooling
 * model asks for: the correlation of two members' log-odds given the truth. It reads every row,
 * where `memberCorrelation`'s phi of correctness reads only the rows where someone was wrong and
 * is attenuated when the members' accuracies differ (a latent 0.85 reads as 0.42 to 0.60). The two
 * answer different questions, and on real rows they can disagree: on e2e T5, jev-1.13 and
 * haiku-5.5 shared item difficulty in their confidences (within-class 0.33) but not their errors
 * (phi -0.04). `panelFromLedger` reads a panel's labelled answers from the ledger, and
 * `panelCeiling` bounds what any combiner that follows a unanimous panel can reach.
 *
 * Pooling weights fitted from these quantities (member strengths, correlations shrunk toward the
 * family prior, centres) were tried on the T5 rows and did not beat the weights `pool()` takes
 * from the phi matrix: equal accuracy, worse log loss and calibration
 * (experiments/e2e/t5-compound/pooling-review.ts reproduces it). Phi stays the engine's measure.
 */
import { exactLowerBound } from "../acceptance.ts";
import { clamp, logit, mean } from "../math.ts";
import { isUnselected, type ScoreOptions } from "./calibration.ts";
import type { FittedFrom } from "./evidence.ts";
import type { DecisionRecord } from "./ledger.ts";
import { admits } from "./sources.ts";

/** One member of a panel: its key across rows, and who it is. */
export interface PanelMember {
  readonly key: string;
  /** The oracle id its answers came from. */
  readonly oracle?: string;
  /** The model its answers recorded. */
  readonly model?: string;
}

/** One labelled row: the truth, and each member's yes log-odds in member order. */
export interface PanelRow {
  readonly truth: boolean;
  /** Undefined where the member did not answer. */
  readonly logits: readonly (number | undefined)[];
}

/** A panel's members and their labelled answers. */
export interface PanelSample {
  readonly members: readonly PanelMember[];
  readonly rows: readonly PanelRow[];
  /**
   * From the ledger: "unselected" when every row read was a shadow row or a blind audit, "all"
   * when some were chosen by the oracle's confidence (reviewed because unsure), whose
   * correlations the selection itself distorts (Berkson's paradox).
   */
  readonly fittedFrom?: FittedFrom;
}

/**
 * The pooled within-class Pearson correlation of two members' yes log-odds: deviations are taken
 * from each truth's own means and pooled over the two truths. The plain correlation would add the
 * signal both members share (any two informative members look correlated), and phi of
 * correctness is attenuated by the members' error rates. A truth with fewer than two rows adds
 * nothing. Undefined, never 0, when a member's log-odds are all equal within a truth (pinned
 * confidences say nothing about how its errors move with another's) or when no truth has two
 * rows; 0 would read as independence, the most optimistic value there is. `n` is the rows read.
 */
export function withinClassCorrelation(
  rows: readonly { readonly truth: boolean; readonly a: number; readonly b: number }[],
): { readonly correlation?: number; readonly n: number } {
  const usable = rows.filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b));
  const n = usable.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  let classes = 0;
  for (const truth of [true, false]) {
    const rs = usable.filter((r) => r.truth === truth);
    if (rs.length < 2) continue;
    const as = rs.map((r) => r.a);
    const bs = rs.map((r) => r.b);
    if (pinned(as) || pinned(bs)) return { n };
    const ma = mean(as);
    const mb = mean(bs);
    for (const r of rs) {
      sxy += (r.a - ma) * (r.b - mb);
      sxx += (r.a - ma) ** 2;
      syy += (r.b - mb) ** 2;
    }
    classes++;
  }
  if (classes === 0 || !(sxx > 0 && syy > 0)) return { n };
  return { correlation: clamp(sxy / Math.sqrt(sxx * syy), -1, 1), n };
}

const pinned = (xs: readonly number[]): boolean => xs.every((x) => x === xs[0]);

/**
 * The panel a ledger shows: compound rows (ensemble, cascade, sequential) of judge questions,
 * labelled with a boolean truth, not failed open, members paired by key across rows, each
 * member's yes log-odds (`logit`, as `pool()` reads it). Rows are selected as `memberCorrelation`
 * selects them: labels pass the trust filter, and `unselectedOnly` keeps shadow rows and blind
 * audits only. A failed-open member did not answer. Battery members are rows of their own that
 * ask different questions, and are not read. `keys` picks and orders the members; by default
 * every key seen, sorted. A member's oracle and model are those of its first answer read. A
 * cascade's rows pair its tiers only on escalated items; measure a cascade's panel on a sample
 * where every tier answered.
 */
export function panelFromLedger(
  rows: readonly DecisionRecord[],
  opts: ScoreOptions & { readonly keys?: readonly string[] } = {},
): PanelSample {
  const read: { truth: boolean; answers: Map<string, number> }[] = [];
  const who = new Map<string, PanelMember>();
  let selected = false;
  for (const r of rows) {
    const truth = r.outcome?.truth;
    if (typeof truth !== "boolean" || !r.members || r.failedOpen || r.verdict.kind !== "judge") {
      continue;
    }
    const unselected = isUnselected(r, opts);
    if (!admits(opts, r.outcome?.source) || (opts.unselectedOnly && !unselected)) continue;
    const answers = new Map<string, number>();
    for (const m of r.members) {
      if (m.failedOpen || m.verdict.kind !== "judge" || answers.has(m.key)) continue;
      if (!Number.isFinite(m.verdict.pYes)) continue;
      answers.set(m.key, logit(m.verdict.pYes));
      if (!who.has(m.key)) {
        who.set(m.key, {
          key: m.key,
          oracle: m.oracle,
          ...(m.model !== undefined ? { model: m.model } : {}),
        });
      }
    }
    if (answers.size === 0) continue;
    if (!unselected) selected = true;
    read.push({ truth, answers });
  }
  const keys = opts.keys ?? [...who.keys()].sort();
  const members = keys.map((key) => who.get(key) ?? { key });
  const panelRows = read.flatMap((row): PanelRow[] => {
    const logits = keys.map((key) => row.answers.get(key));
    return logits.some((z) => z !== undefined) ? [{ truth: row.truth, logits }] : [];
  });
  return {
    members,
    rows: panelRows,
    ...(panelRows.length > 0 ? { fittedFrom: selected ? "all" : "unselected" } : {}),
  };
}

/** How often a whole panel was wrong, and the accuracy that leaves any combiner that follows it. */
export interface PanelCeiling {
  /** Rows on which every member answered. */
  readonly n: number;
  /** Rows on which every member was wrong. */
  readonly allWrong: number;
  /** 1 - allWrong / n; 1 with no rows. */
  readonly ceiling: number;
  /** Exact (Clopper-Pearson) interval on the ceiling at the confidence asked. */
  readonly lower: number;
  readonly upper: number;
}

/**
 * The unanimity ceiling. On a yes-or-no question, where every member is wrong every member gives
 * the same wrong answer, and any combiner that follows a unanimous panel (every pool with
 * non-negative weights) is wrong there too, so its accuracy is at most 1 - P(all wrong). Each
 * row is the members' correctness on one item where all answered. The interval is the exact
 * two-sided Clopper-Pearson interval at `confidence` (default 0.95): no combiner of these
 * members can be shown to beat its upper end. On e2e T5, jev-1.13 and haiku-5.5 were both wrong
 * on 2 of 260 held-out items: ceiling 99.2% (97.2% to 99.9%).
 */
export function allWrongCeiling(
  rows: readonly (readonly boolean[])[],
  confidence = 0.95,
): PanelCeiling {
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`confidence must be strictly between 0 and 1, not ${confidence}`);
  }
  const answered = rows.filter((row) => row.length > 0);
  const n = answered.length;
  const allWrong = answered.filter((row) => row.every((right) => !right)).length;
  if (n === 0) return { n, allWrong, ceiling: 1, lower: 0, upper: 1 };
  const side = 1 - (1 - confidence) / 2;
  return {
    n,
    allWrong,
    ceiling: 1 - allWrong / n,
    lower: exactLowerBound(n - allWrong, n, side),
    upper: 1 - exactLowerBound(allWrong, n, side),
  };
}

/**
 * `allWrongCeiling` over a panel's rows on which every member answered, each member scored by
 * its leading answer (p(yes) at or above 0.5 is yes) against the truth.
 */
export function panelCeiling(sample: PanelSample, confidence = 0.95): PanelCeiling {
  const rows = sample.rows.flatMap((row) =>
    row.logits.every((z) => z !== undefined)
      ? [row.logits.map((z) => (z as number) >= 0 === row.truth)]
      : [],
  );
  return allWrongCeiling(rows, confidence);
}
