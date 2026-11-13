/**
 * Pooling under simulation: the base rate counted once per member, and which dependence
 * measure the pooling weights should read. Members are calibrated Gaussian-logit judges: given
 * the truth, member i's log-odds are lambda0 +- sigma_i^2 / 2 + sigma_i e_i with the e_i jointly
 * normal at correlation R, so each member alone is calibrated and right with probability
 * Phi(sigma_i / 2) at a base rate of one half. That is the model the fitted pool is derived
 * from, so these tables favour it by construction; the T5 ledgers are the check on real rows
 * (experiments/e2e/t5-compound/pooling-review.ts), where it did not beat the phi matrix and was
 * not shipped. The fitted pool is imported from its experiment, not from the library.
 */
import {
  FAMILY_PRIOR,
  fitPool,
  pooledYes,
  shrinkCorrelation,
} from "../experiments/e2e/t5-compound/fitted-pool.ts";
import { type PoolOptions, pool } from "../src/compound/aggregate.ts";
import { errorCorrelation } from "../src/ledger/calibration.ts";
import {
  type PanelMember,
  type PanelRow,
  withinClassCorrelation,
} from "../src/ledger/dependence.ts";
import { logit, mean, type Rand, randNormal, rng, sigmoid } from "../src/math.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import { fmt, heading, note, pct, table } from "./lib.ts";

const q = judge("ok?", { id: "sim.pool" });

/** Inverse standard normal CDF (Acklam's rational approximation, relative error about 1e-9). */
function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const poly = (k: readonly number[], x: number) => k.reduce((s, v) => s * x + v, 0);
  if (p < 0.02425) {
    const t = Math.sqrt(-2 * Math.log(p));
    return poly(c, t) / (poly(d, t) * t + 1);
  }
  if (p > 1 - 0.02425) return -normalQuantile(1 - p);
  const t = p - 0.5;
  const r = t * t;
  return (poly(a, r) * t) / (poly(b, r) * r + 1);
}

/** sigma of a calibrated member right with probability `accuracy` at a base rate of one half. */
const sigmaFor = (accuracy: number): number => 2 * normalQuantile(accuracy);

function cholesky(a: readonly (readonly number[])[]): number[][] {
  const n = a.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i]?.[j] ?? 0;
      for (let k = 0; k < j; k++) s -= (l[i]?.[k] ?? 0) * (l[j]?.[k] ?? 0);
      (l[i] as number[])[j] = i === j ? Math.sqrt(s) : s / (l[j]?.[j] ?? 1);
    }
  }
  return l;
}

function panel(
  r: Rand,
  n: number,
  sigma: readonly number[],
  chol: readonly (readonly number[])[],
  base: number,
): { truth: boolean; logits: number[] }[] {
  const l0 = logit(base);
  return Array.from({ length: n }, () => {
    const truth = r() < base;
    const e = sigma.map(() => randNormal(r));
    const logits = sigma.map((s, i) => {
      const c = (chol[i] ?? []).reduce((acc, x, j) => acc + x * (e[j] ?? 0), 0);
      return l0 + ((truth ? 1 : -1) * s * s) / 2 + s * c;
    });
    return { truth, logits };
  });
}

const sd = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const spread = (xs: readonly number[], places = 3): string =>
  xs.length === 0 ? "-" : `${fmt(mean(xs), places)} +- ${fmt(sd(xs), places)}`;

/** Phi of two members' correctness, undefined when either was always right or always wrong. */
function phiOf(rows: readonly { truth: boolean; logits: readonly number[] }[]): number | undefined {
  const pairs = rows.map((row) => ({
    a: (row.logits[0] ?? 0) >= 0 === row.truth,
    b: (row.logits[1] ?? 0) >= 0 === row.truth,
  }));
  const varies = (f: (x: { a: boolean; b: boolean }) => boolean) =>
    pairs.some(f) && !pairs.every(f);
  return varies((x) => x.a) && varies((x) => x.b) ? errorCorrelation(pairs) : undefined;
}

/** The engine's shipped measured matrix: phi per pair, a pair with no phi left out. */
function phiMatrix(
  rows: readonly { truth: boolean; logits: readonly number[] }[],
  keys: readonly string[],
): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const phi = phiOf(
        rows.map((row) => ({
          truth: row.truth,
          logits: [row.logits[i] ?? 0, row.logits[j] ?? 0],
        })),
      );
      if (phi === undefined) continue;
      const a = keys[i] as string;
      m[a] = { ...(m[a] ?? {}), [keys[j] as string]: phi };
    }
  }
  return m;
}

/**
 * Held-out scores of a pool: `pool()` with these options, or a function of the members' log-odds
 * as `pool()` reads them (`logit` of each member's stated p(yes)).
 */
function scores(
  test: readonly { truth: boolean; logits: readonly number[] }[],
  o: PoolOptions | ((logits: readonly number[]) => number),
): { logLoss: number; brier: number; accuracy: number } {
  let ll = 0;
  let br = 0;
  let right = 0;
  for (const row of test) {
    const ps = row.logits.map((z) => sigmoid(z));
    const p =
      typeof o === "function"
        ? o(ps.map((x) => logit(x)))
        : (
            pool(
              q,
              ps.map((x) => judgeVerdictFrom(q, x)),
              o,
            ) as { pYes: number }
          ).pYes;
    const pt = Math.min(1 - 1e-6, Math.max(1e-6, row.truth ? p : 1 - p));
    ll -= Math.log(pt);
    br += (p - (row.truth ? 1 : 0)) ** 2;
    if (p >= 0.5 === row.truth) right++;
  }
  return { logLoss: ll / test.length, brier: br / test.length, accuracy: right / test.length };
}

function doubleCount(): void {
  heading("14. The base rate counted once per member, and once with `priorYes`");
  note(
    "Every member answers the gate's base rate. For a calibrated member that means it saw no evidence either way, so the right pooled answer is the base rate. Log-odds pooling counts the prior once per member it weighs; `priorYes` subtracts it from each member and adds it back once. The family default is the engine's correlation by voter identity: 0.75 within a model family, 0 across, as a matrix (two members: one family; three: two of one family and one other).",
  );
  const rows: string[][] = [];
  for (const base of [0.5, 0.8, 0.95]) {
    for (const n of [2, 3]) {
      const vs = Array.from({ length: n }, () => judgeVerdictFrom(q, base));
      const keys = ["a", "b", "c"].slice(0, n);
      const family: PoolOptions = { correlations: { a: { b: FAMILY_PRIOR } }, memberKeys: keys };
      const p = (o: PoolOptions) => fmt((pool(q, vs, o) as { pYes: number }).pYes);
      rows.push([
        pct(base, 0),
        String(n),
        p({}),
        p({ priorYes: base }),
        p(family),
        p({ ...family, priorYes: base }),
      ]);
    }
  }
  table(
    [
      "base rate",
      "members",
      "rho 0",
      "rho 0, priorYes",
      "family default",
      "family default, priorYes",
    ],
    rows,
  );

  const accuracies = [0.86, 0.84, 0.965];
  const sigma = accuracies.map(sigmaFor);
  const corr = [
    [1, 0.85, 0.1],
    [0.85, 1, 0.1],
    [0.1, 0.1, 1],
  ];
  const chol = cholesky(corr);
  const base = 0.8;
  const reps = 40;
  const testRows = 5_000;
  const members: PanelMember[] = [
    { key: "j1", model: "jev-1.13" },
    { key: "j2", model: "jev-1.14" },
    { key: "h", model: "claude-haiku" },
  ];
  const keys = members.map((m) => m.key);
  note(
    `A three-member panel at base rate ${pct(base, 0)}: two pins of one family at latent within-class correlation 0.85 and one other family at 0.1, accurate ${accuracies.map((a) => pct(a, 1)).join(", ")} at a base rate of one half. Each pool is fitted on n labelled rows (${reps} seeded fits per n) and scored on the same ${testRows.toLocaleString("en-US")} held-out rows; cells are held-out log loss, mean +- SD across fits. The offset uses the fitted base rate (add-one smoothed), not the true one. "Within-class fit" is the fitted pool measured on e2e T5 and not shipped (\`fitPool\` in experiments/e2e/t5-compound/fitted-pool.ts): its no-offset column pools the fitted weights alone, its offset column adds the prior offset, and its last column the fitted centres as well (the full fit). The oracle pools with the true weights and the true prior.`,
  );
  const test = panel(rng(91_000), testRows, sigma, chol, base);
  const out: string[][] = [];
  const single = scores(
    test.map((row) => ({ truth: row.truth, logits: [row.logits[2] ?? 0] })),
    {},
  );
  out.push(["best single member alone", "-", fmt(single.logLoss), "-", "-", pct(single.accuracy)]);
  // The Bayes weights for these parameters: (R^-1 sigma)_i / sigma_i, on the Cholesky factor.
  const oracleWeights = (() => {
    const s = sigma;
    const n = s.length;
    const m = corr.map((row, i) => [...row, s[i] ?? 0]);
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = (m[r]?.[c] ?? 0) / (m[c]?.[c] ?? 1);
        for (let k = c; k <= n; k++)
          (m[r] as number[])[k] = (m[r]?.[k] ?? 0) - f * (m[c]?.[k] ?? 0);
      }
    }
    return s.map((si, i) => (m[i]?.[n] ?? 0) / (m[i]?.[i] ?? 1) / si);
  })();
  const oracle = scores(test, { weights: oracleWeights, priorYes: base, correlation: 0 });
  out.push(["oracle (true parameters)", "-", "-", fmt(oracle.logLoss), "-", pct(oracle.accuracy)]);
  // Mean log loss at the smallest n, for the reading below: phi, phi + prior, fit, fit + prior, full.
  const first: number[] = [];
  for (const n of [100, 300]) {
    const r = rng(92_000 + n);
    const cells = {
      rho0: [[], []] as number[][],
      phi: [[], []] as number[][],
      fit: [[], [], []] as number[][],
      acc: [] as number[],
    };
    for (let rep = 0; rep < reps; rep++) {
      const rows = panel(r, n, sigma, chol, base);
      const sample = { members, rows: rows as PanelRow[] };
      const fit = fitPool(sample);
      const prior = { priorYes: fit.baseRate ?? base };
      const matrix: PoolOptions = { correlations: phiMatrix(rows, keys), memberKeys: keys };
      cells.rho0[0]?.push(scores(test, {}).logLoss);
      cells.rho0[1]?.push(scores(test, prior).logLoss);
      cells.phi[0]?.push(scores(test, matrix).logLoss);
      cells.phi[1]?.push(scores(test, { ...matrix, ...prior }).logLoss);
      cells.fit[0]?.push(scores(test, (z) => pooledYes(fit, z, "weights")).logLoss);
      cells.fit[1]?.push(scores(test, (z) => pooledYes(fit, z, "prior")).logLoss);
      const s = scores(test, (z) => pooledYes(fit, z, "full"));
      cells.fit[2]?.push(s.logLoss);
      cells.acc.push(s.accuracy);
    }
    const c = (xs: number[] | undefined) => spread(xs ?? []);
    if (first.length === 0) {
      first.push(...[cells.phi[0], cells.phi[1], ...cells.fit].map((xs) => mean(xs ?? [])));
    }
    out.push(["log-odds, rho 0", String(n), c(cells.rho0[0]), c(cells.rho0[1]), "-", "-"]);
    out.push(["phi matrix (shipped)", String(n), c(cells.phi[0]), c(cells.phi[1]), "-", "-"]);
    out.push([
      "within-class fit",
      String(n),
      c(cells.fit[0]),
      c(cells.fit[1]),
      c(cells.fit[2]),
      pct(mean(cells.acc)),
    ]);
  }
  table(
    ["pool", "n", "no offset", "priorYes", "priorYes + fitted centres", "accuracy (full fit)"],
    out,
  );
  const [phi, phiPrior, fitted, fittedPrior, full] = first.map((x) => fmt(x));
  note(
    `Reading it: members who learned nothing pool past the base rate whenever it is not one half, to the prior log-odds times the sum of their weights, always toward the majority class; with the offset they pool to the base rate. On the panel the offset is worth more than the change of dependence measure: at 100 rows it takes the phi matrix from ${phi} to ${phiPrior} and the fitted weights from ${fitted} to ${fittedPrior}, against the oracle's ${fmt(oracle.logLoss)}. The fitted centres add variance and nothing else here (${full} with them), as they should: every member is calibrated, so each centre is the prior. The rows are calibrated Gaussian-logit members, the model the fit assumes; on e2e T5's real rows the fitted weights did not beat the phi matrix (experiments/e2e/t5-compound/pooling-review.ts), and only the offset ships.`,
  );
}

function phiAgainstLogit(): void {
  heading("15. Phi of correctness against the within-class logit correlation");
  const latent = 0.85;
  const reps = 2_000;
  note(
    `Two calibrated members at latent within-class correlation ${latent}, base rate one half. "Population" is phi on 200,000 items. The other columns are ${reps.toLocaleString("en-US")} seeded samples of n labelled rows each, mean +- SD: phi of correctness (the engine's \`memberCorrelation\`, a pair whose member never erred or always erred has none), the within-class logit correlation (\`withinClassCorrelation\`) and that estimate shrunk on Fisher's z scale toward the family prior ${FAMILY_PRIOR} with a prior worth 30 rows, as the fitted pool read it (\`shrinkCorrelation\` in experiments/e2e/t5-compound/fitted-pool.ts).`,
  );
  const rows: string[][] = [];
  const configs: [number, number][] = [
    [0.86, 0.84],
    [0.95, 0.95],
    [0.86, 0.965],
  ];
  const chol = cholesky([
    [1, latent],
    [latent, 1],
  ]);
  for (const [k, [a1, a2]] of configs.entries()) {
    const sigma = [sigmaFor(a1), sigmaFor(a2)];
    const population = phiOf(panel(rng(93_000 + k), 200_000, sigma, chol, 0.5));
    for (const n of [100, 300]) {
      const r = rng(94_000 + 10 * k + n);
      const phis: number[] = [];
      const within: number[] = [];
      const shrunk: number[] = [];
      let undefinedPhi = 0;
      for (let rep = 0; rep < reps; rep++) {
        const rs = panel(r, n, sigma, chol, 0.5);
        const phi = phiOf(rs);
        if (phi === undefined) undefinedPhi++;
        else phis.push(phi);
        const w = withinClassCorrelation(
          rs.map((row) => ({ truth: row.truth, a: row.logits[0] ?? 0, b: row.logits[1] ?? 0 })),
        );
        if (w.correlation !== undefined) within.push(w.correlation);
        shrunk.push(shrinkCorrelation(w.correlation, w.n, FAMILY_PRIOR));
      }
      rows.push([
        `${pct(a1, 1)} / ${pct(a2, 1)}`,
        population === undefined ? "-" : fmt(population, 2),
        String(n),
        spread(phis, 2),
        String(undefinedPhi),
        spread(within, 2),
        spread(shrunk, 2),
      ]);
    }
  }
  table(
    [
      "accuracies",
      "population phi",
      "n",
      "phi",
      "phi undefined",
      "within-class r",
      "shrunk to 0.75",
    ],
    rows,
  );
  note(
    `Reading it: phi reads a latent ${latent} as well under it, the more so the more the members' error rates differ, and it moves several times as much from sample to sample; a correlation plugged into R^-1 1 that low pools correlated members as if they were less so. The within-class logit correlation is centred on the latent value at both sizes and uses every row, not only the rows where someone erred.`,
  );
}

/** Sections 14 and 15: the double-counted prior, and phi against the within-class correlation. */
export function poolingTables(): void {
  doubleCount();
  phiAgainstLogit();
}
