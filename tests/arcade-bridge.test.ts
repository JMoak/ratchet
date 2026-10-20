import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/bridge.ts";

describe("Bridge Builder", () => {
  it("keeps the world untouched in shadow while recording and labelling proposals", async () => {
    const result = await play({ attempts: ["plank", "stone", "floating"] });
    expect(result.mode).toBe("shadow");
    expect(result.built).toEqual([]);
    expect(result.score).toBe(0);
    expect(result.ledger.decisions).toHaveLength(3);
    expect(result.ledger.decisions.every((row) => row.actual === "review")).toBe(true);
    expect(result.ledger.decisions.map((row) => row.truth)).toEqual([true, true, false]);
    expect(result.ledger.decisions[2]?.suggested).toBe("refuse");
  });

  it("uses the actual gate action to advance and preserves completed spans after a bad act", async () => {
    for (const seed of [1, 2, 3, 4]) {
      const result = await play({
        automate: true,
        seed,
        attempts: ["plank", "glass", "truss", "glass", "stone", "stone", "stone"],
      });
      const successful = result.history.filter((row) => row.actual === "act" && row.truth);
      const collapsed = result.history.filter((row) => row.actual === "act" && !row.truth);
      expect(result.built).toEqual(successful.map((row) => row.material));
      expect(result.collapses).toBe(collapsed.length);
      expect(result.built.length).toBeGreaterThan(0);
      for (const row of result.history) {
        expect(row.truth).toBe(row.capacity >= row.load);
      }
      expect(result.ledger.rows.every((row) => !row.state?.includes("pYes"))).toBe(true);
    }
  });

  it("floors unanchored pieces and treats a missing engineer as review", async () => {
    const result = await play({
      automate: true,
      failJudge: true,
      attempts: ["stone", "floating"],
    });
    expect(result.built).toEqual([]);
    expect(result.history[0]?.failedOpen).toBe(true);
    expect(result.history[0]?.actual).toBe("review");
    expect(result.history[1]?.actual).toBe("refuse");
    expect(result.ledger.rows[1]?.strategy).toBe("floored");
    expect(result.ledger.rows.every((row) => row.cost === 0)).toBe(true);
  });

  it("replays the same proposals deterministically and caps work", async () => {
    const input = { automate: true, attempts: ["stone", "truss", "stone", "stone", "plank"] };
    expect((await play(input)).history).toEqual((await play(input)).history);
    for (const bad of [
      null,
      { attempts: ["unknown"] },
      { attempts: Array(31).fill("stone") },
      { attempts: "stone" },
      { seed: 1.5 },
      { seed: -1 },
      { automate: "yes" },
      { failJudge: "yes" },
    ]) {
      await expect(play(bad)).rejects.toThrow();
    }
  });
});
