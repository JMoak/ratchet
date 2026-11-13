/**
 * Verifier frailty: why a verify-then-commit chain finishes less often than independent retries
 * predict, and by how much.
 *
 * A verifier that dislikes a step instance tends to dislike every fresh correct answer to it.
 * N-version software calls this coincident failure and models it with the Eckhardt-Lee
 * intensity; `runChain` is a recovery block whose alternates are resamples of one proposer and
 * whose acceptance test is fixed, the worst case for it. The model here is a beta frailty:
 *
 * - each step instance carries theta, the chance this verifier holds back a correct candidate for
 *   it, with theta ~ Beta(a, b) across instances;
 * - given theta, holds of distinct correct candidates are independent;
 * - a wrong candidate is held with probability t (the catch rate), whatever theta is;
 * - the proposer is right with probability p on every attempt, independently.
 *
 * Then E[theta^k] = prod_{j<k} (a + j) / (a + b + j), the mean false-alarm rate is
 * mu = a / (a + b), the intraclass correlation of holds within an instance is
 * rho = 1 / (a + b + 1), and a held correct candidate's successor is held with probability
 * mu + rho (1 - mu). Fitted to the live verifier track's two rates (15.0% of first correct
 * candidates held, 55.9% of the next held after a hold) it predicts the completion that track
 * measured (49.2 / 56.8 / 61.2 / 61.5% against 48 / 53 / 62 / 58% observed) where independent
 * retries predicted 76.6% to 97.3%.
 *
 * Every prediction is a finite sum of moments, so nothing here needs a gamma function. Internally a
 * frailty is (mu, rho), which stays finite on the closed square: rho = 0 is no frailty (theta is
 * mu on every instance) and rho = 1 is the Bernoulli limit (each instance is always or never
 * held). These functions describe a verifier; they never decide anything.
 */
import { actWasRight, inferGoIsYes, recordedGoIsYes } from "../ledger/calibration.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import { admits, type TrustFilter } from "../ledger/sources.ts";
import { readAction } from "../policy.ts";
import { moreCautious } from "../types.ts";
import { readChainTags } from "./chain.ts";

/** A beta frailty on a verifier's false-alarm propensity per step instance. */
export interface Frailty {
  /** mu = E[theta]: the mean chance a correct candidate is held back. */
  readonly mean: number;
  /**
   * rho = 1 / (a + b + 1): the intraclass correlation of holds on correct candidates of one step
   * instance. 0 is independent retries; 1 means an instance's every correct candidate is held or
   * none is.
   */
  readonly rho: number;
  /** Beta shape a = mu (1/rho - 1). Infinity when rho is 0 (a point mass), 0 when rho is 1. */
  readonly a: number;
  /** Beta shape b = (1 - mu)(1/rho - 1). Infinity when rho is 0, 0 when rho is 1. */
  readonly b: number;
}

/** The two rates a ledger gives without a fit, as `holdRates` reads them. */
export interface HoldRates {
  /** mu: first correct candidates held, over first correct candidates. */
  readonly first: number;
  /** psi: next correct candidates held, over next correct candidates after a held one. */
  readonly again: number;
}

const isProbability = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

function probability(name: string, x: unknown): number {
  if (!isProbability(x)) {
    throw new RangeError(`${name} must be a probability in [0, 1], not ${String(x)}`);
  }
  return x;
}

function integer(name: string, x: unknown, min: number): number {
  if (!(typeof x === "number" && Number.isInteger(x) && x >= min)) {
    throw new RangeError(`${name} must be an integer of at least ${min}, not ${String(x)}`);
  }
  return x;
}

/** A frailty from (mu, rho). A point mass at 0 or 1 has no spread to correlate, so rho is 0. */
function frailtyOf(mean: number, rho: number): Frailty {
  const r = mean === 0 || mean === 1 ? 0 : rho;
  if (r === 0) {
    return { mean, rho: 0, a: Number.POSITIVE_INFINITY, b: Number.POSITIVE_INFINITY };
  }
  const s = 1 / r - 1;
  return { mean, rho: r, a: mean * s, b: (1 - mean) * s };
}

/** Beta(a, b) on theta, for shapes already known. Both must be finite and positive. */
export function betaFrailty(a: number, b: number): Frailty {
  for (const [name, x] of [
    ["a", a],
    ["b", b],
  ] as const) {
    if (!(typeof x === "number" && Number.isFinite(x) && x > 0)) {
      throw new RangeError(`beta shape ${name} must be a finite number above 0, not ${String(x)}`);
    }
  }
  return { mean: a / (a + b), rho: 1 / (a + b + 1), a, b };
}

/** No frailty: every step instance is held back at the same rate f, retries independent. */
export function independentFrailty(f: number): Frailty {
  return frailtyOf(probability("f", f), 0);
}

/**
 * The moment estimator from two rates: mu = `first` and psi = `again` give
 * rho = (psi - mu) / (1 - mu), a = mu (1/rho - 1), b = (1 - mu)(1/rho - 1), because under the beta
 * E[theta^2] / E[theta] = (a + 1) / (a + b + 1) = mu + rho (1 - mu). The live track's 15.0% and
 * 55.9% give rho 0.481, a 0.162, b 0.917.
 *
 * When psi <= mu the rates show no frailty (a beta cannot correlate holds negatively), and the
 * result is `independentFrailty(mu)`: retries are read as independent at rate mu. When mu is 0 or
 * 1 nothing varies across instances and the result is the point mass there. Prefer `fitFrailty`
 * when per-instance counts exist: it uses every candidate, not just the first two.
 */
export function frailtyFromRates(first: number, again: number): Frailty {
  const mu = probability("first", first);
  const psi = probability("again", again);
  if (mu === 0 || mu === 1) return frailtyOf(mu, 0);
  return frailtyOf(mu, Math.max(0, (psi - mu) / (1 - mu)));
}

/**
 * P(the next distinct correct candidate is held | the `held` before it on the same instance were
 * all held): E[theta^(k+1)] / E[theta^k]. At 0 it is mu, at 1 it is psi, and at 2 it is the
 * third-moment check, (a + 2) / (a + b + 2), worth printing beside a two-rate fit (the live track
 * observed 74% to 84% against the fit's 70.2%, a tail near theta = 1 at least as heavy as the
 * beta's).
 */
export function heldNext(frailty: Frailty, held: number): number {
  const law = betaLaw(frailty);
  const k = integer("held", held, 0);
  const lo = law.logMoment(k);
  return lo === Number.NEGATIVE_INFINITY ? Number.NaN : Math.exp(law.logMoment(k + 1) - lo);
}

/** E[theta^k] under the frailty. */
export function frailtyMoment(frailty: Frailty, k: number): number {
  return Math.exp(betaLaw(frailty).logMoment(integer("k", k, 0)));
}

// ---------------------------------------------------------------------------------------------
// Laws on theta. The beta and the two-point extremes share one interface: log moments and the
// mass at theta = 1, which is all exhaustion and its limit read.
// ---------------------------------------------------------------------------------------------

interface Law {
  /** log E[theta^k]; -Infinity when the moment is 0. */
  readonly logMoment: (k: number) => number;
  /** P(theta = 1): instances whose correct candidates are never passed. */
  readonly atOne: number;
}

function betaLaw(f: Frailty): Law {
  const mean = probability("frailty.mean", f.mean);
  const rho = probability("frailty.rho", f.rho);
  const logs: number[] = [0];
  return {
    logMoment: (k) => {
      // E[theta^j] = E[theta^(j-1)] (a + j - 1) / (a + b + j - 1), written in (mu, rho) so that
      // rho = 0 and rho = 1 stay finite: multiply through by rho.
      for (let j = logs.length; j <= k; j++) {
        const factor =
          j === 1 ? mean : (mean * (1 - rho) + (j - 1) * rho) / (1 - rho + (j - 1) * rho);
        logs.push((logs[j - 1] as number) + Math.log(factor));
      }
      return logs[k] as number;
    },
    atOne: mean === 1 ? 1 : rho === 1 ? mean : 0,
  };
}

/** One support point of a discrete law on theta. */
export interface LawPoint {
  readonly value: number;
  readonly weight: number;
}

function pointsLaw(points: readonly LawPoint[]): Law {
  return {
    logMoment: (k) =>
      k === 0 ? 0 : Math.log(points.reduce((s, p) => s + p.weight * p.value ** k, 0)),
    atOne: points.reduce((s, p) => s + (p.value === 1 ? p.weight : 0), 0),
  };
}

/** n log x with 0 log 0 = 0, so empty products are 1 and p or (1 - p) t of 0 stays exact. */
const xlogy = (n: number, x: number): number => (n === 0 ? 0 : n * Math.log(x));

function logSumExp(xs: readonly number[]): number {
  const m = Math.max(...xs);
  if (m === Number.NEGATIVE_INFINITY) return m;
  return m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0));
}

/**
 * P(a step makes no commit in m attempts) = E[h(theta)^m] with h = p theta + (1 - p) t, expanded
 * as sum_k C(m, k) p^k ((1 - p) t)^(m - k) E[theta^min(k, d)]: a correct candidate after the d-th
 * distinct one is a repeat, held exactly when its first copy was. Terms are summed in log space,
 * so a budget of hundreds of attempts neither overflows the binomial nor loses the tail.
 */
function exhaustion(law: Law, p: number, t: number, m: number, d: number): number {
  const q = (1 - p) * t;
  let logC = 0;
  let s = 0;
  for (let k = 0; k <= m; k++) {
    if (k > 0) logC += Math.log((m - k + 1) / k);
    const lw = logC + xlogy(k, p) + xlogy(m - k, q) + law.logMoment(Math.min(k, d));
    if (lw > Number.NEGATIVE_INFINITY) s += Math.exp(lw);
  }
  return Math.min(1, s);
}

/**
 * The limit of exhaustion as attempts grow. With t < 1 (and wrong candidates possible) some wrong
 * candidate eventually passes, so every step commits and the limit is 0: completion then says
 * nothing about precision. With t = 1 correct candidates keep coming and wrong ones never pass,
 * so a step exhausts only if every distinct correct candidate is held: E[theta^d] with d distinct
 * candidates, P(theta = 1) with fresh ones.
 */
function exhaustionLimit(law: Law, p: number, t: number, d: number): number {
  if (p === 0) return t === 1 ? 1 : 0;
  if (t < 1 && p < 1) return 0;
  return Number.isFinite(d) ? Math.exp(law.logMoment(d)) : law.atOne;
}

/** What a chain is asked to do, as the predictions read it. */
export interface ChainModel {
  /** The proposer's chance of a correct candidate on any attempt. */
  readonly p: number;
  /** The verifier's catch rate: the chance it holds back a wrong candidate. */
  readonly t: number;
  /** Attempts per step (m). A finite integer of at least 1. */
  readonly attempts: number;
  /** Steps in the chain (n). An integer of at least 1. */
  readonly steps: number;
  /**
   * At most this many distinct correct candidates per step (default Infinity: every attempt is
   * fresh). A repeat cannot commit, whether a cache replays its first copy's held verdict (the
   * live six-attempt arm, which had three correct styles and so tested three) or `runChain`
   * skips it as a duplicate (`keyOf`). Wrong candidates are taken to be distinct.
   */
  readonly distinctCorrect?: number;
}

interface CheckedModel {
  readonly p: number;
  readonly t: number;
  readonly m: number;
  readonly n: number;
  readonly d: number;
}

function checkModel(model: ChainModel): CheckedModel {
  const d = model.distinctCorrect ?? Number.POSITIVE_INFINITY;
  return {
    p: probability("p", model.p),
    t: probability("t", model.t),
    m: integer("attempts", model.attempts, 1),
    n: integer("steps", model.steps, 1),
    d: d === Number.POSITIVE_INFINITY ? d : integer("distinctCorrect", d, 1),
  };
}

/** One step's outcome probabilities within its attempts. */
export interface StepPrediction {
  /** P(the step commits). */
  readonly commits: number;
  /** P(it commits a correct candidate). */
  readonly commitsCorrect: number;
  /** P(it commits a wrong candidate). */
  readonly commitsWrong: number;
  /** P(it exhausts its attempts): 1 - commits. */
  readonly exhausts: number;
  /** The precision of its commit, commitsCorrect / commits; NaN when no commit is possible. */
  readonly precision: number;
}

export interface ChainPrediction {
  readonly step: StepPrediction;
  /** P(every step commits): the chain finishes. */
  readonly completion: number;
  /** P(the chain finishes with every commit right); also chain success when a wrong commit poisons later steps. */
  readonly allRight: number;
  /** The precision of a commit (each step's). */
  readonly precision: number;
}

function predictStepUnder(law: Law, c: CheckedModel): StepPrediction {
  const exhausts = exhaustion(law, c.p, c.t, c.m, c.d);
  const commits = 1 - exhausts;
  // A wrong commit at attempt j + 1 needs no commit in the first j, then a wrong candidate that
  // passes; that last factor does not depend on theta, so it comes out of the expectation.
  let unresolved = 0;
  for (let j = 0; j < c.m; j++) unresolved += exhaustion(law, c.p, c.t, j, c.d);
  const commitsWrong = Math.min(commits, (1 - c.p) * (1 - c.t) * unresolved);
  const commitsCorrect = Math.max(0, commits - commitsWrong);
  return {
    commits,
    commitsCorrect,
    commitsWrong,
    exhausts,
    precision: commits > 0 ? commitsCorrect / commits : Number.NaN,
  };
}

function predictUnder(law: Law, c: CheckedModel): ChainPrediction {
  const step = predictStepUnder(law, c);
  return {
    step,
    completion: step.commits ** c.n,
    allRight: step.commitsCorrect ** c.n,
    precision: step.precision,
  };
}

/**
 * Prediction under the frailty: a step commits within m fresh attempts with probability
 * 1 - sum_k C(m, k) p^k ((1 - p) t)^(m - k) E[theta^k], the chain finishes with that to the n-th
 * power (steps are independent tasks), and the precision of a commit is the share of commits that
 * are correct. Under the live fit at p = 0.8 and t = 1, step exhaustion falls as a power law,
 * about Gamma(a + b) / Gamma(a) (p m)^-b (0.021, 0.011, 0.0059 at 12, 24, 48 attempts), not
 * geometrically: doubling the budget roughly halves exhaustion where independence would square
 * it, and with b <= 1 the expected number of attempts to commit is infinite. So the attempt budget
 * must stay finite, and a pool (`attemptPool`) spends it better than per-step caps.
 */
export function predictChain(frailty: Frailty, model: ChainModel): ChainPrediction {
  return predictUnder(betaLaw(frailty), checkModel(model));
}

export interface CompletionInterval {
  /** Completion under the two-point law with an atom at 0: {0, psi}, the most optimistic law. */
  readonly optimistic: number;
  /** Completion under the two-point law with an atom at 1: {y, 1}, the most pessimistic law. */
  readonly pessimistic: number;
  /** Both ends as attempts grow without bound (see `exhaustionLimit` in the source). */
  readonly limit: { readonly optimistic: number; readonly pessimistic: number };
  /** The two extreme laws, for printing beside the numbers. */
  readonly laws: {
    readonly optimistic: readonly LawPoint[];
    readonly pessimistic: readonly LawPoint[];
  };
}

/**
 * The completion interval the two rates alone support, always meant to be printed beside the beta
 * prediction. Every law on [0, 1] with E[theta] = mu and E[theta^2] = mu psi gives completion
 * between these two ends, because exhaustion is a positive combination of the moments and, over
 * laws with two fixed moments, every higher moment is smallest under the lower principal
 * representation (an atom at 0: {0 w.p. 1 - mu/psi, psi w.p. mu/psi}) and largest under the upper
 * (an atom at 1: {y w.p. 1 - w, 1 w.p. w}, w = Var / ((1 - mu)^2 + Var), y = (mu - w) / (1 - w),
 * Var = mu psi - mu^2): the Markov-Krein extremes of a Tchebycheff system.
 *
 * The optimistic end is the two-point law the simulation used before this module: the most
 * optimistic reading of the rates, not a prediction. At the live rates (p 0.8, t 1, eight steps)
 * three attempts give [45.0%, 52.0%] around the beta's 49.2%; as attempts grow the optimistic end
 * tends to 1 and the pessimistic end to (1 - w)^n = 52.1%, so no number of retries certifies
 * completion above about 52% from these two rates. Only deeper moments (probe steps that judge
 * several candidates whatever the rulings) can. At one or two attempts the interval is a point.
 * When psi <= mu both ends are independence at mu.
 */
export function completionInterval(rates: HoldRates, model: ChainModel): CompletionInterval {
  const mu = probability("first", rates.first);
  const psi = probability("again", rates.again);
  const c = checkModel(model);
  const variance = Math.max(0, mu * psi - mu * mu);
  const point: readonly LawPoint[] = [{ value: mu, weight: 1 }];
  const optimisticPoints: readonly LawPoint[] =
    variance === 0
      ? point
      : [
          { value: 0, weight: 1 - mu / psi },
          { value: psi, weight: mu / psi },
        ];
  const w = variance / ((1 - mu) ** 2 + variance);
  const pessimisticPoints: readonly LawPoint[] =
    variance === 0
      ? point
      : [
          { value: (mu - w) / (1 - w), weight: 1 - w },
          { value: 1, weight: w },
        ];
  const lo = pointsLaw(optimisticPoints);
  const hi = pointsLaw(pessimisticPoints);
  const complete = (exhausts: number) => (1 - exhausts) ** c.n;
  return {
    optimistic: complete(exhaustion(lo, c.p, c.t, c.m, c.d)),
    pessimistic: complete(exhaustion(hi, c.p, c.t, c.m, c.d)),
    limit: {
      optimistic: complete(exhaustionLimit(lo, c.p, c.t, c.d)),
      pessimistic: complete(exhaustionLimit(hi, c.p, c.t, c.d)),
    },
    laws: { optimistic: optimisticPoints, pessimistic: pessimisticPoints },
  };
}

/** What `holds` holds on one step say about its next attempt. */
export interface AfterHolds {
  readonly holds: number;
  /** E[theta | holds]: the step instance's false-alarm rate as the holds left it. */
  readonly falseAlarm: number;
  /** pi_k: the chance the next attempt commits. */
  readonly commit: number;
  /** q_k: the chance that commit is correct. NaN when no commit is possible. */
  readonly precision: number;
}

/**
 * The step after k holds, read from rulings alone (at run time a held candidate's truth is
 * unknown): the posterior on theta is the prior times h(theta)^k, so with
 * M(k, j) = E[theta^j h(theta)^k] = sum_i C(k, i) p^i ((1 - p) t)^(k - i) E[theta^(i + j)],
 * E[theta | k] = M(k, 1) / M(k, 0), the next attempt commits with
 * pi_k = p (1 - E[theta | k]) + (1 - p)(1 - t) and that commit is right with
 * q_k = p (1 - E[theta | k]) / pi_k. Both fall with k: h is increasing in theta, so the posteriors
 * are ordered by likelihood ratio (each hold is evidence the instance is one the verifier
 * dislikes). With t < 1 late commits are less precise: survivorship, seen from the hold side.
 * p and t must come from labelled first attempts, not from retries. NaN fields when k holds
 * cannot happen under the model.
 */
export function afterHolds(
  frailty: Frailty,
  verifier: { readonly p: number; readonly t: number },
  holds: number,
): AfterHolds {
  const p = probability("p", verifier.p);
  const t = probability("t", verifier.t);
  const k = integer("holds", holds, 0);
  return afterHoldsUnder(betaLaw(frailty), p, t, k);
}

function afterHoldsUnder(law: Law, p: number, t: number, k: number): AfterHolds {
  const q = (1 - p) * t;
  const m0: number[] = [];
  const m1: number[] = [];
  let logC = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((k - i + 1) / i);
    const lw = logC + xlogy(i, p) + xlogy(k - i, q);
    m0.push(lw + law.logMoment(i));
    m1.push(lw + law.logMoment(i + 1));
  }
  const z = logSumExp(m0);
  if (z === Number.NEGATIVE_INFINITY) {
    return { holds: k, falseAlarm: Number.NaN, commit: Number.NaN, precision: Number.NaN };
  }
  const falseAlarm = Math.min(1, Math.exp(logSumExp(m1) - z));
  const right = p * (1 - falseAlarm);
  const commit = right + (1 - p) * (1 - t);
  return { holds: k, falseAlarm, commit, precision: commit > 0 ? right / commit : Number.NaN };
}

export interface EscalationOptions {
  readonly p: number;
  readonly t: number;
  /** The cost of one more proposal and verification. */
  readonly costRetry: number;
  /** The cost of the next tier (a person, a stronger model), taken to resolve the step. */
  readonly costEscalate: number;
  /** Escalate once the next commit would be less precise than this (a gate's precision target). */
  readonly minPrecision?: number;
  /** The most holds to look at. Default 1000. */
  readonly maxHolds?: number;
}

/**
 * The one-step look-ahead rule: escalate at the first hold count k where the next attempt's chance
 * of committing is at most costRetry / costEscalate, or where the precision of that commit falls
 * below `minPrecision`, whichever comes first. With J(k) = min(costEscalate,
 * costRetry + (1 - pi_k) J(k + 1)), retrying beats escalating exactly while
 * costRetry < pi_k costEscalate; pi_k and q_k never rise with k (`afterHolds`), so once either
 * rule fires it keeps firing: the monotone case of optimal stopping, where the one-step
 * look-ahead rule is optimal. It ignores the rest of the chain; a pool's reservation handles that.
 * Undefined when neither rule fires within `maxHolds`, or when that many holds cannot happen.
 * At the live fit with p 0.8 and t 0.99 it escalates after 3, 9 and 29 holds at cost ratios of 3,
 * 10 and 30, and a 99% precision target escalates after five (q_4 is 99.03%, q_5 98.78%).
 */
export function escalateAfter(frailty: Frailty, opts: EscalationOptions): number | undefined {
  const p = probability("p", opts.p);
  const t = probability("t", opts.t);
  for (const [name, x] of [
    ["costRetry", opts.costRetry],
    ["costEscalate", opts.costEscalate],
  ] as const) {
    if (!(typeof x === "number" && Number.isFinite(x) && x >= 0)) {
      throw new RangeError(`${name} must be a finite number of at least 0, not ${String(x)}`);
    }
  }
  if (!(opts.costEscalate > 0)) throw new RangeError("costEscalate must be above 0");
  const floor =
    opts.minPrecision === undefined ? undefined : probability("minPrecision", opts.minPrecision);
  const horizon = integer("maxHolds", opts.maxHolds ?? 1000, 0);
  const law = betaLaw(frailty);
  const bar = opts.costRetry / opts.costEscalate;
  for (let k = 0; k <= horizon; k++) {
    const next = afterHoldsUnder(law, p, t, k);
    if (Number.isNaN(next.commit)) return undefined;
    if (next.commit <= bar) return k;
    if (floor !== undefined && next.precision < floor) return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The likelihood estimator.
// ---------------------------------------------------------------------------------------------

/** One step instance: how many distinct correct candidates were held, and how many passed. */
export interface StepCounts {
  readonly held: number;
  readonly passed: number;
}

export interface FrailtyFit extends Frailty {
  /** Profile-likelihood interval for rho at the requested confidence. */
  readonly interval: { readonly lower: number; readonly upper: number };
  readonly logLikelihood: number;
  /** Instances with at least one correct candidate. */
  readonly instances: number;
  /**
   * Instances with at least two: only these carry information about rho. With none, rho is not
   * identified and the interval is [0, 1].
   */
  readonly informative: number;
}

/** Half the chi-square(1) quantile: Wilks' cut for a profile interval, at 90, 95 or 99%. */
function profileCut(confidence: number): number {
  if (!(typeof confidence === "number" && confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), not ${String(confidence)}`);
  }
  const q = confidence >= 0.99 ? 6.634897 : confidence >= 0.95 ? 3.841459 : 2.705543;
  return q / 2;
}

interface Group {
  readonly h: number;
  readonly r: number;
  readonly n: number;
}

/**
 * log B(a + h, b + r) / B(a, b) = sum_{j<h} log(a + j) + sum_{j<r} log(b + j)
 * - sum_{j<h+r} log(a + b + j), multiplied through by rho (as many factors above as below) so
 * that it reads mu (1 - rho) + j rho over (1 - rho) + j rho. The j = 0 factors are paired by hand:
 * they give log mu, log(1 - mu) and one log(1 - rho) when an instance both held and passed, which
 * is what makes rho = 1 exact (such an instance is impossible there) rather than 0 / 0.
 */
function logLikelihood(groups: readonly Group[], mu: number, rho: number): number {
  let s = 0;
  for (const { h, r, n } of groups) {
    let term = 0;
    if (h > 0) term += Math.log(mu);
    if (r > 0) term += Math.log(1 - mu);
    if (h > 0 && r > 0) term += Math.log(1 - rho);
    for (let j = 1; j < h; j++) term += Math.log(mu * (1 - rho) + j * rho);
    for (let j = 1; j < r; j++) term += Math.log((1 - mu) * (1 - rho) + j * rho);
    for (let j = 1; j < h + r; j++) term -= Math.log(1 - rho + j * rho);
    s += n * term;
  }
  return s;
}

/** d log L / d mu at fixed rho. Every term is concave in mu, so its sign brackets the maximum. */
function slope(groups: readonly Group[], mu: number, rho: number): number {
  let s = 0;
  for (const { h, r, n } of groups) {
    let d = 0;
    if (h > 0) d += 1 / mu;
    if (r > 0) d -= 1 / (1 - mu);
    for (let j = 1; j < h; j++) d += (1 - rho) / (mu * (1 - rho) + j * rho);
    for (let j = 1; j < r; j++) d -= (1 - rho) / ((1 - mu) * (1 - rho) + j * rho);
    s += n * d;
  }
  return s;
}

/**
 * The likelihood estimator, preferred when per-instance counts exist (`frailtyCounts`). For step
 * instances with h held and r passed distinct correct candidates,
 * log L(a, b) = sum_i log B(a + h_i, b + r_i) / B(a, b), in product form so no gamma function is
 * needed. The order of holds and passes does not matter.
 *
 * Why it is valid on retry rows, where naive rates are not: whether a step gets another attempt
 * depends only on rulings already observed, the attempt budget and the proposer's draws, none of
 * which depend on theta. The probability of a step's history therefore factors into
 * P(rulings | theta, truths) times P(continue or stop | the history so far), and the second factor
 * does not involve (a, b), so it drops out: the stopping rule is ignorable for likelihood
 * inference (the stopping-rule principle). Realised false alarm on chain rows was 21% to 23%
 * against 15% to 17% held out, because a retry exists only after a hold; this likelihood is not
 * biased by that. It does need labels whose selection depends only on what was observed: label
 * every attempt of a sampled step, not rows chosen because they were held. And a second opinion
 * that stops a chain must not carry information about the primary's theta beyond its rulings.
 *
 * The search runs in (mu, rho) on the closed unit square rather than in (log a, log b): the
 * domain is bounded, the boundary rho = 0 (no frailty, a and b infinite) and rho = 1 are points
 * of it rather than places an unbounded search drifts off to, and at fixed rho the log likelihood
 * is concave in mu, so its maximum is found exactly by bisection on the slope. The profile over
 * rho is then evaluated on a grid of 201 points, refined by golden section around the best, and
 * its interval is the set where the profile is within half the chi-square(1) quantile of the top
 * (Wilks), widened to the hull if the profile is not unimodal and refined at each edge by
 * bisection. `confidence` is read as 90, 95 or 99%, like `wilsonInterval`.
 */
export function fitFrailty(
  counts: readonly StepCounts[],
  opts: { readonly confidence?: number } = {},
): FrailtyFit {
  const cut = profileCut(opts.confidence ?? 0.95);
  const byPair = new Map<string, Group>();
  let held = 0;
  let passed = 0;
  let instances = 0;
  let informative = 0;
  for (const [i, c] of counts.entries()) {
    const h = integer(`counts[${i}].held`, c?.held, 0);
    const r = integer(`counts[${i}].passed`, c?.passed, 0);
    if (h + r === 0) continue;
    instances++;
    if (h + r >= 2) informative++;
    held += h;
    passed += r;
    const key = `${h}:${r}`;
    byPair.set(key, { h, r, n: (byPair.get(key)?.n ?? 0) + 1 });
  }
  if (instances === 0) {
    throw new RangeError("fitFrailty needs at least one step instance with a correct candidate");
  }
  const whole = { lower: 0, upper: 1 };
  // No holds (or no passes) at all: the maximum is the point mass at 0 (or 1), where every rho
  // gives the data probability 1, so rho is not identified.
  if (held === 0 || passed === 0) {
    return {
      ...frailtyOf(held === 0 ? 0 : 1, 0),
      interval: whole,
      logLikelihood: 0,
      instances,
      informative,
    };
  }
  const groups = [...byPair.values()];
  const bestMu = (rho: number): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (slope(groups, mid, rho) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const profile = (rho: number): number => logLikelihood(groups, bestMu(rho), rho);
  const G = 200;
  const grid = Array.from({ length: G + 1 }, (_, i) => profile(i / G));
  let top = 0;
  for (let i = 1; i <= G; i++) if ((grid[i] as number) > (grid[top] as number)) top = i;
  // Golden section on the cells either side of the best grid point.
  let lo = Math.max(0, top - 1) / G;
  let hi = Math.min(G, top + 1) / G;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = profile(x1);
  let f2 = profile(x2);
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = profile(x2);
    } else {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = profile(x1);
    }
  }
  let rho = (lo + hi) / 2;
  let best = profile(rho);
  if ((grid[top] as number) >= best) {
    rho = top / G;
    best = grid[top] as number;
  }
  const level = best - cut;
  const crossing = (below: number, above: number): number => {
    let b = below;
    let a = above;
    for (let i = 0; i < 60; i++) {
      const mid = (a + b) / 2;
      if (profile(mid) >= level) a = mid;
      else b = mid;
    }
    return a;
  };
  // The hull of the grid points at or above the cut, together with the refined maximum; each edge
  // is refined between its outermost point inside and the grid point just outside it.
  let firstIn = -1;
  let lastIn = -1;
  for (let i = 0; i <= G; i++) {
    if ((grid[i] as number) >= level) {
      if (firstIn < 0) firstIn = i;
      lastIn = i;
    }
  }
  const [lowIn, lowOut] =
    firstIn >= 0 && firstIn / G <= rho ? [firstIn / G, firstIn - 1] : [rho, Math.floor(rho * G)];
  const [highIn, highOut] =
    lastIn >= 0 && lastIn / G >= rho ? [lastIn / G, lastIn + 1] : [rho, Math.ceil(rho * G)];
  const lower = lowOut < 0 ? 0 : crossing(lowOut / G, lowIn);
  const upper = highOut > G ? 1 : crossing(highOut / G, highIn);
  return {
    ...frailtyOf(bestMu(rho), rho),
    interval: { lower, upper },
    logLikelihood: best,
    instances,
    informative,
  };
}

// ---------------------------------------------------------------------------------------------
// Counts from a ledger.
// ---------------------------------------------------------------------------------------------

/** A step instance's counts, with where they came from. */
export interface InstanceCounts extends StepCounts {
  readonly step: string;
  /** The `chain:instance:` key: the step name and the key of the state before it. */
  readonly instance: string;
}

/** The counts behind the two rates and the third-moment check. */
export interface HoldRateCounts {
  /** Instances with a correct candidate, and how many had their first one held. */
  readonly first: number;
  readonly firstHeld: number;
  /** Of those whose first was held, how many reached a second correct candidate, and held it. */
  readonly second: number;
  readonly secondHeld: number;
  /** Of those whose first two were held, how many reached a third, and held it. */
  readonly third: number;
  readonly thirdHeld: number;
}

export interface FrailtyCounts {
  readonly instances: readonly InstanceCounts[];
  readonly rates: HoldRateCounts;
  /** Labelled correct candidates read. */
  readonly candidates: number;
  /** Chain rows not read, by reason. */
  readonly skipped: {
    /** No instance or candidate tag: the chain ran without `keyOf`, so attempts cannot be clustered. */
    readonly untagged: number;
    /** A second opinion's row (`chain:tier:second`): another verifier's evidence. */
    readonly secondOpinion: number;
    /** A battery member's row; its combined row carries the ruling. */
    readonly member: number;
    /** A failed-open verification: a hold no judgement made. */
    readonly failedOpen: number;
    /** No label, or one the trust filter refuses. */
    readonly unlabelled: number;
    /** A wrong candidate: evidence on the catch rate, not on theta. */
    readonly wrong: number;
    /** A candidate already read for its instance: a repeat is not a fresh draw. */
    readonly repeated: number;
  };
}

export interface FrailtyCountOptions extends TrustFilter {
  /** Read only this gate's rows. */
  readonly gateId?: string;
  /** Read only this step's rows (fit per step kind once rows allow). */
  readonly step?: string;
  /** Does yes mean the step succeeded? Default: each row's recorded polarity, else the rows' majority. */
  readonly goIsYes?: boolean;
  /**
   * Was this row's candidate held? Default: in enforce mode the row's action; in shadow mode the
   * gate's policy and floors (`soft` under `floor`), which is what the chain saw when its policy is
   * the gate's. Give it when the chain ruled on another bar. Either way a row followed by a later
   * attempt of the same run and instance counts as held, because a chain retries only after a
   * hold.
   */
  readonly held?: (row: DecisionRecord) => boolean;
}

function heldByRow(r: DecisionRecord): boolean {
  if (r.mode === "enforce") return readAction(r.action) !== "act";
  return moreCautious(readAction(r.soft), readAction(r.floor ?? "act")) !== "act";
}

/**
 * The per-instance counts the estimators need, from decision rows that carry `runChain`'s tags
 * with `keyOf` (run, instance, candidate) and their outcome labels. Only rows whose candidate is
 * labelled correct (acting would have been right) under a label source the trust filter admits are
 * read; each distinct candidate counts once per instance, the first time it appears in row order;
 * failed-open rows, second opinions and battery members are skipped. Rows a floor settled count as
 * what the chain saw: a review floor holds every candidate of an instance it matches, which is a
 * frailty at theta = 1 as far as completion goes.
 *
 * Retries are read here, and they must be: they are most of the evidence on theta. They are read
 * only into the likelihood (`fitFrailty`), which conditions on each step's history, and into the
 * conditional rates (`holdRates`), which compare like with like; never as unselected rows, which
 * they are not (`isUnselected` already excludes them from every bar fit).
 */
export function frailtyCounts(
  rows: readonly DecisionRecord[],
  opts: FrailtyCountOptions = {},
): FrailtyCounts {
  const heldOf = opts.held ?? heldByRow;
  const skipped = {
    untagged: 0,
    secondOpinion: 0,
    member: 0,
    failedOpen: 0,
    unlabelled: 0,
    wrong: 0,
    repeated: 0,
  };
  const batteries = new Set(rows.filter((r) => r.combined === true).map((r) => r.requestId));
  const primary: {
    readonly row: DecisionRecord;
    readonly step: string;
    readonly instance: string;
    readonly candidate: string;
    readonly run?: string;
    readonly attempt?: number;
  }[] = [];
  for (const row of rows) {
    const tags = readChainTags(row.tags);
    if (tags === undefined) continue;
    if (opts.gateId !== undefined && row.gateId !== opts.gateId) continue;
    if (opts.step !== undefined && tags.step !== opts.step) continue;
    if (batteries.has(row.requestId) && row.combined !== true) {
      skipped.member++;
      continue;
    }
    if (tags.tier !== undefined && tags.tier !== "primary") {
      skipped.secondOpinion++;
      continue;
    }
    if (tags.instance === undefined || tags.candidate === undefined) {
      skipped.untagged++;
      continue;
    }
    primary.push({
      row,
      step: tags.step ?? "",
      instance: tags.instance,
      candidate: tags.candidate,
      ...(tags.run !== undefined ? { run: tags.run } : {}),
      ...(tags.attempt !== undefined ? { attempt: tags.attempt } : {}),
    });
  }
  // The instance key is the pair (step tag, instance tag), so a step name that contains the
  // instance tag's separator cannot merge two instances.
  const instanceKey = (x: { readonly step: string; readonly instance: string }) =>
    `${x.step}\u0000${x.instance}`;
  const runKey = (x: (typeof primary)[number]) =>
    x.run === undefined ? undefined : `${x.run}\u0000${instanceKey(x)}`;
  const lastAttempt = new Map<string, number>();
  for (const x of primary) {
    const k = runKey(x);
    if (k !== undefined && x.attempt !== undefined) {
      lastAttempt.set(k, Math.max(lastAttempt.get(k) ?? 0, x.attempt));
    }
  }
  const majority = opts.goIsYes ?? inferGoIsYes(primary.map((x) => x.row)).goIsYes;
  const sequences = new Map<
    string,
    {
      readonly step: string;
      readonly instance: string;
      readonly seen: Set<string>;
      held: boolean[];
    }
  >();
  let candidates = 0;
  for (const x of primary) {
    const r = x.row;
    if (r.failedOpen) {
      skipped.failedOpen++;
      continue;
    }
    if (!r.outcome || !admits(opts, r.outcome.source)) {
      skipped.unlabelled++;
      continue;
    }
    const right = actWasRight(r, opts.goIsYes ?? recordedGoIsYes(r) ?? majority);
    if (right === undefined) {
      skipped.unlabelled++;
      continue;
    }
    if (!right) {
      skipped.wrong++;
      continue;
    }
    const key = instanceKey(x);
    const seq = sequences.get(key) ?? {
      step: x.step,
      instance: x.instance,
      seen: new Set<string>(),
      held: [],
    };
    sequences.set(key, seq);
    if (seq.seen.has(x.candidate)) {
      skipped.repeated++;
      continue;
    }
    seq.seen.add(x.candidate);
    const k = runKey(x);
    const retried =
      k !== undefined && x.attempt !== undefined && (lastAttempt.get(k) ?? 0) > x.attempt;
    seq.held.push(retried || heldOf(r));
    candidates++;
  }
  const instances: InstanceCounts[] = [];
  const rates = { first: 0, firstHeld: 0, second: 0, secondHeld: 0, third: 0, thirdHeld: 0 };
  for (const s of sequences.values()) {
    const h = s.held.filter(Boolean).length;
    instances.push({ step: s.step, instance: s.instance, held: h, passed: s.held.length - h });
    const [a, b, c] = s.held;
    if (a === undefined) continue;
    rates.first++;
    if (!a) continue;
    rates.firstHeld++;
    if (b === undefined) continue;
    rates.second++;
    if (!b) continue;
    rates.secondHeld++;
    if (c === undefined) continue;
    rates.third++;
    if (c) rates.thirdHeld++;
  }
  return { instances, rates, candidates, skipped };
}

/**
 * The two rates (and the third-moment rate when it has data) from `frailtyCounts`, ready for
 * `frailtyFromRates` and `completionInterval`. Undefined until some instance has a first correct
 * candidate held and a second one judged: before that psi is not measured. Do not pool runs that
 * share instances as if they were independent evidence.
 */
export function holdRates(
  counts: HoldRateCounts,
): (HoldRates & { readonly third?: number }) | undefined {
  if (counts.first === 0 || counts.second === 0) return undefined;
  return {
    first: counts.firstHeld / counts.first,
    again: counts.secondHeld / counts.second,
    ...(counts.third > 0 ? { third: counts.thirdHeld / counts.third } : {}),
  };
}
