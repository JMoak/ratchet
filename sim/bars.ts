/**
 * Act bars under simulation: how often a bar fitted on labelled rows delivers less than its
 * promise, how often one is found at all, and what it acts on. Rows follow the research model
 * (research_notes/Foundations review 2026-11/risk_controlled_bars.md, model I and IIa): 60% of
 * rows are ones where acting is right, scores are binormal with AUC 0.95, and the stated
 * probability is sigmoid(z - 0.5). Delivered precision and coverage are read from the population
 * model at the fitted bar, never from a test sample, so every rate is checked against the truth.
 * Today's rule runs through `fitThreshold` itself and the exact fit through `fitExactBar`.
 */
import { fitThreshold } from "../src/ledger/calibration.ts";
import { REPORT_DEFAULTS } from "../src/ledger/evidence.ts";
import { type ActRow, EXACT_BAR_EDGES, fitExactBar } from "../src/ledger/exact-bar.ts";
import { type Rand, randNormal, rng } from "../src/math.ts";
import { heading, note, pct, table } from "./lib.ts";

/** Share of rows where acting is right (the T1 fit split had 60.6% approvals). */
const SHARE_RIGHT = 0.6;
/** Binormal separation: AUC = Phi(2.326 / sqrt 2) = 0.95. */
const SEPARATION = 2.326;

/** Upper tail of the standard normal, by the complementary error function (error < 1.2e-7). */
function normalTail(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -z * z -
    1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t *
                          (-1.13520398 +
                            t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const erfc = t * Math.exp(poly);
  return x >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/** Right and wrong acts per row when acting at or above `bar` on the stated probability. */
function population(bar: number): { readonly precision: number; readonly coverage: number } {
  const z = 0.5 + Math.log(bar / (1 - bar));
  const right = SHARE_RIGHT * normalTail(z - SEPARATION);
  const wrong = (1 - SHARE_RIGHT) * normalTail(z);
  return { precision: right / (right + wrong), coverage: right + wrong };
}

/** The bar whose population precision is exactly `target`: what a perfect fit would find. */
function oracleBar(target: number): number {
  let lo = 0.01;
  let hi = 0.999;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (population(mid).precision < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

const stated = (z: number): number => 1 / (1 + Math.exp(-(z - 0.5)));

function independent(n: number, rand: Rand): ActRow[] {
  return Array.from({ length: n }, () => {
    const right = rand() < SHARE_RIGHT;
    return { go: stated((right ? SEPARATION : 0) + randNormal(rand)), right };
  });
}

/** Knuth's Poisson sampler; the means here are small. */
function poisson(mean: number, rand: Rand): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

/**
 * Rows in groups of 1 + Poisson(size - 1), cut to the rows left. A group shares one label and one
 * score offset of variance `rho`, so `rho` is the within-group correlation of the score; marginally
 * every row follows the independent model.
 */
function clustered(n: number, size: number, rho: number, rand: Rand): ActRow[] {
  const out: ActRow[] = [];
  for (let g = 0; out.length < n; g++) {
    const rows = Math.min(n - out.length, 1 + poisson(size - 1, rand));
    const right = rand() < SHARE_RIGHT;
    const offset = Math.sqrt(rho) * randNormal(rand);
    for (let i = 0; i < rows; i++) {
      const z = (right ? SEPARATION : 0) + offset + Math.sqrt(1 - rho) * randNormal(rand);
      out.push({ go: stated(z), right, group: `g${g}` });
    }
  }
  return out;
}

/** Today's rule: the lowest observed score whose 95% Wilson lower bound clears the promise. */
const todaysBar = (rows: readonly ActRow[], target: number): number | undefined =>
  fitThreshold(
    rows.map((r) => ({ confidence: r.go, correct: r.right })),
    target,
    REPORT_DEFAULTS.minSupport,
    { conservative: true },
  )?.threshold;

/** The exact fit with every row its own unit, whatever groups the rows carry. */
const exactOnRows = (rows: readonly ActRow[], target: number): number | undefined =>
  fitExactBar(
    rows.map(({ go, right }) => ({ go, right })),
    { target },
  ).bar;

const exactOnGroups = (rows: readonly ActRow[], target: number): number | undefined =>
  fitExactBar(rows, { target }).bar;

/** Found, below the promise, below given found, and mean coverage when found, over the runs. */
class Tally {
  private runs = 0;
  private found = 0;
  private below = 0;
  private coverage = 0;

  add(bar: number | undefined, target: number): void {
    this.runs++;
    if (bar === undefined) return;
    const at = population(bar);
    this.found++;
    this.coverage += at.coverage;
    if (at.precision < target) this.below++;
  }

  cells(): string[] {
    if (this.found === 0) return ["0.0%", "0.0%", "-", "-"];
    return [
      pct(this.found / this.runs),
      pct(this.below / this.runs),
      pct(this.below / this.found),
      pct(this.coverage / this.found),
    ];
  }
}

const TALLY_HEADERS = [
  "bar found",
  "delivered < promise",
  "delivered < promise, given found",
  "rows acted on, when found",
];

export function barTables(): void {
  const edges = `${EXACT_BAR_EDGES.length} edges from ${EXACT_BAR_EDGES[0]} to ${EXACT_BAR_EDGES.at(-1)}`;
  const [o95, o98] = [0.95, 0.98].map((t) => population(oracleBar(t)).coverage);

  heading("12. Act bars on independent rows: today's scan, or an exact fixed sequence");
  note(
    `Seeded runs of n independent labelled rows (4,000 per cell, 2,000 at 2,000 rows) with AUC 0.95 and 60% of rows right to act on, delivered precision and coverage read exactly from the population model (the true bar covers ${pct(o95 as number)} of rows at 95% and ${pct(o98 as number)} at 98%); today's scan is \`fitThreshold\` in its conservative mode with ${REPORT_DEFAULTS.minSupport} rows of support, and the exact fit tests ${edges} at one-sided 95%, stopping at the first failure.`,
  );
  const independentRows: string[][] = [];
  let k = 0;
  for (const n of [180, 500, 2000]) {
    for (const target of [0.95, 0.98]) {
      const rand = rng(11_000 + k++);
      const runs = n >= 2000 ? 2_000 : 4_000;
      const today = new Tally();
      const exact = new Tally();
      for (let r = 0; r < runs; r++) {
        const rows = independent(n, rand);
        today.add(todaysBar(rows, target), target);
        exact.add(exactOnRows(rows, target), target);
      }
      independentRows.push([String(n), pct(target, 0), "today's scan", ...today.cells()]);
      independentRows.push([String(n), pct(target, 0), "exact, fixed sequence", ...exact.cells()]);
    }
  }
  table(["rows", "promise", "procedure", ...TALLY_HEADERS], independentRows);
  note(
    "Reading it: with independent rows both hold the promise overall, but at the edge of power (500 rows at 98%) most bars today's scan finds are below the promise and few of the fixed sequence's are; the price is coverage, and neither finds a 98% bar on 180 rows.",
  );

  heading("13. Act bars on clustered rows: rows or groups as the unit");
  note(
    "Seeded runs (2,000 per row) of 500 labelled rows at a 95% promise, in groups of 1 + Poisson(size - 1) that share a label and a score offset with the given within-group correlation, so each row alone follows the model above; groups as units count a group once, as acting at an edge when any of its rows reaches it and wrong when any of its wrong rows does, a promise about groups that bounds row precision here because a group's rows share a label.",
  );
  const clusteredRows: string[][] = [];
  k = 0;
  for (const [size, rho] of [
    [1, 0],
    [3, 0.3],
    [3, 0.6],
    [10, 0.3],
    [10, 0.6],
  ] as const) {
    const rand = rng(12_000 + k++);
    const runs = 2_000;
    const tallies = { today: new Tally(), rows: new Tally(), groups: new Tally() };
    let groups = 0;
    for (let r = 0; r < runs; r++) {
      const rows = clustered(500, size, rho, rand);
      groups += new Set(rows.map((x) => x.group)).size;
      tallies.today.add(todaysBar(rows, 0.95), 0.95);
      tallies.rows.add(exactOnRows(rows, 0.95), 0.95);
      tallies.groups.add(exactOnGroups(rows, 0.95), 0.95);
    }
    const head = [String(size), String(rho), (groups / runs).toFixed(0)];
    clusteredRows.push([...head, "today's scan", ...tallies.today.cells()]);
    clusteredRows.push([...head, "exact, rows as units", ...tallies.rows.cells()]);
    clusteredRows.push([...head, "exact, groups as units", ...tallies.groups.cells()]);
  }
  table(
    ["mean group size", "within-group correlation", "groups", "procedure", ...TALLY_HEADERS],
    clusteredRows,
  );
  note(
    "Reading it: clustering breaks the promise through the unit, not the search, so the exact test on rows fails with today's scan as groups grow, while counting groups keeps it and finds no bar where there are too few groups to support one (about 50 groups cannot hold the 59 a 95% bar needs).",
  );
}
