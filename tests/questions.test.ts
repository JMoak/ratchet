import { describe, expect, it } from "vitest";
import { judge, neutralVerdict, pick, rate, shortlist, validateVerdict } from "../src/questions.ts";

describe("question constructors", () => {
  it("pick rejects degenerate option sets", () => {
    expect(() => pick("q", ["a"])).toThrow();
    expect(() => pick("q", ["a", "a"])).toThrow();
    expect(() => pick("q", ["a", " "])).toThrow();
    expect(pick("q", ["a", "b"]).options).toEqual(["a", "b"]);
  });
  it("rate enforces 2 to 10 levels", () => {
    expect(() => rate("q", ["one"])).toThrow();
    expect(() =>
      rate(
        "q",
        Array.from({ length: 11 }, (_, i) => `l${i}`),
      ),
    ).toThrow();
    expect(rate("q", ["low", "high"]).levels.length).toBe(2);
  });
  it("judge needs a prompt", () => {
    expect(() => judge("  ")).toThrow();
  });
  it("ids are unique unless given", () => {
    expect(judge("a").id).not.toBe(judge("a").id);
    expect(judge("a", { id: "x" }).id).toBe("x");
  });
});

describe("neutral verdicts and validation", () => {
  it("neutral verdicts carry zero confidence and validate", () => {
    const p = pick("q", ["a", "b", "c"]);
    const r = rate("q", ["low", "mid", "high"]);
    const j = judge("q");
    for (const q of [p, r, j] as const) {
      const v = neutralVerdict(q);
      expect(v.confidence).toBe(0);
      expect(() => validateVerdict(q, v)).not.toThrow();
    }
    expect(neutralVerdict(j)).toMatchObject({ pYes: 0.5 });
  });
  it("validation catches mismatches", () => {
    const p = pick("q", ["a", "b"], { id: "p" });
    expect(() =>
      validateVerdict(p, {
        kind: "pick",
        questionId: "p",
        choice: "z",
        probabilities: { a: 0.5, b: 0.5 },
        confidence: 0.5,
      }),
    ).toThrow(/not an option/);
    expect(() =>
      validateVerdict(p, {
        kind: "pick",
        questionId: "p",
        choice: "a",
        probabilities: { a: 0.9, b: 0.9 },
        confidence: 0.9,
      }),
    ).toThrow(/sum/);
  });
});

describe("shortlist", () => {
  it("ranks options with cumulative mass", () => {
    const v = {
      kind: "pick" as const,
      questionId: "q",
      choice: "b",
      probabilities: { a: 0.2, b: 0.5, c: 0.3 },
      confidence: 0.5,
    };
    const s = shortlist(v, 2);
    expect(s.map((x) => x.option)).toEqual(["b", "c"]);
    expect(s[1]?.cumulative).toBeCloseTo(0.8, 9);
    expect(shortlist(v).length).toBe(3);
  });
});
