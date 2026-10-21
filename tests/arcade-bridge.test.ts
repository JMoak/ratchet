import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/bridge.ts";
import { judgeVerdictFrom, type Oracle, pickVerdictFrom } from "../src/index.ts";

function builder(probability = 0.99, forced?: string, states: string[] = []): Oracle {
  return {
    id: "test-builder",
    async decide(state, questions) {
      states.push(state);
      return questions.map((question) => {
        let choice = forced;
        if (question.kind === "pick" && !choice) {
          const world = JSON.parse(state) as {
            requiredLoad: number;
            supplies: number;
            materials: Record<
              string,
              { capacity: number; cost: number; stock: number; anchored: boolean }
            >;
          };
          choice =
            Object.entries(world.materials)
              .filter(
                ([, piece]) =>
                  piece.anchored &&
                  piece.capacity >= world.requiredLoad &&
                  piece.cost <= world.supplies &&
                  piece.stock > 0,
              )
              .sort((a, b) => a[1].cost - b[1].cost)[0]?.[0] ?? "wait";
          for (const option of question.options) {
            if (option === "wait" || option === "return") continue;
            const piece = world.materials[option];
            expect(piece?.anchored).toBe(true);
            expect(piece?.capacity).toBeGreaterThanOrEqual(world.requiredLoad);
            expect(piece?.cost).toBeLessThanOrEqual(world.supplies);
            expect(piece?.stock).toBeGreaterThan(0);
          }
        }
        return {
          verdict:
            question.kind === "pick"
              ? pickVerdictFrom(
                  question,
                  question.options.map((option) => (option === choice ? 0.99 : 0.001)),
                )
              : question.kind === "judge"
                ? judgeVerdictFrom(question, probability)
                : (() => {
                    throw new Error("Unexpected rate question");
                  })(),
          oracle: "test-builder",
          at: new Date().toISOString(),
          cost: 0,
          latencyMs: 0,
        };
      });
    },
  };
}

describe("Bridge Builder", () => {
  it("keeps shadow proposals from advancing the physical world", async () => {
    const preview = await play({ seed: 42 });
    const result = await play({ seed: 42, attempts: ["plank", "stone", "floating"] });
    expect(result.mode).toBe("shadow");
    expect(result.built).toEqual([]);
    expect(result.supplies).toBe(preview.supplies);
    expect(result.minutesLeft).toBe(14);
    expect(result.ledger.decisions).toHaveLength(3);
    expect(result.ledger.decisions.every((row) => row.actual === "review")).toBe(true);
    expect(result.ledger.decisions[2]?.suggested).toBe("refuse");
  });

  it("lets manual construction advance and preserves earlier spans after a collapse", async () => {
    const preview = await play({ seed: 42 });
    const result = await play({
      seed: 42,
      commands: [
        { material: "truss", manual: true },
        { material: "plank", manual: true },
        { material: "glass", manual: true },
      ],
    });
    expect(result.built).toEqual(["truss", "plank"]);
    expect(result.collapses).toBe(1);
    expect(result.supplies).toBe(
      preview.supplies -
        preview.materials.truss.cost -
        preview.materials.plank.cost -
        preview.materials.glass.cost,
    );
    expect(result.minutesLeft).toBe(11);
    expect(result.ledger.decisions.every((row) => row.actual === "act")).toBe(true);
  });

  it("plays seeded feasible crossings to completion with changing real constraints", async () => {
    const signatures = new Set<string>();
    const sequences = new Set<string>();
    for (const seed of [1, 42, 99, 1000, 999999]) {
      const preview = await play({ seed });
      const input = { seed, automate: true, commands: Array(14).fill("agent") };
      const result = await play(input);
      signatures.add(JSON.stringify([preview.loads, preview.materials, preview.supplies]));
      sequences.add(result.built.join(","));
      expect(result.complete).toBe(true);
      expect(result.done).toBe(true);
      expect(result.turns).toBeLessThanOrEqual(10);
      expect(result.supplies).toBeGreaterThanOrEqual(0);
      expect(result.events).toHaveLength(1);
      expect((await play(input)).history).toEqual(result.history);
    }
    expect(signatures.size).toBe(5);
    expect(sequences.size).toBeGreaterThan(1);
  });

  it("uses a physical inspection as new evidence without placing a held piece", async () => {
    const result = await play({ seed: 42, automate: true, commands: Array(14).fill("agent") });
    const heldIndex = result.history.findIndex(
      (row) => row.actual === "review" && row.material !== "wait",
    );
    expect(heldIndex).toBeGreaterThanOrEqual(0);
    const held = result.history[heldIndex];
    expect(held?.result).toContain("crew inspected");
    expect(result.history[heldIndex + 1]).toMatchObject({
      span: held?.span,
      material: held?.material,
      actual: "act",
    });
    const partial = await play({
      seed: 42,
      automate: true,
      commands: Array(heldIndex + 1).fill("agent"),
    });
    expect(partial.built).toHaveLength((held?.span ?? 1) - 1);
    expect(result.ledger.rows.some((row) => row.state?.includes("physical_inspection: true"))).toBe(
      true,
    );
  });

  it("offers only physically eligible choices and still verifies before placement", async () => {
    const states: string[] = [];
    const complete = await play(
      { seed: 42, automate: true, commands: Array(5).fill("agent") },
      builder(0.99, undefined, states),
    );
    expect(complete.complete).toBe(true);
    expect(states.every((state) => !/pYes|score|suggested|truth/.test(state))).toBe(true);
    const floored = await play({ automate: true, commands: ["floating"] }, builder(0.99));
    expect(floored.built).toEqual([]);
    expect(floored.history[0]).toMatchObject({ material: "floating", actual: "refuse" });
    expect(floored.ledger.decisions[0]).toMatchObject({ floor: "refuse", answered: false });
  });

  it("skips a preference vote when physics leaves one option, without skipping verification", async () => {
    const result = await play({ seed: 984766, automate: true, commands: ["agent"] }, builder(0.5));
    expect(result.ledger.decisions.map((row) => row.gate)).toEqual(["bridge.verify-piece"]);
    expect(result.built).toEqual([]);
    expect(result.history[0]?.actual).toBe("review");
    expect(result.history[0]?.result).toContain("inspected");
  });

  it("ends all-review and all-failure runs without installing held pieces or endless calls", async () => {
    for (const failJudge of [false, true]) {
      const result = await play(
        { seed: 42, automate: true, failJudge, commands: Array(30).fill("agent") },
        builder(0.5),
      );
      expect(result.done).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.minutesLeft).toBe(0);
      expect(result.turns).toBe(14);
      expect(result.built).toEqual([]);
      expect(result.supplies).toBe(result.initialSupplies + 2);
      expect(result.ledger.decisions.length).toBeLessThanOrEqual(12);
      expect(result.history.at(-1)?.result).toContain("no new oracle call");
      if (failJudge) expect(result.ledger.decisions.every((row) => row.failedOpen)).toBe(true);
    }
  });

  it("keeps missing anchors blocked in manual play too", async () => {
    const result = await play({ commands: [{ material: "floating", manual: true }] });
    expect(result.built).toEqual([]);
    expect(result.history[0]?.actual).toBe("refuse");
  });

  it.each([
    null,
    { attempts: ["unknown"] },
    { attempts: Array(31).fill("stone") },
    { attempts: "stone" },
    { seed: 1.5 },
    { seed: -1 },
    { automate: "yes" },
    { failJudge: "yes" },
  ])("rejects invalid input %j", async (input) => {
    await expect(play(input)).rejects.toThrow();
  });
});
