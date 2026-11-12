import { describe, expect, it } from "vitest";
import { evaluateAcceptance, exactLowerBound, resolvePlan } from "../src/acceptance.ts";
import { wilsonInterval, wilsonLower } from "../src/ledger/calibration.ts";
import {
  atLeast,
  type BorrowedVia,
  describeGrade,
  type EvidenceGrade,
  GRADE_KINDS,
  gradeOf,
} from "../src/ledger/evidence.ts";
import type { DecisionRecord, Mode, Outcome } from "../src/ledger/ledger.ts";
import { COUNTED_SOURCES, type FitClass } from "../src/ledger/sources.ts";
import type { Action } from "../src/types.ts";

const AT = "2026-10-30T00:00:00.000Z";

interface RowOptions {
  readonly soft?: Action;
  /** Label the row: was its leading answer (yes, at 0.97) right? Absent leaves it unlabelled. */
  readonly right?: boolean;
  /** When the label was given. Default `AT`. */
  readonly labelledAt?: string;
  readonly source?: string;
  readonly mode?: Mode;
  readonly tags?: readonly string[];
  readonly policyHash?: string;
  readonly model?: string;
}

function row(id: string, o: RowOptions = {}): DecisionRecord {
  const outcome: Outcome | undefined =
    o.right === undefined
      ? undefined
      : {
          at: o.labelledAt ?? AT,
          correct: o.right,
          truth: o.right,
          ...(o.source !== undefined ? { source: o.source } : {}),
        };
  return {
    id,
    at: AT,
    gateId: "g",
    requestId: id,
    questionId: "q",
    kind: "judge",
    prompt: "ok?",
    questionHash: "0123456789abcdef",
    policyHash: o.policyHash ?? "fedcba9876543210",
    stateHash: id,
    trustedHash: id,
    untrusted: [],
    oracle: "o",
    model: o.model ?? "m-1",
    strategy: "single",
    verdict: { kind: "judge", questionId: "q", pYes: 0.97, confidence: 0.97 },
    go: 0.97,
    confidence: 0.97,
    agreement: 1,
    soft: o.soft ?? "act",
    action: "review",
    mode: o.mode ?? "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: false,
    tags: o.tags ?? [],
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

const acts = (n: number, prefix: string, o: RowOptions = {}) =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, { right: true, ...o }));
const held = (n: number, prefix: string, o: RowOptions = {}) =>
  acts(n, prefix, { soft: "review", ...o });

/** 29 acts: the planned sample for a 90% promise at 95% confidence with no wrong act allowed. */
const plan = { target: 0.9 };
const profile: BorrowedVia = {
  type: "profile",
  profileHash: "a1b2c3d4e5f60718",
  bar: 0.84,
  donor: {
    rows: 1240,
    gates: ["bash.safe", "tool.safe"],
    ledgers: ["keywork.jsonl"],
    firstAt: "2026-09-01T00:00:00.000Z",
    lastAt: "2026-10-20T00:00:00.000Z",
    sources: { blind: 40, census: 1200, moment: 0, unknown: 0 },
  },
};
const disagreement: BorrowedVia = {
  type: "disagreement",
  rate: 0.25,
  pairs: 40,
  models: ["alpha-1", "beta-1"],
};

describe("wilsonInterval", () => {
  it("matches the textbook interval at the ends and in between", () => {
    expect(wilsonInterval(0, 20)).toEqual({ lower: 0, upper: expect.closeTo(0.1611, 4) });
    expect(wilsonInterval(1, 20)).toEqual({
      lower: expect.closeTo(0.8389, 4),
      upper: expect.closeTo(1, 12),
    });
    expect(wilsonInterval(0.75, 20).lower).toBeCloseTo(0.5313, 4);
    expect(wilsonInterval(0.75, 20).upper).toBeCloseTo(0.8881, 4);
    expect(wilsonInterval(0.5, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it("has wilsonLower as its lower end at every confidence", () => {
    for (const confidence of [0.9, 0.95, 0.99]) {
      for (const [p, n] of [
        [0.9, 40],
        [0.98, 150],
        [0, 5],
      ] as const) {
        expect(wilsonInterval(p, n, confidence).lower).toBe(wilsonLower(p, n, confidence));
      }
    }
  });
});

describe("gradeOf", () => {
  const sample = acts(29, "a");
  const rows = [...sample, ...held(11, "h")];

  it("prefers measured, then estimated, then borrowed, then none", () => {
    expect(gradeOf(rows, { plan }).kind).toBe("measured");
    expect(gradeOf(rows).kind).toBe("estimated");
    const few = rows.slice(0, 12);
    expect(gradeOf(few, { plan, borrowed: disagreement }).kind).toBe("borrowed");
    expect(gradeOf(few, { plan })).toEqual({
      kind: "none",
      reason: "12 labelled unselected rows; estimated needs 30",
      labelled: 12,
      unselected: 12,
    });
    // Evidence from elsewhere never outranks the gate's own labels.
    expect(gradeOf(rows, { borrowed: disagreement }).kind).toBe("estimated");
    expect(gradeOf(rows, { plan, borrowed: profile }).kind).toBe("measured");
  });

  it("measures the planned sample by its exact bound", () => {
    const g = gradeOf(rows, { plan });
    expect(g).toMatchObject({
      kind: "measured",
      errors: 0,
      sampleSize: 29,
      sources: { blind: 0, census: 0, moment: 0, unknown: 29 },
      at: AT,
    });
    if (g.kind !== "measured") throw new Error("expected a measured grade");
    expect(g.lowerBound).toBeCloseTo(exactLowerBound(29, 29), 12);
    expect(g.plan).toEqual(resolvePlan(plan));
  });

  it("estimates on labelled unselected rows of trusted sources only", () => {
    const read = [
      ...acts(20, "b", { source: "review:blind:jordan" }),
      ...held(16, "c", { source: "keywork:person" }),
      ...held(4, "w", { right: false }),
    ];
    const unread = [
      row("moment", { right: false, source: "desk:assisted" }),
      row("consequence", { right: false, source: "reverted:vcs" }),
      row("selected", { right: false, mode: "enforce" }),
      { ...row("failed", { right: false }), failedOpen: true },
      { ...row("floored", { right: false }), strategy: "floored" },
    ];
    const g = gradeOf([...read, ...unread]);
    const { lower, upper } = wilsonInterval(0.9, 40);
    expect(g).toEqual({
      kind: "estimated",
      accuracy: 0.9,
      lower,
      upper,
      n: 40,
      confidence: 0.95,
      sources: { blind: 20, census: 16, moment: 0, unknown: 4 },
      at: AT,
    });
    // In text, empty classes are left out and labels with no source read as what they are.
    expect(describeGrade(g)).toContain("(labels: blind 20, census 16, unsourced 4)");
    // The trust filter is the lever: moment labels can be let in, consequence never.
    expect(gradeOf([...read, ...unread], { sources: COUNTED_SOURCES })).toMatchObject({
      n: 41,
      sources: { moment: 1 },
    });
  });

  it("dates each grade by the age of its evidence, not by when it was read", () => {
    const completed = "2026-10-12T09:00:00.000Z";
    const later = "2026-10-20T09:00:00.000Z";
    const sample = [
      ...acts(28, "a", { labelledAt: "2026-10-01T09:00:00.000Z" }),
      row("last", { right: true, labelledAt: completed }),
    ];
    const afterwards = held(11, "h", { labelledAt: later });
    const unread = row("m", { right: true, source: "desk:assisted", labelledAt: "2026-10-29" });
    // Measured: the label that completed the planned sample, not the labels that came after.
    expect(gradeOf([...sample, ...afterwards], { plan })).toMatchObject({
      kind: "measured",
      at: completed,
    });
    // Estimated: the newest label it read; a newer one it did not read does not count.
    expect(gradeOf([...sample, ...afterwards, unread])).toMatchObject({
      kind: "estimated",
      at: later,
    });
    // Borrowed: the date the evidence came with, and the clock only when nothing else can say.
    expect(gradeOf([], { borrowed: profile })).toHaveProperty("at", "2026-10-20T00:00:00.000Z");
    expect(gradeOf([], { borrowed: disagreement, borrowedAt: later })).toHaveProperty("at", later);
    const undated = gradeOf([], { borrowed: disagreement, now: () => completed });
    expect(undated).toHaveProperty("at", completed);
  });

  it("says why there is no grade, in words a person can act on", () => {
    expect(gradeOf([])).toEqual({
      kind: "none",
      reason: "0 labelled unselected rows; estimated needs 30",
      labelled: 0,
      unselected: 0,
    });
    const selected = acts(40, "s", { mode: "enforce" });
    expect(gradeOf([...acts(12, "a"), ...selected])).toEqual({
      kind: "none",
      reason:
        "12 labelled unselected rows; estimated needs 30, and the other 40 labelled rows were chosen by the oracle's own confidence: label shadow rows or blind audits",
      labelled: 52,
      unselected: 12,
    });
  });

  it("reads a supplied acceptance result, whose sample must be among the rows", () => {
    const acceptance = evaluateAcceptance(sample, plan);
    expect(gradeOf(sample, { acceptance }).kind).toBe("measured");
    expect(() => gradeOf(sample.slice(1), { acceptance })).toThrow(/not among the rows/);
    // A sample still collecting measures nothing, however good the rows look.
    const collecting = evaluateAcceptance(sample.slice(0, 5), plan);
    expect(gradeOf(rows, { acceptance: collecting }).kind).toBe("estimated");
  });

  it("refuses an out-of-range lever or malformed borrowed evidence", () => {
    expect(() => gradeOf([], { minEstimated: 0 })).toThrow(/minEstimated/);
    expect(() => gradeOf([], { confidence: 1 })).toThrow(/confidence/);
    expect(() => gradeOf([], { sources: [] })).toThrow(/at least one/);
    const consequence = ["consequence"] as unknown as FitClass[];
    expect(() => gradeOf([], { sources: consequence })).toThrow(/consequence/);
    const same: BorrowedVia = { ...disagreement, models: ["alpha-1", "alpha-1"] };
    expect(() => gradeOf([], { borrowed: same })).toThrow(/two different models/);
    expect(() => gradeOf([], { borrowed: { ...disagreement, pairs: 0 } })).toThrow(/pair/);
    expect(() => gradeOf([], { borrowed: { ...profile, bar: 0 } })).toThrow(/bar/);
  });
});

describe("the planned sample a ledger implies", () => {
  it("is the current shadow phase, so a demoted gate is graded on its fresh sample", () => {
    const promoted = acts(29, "a");
    const enforced = acts(5, "e", { mode: "enforce", tags: ["audit"] });
    const fresh = [row("b-wrong", { right: false }), ...acts(28, "b")];
    // Still enforcing: graded on the phase that promoted it.
    expect(gradeOf([...promoted, ...enforced], { plan }).kind).toBe("measured");
    // Back in shadow: the fresh sample holds a wrong act, so nothing is measured.
    expect(gradeOf([...promoted, ...enforced, ...fresh], { plan }).kind).toBe("estimated");
  });

  it("starts again with a new configuration and reads only the pinned model's rows", () => {
    const changed = acts(10, "p", { policyHash: "0000000000000001" });
    // The old policy's 29 labels are counted, never read (e2e T4-20): 10 rows estimate nothing.
    expect(gradeOf([...acts(29, "a"), ...changed], { plan })).toMatchObject({
      kind: "none",
      unselected: 10,
      older: 29,
    });
    const foreign = [row("f", { right: false, model: "m-2" }), ...acts(29, "a")];
    expect(gradeOf(foreign, { plan }).kind).toBe("estimated");
    expect(gradeOf(foreign, { plan, model: "m-1" }).kind).toBe("measured");
  });
});

describe("one grade, one shape, one sentence", () => {
  const measured = gradeOf([...acts(29, "a"), ...held(11, "h")], { plan });
  const estimated = gradeOf(acts(40, "a"));
  const borrowed = gradeOf([], { borrowed: profile });
  const none = gradeOf(acts(12, "a"));

  it("keeps one JSON shape per kind", () => {
    const shapes: Record<EvidenceGrade["kind"], readonly string[]> = {
      measured: ["kind", "plan", "lowerBound", "errors", "sampleSize", "sources", "at"],
      estimated: ["kind", "accuracy", "lower", "upper", "n", "confidence", "sources", "at"],
      borrowed: ["kind", "via", "at"],
      none: ["kind", "reason", "labelled", "unselected"],
    };
    for (const g of [measured, estimated, borrowed, none]) {
      expect(Object.keys(g)).toEqual(shapes[g.kind]);
      expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    }
    if (measured.kind !== "measured") throw new Error("expected a measured grade");
    expect(Object.keys(measured.sources)).toEqual(["blind", "census", "moment", "unknown"]);
    expect(Object.keys(measured.plan)).toEqual([
      "target",
      "confidence",
      "maxErrors",
      "sampleSize",
      "sources",
      "hash",
    ]);
  });

  it("orders grades strongest first", () => {
    expect(GRADE_KINDS).toEqual(["measured", "estimated", "borrowed", "none"]);
    expect(atLeast(measured, "estimated")).toBe(true);
    expect(atLeast(estimated, "estimated")).toBe(true);
    expect(atLeast(estimated, "measured")).toBe(false);
    expect(atLeast(borrowed, "estimated")).toBe(false);
    expect(atLeast(none, "borrowed")).toBe(false);
  });

  it("opens with the grade's word and states what each kind must", () => {
    for (const g of [measured, estimated, borrowed, none]) {
      expect(describeGrade(g).split(/[ :]/)[0]).toBe(g.kind);
    }
    expect(describeGrade(measured)).toBe(
      "measured as of 2026-10-30: exact 95% lower bound 90.19% >= promised 90.0% on a planned sample of 29 acts, 0 wrong (labels: unsourced 29)",
    );
    expect(describeGrade(estimated)).toMatch(
      /^estimated as of 2026-10-30: 100\.0% right on 40 labelled unselected rows \(labels: unsourced 40\), 95% interval 91\.2% to 100\.0%, 8\.8 points wide, not a planned sample$/,
    );
    expect(describeGrade(borrowed)).toBe(
      "borrowed as of 2026-10-20: bar 0.840 from profile a1b2c3d4, donor 1240 rows of gates bash.safe, tool.safe in ledger keywork.jsonl, 2026-09-01 to 2026-10-20, 0 rows here",
    );
    expect(describeGrade(gradeOf([], { borrowed: disagreement, borrowedAt: AT }))).toBe(
      "borrowed as of 2026-10-30: alpha-1 and beta-1 disagree on 25.0% of 40 pairs, so at least one of the two judges is wrong on at least 25.0% of them; this is not this gate's error rate",
    );
    expect(describeGrade(none)).toBe("none: 12 labelled unselected rows; estimated needs 30");
  });
});
