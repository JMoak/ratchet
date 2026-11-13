/**
 * Anytime-valid rollout arithmetic: the pure mathematics behind three changes the rollout
 * research proposed, kept apart from the ledger so each can be checked on its own.
 *
 * - **Promotion by betting.** A mixture of likelihood ratios against the promise is a test
 *   supermartingale while the gate is no better than its promise, so by Ville's inequality it
 *   reaches 1/alpha with probability at most alpha however often it is read. A wrong act lowers
 *   it instead of ending the test, which the zero-error plan cannot do. A reverse mixture retires
 *   a hopeless configuration with a guarantee for good ones.
 * - **Demotion as change detection.** A Shiryaev-Roberts mixture over audit outcomes is an
 *   e-detector: for any gate whose audited acts keep the promise, its mean run length to a false
 *   alarm is at least its threshold, which the window rule cannot say.
 * - **Continuous sampling.** The shadow, enforce, audit loop is Dodge's continuous sampling plan
 *   CSP-1, whose outgoing error has a closed form, a limit and a worst case.
 *
 * Nothing here reads a ledger or changes a mode: the controller owns which acts are counted, in
 * what order, and what follows a crossing. Every function validates its inputs and throws on a
 * probability out of range or a count that is not a non-negative integer.
 */

// ---------------------------------------------------------------------------
// Promotion by betting
// ---------------------------------------------------------------------------

/**
 * The default promotion alternatives, as fractions of the promised error rate: twelve values
 * log-spaced from 0.025 to 0.8 (0.025 × 32^(k/11)), weighted equally. Against a 98% promise they
 * bet on error rates from 0.05% to 1.6%. Spreading the bets over a log grid lets one test serve a
 * 99.9% gate and a 99.5% gate without choosing between them first (the method of mixtures).
 */
export const PROMOTION_GRID: readonly number[] = Object.freeze(
  Array.from({ length: 12 }, (_, k) => 0.025 * 32 ** (k / 11)),
);

/**
 * The default futility alternatives, as multiples of the error rate 1 − q_f that a gate worth
 * keeping may have: 1.5, 2, 3, 4, 6 and 8, weighted equally. At q_f = 0.99 they are accuracies
 * 0.985, 0.98, 0.97, 0.96, 0.94 and 0.92. Every multiple times 1 − q_f must stay below 1, so this
 * default needs q_f above 7/8; pass a grid for a lower one.
 */
export const FUTILITY_GRID: readonly number[] = Object.freeze([1.5, 2, 3, 4, 6, 8]);

/**
 * A checked mixture of bets with equal weights: for each component, the log of its factor on a
 * right act and on a wrong act. The weight factors out of the log-sum-exp.
 */
interface Bets {
  readonly onRight: readonly number[];
  readonly onWrong: readonly number[];
  readonly logWeight: number;
}

function checkGrid(grid: readonly number[], name: string): void {
  if (!Array.isArray(grid) || grid.length === 0) {
    throw new Error(`${name} must be a non-empty array of numbers`);
  }
}

function checkFractions(grid: readonly number[]): void {
  checkGrid(grid, "the promotion grid");
  for (const c of grid) {
    if (!(typeof c === "number" && c > 0 && c < 1)) {
      throw new Error(
        `promotion grid entries are fractions of the promised error rate and must lie strictly between 0 and 1; got ${String(c)}`,
      );
    }
  }
}

/**
 * The promotion bets against promise p0: fraction c is the alternative error rate e = c(1 − p0),
 * whose factor is (1 − e)/p0 = 1 + (1 − c)(1 − p0)/p0 on a right act and e/(1 − p0) = c on a
 * wrong one (log1p keeps the right-act factor exact near p0 = 1).
 */
function promotionBets(promise: number, grid: readonly number[]): Bets {
  checkFractions(grid);
  return {
    onRight: grid.map((c) => Math.log1p(((1 - c) * (1 - promise)) / promise)),
    onWrong: grid.map((c) => Math.log(c)),
    logWeight: -Math.log(grid.length),
  };
}

/**
 * The futility bets against q_f: multiple g is the alternative accuracy r = 1 − g(1 − q_f), whose
 * factor is r/q_f = 1 − (g − 1)(1 − q_f)/q_f on a right act and (1 − r)/(1 − q_f) = g on a wrong
 * one.
 */
function futilityBets(worthKeeping: number, grid: readonly number[]): Bets {
  checkGrid(grid, "the futility grid");
  for (const g of grid) {
    if (!(typeof g === "number" && g > 1 && g * (1 - worthKeeping) < 1)) {
      throw new Error(
        `futility grid entries are multiples of the error rate 1 - worthKeeping and must exceed 1 while keeping that rate below 1; got ${String(g)}`,
      );
    }
  }
  return {
    onRight: grid.map((g) => Math.log1p((-(g - 1) * (1 - worthKeeping)) / worthKeeping)),
    onWrong: grid.map((g) => Math.log(g)),
    logWeight: -Math.log(grid.length),
  };
}

/** log of the mixture after `right` right and `wrong` wrong acts, by a stable log-sum-exp. */
function logMixture(bets: Bets, right: number, wrong: number): number {
  const { onRight, onWrong } = bets;
  let max = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < onRight.length; k++) {
    const x = right * (onRight[k] as number) + wrong * (onWrong[k] as number);
    if (x > max) max = x;
  }
  let sum = 0;
  for (let k = 0; k < onRight.length; k++) {
    sum += Math.exp(right * (onRight[k] as number) + wrong * (onWrong[k] as number) - max);
  }
  return bets.logWeight + max + Math.log(sum);
}

/**
 * Log of the promotion e-value after `right` right and `wrong` wrong acts, for the null that the
 * gate's accuracy is at most `promise` (p0). Each grid entry c is an alternative error rate
 * e = c(1 − p0); the e-value is the equally weighted mixture of their likelihood ratios, computed
 * by a stable log-sum-exp:
 *
 *   logsumexp_k( ln w_k + right ln((1 − e_k)/p0) + wrong ln(e_k/(1 − p0)) )
 *
 * Testing by betting: one act's factor X q/p0 + (1 − X)(1 − q)/(1 − p0), with q = 1 − e, has mean
 * 1 + (p − p0)(q − p0)/(p0 (1 − p0)) at true accuracy p. That is at most 1 for every p ≤ p0
 * exactly when q ≥ p0, so only alternatives better than the promise are valid for this composite
 * null. A fixed mixture of test supermartingales is one; their maximum (a generalized likelihood
 * ratio) is not. No independence is needed: the bound holds whenever each act, given those
 * before it, is right with probability at most p0.
 *
 * Grid entries must lie strictly between 0 and 1, an error rate in (0, 1 − p0). At 0 the bet is
 * on a perfect gate, whose factor is 0 at the first wrong act; at 1 it is the promise itself, a
 * bet that never moves; above 1 its mean exceeds 1 at accuracies below the promise, which would
 * break Ville's inequality.
 *
 * The zero-error plan is the special case q = 1: its factor is 1/p0 on a right act and 0 on a
 * wrong one, so it reaches 1/alpha exactly when the first `requiredActs(p0, 1 − alpha)` acts are
 * right (149 at 98% and alpha 0.05). The mixture never stakes everything on q = 1, so a wrong act
 * costs it right acts instead of ending the test: at 98% and alpha 0.05 it promotes after 179
 * clean acts, 313 with one wrong, 430 with two, 535 with three and 632 with four.
 *
 * A pure function of the two counts, because the factors commute: a restore recomputes it from
 * the ledger. Which acts are counted is not order-free: count a prefix of the acts in ledger
 * order, never the acts whose labels happened to arrive first.
 */
export function logEValue(
  right: number,
  wrong: number,
  promise: number,
  grid: readonly number[] = PROMOTION_GRID,
): number {
  checkCount(right, "right");
  checkCount(wrong, "wrong");
  checkOpen(promise, "promise");
  return logMixture(promotionBets(promise, grid), right, wrong);
}

/**
 * True once the promotion e-value reaches 1/alpha. Ville's inequality bounds by alpha the chance
 * that a gate no better than its promise ever gets here, whenever and however often it is read.
 * Wald's approximate SPRT thresholds carry no such guarantee and are not used.
 */
export function promotes(
  right: number,
  wrong: number,
  promise: number,
  alpha: number,
  grid: readonly number[] = PROMOTION_GRID,
): boolean {
  checkOpen(alpha, "alpha");
  return logEValue(right, wrong, promise, grid) >= Math.log(1 / alpha);
}

/**
 * The running lower confidence bound on accuracy: the largest accuracy x the e-value rejects,
 * sup{x : logEValue(right, wrong, x) ≥ ln(1/alpha)}, with the grid rescaled to each x, or 0 when
 * none is rejected (or only accuracies below about 1e-13 are).
 *
 * The search rests on monotonicity in x. A right act's factor for fraction c is
 * (1 − c(1 − x))/x = (1 − c)/x + c, which falls as x rises; a wrong act's factor, c, does not
 * depend on x. So the e-value falls in x, the rejected accuracies run from 0 up to the bound, and
 * bisection to within 1e-13 finds it, rounding down.
 *
 * If every act, given those before it, is right with probability at most x, the bound exceeds x
 * only when the e-value at x has reached 1/alpha, which Ville's inequality bounds by alpha over
 * every look at once (a confidence sequence). So the bound may be shown at every evaluation, and
 * so may its running maximum. `promotes(right, wrong, p0, alpha)` is the event "bound ≥ p0", up
 * to the bisection's 1e-13.
 */
export function anytimeLowerBound(
  right: number,
  wrong: number,
  alpha: number,
  grid: readonly number[] = PROMOTION_GRID,
): number {
  checkCount(right, "right");
  checkCount(wrong, "wrong");
  checkOpen(alpha, "alpha");
  checkFractions(grid);
  if (right === 0) return 0;
  const bar = Math.log(1 / alpha);
  const onWrong = grid.map((c) => Math.log(c));
  const logWeight = -Math.log(grid.length);
  const rejects = (x: number): boolean =>
    logMixture(
      { onRight: grid.map((c) => Math.log1p(((1 - c) * (1 - x)) / x)), onWrong, logWeight },
      right,
      wrong,
    ) >= bar;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (rejects(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Log of the futility e-value: the reverse test, for the null that the gate's accuracy is at
 * least `worthKeeping` (q_f, the lowest accuracy whose loss one would regret; the research's
 * default is p0 + (1 − p0)/2, 0.99 at a 98% promise). Each grid entry g is an alternative accuracy
 * r = 1 − g(1 − q_f) below q_f, weighted equally:
 *
 *   logsumexp_j( ln w_j + right ln(r_j/q_f) + wrong ln((1 − r_j)/(1 − q_f)) )
 *
 * A factor's mean at true accuracy p is 1 + (p − q_f)(r − q_f)/(q_f (1 − q_f)), at most 1 for every
 * p ≥ q_f because r < q_f. So, by Ville's inequality, retiring when it reaches 1/beta retires a
 * gate whose every act is right with probability at least q_f, given those before it, at most
 * beta of the time. Retiring only ends a test without promoting, so it can lower the chance of a
 * false promotion and never raise it. Count the labelled prefix only: counting an unlabelled act
 * as wrong raises this e-value, which voids its guarantee.
 *
 * Entries must exceed 1, with g(1 − q_f) below 1: at 1 the alternative is q_f itself, and at
 * g(1 − q_f) ≥ 1 no accuracy is left to bet on.
 */
export function futilityLogEValue(
  right: number,
  wrong: number,
  worthKeeping: number,
  grid: readonly number[] = FUTILITY_GRID,
): number {
  checkCount(right, "right");
  checkCount(wrong, "wrong");
  checkOpen(worthKeeping, "worthKeeping");
  return logMixture(futilityBets(worthKeeping, grid), right, wrong);
}

/**
 * True once the futility e-value reaches 1/beta. At q_f = 0.99, beta 0.1 and the default grid
 * that is 2 wrong acts before any right one, 3 after 50 right acts, 5 after 100 and 11 after 400.
 */
export function futile(
  right: number,
  wrong: number,
  worthKeeping: number,
  beta: number,
  grid: readonly number[] = FUTILITY_GRID,
): boolean {
  checkOpen(beta, "beta");
  return futilityLogEValue(right, wrong, worthKeeping, grid) >= Math.log(1 / beta);
}

/** The reverse test a promotion run may also carry. */
export interface FutilityTest {
  /** q_f: the lowest accuracy whose loss one would regret. */
  readonly worthKeeping: number;
  /** Retire at a futility e-value of 1/beta. */
  readonly beta: number;
  /** Default `FUTILITY_GRID`. */
  readonly grid?: readonly number[];
}

export interface CrossingOptions {
  /** Promotion alternatives. Default `PROMOTION_GRID`. */
  readonly grid?: readonly number[];
  /** The reverse test; none by default. */
  readonly futility?: FutilityTest;
}

/** How a promotion run ends, exactly. The three probabilities sum to 1. */
export interface ExactCrossing {
  /** P(promoted within the cap). At p ≤ promise this is the false-promotion rate. */
  readonly promote: number;
  /** P(retired by the futility test before promoting); 0 without one. */
  readonly futile: number;
  /** P(neither: the cap was reached, or a promotion within it had become impossible). */
  readonly capped: number;
  /** Expected acts read before the run ended, whichever way. */
  readonly meanActs: number;
}

/**
 * The exact operating characteristic of the promotion test, by dynamic programming over
 * (right, wrong) with no Monte Carlo noise: each act is right with probability p, independently,
 * and the run reads at most `cap` acts. After each act, in this order, it promotes once the
 * e-value reaches 1/alpha; retires once the futility e-value, when a futility test is given,
 * reaches 1/beta; and otherwise stops when it can no longer promote within the cap even if every
 * remaining act is right (curtailment: a right act raises the e-value and a wrong one lowers it,
 * so all-right is the best case), or at the cap. A cap too short for even a clean run to promote
 * ends the run before its first act. Curtailment changes no decision, only when it is known; the
 * futility test can only remove promotions.
 *
 * Every rule depends on (right, wrong) alone, so each is a threshold on the counts: the fewest
 * right acts that promote alongside f wrong ones, and the most alongside which f wrong ones
 * retire. The programme carries the probability of each unstopped (right, wrong) pair, at a cost
 * of at most cap × (the most wrong acts that can still promote) steps.
 */
export function exactCrossingProbability(
  p: number,
  promise: number,
  alpha: number,
  cap: number,
  options: CrossingOptions = {},
): ExactCrossing {
  checkUnit(p, "p");
  checkOpen(promise, "promise");
  checkOpen(alpha, "alpha");
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("cap must be a positive integer");
  const bets = promotionBets(promise, options.grid ?? PROMOTION_GRID);
  const bar = Math.log(1 / alpha);
  const futility = options.futility;
  let reverse: { readonly bets: Bets; readonly bar: number } | undefined;
  if (futility !== undefined) {
    checkOpen(futility.worthKeeping, "worthKeeping");
    checkOpen(futility.beta, "beta");
    reverse = {
      bets: futilityBets(futility.worthKeeping, futility.grid ?? FUTILITY_GRID),
      bar: Math.log(1 / futility.beta),
    };
  }
  // cross[f]: the fewest right acts that promote alongside f wrong ones, for each f that can
  // still promote within the cap. More wrong acts need at least as many right ones.
  const cross: number[] = [];
  for (let f = 0, s = 0; ; f++) {
    while (s + f <= cap && logMixture(bets, s, f) < bar) s++;
    if (s + f > cap) break;
    cross.push(s);
  }
  const reach = cross.length;
  if (reach === 0) return { promote: 0, futile: 0, capped: 1, meanActs: 0 };
  // retire[f]: the most right acts alongside which f wrong ones retire, -1 when none do. A run
  // that reaches `reach` wrong acts stops there, so no larger f is needed.
  const retire: number[] = [];
  if (reverse !== undefined) {
    for (let f = 0, s = -1; f <= reach; f++) {
      while (s + 1 + f <= cap && logMixture(reverse.bets, s + 1, f) >= reverse.bar) s++;
      retire.push(s);
    }
  }
  const mass = new Float64Array(reach + 1);
  mass[0] = 1;
  const q = 1 - p;
  let promote = 0;
  let retired = 0;
  let capped = 0;
  let meanActs = 0;
  for (let t = 1; t <= cap; t++) {
    const top = Math.min(t, reach);
    for (let f = top; f >= 1; f--) {
      mass[f] = (mass[f] as number) * p + (mass[f - 1] as number) * q;
    }
    mass[0] = (mass[0] as number) * p;
    for (let f = 0; f <= top; f++) {
      const m = mass[f] as number;
      if (m === 0) continue;
      const s = t - f;
      const needed = f < reach ? (cross[f] as number) : Number.POSITIVE_INFINITY;
      if (s >= needed) promote += m;
      else if (reverse !== undefined && s <= (retire[f] as number)) retired += m;
      else if (s + (cap - t) < needed || t === cap) capped += m;
      else continue;
      meanActs += m * t;
      mass[f] = 0;
    }
  }
  return { promote, futile: retired, capped, meanActs };
}

// ---------------------------------------------------------------------------
// Demotion as change detection
// ---------------------------------------------------------------------------

/** The default post-change shifts: the promised error rate doubled, quadrupled and octupled. */
export const DEMOTION_SHIFTS: readonly number[] = Object.freeze([2, 4, 8]);

/**
 * Shiryaev-Roberts sums the e-processes started at every audit; CUSUM takes their maximum, so it
 * is never above Shiryaev-Roberts on the same audits and alarms no sooner.
 */
export type DetectorRule = "shiryaev-roberts" | "cusum";

export interface DetectorSpec {
  /** Accuracy promised on acts; e0 = 1 − promise is the error rate the gate may have. */
  readonly promise: number;
  /** The alarm threshold A, above 1: the mean run length to a false alarm is at least A. */
  readonly threshold: number;
  /**
   * Post-change error rates as multiples of e0. Omitted: `DEMOTION_SHIFTS`, each post-change
   * rate capped at (1 + e0)/2 so that low promises keep it below 1. Given: used as they are, and
   * each must put the post-change rate strictly between e0 and 1.
   */
  readonly shifts?: readonly number[];
  /** Default "shiryaev-roberts". */
  readonly rule?: DetectorRule;
}

/**
 * A detector's state: plain data that survives a JSON round trip. `statistics` holds one
 * statistic per post-change rate; `audits` counts the audited acts read. Once `alarmed`, stepping
 * leaves the state as it is, so `audits` is the audit that raised the alarm.
 */
export interface DetectorState {
  readonly statistics: readonly number[];
  readonly audits: number;
  readonly alarmed: boolean;
}

/**
 * The post-change error rates a detector bets on: e1_k = s_k e0. The default shifts are capped at
 * (1 + e0)/2, so at a 98% promise they are 0.04, 0.08 and 0.16, and at 80% they are 0.4, 0.6 and
 * 0.6. Shifts passed explicitly are not capped; one that puts e1 at or above 1, or at or below e0,
 * is refused: at or below e0 the bet is not on a change at all, and at 1 or above it is no rate.
 */
export function demotionAlternatives(promise: number, shifts?: readonly number[]): number[] {
  checkOpen(promise, "promise");
  const e0 = 1 - promise;
  if (shifts === undefined) return DEMOTION_SHIFTS.map((s) => Math.min(s * e0, (1 + e0) / 2));
  checkGrid(shifts, "shifts");
  return shifts.map((s) => {
    const e1 = s * e0;
    if (!(e1 > e0 && e1 < 1)) {
      throw new Error(
        `a shift must put the post-change error rate strictly between ${e0} and 1; ${String(s)} gives ${String(e1)}`,
      );
    }
    return e1;
  });
}

interface Detector {
  readonly onWrong: readonly number[];
  readonly onRight: readonly number[];
  readonly threshold: number;
  readonly cusum: boolean;
}

function resolveDetector(spec: DetectorSpec): Detector {
  const e1 = demotionAlternatives(spec.promise, spec.shifts);
  if (!(Number.isFinite(spec.threshold) && spec.threshold > 1)) {
    throw new Error("threshold must be a finite number above 1");
  }
  const rule = spec.rule ?? "shiryaev-roberts";
  if (rule !== "shiryaev-roberts" && rule !== "cusum") {
    throw new Error(`rule must be "shiryaev-roberts" or "cusum"; got ${String(rule)}`);
  }
  const e0 = 1 - spec.promise;
  return {
    onWrong: e1.map((e) => e / e0),
    onRight: e1.map((e) => (1 - e) / (1 - e0)),
    threshold: spec.threshold,
    cusum: rule === "cusum",
  };
}

/** A detector before its first audit: every statistic at 0, no alarm. */
export function startDetector(spec: DetectorSpec): DetectorState {
  const d = resolveDetector(spec);
  return { statistics: d.onWrong.map(() => 0), audits: 0, alarmed: false };
}

/**
 * Read one audited act, in ledger order, labelled (`wrong`: the act was wrong). For post-change
 * rate e1_k the likelihood ratio is L_k = e1_k/e0 on an error and (1 − e1_k)/(1 − e0) otherwise;
 * Shiryaev-Roberts updates m_k ← L_k (m_k + 1) and CUSUM m_k ← L_k max(m_k, 1). The detector
 * alarms once the mean of the m_k reaches the threshold. Pure: the state passed in is not changed.
 *
 * The guarantee (e-detectors): if every audited act, given the audits before it, is wrong with
 * probability at most e0, then E[L_k] ≤ 1, so m_k − n is a supermartingale for Shiryaev-Roberts
 * and for CUSUM. A fixed mixture of e-detectors is an e-detector, so the mean statistic is one,
 * while the maximum over the shifts is not. Hence the average run length to a false alarm is at
 * least A audits, and P(false alarm within n audits) ≤ n/A (`falseAlarmBound`). Nothing assumes
 * the audits are identically distributed: a gate drifting anywhere within its promise is covered.
 *
 * Feed it only labelled audits. Counting a missing label as an error inflates false alarms and
 * voids the guarantee. The statistics need no log scale: before an alarm each is below K × A, and
 * after any audit each is at least its smallest factor, so they neither overflow nor underflow.
 */
export function stepDetector(
  spec: DetectorSpec,
  state: DetectorState,
  wrong: boolean,
): DetectorState {
  const d = resolveDetector(spec);
  checkState(state, d.onWrong.length);
  if (typeof wrong !== "boolean") throw new Error("wrong must be a boolean");
  if (state.alarmed) return state;
  const factors = wrong ? d.onWrong : d.onRight;
  let total = 0;
  const statistics = state.statistics.map((m, k) => {
    const next = (factors[k] as number) * (d.cusum ? Math.max(m, 1) : m + 1);
    total += next;
    return next;
  });
  return {
    statistics,
    audits: state.audits + 1,
    alarmed: total / statistics.length >= d.threshold,
  };
}

/** The detector's statistic: the mean of its per-shift statistics, compared with the threshold. */
export function detectorStatistic(state: DetectorState): number {
  checkState(state, Array.isArray(state?.statistics) ? state.statistics.length : 0);
  return state.statistics.reduce((a, b) => a + b, 0) / state.statistics.length;
}

/**
 * The stated false-alarm bound: for a gate whose audited acts keep the promise, the chance that a
 * detector with threshold A alarms within n audits is at most n/A. Ville's inequality applied to
 * the supermartingale m_k + (n − k), k ≤ n, which starts at n and is never below m_k. It holds for
 * Shiryaev-Roberts, for CUSUM (never above it) and for their mixtures, and says nothing once n
 * reaches A; the average run length of at least A is the guarantee for longer horizons.
 */
export function falseAlarmBound(audits: number, threshold: number): number {
  checkCount(audits, "audits");
  if (!(Number.isFinite(threshold) && threshold > 1)) {
    throw new Error("threshold must be a finite number above 1");
  }
  return Math.min(1, audits / threshold);
}

/**
 * The fewest consecutive audited errors that raise an alarm from a fresh start, which is also
 * the fewest audits of any kind that can: every statistic rises with each audit's factor, and an
 * error's factor is the larger. At a 98% promise with the default shifts it is 4 for
 * Shiryaev-Roberts at A = 300 or 1000 and 3 at A = 100, against 30 audits before the window rule
 * can demote at all.
 */
export function fewestAlarmErrors(spec: DetectorSpec): number {
  let state = startDetector(spec);
  while (!state.alarmed) {
    if (state.audits >= 1_000_000) {
      throw new Error("no alarm within a million consecutive errors; the shifts are too small");
    }
    state = stepDetector(spec, state, true);
  }
  return state.audits;
}

function checkState(state: DetectorState, size: number): void {
  if (
    typeof state !== "object" ||
    state === null ||
    !Array.isArray(state.statistics) ||
    state.statistics.length !== size ||
    size === 0 ||
    !state.statistics.every((m) => typeof m === "number" && Number.isFinite(m) && m >= 0) ||
    !Number.isSafeInteger(state.audits) ||
    state.audits < 0 ||
    typeof state.alarmed !== "boolean"
  ) {
    throw new Error(
      `a detector state needs ${size} finite non-negative statistics, a count of audits and an alarm flag`,
    );
  }
}

// ---------------------------------------------------------------------------
// Continuous sampling (Dodge's CSP-1)
// ---------------------------------------------------------------------------

/**
 * Outgoing quality of the rollout loop read as Dodge's continuous sampling plan CSP-1: shadow
 * until `clearance` (i) consecutive right acts, then enforce with a fraction `auditRate` (f) of
 * acts audited, and back to shadow at the first audited error. At a stationary error rate p,
 * with q = 1 − p:
 *
 *   p (1 − f) q^i / (f + (1 − f) q^i)
 *
 * What it bounds: wrong acts executed per act-eligible decision (every decision the policy would
 * act on, counting those people make in shadow and on audit). It is not the precision of the
 * automated acts: at a stationary rate each executed act is still wrong with probability p, and
 * the plan only limits how many execute.
 *
 * Assumptions: the audit label is correct and known before the next act, so the return to shadow
 * is immediate; the audit draw is unpredictable, independent of the act's correctness and of
 * everything before it; every shadow decision is made and labelled by a person, which is what
 * counts the clearance; and the gate returns to shadow at the first audited error. The formula
 * and its limit also assume independent acts at one error rate; `worstOutgoingQuality` drops that.
 */
export function outgoingQuality(errorRate: number, clearance: number, auditRate: number): number {
  checkUnit(errorRate, "errorRate");
  checkPlan(clearance, auditRate);
  const clean = Math.exp(clearance * Math.log1p(-errorRate));
  return (errorRate * (1 - auditRate) * clean) / (auditRate + (1 - auditRate) * clean);
}

/** The worst stationary outgoing quality, and the error rate that attains it. */
export interface QualityLimit {
  readonly limit: number;
  readonly at: number;
}

/**
 * The outgoing quality limit: the largest `outgoingQuality` over stationary error rates, and
 * where it is attained (0.479% at an error rate near 1.14% for clearance 149 and f = 0.2). The
 * maximiser is unique: with D(p) = f(1 − p)^(−i) + 1 − f the quality is (1 − f) p/D(p), and
 * p D'(p)/D(p) = (i p/(1 − p)) / (1 + (1 − f)(1 − p)^i/f) rises from 0 without bound, so the
 * log-derivative 1/p − D'/D crosses zero exactly once. Bisection finds the crossing.
 */
export function outgoingQualityLimit(clearance: number, auditRate: number): QualityLimit {
  checkPlan(clearance, auditRate);
  const f = auditRate;
  const excess = (p: number): number =>
    (clearance * p) / (1 - p) - 1 - ((1 - f) * Math.exp(clearance * Math.log1p(-p))) / f;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (excess(mid) < 0) lo = mid;
    else hi = mid;
  }
  const at = (lo + hi) / 2;
  return { limit: outgoingQuality(at, clearance, auditRate), at };
}

/**
 * The worst outgoing quality against any error process that cannot see the audit draw,
 * stationary or not: (1/f − 1)/(i + 1/f), 2.60% for clearance 149 and f = 0.2. Each enforce
 * phase follows at least i shadow decisions, and the wrong acts it executes before its first
 * audited error number (1 − f)/f on average at most, given everything before the phase, since
 * each wrong act is audited with chance f. A phase that executes W wrong acts spans, with its
 * shadow, at least i + W + 1 decisions; summed over phases, the long-run share is at most
 * E[W]/(i + 1 + E[W]) with E[W] ≤ (1 − f)/f, which is the bound. A process right throughout shadow
 * and wrong throughout enforce attains it.
 */
export function worstOutgoingQuality(clearance: number, auditRate: number): number {
  checkPlan(clearance, auditRate);
  return (1 - auditRate) / (auditRate * clearance + 1);
}

function checkPlan(clearance: number, auditRate: number): void {
  if (!Number.isSafeInteger(clearance) || clearance < 1) {
    throw new Error("clearance must be a positive integer");
  }
  if (!(auditRate > 0 && auditRate <= 1)) {
    throw new Error("auditRate must be above 0 and at most 1");
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkCount(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
}

function checkOpen(x: number, name: string): void {
  if (!(typeof x === "number" && x > 0 && x < 1)) {
    throw new Error(`${name} must be strictly between 0 and 1`);
  }
}

function checkUnit(x: number, name: string): void {
  if (!(typeof x === "number" && x >= 0 && x <= 1)) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}
