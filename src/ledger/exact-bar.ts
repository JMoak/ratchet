/**
 * The exact fixed-sequence act bar: where a gate may act, read so that the promise holds with a
 * stated probability rather than on average, and with the unit of evidence said out loud.
 *
 * Today's conservative bar (`fitThreshold` with `conservative`) scans every observed score and
 * keeps the lowest whose Wilson lower bound clears the promise. With independent rows that held
 * its level in simulation, but two things break it. Rows that share a session or a template share
 * their errors, and counting them one by one broke a 95% promise 7% to 18% of the time where
 * groups counted once broke it about 0.1% of the time. And a bar found at the edge of statistical
 * power is usually wrong: at 500 rows and a 98% promise, 85% of the bars the scan found were
 * below the promise, against 3% for a fixed-sequence test over preset edges. This module is the
 * replacement: preset edges, an exact (Clopper-Pearson) test at each, walked downward in a fixed
 * order and stopped at the first failure, over units that are rows or whole groups.
 */

import { exactLowerBound, requiredActs } from "../acceptance.ts";
import { inferGoIsYes, type ScoreOptions, scoredForAct } from "./calibration.ts";
import type { DecisionRecord } from "./ledger.ts";

/** One labelled row on the act side: what the policy read, and whether acting was right. */
export interface ActRow {
  /** The probability that acting is right, as the policy read it: what `actAbove` is set on. */
  readonly go: number;
  /** Whether acting was right (`actWasRight`). */
  readonly right: boolean;
  /**
   * The group the row belongs to (a session, a template, a conversation). Rows that share a key
   * are one unit of evidence; a row without one is a unit of its own.
   */
  readonly group?: string;
}

/**
 * The default edges: 19 of them, 0.95 down to 0.05 in steps of 0.05, on the act-side probability.
 * They are fixed in code so that no label can choose them. A coarse grid gave the most reliable
 * found bars in simulation: a 99-edge sequence keeps stepping down until just before the first
 * error, so the bar lands where the sample was luckiest (22% of its found bars below a 98%
 * promise at 500 rows, against 3% on these 19). There is no edge at 0, which would mean acting on
 * everything.
 */
export const EXACT_BAR_EDGES: readonly number[] = Object.freeze(
  Array.from({ length: 19 }, (_, i) => (19 - i) / 20),
);

export interface ExactBarOptions {
  /** Precision promised on the acts the gate takes, in (0, 1). */
  readonly target: number;
  /**
   * One-sided confidence of each test, in (0, 1). Default 0.95, the acceptance test's level: the
   * same mathematics (`exactLowerBound`, `requiredActs`) at the same level.
   */
  readonly confidence?: number;
  /**
   * The edges to walk, highest first: strictly descending probabilities in [0, 1]. Default
   * `EXACT_BAR_EDGES`. Choose them before reading any label; edges picked after seeing where the
   * errors fall void the guarantee.
   */
  readonly edges?: readonly number[];
  /**
   * Units at or above each edge, counted from rows independent of the labelled fit rows (every
   * shadow row of the configuration, labelled or not, grouped as the fit rows are), one count per
   * edge in `edges` order and never larger at a higher edge. When given, the start rule reads
   * these instead of the fit units' own counts, which keeps the guarantee exact for the true
   * precision. They choose the start edge only; every test reads the fit units.
   */
  readonly startCounts?: readonly number[];
}

/** The exact test at one edge, on the units at or above it. */
export interface EdgeTest {
  readonly edge: number;
  /** Units acting at the edge: a row at or above it, or a group with any row at or above it. */
  readonly units: number;
  /** Units wrong at the edge: a wrong row at or above it, or a group with one. */
  readonly wrong: number;
  /** Rows at or above the edge. */
  readonly rows: number;
  /** The exact one-sided lower bound on the share of acting units that were right. */
  readonly lowerBound: number;
  /** True when `lowerBound` reaches the target. */
  readonly accepted: boolean;
}

interface ExactBarCommon {
  readonly target: number;
  readonly confidence: number;
  /**
   * What one observation is. "row" when no row names a group: the result then assumes rows are
   * independent. "group" when any does: each group counts once, and a row without one is a group
   * of its own.
   */
  readonly unit: "row" | "group";
  /** Rows read. */
  readonly rows: number;
  /** Units they form: N rows are about this many independent observations. */
  readonly units: number;
  /** Rows per unit: the design effect in plain words. 1 for row units; 0 when there are none. */
  readonly rowsPerUnit: number;
  /**
   * Units a bar needs in its tail with none wrong (`requiredActs(target, confidence, 0)`): 59 at
   * 95%, 149 at 98%.
   */
  readonly needed: number;
  /** The edges walked, highest first. */
  readonly edges: readonly number[];
  /**
   * Whose counts chose the start edge: "fit" when the fit units' own (the default), "independent"
   * when `startCounts` supplied them. Only "independent" makes the guarantee exact for the true
   * precision; see `fitExactBar`.
   */
  readonly startFrom: "fit" | "independent";
  /** Units in the largest tail by the counts the start rule read: the lowest edge's. */
  readonly largestTail: number;
  /** The start edge: the highest whose tail holds `needed` units. Absent when none does. */
  readonly start?: number;
  /** Every edge tested, in walk order. The last one failed unless the walk ran out of edges. */
  readonly tested: readonly EdgeTest[];
}

/** A bar was found: the last edge the walk accepted. */
export interface ExactBarFound extends ExactBarCommon {
  /** The bar to act at: act when the act-side probability is at or above it. */
  readonly bar: number;
  /** The test at the bar: its units, wrong units, rows and exact lower bound. */
  readonly tail: EdgeTest;
  /**
   * True when the bar is the start edge itself, or its tail holds fewer than 1.5 times `needed`
   * units: found at the edge of power, where a found bar is least reliable (at 500 rows and a 98%
   * promise, 85% of the bars today's scan found were below it). A heuristic from simulation, not
   * a theorem: its trigger and its 1.5 have not been tested on their own.
   */
  readonly provisional: boolean;
}

/** No bar: why, in one sentence. */
export interface ExactBarNone extends ExactBarCommon {
  readonly bar?: undefined;
  readonly reason: string;
}

export type ExactBar = ExactBarFound | ExactBarNone;

/**
 * Fit the act bar by fixed-sequence testing over preset edges, with an exact binomial test at
 * each. The procedure:
 *
 * 1. Units. Rows that share a `group` are one unit. A group acts at an edge when any of its rows
 *    reaches it (its largest `go` is at or above the edge), and it is wrong there when any of its
 *    wrong rows reaches it. Rows without a group are units of their own.
 * 2. Start, from counts only, never labels: the highest edge whose tail holds `needed` units, the
 *    fewest with which a tail with no wrong unit can pass. If no edge holds that many there is no
 *    bar, and the reason says how many a bar needs and how many the largest tail holds.
 * 3. Walk down from the start. Accept an edge while the exact (Clopper-Pearson) lower bound on its
 *    tail reaches the target, equivalently P(Bin(units, 1 - target) <= wrong) <= 1 - confidence.
 *    Stop at the first edge that fails; edges below it are never tested, however they would come
 *    out. The bar is the last accepted edge.
 *
 * What it guarantees. Fixed-sequence testing controls the family-wise error rate at 1 -
 * confidence without a multiplicity correction, because the order was set before the data: a
 * wrong bar needs the first false hypothesis in the order to be accepted, and that happens with
 * probability at most 1 - confidence. So, for independent and identically distributed units and
 * a start edge fixed independently of them, P(a bar is found and the precision of acting at it is
 * below the target) <= 1 - confidence, whatever the shape of the precision curve.
 *
 * The start rule is not unconditionally exact. When the counts that choose it come from rows
 * independent of the labelled fit rows (`startCounts`, for example every shadow row of the
 * configuration, labelled or not), the start edge is fixed independently of the fit sample and
 * the guarantee holds exactly for the true precision. When it is chosen from the fit units' own
 * counts (the default), the test is exact for the precision of that tail's own mix of rows and
 * only approximate for the true precision; the simulations saw 0.0% to 2.5% violations at a 5%
 * level. `startFrom` says which counts chose it.
 *
 * With groups as units, the promise is about groups: at most 1 - target of acting groups contain
 * a wrong act. It bounds row-level precision only when groups that err do not act on more rows
 * than acting groups do on average (as when variants share a label), or when one row is taken per
 * group. Rows treated as units when they cluster overstate the evidence: in simulation (500 rows
 * in groups of ten, within-group correlation 0.6) this fit on rows broke a 95% promise 9% of the
 * time and today's scan 17%, while counting groups broke it in no run.
 *
 * Throws on a target, confidence, edges, start counts or row out of range.
 */
export function fitExactBar(rows: readonly ActRow[], opts: ExactBarOptions): ExactBar {
  const target = opts.target;
  const confidence = opts.confidence ?? 0.95;
  // Validates target and confidence: both strictly between 0 and 1.
  const needed = requiredActs(target, confidence, 0);
  const edges = opts.edges === undefined ? EXACT_BAR_EDGES : checkedEdges(opts.edges);
  const startCounts =
    opts.startCounts === undefined ? undefined : checkedStartCounts(opts.startCounts, edges);
  const units = unitsOf(rows);
  const tails = edges.map((edge) => tailAt(units, edge));
  const counts = startCounts ?? tails.map((t) => t.units);
  const startFrom = startCounts === undefined ? "fit" : "independent";
  const largestTail = counts[counts.length - 1] ?? 0;
  const startIndex = counts.findIndex((n) => n >= needed);
  const word = units.unit === "group" ? "groups" : "rows";
  const common = {
    target,
    confidence,
    unit: units.unit,
    rows: rows.length,
    units: units.count,
    rowsPerUnit: units.count === 0 ? 0 : rows.length / units.count,
    needed,
    edges: edges.slice(),
    startFrom,
    largestTail,
  } as const;
  if (startIndex < 0) {
    const where = startFrom === "independent" ? " by the independent counts" : "";
    return {
      ...common,
      tested: [],
      reason: `no act bar: too few ${word} for a ${pct(target)} promise; a bar needs ${needed} ${word} at or above it with none wrong, and the largest tail${where} holds ${largestTail}`,
    };
  }
  const tested: EdgeTest[] = [];
  let barIndex = -1;
  for (let i = startIndex; i < edges.length; i++) {
    const t = tails[i] as Tail;
    const lowerBound = exactLowerBound(t.units - t.wrong, t.units, confidence);
    const accepted = lowerBound >= target;
    tested.push({ edge: edges[i] as number, ...t, lowerBound, accepted });
    if (!accepted) break;
    barIndex = i;
  }
  const start = edges[startIndex] as number;
  if (barIndex < 0) {
    const first = tested[0] as EdgeTest;
    const erred =
      units.unit === "group"
        ? "held a wrong act"
        : `${first.wrong === 1 ? "was" : "were"} wrong to act on`;
    const why =
      first.wrong === 0 && first.units < needed
        ? `the start edge ${dec(start)}, chosen by the independent counts, has ${first.units} labelled ${word} at or above it, and a bar needs ${needed} with none wrong`
        : `at the start edge ${dec(start)}, ${first.wrong} of the ${first.units} ${word} at or above it ${erred}, so the exact lower bound ${pct(first.lowerBound)} is below the ${pct(target)} promise`;
    return { ...common, start, tested, reason: `no act bar: ${why}` };
  }
  const tail = tested[barIndex - startIndex] as EdgeTest;
  return {
    ...common,
    start,
    tested,
    bar: tail.edge,
    tail,
    provisional: barIndex === startIndex || tail.units < 1.5 * needed,
  };
}

interface Units {
  readonly unit: "row" | "group";
  readonly count: number;
  /** Each unit's largest go, highest first. */
  readonly tops: readonly number[];
  /** Each unit's largest go among its wrong rows, highest first; units with none are left out. */
  readonly wrongTops: readonly number[];
  /** Every row's go, highest first. */
  readonly gos: readonly number[];
}

function unitsOf(rows: readonly ActRow[]): Units {
  const groups = new Map<string, { top: number; wrongTop: number }>();
  const tops: number[] = [];
  const wrongTops: number[] = [];
  const gos: number[] = [];
  let grouped = false;
  rows.forEach((r, i) => {
    const go = r.go;
    if (typeof go !== "number" || !(go >= 0 && go <= 1)) {
      throw new Error(`row ${i}: go must be a probability in [0, 1]`);
    }
    if (typeof r.right !== "boolean") throw new Error(`row ${i}: right must be a boolean`);
    if (r.group !== undefined && typeof r.group !== "string") {
      throw new Error(`row ${i}: group must be a string`);
    }
    gos.push(go);
    if (r.group === undefined) {
      tops.push(go);
      if (!r.right) wrongTops.push(go);
      return;
    }
    grouped = true;
    const g = groups.get(r.group) ?? { top: -1, wrongTop: -1 };
    g.top = Math.max(g.top, go);
    if (!r.right) g.wrongTop = Math.max(g.wrongTop, go);
    groups.set(r.group, g);
  });
  for (const g of groups.values()) {
    tops.push(g.top);
    if (g.wrongTop >= 0) wrongTops.push(g.wrongTop);
  }
  const desc = (a: number, b: number) => b - a;
  tops.sort(desc);
  return {
    unit: grouped ? "group" : "row",
    count: tops.length,
    tops,
    wrongTops: wrongTops.sort(desc),
    // With no group every row is a unit, and its own top.
    gos: grouped ? gos.sort(desc) : tops,
  };
}

interface Tail {
  readonly units: number;
  readonly wrong: number;
  readonly rows: number;
}

function tailAt(u: Units, edge: number): Tail {
  return {
    units: atOrAbove(u.tops, edge),
    wrong: atOrAbove(u.wrongTops, edge),
    rows: atOrAbove(u.gos, edge),
  };
}

/** How many of `desc` (sorted highest first) are at or above `edge`. */
function atOrAbove(desc: readonly number[], edge: number): number {
  let lo = 0;
  let hi = desc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((desc[mid] as number) >= edge) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function checkedEdges(edges: readonly number[]): readonly number[] {
  if (!Array.isArray(edges) || edges.length === 0) throw new Error("edges must not be empty");
  edges.forEach((e, i) => {
    if (typeof e !== "number" || !(e >= 0 && e <= 1)) {
      throw new Error(`edges must be probabilities in [0, 1]; edge ${i} is ${String(e)}`);
    }
    if (i > 0 && !(e < (edges[i - 1] as number))) {
      throw new Error("edges must be strictly descending, highest first");
    }
  });
  return edges;
}

function checkedStartCounts(
  counts: readonly number[],
  edges: readonly number[],
): readonly number[] {
  if (!Array.isArray(counts) || counts.length !== edges.length) {
    throw new Error(`startCounts must hold one count per edge (${edges.length})`);
  }
  counts.forEach((n, i) => {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`startCounts must be counts; count ${i} is ${String(n)}`);
    }
    // A tail at a higher edge is contained in the tail at a lower one.
    if (i > 0 && n < (counts[i - 1] as number)) {
      throw new Error("startCounts must never be larger at a higher edge");
    }
  });
  return counts;
}

/** Which rows `actRows` reads, and how it groups them. */
export type ActRowOptions = ScoreOptions & {
  /** Which side of a judge question is go, for a row that cannot tell. Default the gate's majority. */
  readonly goIsYes?: boolean;
  /**
   * Rows sharing a tag with this prefix (for example "session:") form one group, keyed by the
   * first such tag, as `AcceptancePlan.group` reads them. A row without such a tag has no group.
   */
  readonly group?: { readonly tagPrefix: string };
};

/**
 * Labelled rows on the act side, with their group: exactly `scoredForAct`'s rows (the same trust
 * filter; floored, bypassed and failed-open rows skipped; each judge row read on the side its
 * policy acted on; the same `unselectedOnly`), as `go` and `right` in place of `confidence` and
 * `correct`. Each row is read through `scoredForAct` itself, with the gate's polarity fixed first
 * over all the rows, so the two cannot drift apart. Throws on an empty group prefix.
 */
export function actRows(records: readonly DecisionRecord[], opts: ActRowOptions = {}): ActRow[] {
  const { group, ...score } = opts;
  const prefix = group?.tagPrefix;
  if (prefix !== undefined && (typeof prefix !== "string" || prefix.trim() === "")) {
    throw new Error("group tagPrefix must be non-empty");
  }
  const goIsYes = score.goIsYes ?? inferGoIsYes(records).goIsYes;
  return records.flatMap((r) => {
    const [s] = scoredForAct([r], { ...score, goIsYes });
    if (s === undefined) return [];
    const key = prefix === undefined ? undefined : r.tags.find((t) => t.startsWith(prefix));
    return [{ go: s.confidence, right: s.correct, ...(key !== undefined ? { group: key } : {}) }];
  });
}

/** One stratum's evidence at the bar, and how much of deployment it is. */
export interface StratumEvidence {
  /**
   * Deployment acts in the stratum over the reporting window, counted from every ask without
   * labels, or any non-negative weight proportional to them.
   */
  readonly acts: number;
  /** Labelled units at or above the bar in the stratum. */
  readonly units: number;
  /** Of those, the ones wrong to act on. */
  readonly wrong: number;
}

export interface StratumBound extends StratumEvidence {
  /** The stratum's share of deployment acts. */
  readonly share: number;
  /** Its exact lower bound, at `stratumConfidence`; 0 when it holds no labelled unit. */
  readonly lowerBound: number;
}

export interface StratifiedBound {
  /** The deployment-weighted lower bound: sum(acts * lowerBound) / sum(acts). */
  readonly lowerBound: number;
  /** The confidence the whole bound holds at. */
  readonly confidence: number;
  /** The confidence each stratum's bound is read at: 1 - (1 - confidence) / K for K strata. */
  readonly stratumConfidence: number;
  readonly strata: readonly StratumBound[];
  /** Labelled units across the strata. */
  readonly units: number;
  /**
   * The Kish effective sample size of the reweighting: (sum w)^2 / sum w^2, with each unit in
   * stratum s weighted (acts_s / sum acts) / (units_s / sum units). Units are worth this many
   * once they are read for the deployment mix rather than the fit mix.
   */
  readonly effectiveUnits: number;
}

/**
 * Read the evidence at a bar for the deployment mix, not the mix the labels happened to come in.
 * Each stratum's exact (Clopper-Pearson) lower bound is read at 1 - (1 - confidence) / K for K
 * strata, so by Bonferroni all of them hold at once with probability at least `confidence`, and
 * so does their deployment-weighted average: sum(acts * lowerBound) / sum(acts). A thin stratum
 * with a large share drags the bound down, which is the right behaviour: it says where to label
 * next, or which stratum to floor. The acts are the window's counts; read as a forecast of future
 * traffic they are estimates themselves. Compute strata in code from trusted fields only, so that
 * untrusted text cannot steer a request into a well-evidenced stratum.
 *
 * Undefined when no stratum has a deployment act. Throws on a confidence, count or weight out of
 * range.
 */
export function stratifiedBound(
  strata: readonly StratumEvidence[],
  confidence = 0.95,
): StratifiedBound | undefined {
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error("confidence must be strictly between 0 and 1");
  }
  if (!Array.isArray(strata) || strata.length === 0) throw new Error("strata must not be empty");
  strata.forEach((s, i) => {
    if (typeof s.acts !== "number" || !Number.isFinite(s.acts) || s.acts < 0) {
      throw new Error(`stratum ${i}: acts must be a finite non-negative number`);
    }
    if (!Number.isSafeInteger(s.units) || s.units < 0) {
      throw new Error(`stratum ${i}: units must be a count`);
    }
    if (!Number.isSafeInteger(s.wrong) || s.wrong < 0 || s.wrong > s.units) {
      throw new Error(`stratum ${i}: wrong must be a count no larger than units`);
    }
  });
  const totalActs = strata.reduce((sum, s) => sum + s.acts, 0);
  if (!(totalActs > 0)) return undefined;
  const stratumConfidence = 1 - (1 - confidence) / strata.length;
  const read = strata.map((s) => ({
    acts: s.acts,
    units: s.units,
    wrong: s.wrong,
    share: s.acts / totalActs,
    lowerBound: exactLowerBound(s.units - s.wrong, s.units, stratumConfidence),
  }));
  // Kish over units: a stratum with no labelled unit carries no weight, only a bound of 0.
  let carried = 0;
  let spread = 0;
  for (const s of read) {
    if (s.units === 0) continue;
    carried += s.share;
    spread += (s.share * s.share) / s.units;
  }
  return {
    lowerBound: read.reduce((sum, s) => sum + s.share * s.lowerBound, 0),
    confidence,
    stratumConfidence,
    strata: read,
    units: read.reduce((sum, s) => sum + s.units, 0),
    effectiveUnits: spread === 0 ? 0 : (carried * carried) / spread,
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const dec = (x: number): string => x.toFixed(2);
