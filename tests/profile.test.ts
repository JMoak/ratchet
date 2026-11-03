import { describe, expect, it } from "vitest";
import { borrowFor, parseProfile } from "../src/ledger/borrow.ts";
import { fitThreshold, scoredFromLedger, wilsonLower } from "../src/ledger/calibration.ts";
import { describeGrade, gradeOf } from "../src/ledger/evidence.ts";
import type { DecisionRecord, Mode } from "../src/ledger/ledger.ts";
import {
  borrowedBar,
  buildProfile,
  type CalibrationProfile,
  gateBars,
  mergeProfiles,
  PROFILE_TARGETS,
  type ProfileKey,
  profileAge,
  profileHash,
  profileMatches,
  profileVia,
} from "../src/ledger/profile.ts";
import { rng } from "../src/math.ts";
import { hashPolicy, policyFromProfile, policyWithBand } from "../src/policy.ts";
import type { QuestionKind } from "../src/types.ts";

const AT = "2026-10-20T00:00:00.000Z";
const KEY: ProfileKey = { model: "m-1", kind: "judge" };

interface RowOptions {
  readonly gate?: string;
  readonly model?: string;
  readonly kind?: QuestionKind;
  readonly mode?: Mode;
  readonly tags?: readonly string[];
  readonly source?: string;
  readonly strategy?: string;
  readonly questionHash?: string;
  readonly failedOpen?: boolean;
  readonly labelled?: boolean;
  readonly at?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

let ids = 0;

/** A decision row answered at `confidence` (yes for a judge), labelled right or wrong. */
function row(confidence: number, right: boolean, o: RowOptions = {}): DecisionRecord {
  const id = `r${ids++}`;
  const kind = o.kind ?? "judge";
  return {
    id,
    at: o.at ?? AT,
    gateId: o.gate ?? "g",
    requestId: id,
    questionId: "q",
    kind,
    prompt: "ok?",
    questionHash: o.questionHash ?? "0123456789abcdef",
    stateHash: id,
    trustedHash: id,
    untrusted: [],
    oracle: "o",
    model: o.model ?? "m-1",
    strategy: o.strategy ?? "single",
    verdict:
      kind === "judge"
        ? { kind: "judge", questionId: "q", pYes: confidence, confidence }
        : {
            kind: "pick",
            questionId: "q",
            choice: "a",
            probabilities: { a: confidence },
            confidence,
          },
    go: confidence,
    confidence,
    agreement: 1,
    soft: "review",
    action: "review",
    mode: o.mode ?? "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: o.failedOpen === true,
    tags: o.tags ?? [],
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
    ...(o.labelled === false
      ? {}
      : {
          outcome: {
            at: o.at ?? AT,
            correct: right,
            truth: right,
            ...(o.source !== undefined ? { source: o.source } : {}),
          },
        }),
  };
}

/** `n` rows at `confidence`, the first `right` of them right. */
const rows = (n: number, confidence: number, right: number, o: RowOptions = {}) =>
  Array.from({ length: n }, (_, i) => row(confidence, i < right, o));

const build = (rs: readonly DecisionRecord[], targets = [0.9], key = KEY) =>
  buildProfile(rs, key, { ledgers: ["l.jsonl"], targets }) as CalibrationProfile;

// Two gates whose own bars differ at a 90% promise with 30 rows of support: on "a" the model
// kept 90% from 0.75 up (80 of 80 right), on "b" only from 0.9 up (its 0.75s are 60% right).
// The 40-row runs sit just past the Wilson bound: 40 of 40 right bounds accuracy at 0.912.
const gateA = [...rows(40, 0.95, 40, { gate: "a" }), ...rows(40, 0.75, 40, { gate: "a" })];
const gateB = [...rows(40, 0.9, 40, { gate: "b" }), ...rows(40, 0.75, 24, { gate: "b" })];
const unsureA = rows(40, 0.55, 20, { gate: "a" });

describe("buildProfile: the cautious end", () => {
  it("takes each gate's lowest clearing tail, then the highest across gates", () => {
    expect(wilsonLower(1, 40)).toBeGreaterThan(0.9);
    expect(wilsonLower(64 / 80, 80)).toBeLessThan(0.9);
    const p = build([...gateA, ...unsureA, ...gateB]);
    expect(p.resolution).toBe(100);
    expect(gateBars(p, 0.9)).toEqual([
      { gate: "a", rows: 120, bar: 0.75, support: 80 },
      { gate: "b", rows: 80, bar: 0.9, support: 40 },
    ]);
    expect(p.bars).toEqual([{ target: 0.9, bar: 0.9, support: 40 }]);
    expect(borrowedBar(p, 0.9)).toBe(0.9);
    // Alone, gate "a" lends its own lower bar.
    expect(build([...gateA, ...unsureA]).bars).toEqual([{ target: 0.9, bar: 0.75, support: 80 }]);
  });

  it("reads a bar as fitThreshold does: the lowest confidence whose tail keeps the promise", () => {
    // One gate, confidences on hundredths, right as often as they claim. Seeded.
    const rand = rng(5);
    const calibrated = Array.from({ length: 2000 }, () => {
      const c = Math.round(100 * (0.5 + 0.49 * rand())) / 100;
      return row(c, rand() < c);
    });
    const p = build(calibrated, [0.8, 0.9, 0.95, 0.99]);
    const scored = scoredFromLedger(calibrated);
    let barred = 0;
    for (const t of p.targets) {
      const fitted = fitThreshold(scored, t, 30, { conservative: true });
      expect(borrowedBar(p, t)).toBe(fitted?.threshold);
      if (fitted) barred++;
    }
    // Not vacuous: some promises have a bar and the strictest has none.
    expect(barred).toBeGreaterThanOrEqual(2);
    expect(borrowedBar(p, 0.99)).toBeUndefined();
  });

  it("puts bars on the edges of its resolution, and coarse bins hide a bar the model earned", () => {
    const both = [...gateA, ...gateB];
    const at = (resolution: number) =>
      buildProfile(both, KEY, { ledgers: ["l"], targets: [0.9], resolution }) as CalibrationProfile;
    expect(gateBars(at(10), 0.9)).toEqual([
      { gate: "a", rows: 80, bar: 0.7, support: 80 },
      { gate: "b", rows: 80, bar: 0.9, support: 40 },
    ]);
    // In quarters, "b"'s 0.75s and 0.9s share one bin, which fails the promise whole.
    expect(at(4).bars).toEqual([]);
    expect(at(100).bars).toEqual([{ target: 0.9, bar: 0.9, support: 40 }]);
    expect(at(4).hash).not.toBe(at(100).hash);
    for (const resolution of [0, 1001, 2.5]) {
      expect(() => at(resolution)).toThrow(/resolution/);
    }
  });

  it("lends no bar when a gate with enough rows at it fails the promise there", () => {
    const wrongAtTheTop = rows(40, 0.95, 32, { gate: "c" });
    expect(build([...gateA, ...gateB, ...wrongAtTheTop]).bars).toEqual([]);
    expect(borrowedBar(build([...gateA, ...gateB, ...wrongAtTheTop]), 0.9)).toBeUndefined();
    // Too few rows that sure, or a gate never that sure, says nothing about the bar.
    const thin = rows(10, 0.95, 0, { gate: "d" });
    const unsure = rows(60, 0.55, 30, { gate: "e" });
    expect(build([...gateA, ...gateB, ...thin, ...unsure]).bars).toEqual([
      { target: 0.9, bar: 0.9, support: 40 },
    ]);
  });

  it("searches upward past an edge where one gate misses, to the next that holds on all", () => {
    const v = [...rows(30, 0.7, 20, { gate: "v" }), ...rows(40, 0.8, 40, { gate: "v" })];
    const w = [
      ...rows(100, 0.7, 100, { gate: "w" }),
      ...rows(34, 0.8, 30, { gate: "w" }),
      ...rows(40, 0.9, 40, { gate: "w" }),
    ];
    const p = build([...v, ...w]);
    expect(gateBars(p, 0.9)).toEqual([
      { gate: "v", rows: 70, bar: 0.8, support: 40 },
      { gate: "w", rows: 174, bar: 0.7, support: 174 },
    ]);
    // At 0.8, the higher of the two gates' own bars, "w" holds 74 rows and misses (70 right);
    // one edge up it keeps the promise, and "v" has no rows left there to say otherwise.
    expect(wilsonLower(70 / 74, 74)).toBeLessThan(0.9);
    expect(p.bars).toEqual([{ target: 0.9, bar: 0.9, support: 40 }]);
  });

  it("reads only labelled unselected rows of trusted sources the key's model answered alone", () => {
    const counted = rows(30, 0.95, 30);
    const p = buildProfile(
      [
        ...counted,
        ...rows(5, 0.95, 5, { mode: "enforce" }),
        ...rows(5, 0.95, 5, { mode: "enforce", tags: ["audit"] }),
        ...rows(5, 0.95, 5, { source: "desk:assisted" }),
        ...rows(5, 0.95, 5, { source: "reverted:vcs" }),
        ...rows(5, 0.95, 5, { source: "review:blind:jo" }),
        ...rows(5, 0.95, 5, { model: "m-2" }),
        ...rows(5, 0.95, 5, { kind: "pick" }),
        ...rows(5, 0.95, 5, { failedOpen: true }),
        ...rows(5, 0.95, 5, { strategy: "battery" }),
        ...rows(5, 0.95, 5, { labelled: false }),
        ...rows(5, 0.95, 5, { at: "" }),
        // The same row twice, as one ledger named twice gives it, counts once.
        ...counted.slice(0, 5),
      ],
      KEY,
      { ledgers: ["l.jsonl"] },
    );
    expect(p?.targets).toEqual([0.9, 0.95, 0.98, 0.99]);
    expect(PROFILE_TARGETS).toEqual(p?.targets);
    // 30 shadow, 5 audits and 5 blind reviews.
    expect(p?.from).toMatchObject({
      rows: 40,
      sources: { blind: 5, census: 0, moment: 0, unknown: 35 },
    });
    const rubric = buildProfile(rows(5, 0.9, 5, { questionHash: "feedfacefeedface" }), KEY, {
      ledgers: ["l"],
    });
    expect(rubric?.from.rows).toBe(5);
    const keyed = { ...KEY, questionHash: "feedfacefeedface" };
    expect(buildProfile(counted, keyed, { ledgers: ["l"] })).toBeUndefined();
    expect(() => buildProfile(counted, KEY, { ledgers: [], targets: [0.9] })).toThrow(/ledgers/);
    expect(() => buildProfile(counted, KEY, { ledgers: ["l"], targets: [1.2] })).toThrow(/target/);
    expect(() => buildProfile(counted, KEY, { ledgers: ["l"], minSupport: 0 })).toThrow();
    expect(() =>
      buildProfile(counted, KEY, { ledgers: ["l"], sources: ["consequence" as "blind"] }),
    ).toThrow(/never fit a bar/);
    expect(() => buildProfile(counted, { ...KEY, model: "" }, { ledgers: ["l"] })).toThrow();
  });

  it("is dated and named by what it read, and hashes only the evidence", () => {
    const early = rows(10, 0.95, 10, { gate: "a", at: "2026-10-01T00:00:00.000Z" });
    const p = build([...early, ...gateA]);
    expect(p.from).toMatchObject({
      gates: ["a"],
      ledgers: ["l.jsonl"],
      firstAt: "2026-10-01T00:00:00.000Z",
      lastAt: AT,
    });
    const renamed = buildProfile([...gateA, ...early].reverse(), KEY, {
      ledgers: ["elsewhere.jsonl"],
      targets: [0.9],
    });
    expect(renamed?.hash).toBe(p.hash);
    expect(profileHash(p)).toBe(p.hash);
    expect(profileAge(p, new Date("2026-10-30T00:00:00.000Z"))).toBe(10);
  });
});

describe("expiry and matching", () => {
  const p = build(gateA);
  it("matches the exact model and kind, and the rubric when keyed to one", () => {
    expect(profileMatches(p, { model: "m-1", kind: "judge" })).toBe(true);
    expect(profileMatches(p, { model: "m-1", kind: "judge", questionHash: "x" })).toBe(true);
    expect(profileMatches(p, { model: "m-1.1", kind: "judge" })).toBe(false);
    expect(profileMatches(p, { model: "m-1", kind: "pick" })).toBe(false);
    const keyed = build(gateA, [0.9], { ...KEY, questionHash: "0123456789abcdef" });
    expect(profileMatches(keyed, { model: "m-1", kind: "judge" })).toBe(false);
    expect(
      profileMatches(keyed, { model: "m-1", kind: "judge", questionHash: "0123456789abcdef" }),
    ).toBe(true);
  });

  it("lends to a gate on the key's model and expires when the pin moves", () => {
    const here = rows(10, 0.8, 8, { gate: "new" });
    expect(borrowFor(here, [p], { target: 0.9 })).toEqual({
      via: profileVia(p, 0.9),
      stale: false,
    });
    const upgraded = rows(10, 0.8, 8, { gate: "new", model: "m-2" });
    expect(borrowFor(upgraded, [p], { target: 0.9 })).toBeUndefined();
    // A declared pin stands in for the rows' model.
    expect(borrowFor(upgraded, [p], { target: 0.9, model: "m-1" })?.stale).toBe(false);
    // A pooled answer is not the model's own; the newest answered row decides.
    expect(borrowFor(rows(10, 0.8, 8, { strategy: "ensemble" }), [p], { target: 0.9 })).toBe(
      undefined,
    );
    expect(borrowFor(here, [p], { target: 0.99 })).toBeUndefined();
  });

  it("reads a gate that names its profile as stale once it moves off the key", () => {
    const detail = { barSource: { profileHash: p.hash } };
    const before = rows(10, 0.8, 8, { gate: "new", detail });
    const after = rows(10, 0.8, 8, { gate: "new", model: "m-2", detail });
    expect(borrowFor(before, [p], { target: 0.9 })?.stale).toBe(false);
    expect(borrowFor([...before, ...after], [p], { target: 0.9 })?.stale).toBe(true);
    // Only the named profile can lend to it, however well another matches.
    const other = build(gateB);
    expect(borrowFor(before, [other], { target: 0.9 })).toBeUndefined();
    const via = profileVia(p, 0.9);
    if (via === undefined) throw new Error("the fixture's profile has a bar at 90%");
    const stale = gradeOf([], { borrowed: via, stale: true });
    expect(stale).toMatchObject({ kind: "borrowed", stale: true, at: AT });
    expect(describeGrade(stale)).toMatch(
      /^borrowed \(stale\) as of 2026-10-20: bar 0\.750 from profile [0-9a-f]{8}, which no longer matches the gate's model, donor 80 rows of gate a in ledger l\.jsonl/,
    );
    expect(Object.keys(gradeOf([], { borrowed: via }))).toEqual(["kind", "via", "at"]);
    const pairs = {
      type: "disagreement" as const,
      rate: 0.2,
      pairs: 5,
      models: ["x", "y"] as const,
    };
    expect(() => gradeOf([], { borrowed: pairs, stale: true })).toThrow(/only a borrowed profile/);
  });
});

describe("policyFromProfile", () => {
  const p = build([...gateA, ...unsureA, ...gateB]);
  it("acts at the band's upper edge, the borrowed bar plus 0.05", () => {
    expect(policyFromProfile(p, 0.9)).toEqual({ actAbove: 0.95 });
    expect(policyFromProfile(p, 0.9, { halfWidth: 0.1, refuse: true, goIsYes: false })).toEqual({
      actAbove: 1,
      refuseBelow: 0.8,
      goIsYes: false,
    });
    expect(() => policyFromProfile(p, 0.99)).toThrow(/no bar/);
    expect(() => policyFromProfile(p, 0.9, { halfWidth: -1 })).toThrow(/halfWidth/);
  });

  it("round-trips through hashPolicy: one profile, one policy hash, however it travelled", () => {
    const hash = hashPolicy(policyFromProfile(p, 0.9));
    expect(hash).toBe(hashPolicy(policyWithBand(0.9, 0.05)));
    const travelled = parseProfile(JSON.parse(JSON.stringify(p)));
    expect(travelled).toEqual(p);
    expect(hashPolicy(policyFromProfile(travelled, 0.9))).toBe(hash);
    const rebuilt = build([...gateB, ...unsureA, ...gateA].reverse());
    expect(rebuilt.hash).toBe(p.hash);
    expect(hashPolicy(policyFromProfile(rebuilt, 0.9))).toBe(hash);
  });
});

describe("mergeProfiles", () => {
  // Three ledgers over three gates, each gate in two of them, answered by a calibrated model:
  // confidence drawn from [0.5, 1) and right with that probability. Seeded.
  const rand = rng(17);
  const ledger = (gates: readonly string[], n: number) =>
    Array.from({ length: n }, (_, i) => {
      const c = 0.5 + 0.5 * rand();
      return row(c, rand() < c, {
        gate: gates[i % gates.length] as string,
        at: `2026-10-${String(10 + (i % 9)).padStart(2, "0")}T0${i % 10}:00:00.000Z`,
      });
    });
  const la = ledger(["g1", "g2"], 700);
  const lb = ledger(["g2", "g3"], 700);
  const lc = ledger(["g1", "g3"], 700);
  const of = (rs: readonly DecisionRecord[], name: string, targets: number[]) =>
    buildProfile(rs, KEY, { ledgers: [name], targets }) as CalibrationProfile;
  const a = of(la, "a.jsonl", [0.8]);
  const b = of(lb, "b.jsonl", [0.9]);
  const c = of(lc, "c.jsonl", [0.8, 0.95]);

  it("is commutative and associative, and equals one build over every row", () => {
    expect(mergeProfiles(a, b)).toEqual(mergeProfiles(b, a));
    const left = mergeProfiles(mergeProfiles(a, b), c);
    const right = mergeProfiles(a, mergeProfiles(b, c));
    expect(left).toEqual(right);
    expect(mergeProfiles(mergeProfiles(c, a), b)).toEqual(left);
    const once = buildProfile([...la, ...lb, ...lc], KEY, {
      ledgers: ["a.jsonl", "b.jsonl", "c.jsonl"],
      targets: [0.8, 0.9, 0.95],
    });
    expect(once).toEqual(left);
    expect(left.from).toMatchObject({ rows: 2100, gates: ["g1", "g2", "g3"] });
    expect(left.targets).toEqual([0.8, 0.9, 0.95]);
    // Not vacuous: the merged rows support a bar, and the bins kept their integer counts.
    expect(left.bars.length).toBeGreaterThan(0);
    for (const bin of left.bins) {
      expect(bin.accuracy * bin.n).toBeCloseTo(Math.round(bin.accuracy * bin.n), 9);
    }
  });

  it("refuses profiles of different keys or levers, or that read one ledger", () => {
    const pick = buildProfile(
      rows(10, 0.9, 9, { kind: "pick" }),
      { ...KEY, kind: "pick" },
      {
        ledgers: ["p.jsonl"],
      },
    ) as CalibrationProfile;
    expect(() => mergeProfiles(a, pick)).toThrow(/cannot merge a profile of m-1 judge/);
    const strict = buildProfile(lb, KEY, { ledgers: ["s.jsonl"], minSupport: 50 });
    expect(() => mergeProfiles(a, strict as CalibrationProfile)).toThrow(/min support/);
    const tenths = buildProfile(lb, KEY, { ledgers: ["t.jsonl"], resolution: 10 });
    expect(() => mergeProfiles(a, tenths as CalibrationProfile)).toThrow(
      /cannot merge profiles of 100 and 10 bins/,
    );
    expect(() => mergeProfiles(a, a)).toThrow(/count twice/);
  });
});

describe("parseProfile", () => {
  const p = build([...gateA, ...gateB]);
  const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(p));

  it("refuses a profile whose bars, bins or hash do not agree", () => {
    const bar = copy();
    (bar.bars as { bar: number }[])[0] = {
      ...(bar.bars as { bar: number }[])[0],
      bar: 0.5,
    } as never;
    expect(() => parseProfile(bar)).toThrow(/bars and hash/);
    const bin = copy();
    (bin.bins as { accuracy: number }[])[0] = {
      ...(bin.bins as { accuracy: number }[])[0],
      accuracy: 0.5,
    } as never;
    expect(() => parseProfile(bin)).toThrow(/bars and hash/);
    expect(() => parseProfile({ ...copy(), hash: "0".repeat(16) })).toThrow(/bars and hash/);
    expect(() => parseProfile({ ...copy(), format: 2 })).toThrow(/format/);
    expect(() => parseProfile({ ...copy(), bins: "none" })).toThrow(/bins must be a list/);
    const rowsOff = copy();
    rowsOff.from = { ...(rowsOff.from as object), rows: 1 };
    expect(() => parseProfile(rowsOff)).toThrow(/provenance/);
    expect(() => parseProfile(null)).toThrow(/object/);
  });
});
