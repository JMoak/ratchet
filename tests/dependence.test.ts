import { describe, expect, it } from "vitest";
import { errorCorrelation } from "../src/ledger/calibration.ts";
import {
  allWrongCeiling,
  type PanelSample,
  panelCeiling,
  panelFromLedger,
  withinClassCorrelation,
} from "../src/ledger/dependence.ts";
import type { DecisionRecord, MemberRecord } from "../src/ledger/ledger.ts";
import { logit, randNormal, rng } from "../src/math.ts";

describe("withinClassCorrelation", () => {
  it("pools deviations from each truth's own means", () => {
    // Yes rows: deviations (-1, 0, 1) for both members (sxy 2, sxx 2, syy 2). No rows: a's
    // deviations (-1, 0, 1), b's (1, -2, 1) (sxy 0, sxx 2, syy 6). Pooled: 2 / sqrt(4 * 8).
    const rows = [
      { truth: true, a: 4, b: 9 },
      { truth: true, a: 5, b: 10 },
      { truth: true, a: 6, b: 11 },
      { truth: false, a: -6, b: -7 },
      { truth: false, a: -5, b: -10 },
      { truth: false, a: -4, b: -7 },
    ];
    const out = withinClassCorrelation(rows);
    expect(out.correlation).toBeCloseTo(2 / Math.sqrt(32), 12);
    expect(out.n).toBe(6);
    // The plain correlation reads the shared signal (the class means) as dependence.
    const xs = rows.map((r) => r.a);
    const ys = rows.map((r) => r.b);
    const mx = xs.reduce((s, x) => s + x, 0) / 6;
    const my = ys.reduce((s, y) => s + y, 0) / 6;
    const cxy = xs.reduce((s, x, i) => s + (x - mx) * ((ys[i] ?? 0) - my), 0);
    const cxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    const cyy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
    expect(cxy / Math.sqrt(cxx * cyy)).toBeGreaterThan(0.95);
  });

  it("is undefined, never 0, when a member is pinned within a truth or no truth has two rows", () => {
    const pinnedYes = [
      { truth: true, a: 4.6, b: 1 },
      { truth: true, a: 4.6, b: 2 },
      { truth: false, a: -1, b: -1 },
      { truth: false, a: -2, b: -3 },
    ];
    expect(withinClassCorrelation(pinnedYes).correlation).toBeUndefined();
    expect(withinClassCorrelation(pinnedYes).n).toBe(4);
    const single = [
      { truth: true, a: 1, b: 2 },
      { truth: false, a: -1, b: -2 },
    ];
    expect(withinClassCorrelation(single).correlation).toBeUndefined();
    expect(withinClassCorrelation([]).correlation).toBeUndefined();
  });

  it("recovers a latent correlation that phi of correctness reads attenuated", () => {
    // Two calibrated Gaussian-logit members accurate 86% and 96.5% at a base rate of one half
    // (sigma = 2 Phi^-1(accuracy)), latent within-class correlation 0.85. At 20,000 rows the
    // estimate's SD is about (1 - r^2) / sqrt(n) = 0.002, so 0.02 is ten of them; phi's
    // population value here is 0.42 (research table A1), far outside that.
    const r = rng(1201);
    const s = [2.160638, 3.623822];
    const rho = 0.85;
    const rows = Array.from({ length: 20_000 }, () => {
      const truth = r() < 0.5;
      const e1 = randNormal(r);
      const e2 = rho * e1 + Math.sqrt(1 - rho * rho) * randNormal(r);
      const sign = truth ? 1 : -1;
      const s0 = s[0] ?? 0;
      const s1 = s[1] ?? 0;
      return {
        truth,
        a: (sign * s0 * s0) / 2 + s0 * e1,
        b: (sign * s1 * s1) / 2 + s1 * e2,
      };
    });
    expect(Math.abs((withinClassCorrelation(rows).correlation ?? 0) - rho)).toBeLessThan(0.02);
    const phi = errorCorrelation(
      rows.map((x) => ({ a: x.a >= 0 === x.truth, b: x.b >= 0 === x.truth })),
    );
    expect(phi).toBeLessThan(0.6);
  });
});

describe("the unanimity ceiling", () => {
  it("is 1 - P(all wrong) with an exact interval", () => {
    // e2e T5's cross-family pair on held-out: both wrong on 2 of 260.
    const rows = Array.from({ length: 260 }, (_, i) => [i >= 2, i >= 2 && i % 7 !== 0]);
    const c = allWrongCeiling(rows);
    expect(c.n).toBe(260);
    expect(c.allWrong).toBe(2);
    expect(c.ceiling).toBeCloseTo(258 / 260, 12);
    // Clopper-Pearson 95% for 2 of 260 all wrong is 0.09% to 2.75%.
    expect(c.lower).toBeCloseTo(1 - 0.0275, 3);
    expect(c.upper).toBeCloseTo(1 - 0.00093, 4);
    // Never all wrong: the upper end is 1 and the lower end has the closed form.
    const none = allWrongCeiling(Array.from({ length: 30 }, () => [false, true]));
    expect(none.upper).toBe(1);
    expect(none.lower).toBeCloseTo(0.025 ** (1 / 30), 12);
    expect(allWrongCeiling([])).toEqual({ n: 0, allWrong: 0, ceiling: 1, lower: 0, upper: 1 });
    expect(() => allWrongCeiling(rows, 1)).toThrow(/confidence/);
  });

  it("reads a panel's rows where every member answered, by leading answer", () => {
    const sample: PanelSample = {
      members: [{ key: "a" }, { key: "b" }],
      rows: [
        { truth: true, logits: [-1, -2] }, // both wrong
        { truth: true, logits: [0, -2] }, // p(yes) 0.5 leans yes: a right
        { truth: false, logits: [1, undefined] }, // b did not answer: not read
        { truth: false, logits: [-1, 3] },
      ],
    };
    const c = panelCeiling(sample);
    expect(c.n).toBe(3);
    expect(c.allWrong).toBe(1);
  });
});

describe("panelFromLedger", () => {
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
    oracle: "ensemble(a,b)",
    strategy: "ensemble",
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
  const member = (key: string, pYes: number, extra: Partial<MemberRecord> = {}): MemberRecord => ({
    key,
    oracle: `${key}@x`,
    model: key === "a" ? "typesafe/jev-1.13" : "anthropic/claude-haiku-5.5",
    verdict: { kind: "judge", questionId: "q", pYes, confidence: Math.max(pYes, 1 - pYes) },
    cost: 0,
    latencyMs: 0,
    ...extra,
  });
  const row = (id: string, over: Partial<DecisionRecord>): DecisionRecord => ({
    ...template,
    id,
    requestId: id,
    ...over,
  });
  const labelled = (truth: boolean, source = "review:blind") => ({
    at: template.at,
    correct: true,
    truth,
    source,
  });

  it("pairs members by key over labelled, trusted compound rows, as memberCorrelation selects", () => {
    const rows: DecisionRecord[] = [
      row("1", { members: [member("a", 0.9), member("b", 0.8)], outcome: labelled(true) }),
      row("2", {
        members: [member("b", 0.2), member("a", 0.3, { failedOpen: true })],
        outcome: labelled(false),
      }),
      // Refused: a label from an unregistered route, no truth, a failed-open row, no members.
      row("3", { members: [member("a", 0.9)], outcome: labelled(true, "nowhere:odd") }),
      row("4", { members: [member("a", 0.9)] }),
      row("5", { members: [member("a", 0.9)], failedOpen: true, outcome: labelled(true) }),
      row("6", { outcome: labelled(true) }),
      // Selected by confidence: read, but the sample says so.
      row("7", { members: [member("a", 0.6)], mode: "enforce", outcome: labelled(true) }),
    ];
    const sample = panelFromLedger(rows);
    expect(sample.members.map((m) => m.key)).toEqual(["a", "b"]);
    expect(sample.members[0]?.model).toBe("typesafe/jev-1.13");
    expect(sample.rows).toEqual([
      { truth: true, logits: [logit(0.9), logit(0.8)] },
      { truth: false, logits: [undefined, logit(0.2)] },
      { truth: true, logits: [logit(0.6), undefined] },
    ]);
    expect(sample.fittedFrom).toBe("all");
    const unselected = panelFromLedger(rows, { unselectedOnly: true });
    expect(unselected.rows).toHaveLength(2);
    expect(unselected.fittedFrom).toBe("unselected");
    const only = panelFromLedger(rows, { keys: ["b"] });
    expect(only.rows).toEqual([
      { truth: true, logits: [logit(0.8)] },
      { truth: false, logits: [logit(0.2)] },
    ]);
    expect(panelFromLedger([]).fittedFrom).toBeUndefined();
  });
});
