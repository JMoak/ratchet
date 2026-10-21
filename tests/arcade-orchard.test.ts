import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/orchard.ts";
import { judgeVerdictFrom, type Oracle, pickVerdictFrom } from "../src/index.ts";

describe("Signal Orchard", () => {
  it("lets a player harvest in shadow, consumes finite fruit, and ends after twelve days", async () => {
    const result = await play({
      commands: Array.from({ length: 12 }, () => ({ tree: 1, manual: true })),
    });
    expect(result.mode).toBe("shadow");
    expect(result.stock).toEqual([4, 0, 4]);
    expect(result.harvested + result.spoiled).toBe(4);
    expect(result.done).toBe(true);
    expect(
      result.ledger.decisions.every((row) => row.actual === "act" && row.mode === "shadow"),
    ).toBe(true);
  });

  it("uses the injected oracle to choose a tree and separately judge its harvest", async () => {
    const states: string[] = [];
    const oracle: Oracle = {
      id: "test-gardener",
      async decide(state, questions) {
        states.push(state);
        return questions.map((q) => ({
          verdict:
            q.kind === "pick"
              ? pickVerdictFrom(
                  q,
                  q.options.map((option) => (option === "Hill" ? 0.97 : 0.01)),
                )
              : q.kind === "judge"
                ? judgeVerdictFrom(q, 0.99)
                : (() => {
                    throw new Error("Unexpected rate");
                  })(),
          oracle: "test-gardener",
          at: new Date().toISOString(),
          cost: 0,
          latencyMs: 0,
        }));
      },
    };
    const shadow = await play({ commands: ["agent"] }, oracle);
    expect(shadow.stock).toEqual([4, 4, 4]);
    const active = await play({ commands: ["agent"], automate: true }, oracle);
    expect(active.position).toBe(2);
    expect(active.stock).toEqual([4, 4, 3]);
    expect(active.ledger.decisions.map((row) => row.gate)).toEqual([
      "orchard.choose-tree",
      "orchard.harvest",
    ]);
    expect(states.every((state) => !/"truth"|"pYes"|"score"|"suggested"/.test(state))).toBe(true);
  });

  it("uses a weather day after a failed choice without harvesting the fallback", async () => {
    const oracle: Oracle = {
      id: "offline",
      async decide() {
        throw new Error("offline");
      },
    };
    const result = await play({ commands: ["agent"], automate: true }, oracle);
    expect(result.stock).toEqual([4, 4, 4]);
    expect(result.paused).toBe(false);
    expect(result.turn).toBe(1);
    expect(result.history[0]?.event).toContain("waited");
    expect(result.ledger.decisions).toHaveLength(1);
    expect(result.ledger.decisions[0]?.failedOpen).toBe(true);
  });

  it("finishes a season of failed choices on changed observations, with every action held", async () => {
    const states: string[] = [];
    const oracle: Oracle = {
      id: "unavailable-gardener",
      async decide(state) {
        states.push(state);
        throw new Error("unavailable");
      },
    };
    const result = await play({ commands: Array(12).fill("agent"), automate: true }, oracle);
    expect(result.done).toBe(true);
    expect(result.score).toBe(0);
    expect(result.stock).toEqual([4, 4, 4]);
    expect(result.history).toHaveLength(12);
    expect(new Set(states).size).toBe(12);
    expect(JSON.parse(states[0] ?? "{}").trees).not.toEqual(JSON.parse(states[11] ?? "{}").trees);
    expect(result.ledger.decisions.every((row) => row.failedOpen && row.actual === "review")).toBe(
      true,
    );
  });

  it("keeps uncertain harvests held, then accepts an explicit human harvest", async () => {
    const oracle: Oracle = {
      id: "uncertain-gardener",
      async decide(_state, questions) {
        return questions.map((q) => ({
          verdict:
            q.kind === "pick"
              ? pickVerdictFrom(
                  q,
                  q.options.map((_, index) => (index === 0 ? 0.97 : 0.01)),
                )
              : q.kind === "judge"
                ? judgeVerdictFrom(q, 0.6)
                : (() => {
                    throw new Error("rate");
                  })(),
          oracle: "uncertain-gardener",
          at: "2026-10-20T00:00:00Z",
          latencyMs: 0,
          cost: 0,
        }));
      },
    };
    const commands = Array(11).fill("agent");
    const held = await play({ commands, automate: true }, oracle);
    expect(held.stock).toEqual([4, 4, 4]);
    expect(held.history.every((turn) => turn.actual === "review")).toBe(true);
    const manual = await play(
      { commands: [...commands, { tree: 0, manual: true }], automate: true },
      oracle,
    );
    expect(manual.done).toBe(true);
    expect(manual.stock).toEqual([3, 4, 4]);
    expect(manual.history.at(-1)?.actor).toBe("player");
    expect(manual.ledger.decisions.at(-1)).toMatchObject({ mode: "shadow", actual: "act" });
  });

  it("replays each physical season, including a partial prefix, while new seeds change its route", async () => {
    const commands = Array(12).fill("agent");
    const trajectories = new Set<string>();
    let wins = 0;
    for (const seed of [0, 1, 2, 46, 64, 712, 713, 9001]) {
      const input = { seed, commands, automate: true, threshold: 0.8 };
      const first = await play(input);
      const replay = await play(input);
      const prefix = await play({ ...input, commands: commands.slice(0, 6) });
      expect(first.done).toBe(true);
      expect(first.history).toEqual(replay.history);
      expect(first.history.slice(0, 6)).toEqual(prefix.history);
      trajectories.add(JSON.stringify(first.history.map((turn) => [turn.treeIndex, turn.actual])));
      if (first.won) wins++;
    }
    expect(trajectories.size).toBeGreaterThan(1);
    expect(wins).toBeGreaterThan(0);
  });
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
