import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/treasure.ts";

describe("Treasure Survey", () => {
  it("collects every practice label in shadow and withholds expedition outcomes", async () => {
    const result = await play({ automate: true });
    expect(result.practice).toHaveLength(12);
    expect(result.expedition).toEqual([]);
    expect(result.fit.sourceCount).toBe(12);
    expect(result.fit.sourceModes).toEqual(["shadow"]);
    expect(result.score).toBe(0);
    expect(result.ledger.decisions.every((row) => row.actual === "review")).toBe(true);
    expect(result.ledger.decisions.every((row) => typeof row.truth === "boolean")).toBe(true);
    expect(result.ledger.rows.every((row) => !row.state?.includes('"truth"'))).toBe(true);
  });

  it("freezes a practice-only fit before labelling twelve distinct expedition sites", async () => {
    const practice = await play({ seed: 64 });
    const expedition = await play({ seed: 64, phase: "expedition" });
    expect(expedition.fit).toEqual(practice.fit);
    expect(expedition.practice).toEqual(practice.practice);
    expect(expedition.expedition).toHaveLength(12);
    expect(expedition.ledger.decisions).toHaveLength(24);
    const heldoutRows = expedition.ledger.rows.filter(
      (row) => row.gateId === "treasure.expedition",
    );
    expect(heldoutRows).toHaveLength(12);
    expect(
      heldoutRows.every((row) => !expedition.fit.sourceStateHashes.includes(row.stateHash)),
    ).toBe(true);
    expect(expedition.score).toBe(0);
    expect(expedition.expedition.every((site) => site.actual === "review")).toBe(true);
  });

  it("uses actual gate actions for the reversible toy score and replays deterministically", async () => {
    const input = { phase: "expedition", automate: true, threshold: 0.5 };
    const first = await play(input);
    const replay = await play(input);
    expect(first.expedition).toEqual(replay.expedition);
    expect(first.fit).toEqual(replay.fit);
    expect(first.found + first.empty).toBeGreaterThan(0);
    expect(first.score).toBe(
      first.expedition.reduce(
        (score, site) => score + (site.actual === "act" ? (site.truth ? 5 : -8) : 0),
        0,
      ),
    );
    expect(first.practice.every((site) => site.actual === "review")).toBe(true);
  });

  it("changes compass claims without changing world labels", async () => {
    const honest = await play({});
    const bold = await play({ compass: "bold" });
    expect(honest.practice.map((site) => site.truth)).toEqual(
      bold.practice.map((site) => site.truth),
    );
    expect(honest.practice.map((site) => site.probability)).not.toEqual(
      bold.practice.map((site) => site.probability),
    );
    expect(honest.bins.reduce((n, bin) => n + bin.n, 0)).toBe(12);
  });

  it("reports support and accuracy at the suggested selectable threshold", async () => {
    for (let seed = 0; seed < 30; seed++) {
      const result = await play({ seed });
      const threshold = result.fit.suggestedThreshold;
      if (threshold === null) continue;
      const eligible = result.practice.filter((site) => site.probability >= threshold);
      expect(threshold).toBeGreaterThanOrEqual(0.5);
      expect(result.fit.support).toBe(eligible.length);
      expect(result.fit.accuracy).toBe(
        eligible.filter((site) => site.truth).length / eligible.length,
      );
      expect(result.fit.support).toBeGreaterThanOrEqual(3);
      expect(result.fit.accuracy).toBeGreaterThanOrEqual(result.fit.target);
    }
  });

  it("gives different terrains distinct seeded worlds", async () => {
    const coast = await play({ terrain: "coast" });
    const canyon = await play({ terrain: "canyon" });
    expect(coast.practice).not.toEqual(canyon.practice);
  });

  it.each([
    { phase: "training-and-testing-together" },
    { threshold: 0.4 },
    { seed: -1 },
    { seed: 1.5 },
    { terrain: "moon" },
    { compass: "magic" },
    { automate: 1 },
  ])("rejects invalid controls: %j", async (input) => {
    await expect(play(input)).rejects.toThrow();
  });
});
