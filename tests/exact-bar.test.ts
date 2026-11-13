import { describe, expect, it } from "vitest";
import { exactLowerBound, requiredActs } from "../src/acceptance.ts";
import { fitThreshold, type ScoreOptions, scoredForAct } from "../src/ledger/calibration.ts";
import {
  type ActRow,
  actRows,
  EXACT_BAR_EDGES,
  type ExactBar,
  fitExactBar,
  stratifiedBound,
} from "../src/ledger/exact-bar.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { trustRegistry } from "../src/ledger/sources.ts";
import { type Rand, randNormal, rng } from "../src/math.ts";

/** `n` rows at `go`, all right or all wrong, in `group` when one is named. */
const at = (n: number, go: number, right = true, group?: string): ActRow[] =>
  Array.from({ length: n }, () => ({ go, right, ...(group !== undefined ? { group } : {}) }));

function found(r: ExactBar): Extract<ExactBar, { bar: number }> {
  if (r.bar === undefined) throw new Error(`expected a bar, got: ${r.reason}`);
  return r;
}

function none(r: ExactBar): Extract<ExactBar, { reason: string }> {
  if (r.bar !== undefined) throw new Error(`expected no bar, got ${r.bar}`);
  return r;
}

describe("the exact fixed-sequence act bar", () => {
  it("uses 19 preset edges and the acceptance test's sample size", () => {
    expect(EXACT_BAR_EDGES).toHaveLength(19);
    expect(EXACT_BAR_EDGES[0]).toBe(0.95);
    expect(EXACT_BAR_EDGES.at(-1)).toBe(0.05);
    expect(Object.isFrozen(EXACT_BAR_EDGES)).toBe(true);
    const r = fitExactBar([], { target: 0.98 });
    expect(r.needed).toBe(requiredActs(0.98, 0.95, 0));
    expect(r.needed).toBe(149);
    expect(fitExactBar([], { target: 0.95 }).needed).toBe(59);
  });

  it("finds a bar on a clean tail of exactly n_min units, and its bound is exactLowerBound's", () => {
    // 59 clean rows at 0.97 and nothing else: every edge's tail is those 59, so the walk accepts
    // all 19 and runs out of edges.
    const r = found(fitExactBar(at(59, 0.97), { target: 0.95 }));
    expect(r.start).toBe(0.95);
    expect(r.bar).toBe(0.05);
    expect(r.tested).toHaveLength(19);
    expect(r.tested.every((t) => t.accepted)).toBe(true);
    expect(r.tail).toMatchObject({ edge: 0.05, units: 59, wrong: 0, rows: 59 });
    expect(r.tail.lowerBound).toBe(exactLowerBound(59, 59, 0.95));
    expect(r.tail.lowerBound).toBeCloseTo(0.05 ** (1 / 59), 12);
    // 59 is under 1.5 times n_min: found at the edge of power.
    expect(r.provisional).toBe(true);
    expect(r).toMatchObject({ unit: "row", rows: 59, units: 59, rowsPerUnit: 1, startFrom: "fit" });
  });

  it("stops at the first wrong edge below a clean start", () => {
    // 59 clean at 0.97, then 20 wrong at exactly 0.50: edges 0.95 to 0.55 pass, 0.50 fails.
    const r = found(fitExactBar([...at(59, 0.97), ...at(20, 0.5, false)], { target: 0.95 }));
    expect(r.start).toBe(0.95);
    expect(r.bar).toBe(0.55);
    expect(r.tested.map((t) => t.edge)).toEqual([
      0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5,
    ]);
    expect(r.tested.at(-1)).toMatchObject({ edge: 0.5, units: 79, wrong: 20, accepted: false });
    expect(r.tested.at(-1)?.lowerBound).toBe(exactLowerBound(59, 79, 0.95));
  });

  it("finds none one unit short of n_min, and says what a bar needs", () => {
    const r = none(fitExactBar(at(58, 0.97), { target: 0.95 }));
    expect(r.start).toBeUndefined();
    expect(r.tested).toEqual([]);
    expect(r.largestTail).toBe(58);
    expect(r.reason).toBe(
      "no act bar: too few rows for a 95.0% promise; a bar needs 59 rows at or above it with none wrong, and the largest tail holds 58",
    );
  });

  it("finds none when the start tail holds one wrong unit", () => {
    // 80 rows at 0.97, one wrong: the start is 0.95 and its exact bound is about 0.942.
    const rows = [...at(79, 0.97), ...at(1, 0.97, false)];
    const r = none(fitExactBar(rows, { target: 0.95 }));
    const lower = exactLowerBound(79, 80, 0.95);
    expect(lower).toBeLessThan(0.95);
    expect(r.start).toBe(0.95);
    expect(r.tested).toEqual([
      { edge: 0.95, units: 80, wrong: 1, rows: 80, lowerBound: lower, accepted: false },
    ]);
    expect(r.reason).toBe(
      `no act bar: at the start edge 0.95, 1 of the 80 rows at or above it was wrong to act on, so the exact lower bound ${(100 * lower).toFixed(1)}% is below the 95.0% promise`,
    );
  });

  it("never tests below the first failing edge, even when a lower edge would pass", () => {
    // 59 clean at 0.97, one wrong at 0.92, 300 clean at 0.87. Edge 0.95 passes, 0.90 fails
    // (one wrong in 60), and 0.85 would pass (one wrong in 360) but is never tested.
    const rows = [...at(59, 0.97), ...at(1, 0.92, false), ...at(300, 0.87)];
    expect(exactLowerBound(359, 360, 0.95)).toBeGreaterThan(0.95);
    const r = found(fitExactBar(rows, { target: 0.95 }));
    expect(r.bar).toBe(0.95);
    expect(r.tested.map((t) => [t.edge, t.accepted])).toEqual([
      [0.95, true],
      [0.9, false],
    ]);
    // The bar is the start edge itself, so it is provisional.
    expect(r.provisional).toBe(true);
    // Today's scan keeps the lowest bar that clears, past the failure above it.
    const scan = fitThreshold(
      rows.map((x) => ({ confidence: x.go, correct: x.right })),
      0.95,
      30,
      { conservative: true },
    );
    expect(scan?.threshold).toBe(0.87);
  });

  it("is not provisional with a tail of 1.5 n_min below the start", () => {
    const rows = [...at(59, 0.97), ...at(100, 0.92), ...at(30, 0.3, false)];
    const r = found(fitExactBar(rows, { target: 0.95 }));
    expect(r.bar).toBe(0.35);
    expect(r.tail).toMatchObject({ units: 159, wrong: 0 });
    expect(r.provisional).toBe(false);
  });

  it("reads each test at the confidence asked for", () => {
    const rows = [...at(49, 0.97), ...at(1, 0.97, false), ...at(10, 0.5)];
    const r = fitExactBar(rows, { target: 0.92, confidence: 0.9 });
    expect(r.needed).toBe(requiredActs(0.92, 0.9, 0));
    expect(r.tested[0]?.lowerBound).toBe(exactLowerBound(49, 50, 0.9));
    expect(r.confidence).toBe(0.9);
  });
});

describe("groups as units", () => {
  it("counts ten rows of one group once", () => {
    // 58 singletons and one group of ten: 59 units, enough for a bar at 95%.
    const rows = [...at(58, 0.97), ...at(10, 0.97, true, "session:a")];
    const r = found(fitExactBar(rows, { target: 0.95 }));
    expect(r).toMatchObject({ unit: "group", rows: 68, units: 59 });
    expect(r.rowsPerUnit).toBeCloseTo(68 / 59, 12);
    expect(r.tail).toMatchObject({ units: 59, rows: 68 });
    // Read as rows, the same evidence would count 68.
    const asRows = found(
      fitExactBar(
        rows.map(({ go, right }) => ({ go, right })),
        { target: 0.95 },
      ),
    );
    expect(asRows.units).toBe(68);
    // One singleton fewer and there is no bar, said in groups.
    const short = none(fitExactBar(rows.slice(1), { target: 0.95 }));
    expect(short.reason).toBe(
      "no act bar: too few groups for a 95.0% promise; a bar needs 59 groups at or above it with none wrong, and the largest tail holds 58",
    );
  });

  it("makes a group wrong when any wrong row reaches the edge", () => {
    // 59 groups of two rows at 0.97; one group's second row is wrong at 0.96.
    const rows = Array.from({ length: 59 }, (_, g) => [
      { go: 0.97, right: true, group: `g${g}` },
      { go: g === 0 ? 0.96 : 0.97, right: g !== 0, group: `g${g}` },
    ]).flat();
    const r = none(fitExactBar(rows, { target: 0.95 }));
    expect(r.tested[0]).toMatchObject({ edge: 0.95, units: 59, wrong: 1, rows: 118 });
    expect(r.reason).toContain("1 of the 59 groups at or above it held a wrong act");
    expect(r.reason).not.toContain("rows");
  });

  it("acts on a group at its highest row and counts a wrong row only from its own edge", () => {
    // A group that acts at 0.97 holds a wrong row at 0.40: right at every edge above 0.40.
    const rows = [
      ...Array.from({ length: 58 }, (_, g) => ({ go: 0.97, right: true, group: `g${g}` })),
      { go: 0.97, right: true, group: "mixed" },
      { go: 0.4, right: false, group: "mixed" },
    ];
    const r = found(fitExactBar(rows, { target: 0.95 }));
    expect(r.bar).toBe(0.45);
    const at40 = r.tested.at(-1);
    expect(at40).toMatchObject({ edge: 0.4, units: 59, wrong: 1, rows: 60, accepted: false });
    expect(r.tested.find((t) => t.edge === 0.45)).toMatchObject({ units: 59, wrong: 0, rows: 59 });
  });
});

describe("the start rule from independent counts", () => {
  it("starts where the independent counts first hold n_min and says so", () => {
    const counts = EXACT_BAR_EDGES.map((e) => (e >= 0.9 ? 10 : 200));
    const r = found(fitExactBar(at(200, 0.97), { target: 0.95, startCounts: counts }));
    expect(r.startFrom).toBe("independent");
    expect(r.start).toBe(0.85);
    expect(r.tested[0]?.edge).toBe(0.85);
    expect(r.largestTail).toBe(200);
    expect(found(fitExactBar(at(200, 0.97), { target: 0.95 })).start).toBe(0.95);
  });

  it("fails a start whose labelled tail is too small, and names the independent counts", () => {
    const counts = EXACT_BAR_EDGES.map(() => 100);
    const r = none(fitExactBar(at(40, 0.97), { target: 0.95, startCounts: counts }));
    expect(r.reason).toBe(
      "no act bar: the start edge 0.95, chosen by the independent counts, has 40 labelled rows at or above it, and a bar needs 59 with none wrong",
    );
    const few = none(
      fitExactBar(at(100, 0.97), { target: 0.95, startCounts: EXACT_BAR_EDGES.map(() => 30) }),
    );
    expect(few.reason).toBe(
      "no act bar: too few rows for a 95.0% promise; a bar needs 59 rows at or above it with none wrong, and the largest tail by the independent counts holds 30",
    );
  });

  it("validates the counts: one per edge, never larger at a higher edge", () => {
    const withCounts = (startCounts: readonly number[]) =>
      fitExactBar(at(60, 0.97), { target: 0.95, startCounts });
    expect(() => withCounts([1, 2, 3])).toThrow(/one count per edge \(19\)/);
    expect(() => withCounts(EXACT_BAR_EDGES.map((_, i) => 100 - i))).toThrow(/never be larger/);
    expect(() => withCounts(EXACT_BAR_EDGES.map(() => 1.5))).toThrow(/must be counts/);
    expect(() => withCounts(EXACT_BAR_EDGES.map(() => -1))).toThrow(/must be counts/);
  });
});

describe("custom edges and validation", () => {
  it("walks the edges a caller fixes", () => {
    const r = found(
      fitExactBar([...at(80, 0.97), ...at(5, 0.6, false)], {
        target: 0.95,
        edges: [0.9, 0.8, 0.5],
      }),
    );
    expect(r.edges).toEqual([0.9, 0.8, 0.5]);
    expect(r.bar).toBe(0.8);
    expect(r.tested.map((t) => t.edge)).toEqual([0.9, 0.8, 0.5]);
  });

  it("refuses edges that are empty, out of range or not strictly descending", () => {
    const withEdges = (edges: readonly number[]) =>
      fitExactBar(at(60, 0.97), { target: 0.95, edges });
    expect(() => withEdges([])).toThrow(/must not be empty/);
    expect(() => withEdges([0.9, 0.9])).toThrow(/strictly descending/);
    expect(() => withEdges([0.5, 0.9])).toThrow(/strictly descending/);
    expect(() => withEdges([1.2, 0.5])).toThrow(/probabilities in \[0, 1\]/);
    expect(() => withEdges([0.9, Number.NaN])).toThrow(/probabilities in \[0, 1\]/);
  });

  it("refuses a target, a confidence or a row out of range", () => {
    expect(() => fitExactBar([], { target: 1 })).toThrow(/target/);
    expect(() => fitExactBar([], { target: 0.95, confidence: 1.2 })).toThrow(/confidence/);
    expect(() => fitExactBar([{ go: Number.NaN, right: true }], { target: 0.95 })).toThrow(
      /row 0: go must be a probability/,
    );
    expect(() => fitExactBar([{ go: 1.01, right: true }], { target: 0.95 })).toThrow(/row 0/);
    const bad = [{ go: 0.9, right: "yes" }] as unknown as ActRow[];
    expect(() => fitExactBar(bad, { target: 0.95 })).toThrow(/right must be a boolean/);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading ledger rows.

const template: DecisionRecord = {
  id: "",
  at: "2026-11-12T00:00:00.000Z",
  gateId: "g",
  requestId: "",
  questionId: "q",
  kind: "judge",
  prompt: "ok?",
  questionHash: "0000000000000000",
  stateHash: "",
  trustedHash: "",
  untrusted: [],
  oracle: "fixed",
  strategy: "single",
  verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
  go: 0.9,
  confidence: 0.9,
  agreement: 1,
  soft: "act",
  action: "review",
  mode: "shadow",
  cost: 0,
  latencyMs: 0,
  failedOpen: false,
  tags: [],
};

let seq = 0;
/** A judge row ruled with `goIsYes`, labelled with `truth` unless `label` says otherwise. */
function judgeRow(
  pYes: number,
  goIsYes: boolean,
  truth: boolean | undefined,
  extra: Partial<DecisionRecord> & { readonly source?: string; readonly correct?: boolean } = {},
): DecisionRecord {
  const { source, correct, ...rest } = extra;
  const id = `r${seq++}`;
  return {
    ...template,
    id,
    requestId: id,
    stateHash: id,
    verdict: { kind: "judge", questionId: "q", pYes, confidence: Math.max(pYes, 1 - pYes) },
    go: goIsYes ? pYes : 1 - pYes,
    confidence: Math.max(pYes, 1 - pYes),
    ...(truth !== undefined || correct !== undefined
      ? {
          outcome: {
            at: template.at,
            correct: correct ?? pYes >= 0.5 === truth,
            ...(truth !== undefined ? { truth } : {}),
            ...(source !== undefined ? { source } : {}),
          },
        }
      : {}),
    ...rest,
  };
}

function pickRow(
  confidence: number,
  correct: boolean | undefined,
  extra: Partial<DecisionRecord> = {},
) {
  const id = `r${seq++}`;
  return {
    ...template,
    id,
    requestId: id,
    stateHash: id,
    kind: "pick",
    verdict: {
      kind: "pick",
      questionId: "q",
      choice: "a",
      probabilities: { a: confidence, b: 1 - confidence },
      confidence,
    },
    go: confidence,
    confidence,
    ...(correct !== undefined ? { outcome: { at: template.at, correct } } : {}),
    ...extra,
  } as DecisionRecord;
}

/** Every kind of row the act-side reader must read or skip, on a gate whose go side is `side`. */
function mixedGate(side: boolean): DecisionRecord[] {
  return [
    // The gate's own side, labelled with a truth, right and wrong, shadow and enforce.
    ...[0.95, 0.8, 0.62, 0.3, 0.1].map((p, i) => judgeRow(p, side, i % 2 === 0)),
    judgeRow(0.85, side, true, { mode: "enforce" }),
    judgeRow(0.15, side, false, { mode: "enforce", tags: ["audit"] }),
    // A minority on the other side, and rows labelled without a truth (only `correct`).
    judgeRow(0.7, !side, true),
    judgeRow(0.4, !side, false),
    judgeRow(0.75, side, undefined, { correct: true }),
    judgeRow(0.25, side, undefined, { correct: false }),
    // An exact 0.5 and a go that matches neither side: the gate's majority decides.
    judgeRow(0.5, side, true),
    judgeRow(0.66, side, true, { go: 0.42 }),
    // Rows that must be skipped by default, and some read only by other options.
    judgeRow(0.9, side, true, { strategy: "floored" }),
    judgeRow(0.9, side, true, { strategy: "bypass" }),
    judgeRow(0.9, side, true, { failedOpen: true }),
    judgeRow(0.9, side, undefined),
    judgeRow(0.9, side, false, { source: "reverted:git" }),
    judgeRow(0.88, side, true, { source: "desk:assisted" }),
    judgeRow(0.87, side, true, { source: "Reverted:git" }),
    judgeRow(0.86, side, false, { source: "review:blind" }),
    judgeRow(0.84, side, true, { source: "team:qa" }),
    judgeRow(0.83, side, true, { tags: ["chain", "chain:attempt:2"] }),
    judgeRow(0.82, side, true, { mode: "enforce", tags: ["chain:attempt:1"] }),
    // Pick rows act on the leading answer.
    pickRow(0.9, true),
    pickRow(0.55, false, { mode: "enforce" }),
    pickRow(0.7, true, { tags: ["audit"] }),
  ];
}

describe("actRows reads exactly scoredForAct's rows", () => {
  const options: (ScoreOptions & { readonly goIsYes?: boolean })[] = [
    {},
    { unselectedOnly: true },
    { goIsYes: true },
    { goIsYes: false },
    { sources: ["blind", "census", "moment", "unknown"] },
    { sources: ["consequence"] },
    { sources: ["unregistered"] },
    { trust: trustRegistry({ "team:qa": "blind" }) },
    { trust: trustRegistry({ "team:qa": "blind" }), unselectedOnly: true },
  ];

  for (const side of [true, false]) {
    it(`on a gate whose go side is ${side ? "yes" : "no"}`, () => {
      const rows = mixedGate(side);
      for (const opts of options) {
        const expected = scoredForAct(rows, opts);
        const got = actRows(rows, opts);
        expect(
          got.map((r) => ({ confidence: r.go, correct: r.right })),
          JSON.stringify(opts),
        ).toEqual(expected);
        expect(got.every((r) => r.group === undefined)).toBe(true);
      }
      // The fixture is not trivial: both outcomes, judge rows read on the "no" side, and skips.
      const all = actRows(rows);
      expect(all.length).toBeGreaterThan(10);
      expect(all.length).toBeLessThan(rows.length);
      expect(new Set(all.map((r) => r.right))).toEqual(new Set([true, false]));
      expect(all.some((r) => r.go === 0.95)).toBe(side);
      expect(all.some((r) => Math.abs(r.go - 0.05) < 1e-12)).toBe(!side);
    });
  }

  it("groups by the first tag with the prefix, as the acceptance plan does", () => {
    const rows = [
      judgeRow(0.9, true, true, { tags: ["chain", "session:a", "session:b"] }),
      judgeRow(0.8, true, true, { tags: ["session:a"] }),
      judgeRow(0.7, true, false, { tags: ["other"] }),
      judgeRow(0.6, true, true, { strategy: "floored", tags: ["session:c"] }),
    ];
    expect(actRows(rows, { group: { tagPrefix: "session:" } })).toEqual([
      { go: 0.9, right: true, group: "session:a" },
      { go: 0.8, right: true, group: "session:a" },
      { go: 0.7, right: false },
    ]);
    // An acceptance plan's group can be passed as it is.
    const plan = { group: { tagPrefix: "session:", maxPerGroup: 3 } };
    expect(actRows(rows, plan)).toEqual(actRows(rows, { group: { tagPrefix: "session:" } }));
    expect(() => actRows(rows, { group: { tagPrefix: " " } })).toThrow(/non-empty/);
  });
});

// ---------------------------------------------------------------------------------------------
// The stratified reading.

describe("the deployment-weighted bound over strata", () => {
  it("weights each stratum's Bonferroni bound by its deployment acts", () => {
    // The research's worked example: 180 rows in a 50/35/15 mix read for a 30/30/40 deployment.
    const strata = [
      { acts: 300, units: 90, wrong: 0 },
      { acts: 300, units: 63, wrong: 1 },
      { acts: 400, units: 27, wrong: 2 },
    ];
    const r = stratifiedBound(strata);
    if (!r) throw new Error("no bound");
    const level = 1 - 0.05 / 3;
    const bounds = strata.map((s) => exactLowerBound(s.units - s.wrong, s.units, level));
    expect(r.stratumConfidence).toBeCloseTo(level, 15);
    expect(r.strata.map((s) => s.lowerBound)).toEqual(bounds);
    expect(r.strata.map((s) => s.share)).toEqual([0.3, 0.3, 0.4]);
    const [b0, b1, b2] = bounds as [number, number, number];
    expect(r.lowerBound).toBeCloseTo(0.3 * b0 + 0.3 * b1 + 0.4 * b2, 15);
    expect(r.units).toBe(180);
    // Kish: unit weights 0.60, 0.86 and 2.67; about 120 effective units of 180 (research: 120).
    const weights = strata.flatMap((s) =>
      Array.from({ length: s.units }, () => s.acts / 1000 / (s.units / 180)),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const sumSq = weights.reduce((a, b) => a + b * b, 0);
    expect(r.effectiveUnits).toBeCloseTo((sum * sum) / sumSq, 9);
    expect(Math.round(r.effectiveUnits)).toBe(120);
  });

  it("is the plain exact bound for one stratum, and a thin stratum drags it down", () => {
    const one = stratifiedBound([{ acts: 7, units: 100, wrong: 1 }], 0.95);
    expect(one?.lowerBound).toBeCloseTo(exactLowerBound(99, 100, 0.95), 12);
    expect(one?.effectiveUnits).toBeCloseTo(100, 12);
    const thin = stratifiedBound([
      { acts: 50, units: 300, wrong: 0 },
      { acts: 50, units: 0, wrong: 0 },
    ]);
    expect(thin?.strata[1]?.lowerBound).toBe(0);
    expect(thin?.lowerBound).toBeCloseTo(0.5 * exactLowerBound(300, 300, 0.975), 15);
    // The empty stratum carries no units, so it adds nothing to the effective size.
    expect(thin?.effectiveUnits).toBeCloseTo(300, 9);
  });

  it("is undefined without deployment acts, and refuses counts out of range", () => {
    expect(stratifiedBound([{ acts: 0, units: 10, wrong: 0 }])).toBeUndefined();
    expect(() => stratifiedBound([])).toThrow(/must not be empty/);
    expect(() => stratifiedBound([{ acts: -1, units: 1, wrong: 0 }])).toThrow(/acts/);
    expect(() => stratifiedBound([{ acts: 1, units: 1.5, wrong: 0 }])).toThrow(/units/);
    expect(() => stratifiedBound([{ acts: 1, units: 1, wrong: 2 }])).toThrow(/wrong/);
    expect(() => stratifiedBound([{ acts: 1, units: 1, wrong: 0 }], 1)).toThrow(/confidence/);
  });
});

// ---------------------------------------------------------------------------------------------
// Clustered rows: the unit, not the search, is what breaks the promise.

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

// The research's model: 60% of rows are ones where acting is right, binormal scores with AUC 0.95
// (separation 2.326), stated probability sigmoid(z - 0.5).
const SHARE_RIGHT = 0.6;
const SEPARATION = 2.326;

/** Precision of acting at or above a bar on the stated probability, from the population model. */
function delivered(bar: number): number {
  const t = 0.5 + Math.log(bar / (1 - bar));
  const right = SHARE_RIGHT * normalTail(t - SEPARATION);
  const wrong = (1 - SHARE_RIGHT) * normalTail(t);
  return right / (right + wrong);
}

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
 * Rows in groups of 1 + Poisson(size - 1): a group shares its label and a score offset with
 * within-group correlation `rho`. Marginally each row follows the model above.
 */
function clustered(n: number, size: number, rho: number, rand: Rand): ActRow[] {
  const out: ActRow[] = [];
  for (let g = 0; out.length < n; g++) {
    const rows = Math.min(n - out.length, 1 + poisson(size - 1, rand));
    const right = rand() < SHARE_RIGHT;
    const offset = Math.sqrt(rho) * randNormal(rand);
    for (let i = 0; i < rows; i++) {
      const z = (right ? SEPARATION : 0) + offset + Math.sqrt(1 - rho) * randNormal(rand);
      out.push({ go: 1 / (1 + Math.exp(-(z - 0.5))), right, group: `g${g}` });
    }
  }
  return out;
}

function violations(size: number, rho: number, reps: number, seed: number) {
  const rand = rng(seed);
  const tally = { today: [0, 0], rows: [0, 0], groups: [0, 0] };
  const count = (t: number[], bar: number | undefined) => {
    if (bar === undefined) return;
    t[0] = (t[0] as number) + 1;
    if (delivered(bar) < 0.95) t[1] = (t[1] as number) + 1;
  };
  for (let k = 0; k < reps; k++) {
    const rows = clustered(500, size, rho, rand);
    const scored = rows.map((r) => ({ confidence: r.go, correct: r.right }));
    count(tally.today, fitThreshold(scored, 0.95, 30, { conservative: true })?.threshold);
    count(
      tally.rows,
      fitExactBar(
        rows.map(({ go, right }) => ({ go, right })),
        { target: 0.95 },
      ).bar,
    );
    count(tally.groups, fitExactBar(rows, { target: 0.95 }).bar);
  }
  const rate = (t: number[]) => ({
    found: (t[0] as number) / reps,
    broke: (t[1] as number) / reps,
  });
  return { today: rate(tally.today), rows: rate(tally.rows), groups: rate(tally.groups) };
}

describe("clustered rows (simulation)", () => {
  const REPS = 400;

  it("rows as units break a 95% promise often at ten rows a group; groups as units do not", () => {
    const v = violations(10, 0.6, REPS, 1106);
    // Research: today's rule 18.0% (2,000 runs), reproduced at 17.9%. Its standard error at 400
    // runs is 1.9 points, so 10% to 26% is four of them either side.
    expect(v.today.broke).toBeGreaterThan(0.1);
    expect(v.today.broke).toBeLessThan(0.26);
    // The exact fit on rows shares the independence assumption: 10.6% over 2,000 runs on these
    // 19 edges (the research's 99-edge version: 17.8%). 4% is four standard errors below.
    expect(v.rows.broke).toBeGreaterThan(0.04);
    // About 50 groups can never hold the 59 a 95% bar needs: the group fit says so and never
    // acts. That is the honest answer for 500 rows in groups of ten.
    expect(v.groups).toEqual({ found: 0, broke: 0 });
  });

  it("groups as units still find bars at three rows a group, and keep the promise", () => {
    const v = violations(3, 0.6, REPS, 1103);
    // Research (99 edges): groups found a bar 40.2% of the time and broke the promise 0.1%;
    // these 19 edges found one 24.0% and broke it 0.0% over 2,000 runs. 12% is over five
    // standard errors below 24%, and at a true rate near 0.1% four breaks in 400 runs would be
    // a 1-in-10,000 event.
    expect(v.groups.found).toBeGreaterThan(0.12);
    expect(v.groups.broke).toBeLessThanOrEqual(0.01);
    expect(v.today.broke).toBeGreaterThan(v.groups.broke);
  });
});
