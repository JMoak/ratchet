/**
 * The fitted pool, measured on e2e T5 and not shipped. This is the estimator the 2026-11
 * foundations review recommended (research_notes/Foundations review 2026-11/
 * pooling_and_deferral.md, section 6), as it was built for the library: supra-Bayesian pooling
 * of Gaussian logits, with each pair's within-class logit correlation shrunk toward its model
 * family's prior on Fisher's z scale, each member's strength from its class-mean gap, centres at
 * the class-mean midpoints, a variance floor at the gap, and non-negative weights of at most 1.
 * On T5's judge gates it tied the shipped phi matrix on accuracy and lost on log loss and ECE
 * (`pooling-review.ts` prints the table); in the research's Gaussian-logit simulations it won
 * (`sim/pooling.ts`). It is kept here, self-contained, so that result stays reproducible: it
 * computes its pooled probability directly, and nothing under src/ reads it.
 */
import { modelFamily } from "../../../src/ledger/calibration.ts";
import {
  type PanelMember,
  type PanelRow,
  type PanelSample,
  withinClassCorrelation,
} from "../../../src/ledger/dependence.ts";
import { clamp, logit, mean, sigmoid } from "../../../src/math.ts";

/** The prior correlation of two members of one model family or one oracle; 0 across families. */
export const FAMILY_PRIOR = 0.75;

/** What the family prior is worth, in labelled rows, when a correlation is shrunk to it. */
export const PRIOR_ROWS = 30;

/** Labelled rows each member needs, with both truths among them, before its strength is read. */
export const MIN_STRENGTH_ROWS = 30;

/** Correlations are read in [0, 0.99] for the weights, as `pool()` reads a matrix. */
const MAX_RHO = 0.99;

/** Fisher's z of a correlation of 1 is infinite; estimates are read inside this. */
const MAX_Z_RHO = 0.995;

/** One pair's correlation as the fit reads it. */
export interface FittedPair {
  readonly keys: readonly [string, string];
  /** What the weights read: the estimate shrunk toward the prior, or the prior alone. */
  readonly correlation: number;
  /** The within-class estimate; absent when the rows could not give one. */
  readonly estimate?: number;
  readonly prior: number;
  readonly source: "measured" | "prior";
  readonly n: number;
}

/** A member's separation of the two answers, read from its labelled rows. */
export interface MemberStrength {
  /** Mean log-odds on yes rows less mean log-odds on no rows. */
  readonly gap: number;
  /** Pooled within-class variance of its log-odds (denominator n - 2), as measured. */
  readonly variance: number;
  /** Midpoint of the two class means: the log-odds at which it has seen no evidence. */
  readonly centre: number;
  readonly n: number;
}

export interface FittedPool {
  /** Member keys; `weights`, `centres` and `strengths` follow this order. */
  readonly keys: readonly string[];
  /** Each member's weight, in [0, 1]. */
  readonly weights: readonly number[];
  /** Each member's centre; only when strengths were measured. */
  readonly centres?: readonly number[];
  readonly strengths: readonly (MemberStrength | undefined)[];
  /** "measured" when every member had `MIN_STRENGTH_ROWS` rows with both truths, else "equal". */
  readonly strength: "measured" | "equal";
  readonly pairs: readonly FittedPair[];
  /** Share of yes among the rows read, add-one smoothed. */
  readonly baseRate?: number;
  readonly rows: number;
}

/**
 * A correlation shrunk toward a prior on Fisher's z scale, the prior worth `priorRows` rows:
 * tanh((n0 atanh(r0) + (n - 3) atanh(r)) / (n0 + n - 3)), the precision-weighted mean of two
 * estimates of z (the variance of atanh(r) is about 1 / (n - 3)). With no estimate, or n of 3
 * or fewer, it is the prior.
 */
export function shrinkCorrelation(
  estimate: number | undefined,
  n: number,
  prior: number,
  priorRows = PRIOR_ROWS,
): number {
  const r0 = clamp(prior, -MAX_Z_RHO, MAX_Z_RHO);
  const rows = Number.isFinite(n) ? Math.max(n - 3, 0) : 0;
  if (estimate === undefined || !Number.isFinite(estimate) || rows === 0) return r0;
  const z =
    (priorRows * Math.atanh(r0) + rows * Math.atanh(clamp(estimate, -MAX_Z_RHO, MAX_Z_RHO))) /
    (priorRows + rows);
  return Math.tanh(z);
}

/**
 * `FAMILY_PRIOR` when two members share an oracle id or a model family (of the model their
 * answers recorded, else of the oracle id), else 0: the engine's default by voter identity.
 */
export function familyPrior(a: PanelMember, b: PanelMember): number {
  if (a.oracle !== undefined && a.oracle !== "" && a.oracle === b.oracle) return FAMILY_PRIOR;
  const voice = (m: PanelMember) => {
    const name = m.model?.trim() ? m.model : m.oracle?.trim() ? m.oracle : undefined;
    return name === undefined ? undefined : modelFamily(name);
  };
  const fa = voice(a);
  return fa !== undefined && fa === voice(b) ? FAMILY_PRIOR : 0;
}

/** Gap, pooled within-class variance and centre; undefined below three rows or one truth. */
export function memberStrength(
  rows: readonly { readonly truth: boolean; readonly z: number }[],
): MemberStrength | undefined {
  const usable = rows.filter((r) => Number.isFinite(r.z));
  const yes = usable.filter((r) => r.truth).map((r) => r.z);
  const no = usable.filter((r) => !r.truth).map((r) => r.z);
  if (usable.length < 3 || yes.length === 0 || no.length === 0) return undefined;
  const m1 = mean(yes);
  const m0 = mean(no);
  const ss = yes.reduce((s, z) => s + (z - m1) ** 2, 0) + no.reduce((s, z) => s + (z - m0) ** 2, 0);
  return {
    gap: m1 - m0,
    variance: ss / (usable.length - 2),
    centre: (m1 + m0) / 2,
    n: usable.length,
  };
}

/** Gaussian elimination with partial pivoting; undefined when singular. */
function solve(a: readonly (readonly number[])[], b: readonly number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row.slice(0, n), b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    }
    const top = m[pivot] as number[];
    if (!(Math.abs(top[c] ?? 0) > 1e-9)) return undefined;
    [m[c], m[pivot]] = [top, m[c] as number[]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r] as number[];
      const f = (row[c] ?? 0) / (top[c] ?? 1);
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (top[k] ?? 0);
    }
  }
  const x = m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
  return x.every(Number.isFinite) ? x : undefined;
}

/**
 * Non-negative R u = t by an active set, as `pool()` solves R w = 1: drop the most negative
 * entry and solve again; when singular, drop the member most correlated with the rest.
 */
function nonNegativeSolve(r: readonly (readonly number[])[], t: readonly number[]): number[] {
  const n = t.length;
  let active = Array.from({ length: n }, (_, i) => i);
  while (active.length > 0) {
    const sub = active.map((i) => active.map((j) => r[i]?.[j] ?? 0));
    const u = solve(
      sub,
      active.map((i) => t[i] ?? 0),
    );
    let drop = -1;
    if (u === undefined) {
      let most = -1;
      sub.forEach((row, k) => {
        const total = row.reduce((s, x, j) => s + (j === k ? 0 : x), 0);
        if (total > most) {
          most = total;
          drop = k;
        }
      });
    } else {
      for (let k = 0; k < u.length; k++) {
        if ((u[k] ?? 0) < -1e-12 && (drop < 0 || (u[k] ?? 0) < (u[drop] ?? 0))) drop = k;
      }
      if (drop < 0) {
        const out = new Array<number>(n).fill(0);
        active.forEach((i, k) => {
          out[i] = Math.max(u[k] ?? 0, 0);
        });
        return out;
      }
    }
    active = active.filter((_, k) => k !== drop);
  }
  return new Array<number>(n).fill(0);
}

/**
 * Weights in the standardised form R u = t, t_i = d_i / sqrt(v_i), w_i = u_i / sqrt(v_i): the
 * solution of Sigma w = d with Sigma = D R D on a unit diagonal. A member with no separation
 * (d_i <= 0) takes weight 0 outside the solve; each weight is clamped to [0, 1].
 */
function weightsOf(
  r: readonly (readonly number[])[],
  gap: readonly number[],
  variance: readonly number[],
): number[] {
  const n = gap.length;
  const live = Array.from({ length: n }, (_, i) => i).filter((i) => (gap[i] ?? 0) > 0);
  const sub = live.map((i) => live.map((j) => (i === j ? 1 : clamp(r[i]?.[j] ?? 0, 0, MAX_RHO))));
  const u = nonNegativeSolve(
    sub,
    live.map((i) => (gap[i] ?? 0) / Math.sqrt(variance[i] ?? 1)),
  );
  const out = new Array<number>(n).fill(0);
  live.forEach((i, k) => {
    const w = (u[k] ?? 0) / Math.sqrt(variance[i] ?? 1);
    out[i] = Number.isFinite(w) ? clamp(w, 0, 1) : 0;
  });
  return out;
}

function pairsOf(members: readonly PanelMember[], rows: readonly PanelRow[]): FittedPair[] {
  const pairs: FittedPair[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i] as PanelMember;
      const b = members[j] as PanelMember;
      const both = rows.flatMap((row) => {
        const x = row.logits[i];
        const y = row.logits[j];
        return x === undefined || y === undefined ? [] : [{ truth: row.truth, a: x, b: y }];
      });
      const prior = familyPrior(a, b);
      const est = both.length > 0 ? withinClassCorrelation(both) : { n: 0 };
      const measured = est.correlation !== undefined && est.n > 3;
      pairs.push({
        keys: [a.key, b.key],
        correlation: measured ? shrinkCorrelation(est.correlation, est.n, prior) : prior,
        ...(est.correlation !== undefined ? { estimate: est.correlation } : {}),
        prior,
        source: measured ? "measured" : "prior",
        n: est.n,
      });
    }
  }
  return pairs;
}

/**
 * Fit the pool on labelled rows. Base rate add-one smoothed; each pair's correlation shrunk
 * toward its family prior; each member's gap, variance and centre, the variance floored at the
 * gap (a calibrated member's variance equals its gap, and a member pinned near 0 and 1 would
 * otherwise take the unbounded weight d / v; on T5 the floor read every member as at most
 * calibrated, because every gap exceeded its variance); weights from Sigma w = d, non-negative,
 * clamped to [0, 1]. Strengths are read only when every member has `MIN_STRENGTH_ROWS` rows with
 * both truths, else every member is read at one strength.
 */
export function fitPool(sample: PanelSample): FittedPool {
  const keys = sample.members.map((m) => m.key);
  if (keys.length === 0) throw new Error("a panel needs at least one member");
  const rows = sample.rows.filter((row) => row.logits.some((z) => z !== undefined));
  const pairs = pairsOf(sample.members, rows);
  const n = keys.length;
  const r = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = pairs[k++]?.correlation ?? 0;
      (r[i] as number[])[j] = c;
      (r[j] as number[])[i] = c;
    }
  }
  const strengths = keys.map((_, i) =>
    memberStrength(
      rows.flatMap((row) => {
        const z = row.logits[i];
        return z === undefined ? [] : [{ truth: row.truth, z }];
      }),
    ),
  );
  const base =
    rows.length === 0
      ? {}
      : { baseRate: (rows.filter((row) => row.truth).length + 1) / (rows.length + 2) };
  const common = { keys, strengths, pairs, rows: rows.length, ...base };
  if (rows.length > 0 && strengths.every((s) => s !== undefined && s.n >= MIN_STRENGTH_ROWS)) {
    const ms = strengths as MemberStrength[];
    return {
      ...common,
      weights: weightsOf(
        r,
        ms.map((s) => s.gap),
        ms.map((s) => Math.max(s.variance, s.gap)),
      ),
      centres: ms.map((s) => s.centre),
      strength: "measured",
    };
  }
  const ones = keys.map(() => 1);
  return { ...common, weights: weightsOf(r, ones, ones), strength: "equal" };
}

/**
 * The pooled p(yes) for members' log-odds in the fit's key order (`logit` of each member's
 * p(yes), as `pool()` reads it). "weights": sum_i w_i z_i. "prior": lambda0 + sum_i w_i
 * (z_i - lambda0). "full": lambda0 + sum_i w_i (z_i - c_i), the fit as built. With measured
 * strengths there is no confidence cap (weights at most 1); with equal strengths the fit was
 * meant for `pool()`'s matrix path, so its cap applies: |L - lambda0| <= |sum_i (z_i - lambda0)|.
 */
export function pooledYes(
  fit: FittedPool,
  logits: readonly number[],
  form: "weights" | "prior" | "full" = "full",
): number {
  const lambda0 = form === "weights" || fit.baseRate === undefined ? 0 : logit(fit.baseRate);
  const centre = (i: number) =>
    form === "full" && fit.centres !== undefined ? (fit.centres[i] ?? lambda0) : lambda0;
  const evidence = logits.map((z, i) => z - centre(i));
  const sum = evidence.reduce((acc, e, i) => acc + (fit.weights[i] ?? 0) * e, 0);
  if (fit.strength === "measured") return sigmoid(lambda0 + sum);
  const independent = Math.abs(evidence.reduce((acc, e) => acc + e, 0));
  return sigmoid(lambda0 + Math.sign(sum) * Math.min(Math.abs(sum), independent));
}
