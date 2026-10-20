import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/orchard.ts";

describe("Signal Orchard", () => {
  it("keeps all shadow fruit on the tree and labels each ledger decision", async () => {
    const result = await play({ choices: [0, 1, 2, 0, 1, 2], threshold: 0.5 });
    expect(result.score).toBe(0);
    expect(result.harvested + result.spoiled).toBe(0);
    expect(result.ledger.decisions).toHaveLength(6);
    expect(result.ledger.decisions.every((row) => row.actual === "review")).toBe(true);
    expect(result.ledger.decisions.every((row) => typeof row.truth === "boolean")).toBe(true);
    expect(result.history.every((row) => row.points === 0)).toBe(true);
  });

  it("discounts the same votes toward neutral as assumed correlation rises", async () => {
    const choices = Array.from({ length: 12 }, (_, index) => index % 3);
    const independent = await play({ choices, correlation: 0 });
    const correlated = await play({ choices, correlation: 1 });
    expect(independent.effectiveScouts).toBe(5);
    expect(correlated.effectiveScouts).toBe(1);
    for (const [index, row] of independent.history.entries()) {
      const other = correlated.history[index];
      expect(other?.votes).toEqual(row.votes);
      expect(other?.truth).toBe(row.truth);
      expect(Math.abs((other?.probability ?? 0.5) - 0.5)).toBeLessThan(
        Math.abs(row.probability - 0.5),
      );
    }
  });

  it("only awards fruit for actual enforce actions and preserves the simulator labels", async () => {
    const choices = Array.from({ length: 12 }, (_, index) => index % 3);
    const result = await play({ choices, automate: true, threshold: 0.5 });
    expect(result.mode).toBe("enforce");
    expect(result.done).toBe(true);
    expect(result.trees).toEqual([]);
    expect(result.score).toBe(
      result.history.reduce(
        (score, row) => score + (row.actual === "act" ? (row.truth ? 3 : -4) : 0),
        0,
      ),
    );
    expect(result.harvested + result.spoiled).toBe(
      result.history.filter((row) => row.actual === "act").length,
    );
    expect(result.harvested + result.spoiled).toBeGreaterThan(0);
    for (const [index, row] of result.ledger.decisions.entries()) {
      expect(row.truth).toBe(result.history[index]?.truth);
      expect(row.correct).toBe(row.probability >= 0.5 === row.truth);
    }
  });

  it("uses one actual member for solo and starts an empty season without a decision", async () => {
    const empty = await play({ choices: [] });
    expect(empty.ledger.rows).toEqual([]);
    expect(empty.trees).toHaveLength(3);
    const solo = await play({ strategy: "solo", correlation: 0.8 });
    expect(solo.effectiveScouts).toBe(1);
    expect(solo.history[0]?.votes).toHaveLength(1);
    for (const point of solo.curve) {
      expect(point.probability).toBeCloseTo(solo.history[0]?.probability ?? -1, 12);
    }
  });

  it.each([
    { choices: [3] },
    { choices: ["0"] },
    { choices: Array.from({ length: 13 }, () => 0) },
    { correlation: -0.1 },
    { threshold: 1.1 },
    { seed: 1.5 },
    { automate: "true" },
    { fruit: "banana" },
    { strategy: "wishful-thinking" },
  ])("rejects invalid controls: %j", async (input) => {
    await expect(play(input)).rejects.toThrow();
  });
});
