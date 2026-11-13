/**
 * What a gate's own labels support, read the same way by every surface: the act bar, the
 * evidence grade beside it, and for a battery how often its pooled verdicts saturate.
 * `Gate.report()`, `Engine.report()` and `ratchet report`, `check` and `trail` all read a gate
 * through `gateEvidence`, with one set of levers (`REPORT_DEFAULTS`), so one ledger cannot be
 * measured in one place and estimated in another.
 *
 * The bar is fitted on the act side and conservatively:
 * - act side: on the probability that acting is right as the policy reads it, against whether
 *   acting was right (`scoredForAct`), so it is the number to put in `actAbove`. A bar fitted on
 *   the leading answer's confidence also counts confident "no" answers toward the promise; used
 *   as an act bar it delivered 80% precision against 95% (offline) and 89% against 98% (live).
 * - conservatively: the lowest bar at which the lower end of the 95% Wilson interval of acting
 *   right (z 1.96, so a one-sided 97.5% bound), on the
 *   rows at or above it, reaches the promise (`fitThreshold`'s conservative mode, the rule a
 *   profile's bar is read with). A point estimate on a small fit set does not transfer: a bar
 *   fitted at 98% on one set of template groups delivered 91.2% on held-out groups. The point
 *   bar is kept beside it, for reading, never as the one to act at.
 * Both read only the current configuration's rows (`currentConfiguration`).
 */

import { borrowFor } from "./borrow.ts";
import type { FittedThreshold } from "./calibration.ts";
import { fitThreshold, inferGoIsYes, scoredForAct, wilsonLower } from "./calibration.ts";
import {
  type BorrowedVia,
  currentConfiguration,
  type EvidenceGrade,
  type FittedFrom,
  gradeOf,
  REPORT_DEFAULTS,
  type ReportLevers,
} from "./evidence.ts";
import { actRows, type ExactBar, fitExactBar } from "./exact-bar.ts";
import { type DecisionRecord, settledWithoutAnswer } from "./ledger.ts";
import type { CalibrationProfile } from "./profile.ts";
import { DEFAULT_TRUST, type TrustRegistry } from "./sources.ts";

/** Levers with every default filled and each checked. Throws on one out of range. */
export function resolveLevers(levers: Partial<ReportLevers> = {}): ReportLevers {
  const target = levers.target ?? REPORT_DEFAULTS.target;
  const minSupport = levers.minSupport ?? REPORT_DEFAULTS.minSupport;
  const minEstimated = levers.minEstimated ?? REPORT_DEFAULTS.minEstimated;
  if (!(target > 0 && target <= 1)) throw new Error("target must be in (0, 1]");
  if (!Number.isSafeInteger(minSupport) || minSupport < 1) {
    throw new Error("minSupport must be a positive integer");
  }
  if (!Number.isSafeInteger(minEstimated) || minEstimated < 1) {
    throw new Error("minEstimated must be a positive integer");
  }
  return { target, minSupport, minEstimated };
}

/** The act bar a gate's own labels support, fitted on the act side. */
export interface ActBar {
  /**
   * The bar to act at: the lowest probability-that-acting-is-right at which the lower end of the
   * 95% Wilson interval of acting right (a one-sided 97.5% bound), on the fitted rows at or above
   * it, reaches the target, with at least `minSupport` of them. Its `accuracy` is the share of those acts that were right.
   */
  readonly fitted?: FittedThreshold;
  /**
   * The same fit on the point estimate: never above `fitted`, and not a bar to act at on its
   * own, since a lucky run on a few rows clears it.
   */
  readonly pointFitted?: FittedThreshold;
  /**
   * Which rows were fitted: unselected (shadow rows and blind audits) when there were at least
   * `minSupport` of them, else every trusted labelled row, which the oracle's confidence
   * selected. Absent when no labelled row of a trusted source exists.
   */
  readonly fittedFrom?: FittedFrom;
  /** How many rows that was. */
  readonly fitRows?: number;
}

/**
 * Fit a gate's act bar on the current configuration's labelled rows (`ActBar`). Labels pass the
 * trust filter, rows a floor or bypass settled and failed-open rows are skipped, and each judge
 * row is read on the side its policy acted on.
 */
export function fitActBar(
  rows: readonly DecisionRecord[],
  opts: { readonly trust?: TrustRegistry; readonly target: number; readonly minSupport: number },
): ActBar {
  const { current } = currentConfiguration(rows);
  const trust = opts.trust ?? DEFAULT_TRUST;
  const goIsYes = inferGoIsYes(current).goIsYes;
  const trusted = scoredForAct(current, { trust, goIsYes });
  if (trusted.length === 0) return {};
  const unselected = scoredForAct(current, { trust, goIsYes, unselectedOnly: true });
  const onUnselected = unselected.length >= opts.minSupport;
  const fitSet = onUnselected ? unselected : trusted;
  const fitted = fitThreshold(fitSet, opts.target, opts.minSupport, { conservative: true });
  const point = fitThreshold(fitSet, opts.target, opts.minSupport);
  return {
    fittedFrom: onUnselected ? "unselected" : "all",
    fitRows: fitSet.length,
    ...(fitted !== undefined ? { fitted } : {}),
    ...(point !== undefined ? { pointFitted: point } : {}),
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const dec = (x: number): string => x.toFixed(3);

/**
 * One sentence for an act bar: where to act and what it rests on, or why there is no bar to act
 * at, saying so when the point estimate has one that the rows are too few to bound.
 */
export function describeActBar(bar: ActBar, levers: ReportLevers): string {
  const promise = pct(levers.target);
  const from =
    bar.fittedFrom === "all"
      ? `all ${bar.fitRows} labelled rows, which the oracle's confidence selected (biased)`
      : `${bar.fitRows} unselected rows`;
  const f = bar.fitted;
  const p = bar.pointFitted;
  if (f !== undefined) {
    const lower = wilsonLower(f.accuracy, f.n);
    const point =
      p !== undefined && p.threshold < f.threshold
        ? `; the point estimate alone would act above ${dec(p.threshold)}`
        : "";
    return `act above ${dec(f.threshold)}: acting was right on ${pct(f.accuracy)} of the ${f.n} rows at or above it (${pct(f.coverage)} of ${from}), lower end of the 95% interval ${pct(lower)} >= ${promise}${point}`;
  }
  if (bar.fitRows === undefined) return "no act bar: no labelled row of a trusted source";
  if (p !== undefined) {
    const lower = wilsonLower(p.accuracy, p.n);
    return `no act bar: too few rows for one at ${promise}; the point estimate clears it above ${dec(p.threshold)} (${pct(p.accuracy)} of ${p.n} rows) but the lower end of its 95% interval is ${pct(lower)}, so label more before acting on it (fitted on ${from})`;
  }
  if (bar.fitRows < levers.minSupport) {
    return `no act bar: ${bar.fitRows} labelled rows, and a bar needs ${levers.minSupport} at or above it`;
  }
  return `no act bar: acting delivers ${promise} at no bar with ${levers.minSupport} rows at or above it (fitted on ${from})`;
}

/** An exact bar and what was set aside before it was fitted. */
export interface ExactBarReading {
  /** `fitExactBar`'s result on the rows the reported bar is fitted on. */
  readonly bar: ExactBar;
  /**
   * Rows of that fit set left out because their act-side probability was not a number in
   * [0, 1]: `fitExactBar` throws on one, and a report never throws on a ledger's content.
   * `bar.rows + leftOut` is `ActBar.fitRows`, except for a row whose probability is not finite,
   * which the act-side reader drops before either fit sees it.
   */
  readonly leftOut: number;
}

/**
 * The exact fixed-sequence bar (`fitExactBar`) on the rows `fitActBar` fits: the current
 * configuration's labelled rows of trusted sources on the act side, unselected ones when there
 * are at least `minSupport` of them and every trusted labelled row otherwise, so the two bars
 * can be read side by side on one set of rows. The rows are read through `actRows`, which
 * carries each row's group from `group.tagPrefix`. Throws when `target` is not in (0, 1), the
 * range `fitExactBar` takes.
 */
export function exactBarFor(
  rows: readonly DecisionRecord[],
  opts: {
    readonly trust?: TrustRegistry;
    readonly target: number;
    readonly minSupport: number;
    readonly group?: { readonly tagPrefix: string };
  },
): ExactBarReading {
  const { current } = currentConfiguration(rows);
  const trust = opts.trust ?? DEFAULT_TRUST;
  const goIsYes = inferGoIsYes(current).goIsYes;
  const read = (unselectedOnly: boolean) =>
    actRows(current, {
      trust,
      goIsYes,
      ...(unselectedOnly ? { unselectedOnly: true } : {}),
      ...(opts.group !== undefined ? { group: opts.group } : {}),
    });
  const unselected = read(true);
  const fitSet = unselected.length >= opts.minSupport ? unselected : read(false);
  const usable = fitSet.filter((r) => r.go >= 0 && r.go <= 1);
  return {
    bar: fitExactBar(usable, { target: opts.target }),
    leftOut: fitSet.length - usable.length,
  };
}

/**
 * One sentence for an exact bar, in the voice of `describeActBar`: where to act, how many units
 * in its tail and how many were wrong, the exact one-sided lower bound, that it is a fixed
 * sequence over preset edges, what one observation is, whose counts chose the start, and
 * whether it is provisional; or the reason there is none. With groups as the unit it speaks of
 * groups, since that is what the bound is about.
 */
export function describeExactBar(reading: ExactBarReading): string {
  const { bar, leftOut } = reading;
  const left =
    leftOut > 0
      ? `; ${leftOut} ${leftOut === 1 ? "row" : "rows"} left out, their act-side probability not a number in [0, 1]`
      : "";
  if (bar.bar === undefined) return `${bar.reason}${left}`;
  const word = bar.unit === "group" ? "group" : "row";
  const plural = (n: number) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const t = bar.tail;
  const wrong = bar.unit === "group" ? `${t.wrong} held a wrong act` : `${t.wrong} wrong`;
  const unit =
    bar.unit === "group"
      ? `${bar.rows} rows are about ${bar.units} independent observations`
      : "assumes rows are independent";
  const start =
    bar.startFrom === "independent"
      ? "start chosen from independent counts"
      : `start chosen from the fit ${word}s' own counts`;
  const provisional = bar.provisional
    ? "; provisional: found at the edge of power, label more before relying on it"
    : "";
  return `act above ${dec(bar.bar)}: of the ${plural(t.units)} at or above it, ${wrong}; exact one-sided ${pct(bar.confidence)} lower bound ${pct(t.lowerBound)} >= ${pct(bar.target)}; a fixed sequence over ${bar.edges.length} preset edges; ${unit}; ${start}${provisional}${left}`;
}

/**
 * A pooled probability this close to 0 or 1 is saturated: beyond 0.001 or 0.999, a log-odds of
 * about 6.9 either way. A battery pooled in log-odds at correlation 0 put 37% of a conjunctive
 * battery's verdicts there, with a fitted bar of 0.99999991 and a review band that could no
 * longer act on anything.
 */
export const SATURATION_CUT = 0.001;

/** At or above this share of saturated verdicts, a report says what to combine with instead. */
export const SATURATION_WARN = 0.2;

/** How a battery's pooled verdicts sit: the share pushed to the ends of the scale. */
export interface BatteryReadout {
  /**
   * The combiner the newest combined row names (`detail.combine`): logodds, any, all, learned,
   * ... Absent on rows written before batteries recorded it.
   */
  readonly combine?: string;
  /** Combined verdicts read: answered, not failed open, of the current configuration. */
  readonly verdicts: number;
  /** Of those, the ones beyond `SATURATION_CUT` of 0 or 1. */
  readonly saturated: number;
  readonly share: number;
}

/** A battery's saturation readout from its combined rows, or undefined for any other gate. */
export function batteryReadout(rows: readonly DecisionRecord[]): BatteryReadout | undefined {
  const { current } = currentConfiguration(rows);
  const combined = current.filter(
    (r) =>
      r.combined === true &&
      !r.failedOpen &&
      !settledWithoutAnswer(r) &&
      r.verdict.kind === "judge" &&
      Number.isFinite(r.verdict.pYes),
  );
  if (combined.length === 0) return undefined;
  const saturated = combined.filter((r) => {
    const p = r.verdict.kind === "judge" ? r.verdict.pYes : 0.5;
    return Math.min(p, 1 - p) < SATURATION_CUT;
  }).length;
  const method = combined.at(-1)?.detail?.combine;
  return {
    ...(typeof method === "string" ? { combine: method } : {}),
    verdicts: combined.length,
    saturated,
    share: saturated / combined.length,
  };
}

/**
 * What to do about a battery that saturates often, by the combiner it uses: advice to "fit a
 * learned combiner" read as nonsense on a gate already using one.
 */
function saturationAdvice(combine: string | undefined): string | undefined {
  const pool =
    'Combine a disjunction ("does any apply?") with "any", a conjunction ("do all hold?") with "all"';
  switch (combine) {
    case "any":
    case "all":
      // The pool is a probability of a union or an intersection, which sits near 0 or 1 when
      // a member does; the observed accuracy beside it says whether that is the right shape.
      return undefined;
    case "learned":
      return "the learned combiner is that sure of itself: check it converged (fitLogistic's converged and reason) and was fitted on unselected rows of this configuration, and refit with a larger l2 or more rows if not";
    case "max":
    case "min":
      return "max and min pass a member's own answer through, so the members themselves answer that close to certainty: read their calibration in the report";
    case "function":
      return `a custom combiner pushes the verdicts there: check its calibration on labelled rows. ${pool}, or fit a learned combiner on labelled member rows`;
    default:
      return `pooling in log-odds treats members as evidence for one answer, and members that ask different questions drive it to the ends. ${pool}, or fit a learned combiner on labelled member rows`;
  }
}

/** One sentence for a battery's readout, with what to do when it saturates often. */
export function describeBattery(b: BatteryReadout): string {
  const under = b.combine !== undefined ? ` under ${b.combine}` : "";
  const head = `${pct(b.share)} of ${b.verdicts} combined verdicts saturated (beyond ${SATURATION_CUT} or ${1 - SATURATION_CUT})${under}`;
  const advice = b.share >= SATURATION_WARN ? saturationAdvice(b.combine) : undefined;
  return advice === undefined ? head : `${head}: ${advice}`;
}

/** What `gateEvidence` reads a gate with. */
export interface GateEvidenceOptions {
  readonly levers?: Partial<ReportLevers>;
  /** How label sources map to trust classes. Default `DEFAULT_TRUST`. */
  readonly trust?: TrustRegistry;
  /**
   * False for rows that are features of another decision (a battery's members): they hold no
   * planned sample and borrow nothing. Default true.
   */
  readonly measurable?: boolean;
  /** Only rows this model answered enter the planned sample, as a pinned rollout reads them. */
  readonly model?: string;
  /** Evidence that is not this gate's labels, supplied by the caller. */
  readonly borrowed?: BorrowedVia;
  /** Profiles the gate may borrow a bar from (`borrowFor`). */
  readonly profiles?: readonly CalibrationProfile[];
  /** The model a profile is matched against. Default the newest answered row's. */
  readonly pin?: string;
  /**
   * Also fit the exact fixed-sequence bar (`exactBarFor`) on the rows the act bar is fitted on,
   * with `group` naming the tag prefix whose rows form one unit of evidence. Absent: the result
   * has no `exact` field.
   */
  readonly exact?: { readonly group?: { readonly tagPrefix: string } };
}

/** A gate's bar and grade, and the levers they were read with. */
export interface GateEvidence {
  readonly levers: ReportLevers;
  readonly bar: ActBar;
  readonly grade: EvidenceGrade;
  /** Set on a battery's combined rows. */
  readonly battery?: BatteryReadout;
  /** Set only when `exact` was asked for: the exact bar beside `bar`, which it does not replace. */
  readonly exact?: ExactBarReading;
}

/**
 * A gate's act bar and evidence grade from its rows in ledger order (one gate's decision rows,
 * or one battery member's rows). The grade is the strongest the rows support (`gradeOf`): a
 * planned sample read against the target is measured, enough unselected labels of the current
 * configuration are estimated, and a profile that matches the gate lends its bar until then. A
 * gate keeps borrowing until its own labels grade it estimated, not merely until they fit a
 * bar: otherwise a gate with 20 to 29 labels lost the borrowed bar and graded none.
 */
export function gateEvidence(
  rows: readonly DecisionRecord[],
  opts: GateEvidenceOptions = {},
): GateEvidence {
  const levers = resolveLevers(opts.levers);
  const trust = opts.trust ?? DEFAULT_TRUST;
  const measurable = opts.measurable ?? true;
  const bar = fitActBar(rows, { trust, target: levers.target, minSupport: levers.minSupport });
  // A promise of 1 has no finite planned sample, so it can be fitted to but never measured.
  const planned = measurable && levers.target < 1;
  const profiles = opts.profiles ?? [];
  const lent =
    opts.borrowed === undefined && measurable && profiles.length > 0
      ? borrowFor(rows, profiles, {
          target: levers.target,
          ...(opts.pin !== undefined ? { model: opts.pin } : {}),
        })
      : undefined;
  const grade = gradeOf(rows, {
    ...(planned ? { plan: { target: levers.target } } : {}),
    ...(planned && opts.model !== undefined ? { model: opts.model } : {}),
    trust,
    minEstimated: levers.minEstimated,
    ...(opts.borrowed !== undefined ? { borrowed: opts.borrowed } : {}),
    ...(lent !== undefined ? { borrowed: lent.via, stale: lent.stale } : {}),
  });
  const battery = batteryReadout(rows);
  const exact =
    opts.exact === undefined
      ? undefined
      : exactBarFor(rows, {
          trust,
          target: levers.target,
          minSupport: levers.minSupport,
          ...(opts.exact.group !== undefined ? { group: opts.exact.group } : {}),
        });
  return {
    levers,
    bar,
    grade,
    ...(battery !== undefined ? { battery } : {}),
    ...(exact !== undefined ? { exact } : {}),
  };
}
