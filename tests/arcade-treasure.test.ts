import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/treasure.ts";
import { judgeVerdictFrom, type Oracle, pickVerdictFrom } from "../src/index.ts";

describe("Treasure Survey", () => {
  it("starts an interactive expedition with hidden sites and permits manual survey then dig", async () => {
    const start = await play({ phase: "expedition", commands: [] });
    expect(start.expedition).toEqual([]);
    expect(start.map.every((site) => site.truth === null)).toBe(true);
    const result = await play({
      phase: "expedition",
      commands: [
        { site: 0, move: "survey" },
        { site: 0, move: "dig" },
      ],
    });
    expect(result.mode).toBe("shadow");
    expect(result.energy).toBe(20);
    expect(result.shovels).toBe(5);
    expect(result.map[0]?.dug).toBe(true);
    expect(result.map.slice(1).every((site) => site.truth === null)).toBe(true);
    expect(result.fit).toEqual(start.fit);
  });

  it("surveys after a reviewed dig, continues exploration, and lets a human finish it", async () => {
    const states: string[] = [];
    const oracle: Oracle = {
      id: "test-explorer",
      async decide(state, questions) {
        states.push(state);
        return questions.map((q) => ({
          verdict:
            q.kind === "pick"
              ? pickVerdictFrom(
                  q,
                  q.options.map((option) => (option === "0" ? 0.88 : 0.01)),
                )
              : q.kind === "judge"
                ? judgeVerdictFrom(q, 0.6)
                : (() => {
                    throw new Error("Unexpected rate");
                  })(),
          oracle: "test-explorer",
          at: new Date().toISOString(),
          cost: 0,
          latencyMs: 0,
        }));
      },
    };
    const reviewed = await play(
      { phase: "expedition", commands: ["agent"], automate: true },
      oracle,
    );
    expect(reviewed.position).toBe(0);
    expect(reviewed.paused).toBe(false);
    expect(reviewed.shovels).toBe(6);
    expect(reviewed.map[0]).toMatchObject({ visited: true, dug: false, truth: null });
    const manual = await play(
      { phase: "expedition", commands: ["agent", { site: 0, move: "dig" }], automate: true },
      oracle,
    );
    expect(manual.map[0]?.dug).toBe(true);
    expect(manual.shovels).toBe(5);
    expect(manual.fit).toEqual(reviewed.fit);
    expect(states.every((state) => !/"truth"|"pYes"|"score"|"probability"/.test(state))).toBe(true);
    const shadow = await play({ phase: "expedition", commands: ["agent"] }, oracle);
    expect(shadow.position).toBe(-1);
    expect(shadow.energy).toBe(24);
  });

  it.each(["uncertain", "failed"] as const)(
    "finishes with %s destinations by surveying different sites without digging",
    async (response) => {
      const states: string[] = [];
      const oracle: Oracle = {
        id: "held-explorer",
        async decide(state, questions) {
          if (questions[0]?.kind === "pick") states.push(state);
          if (response === "failed") throw new Error("unavailable");
          return questions.map((q) => ({
            verdict:
              q.kind === "pick"
                ? pickVerdictFrom(
                    q,
                    q.options.map(() => 1 / q.options.length),
                  )
                : q.kind === "judge"
                  ? judgeVerdictFrom(q, 0.5)
                  : (() => {
                      throw new Error("rate");
                    })(),
            oracle: "held-explorer",
            at: "2026-10-20T00:00:00Z",
            latencyMs: 0,
            cost: 0,
          }));
        },
      };
      const result = await play(
        {
          phase: "expedition",
          commands: Array(18).fill("agent"),
          automate: true,
        },
        oracle,
      );
      expect(result.done).toBe(true);
      expect(result.turns).toBeLessThanOrEqual(18);
      expect(result.paused).toBe(false);
      expect(result.shovels).toBe(6);
      expect(result.found + result.empty).toBe(0);
      expect(result.visited.length).toBeGreaterThan(1);
      expect(result.map.every((site) => !site.dug && site.truth === null)).toBe(true);
      expect(result.ledger.decisions.every((row) => row.actual === "review")).toBe(true);
      expect(result.expedition.every((turn) => turn.actor === "code" && !turn.dug)).toBe(true);
      expect(new Set(states).size).toBe(states.length);
      for (let index = 1; index < states.length; index++) {
        expect(JSON.parse(states[index] ?? "{}").energy).toBeLessThan(
          JSON.parse(states[index - 1] ?? "{}").energy,
        );
      }
    },
  );

  it("finishes different seeded routes and reproduces a partial expedition exactly", async () => {
    const commands = Array(18).fill("agent");
    const routes = new Set<string>();
    for (const seed of [0, 1, 2, 46, 64, 712, 713, 9001]) {
      const input = { seed, phase: "expedition", commands, automate: true };
      const first = await play(input);
      const replay = await play(input);
      const prefix = await play({ ...input, commands: commands.slice(0, 3) });
      expect(first.done).toBe(true);
      expect(first.expedition).toEqual(replay.expedition);
      expect(first.expedition.slice(0, prefix.expedition.length)).toEqual(prefix.expedition);
      expect(first.fit).toEqual(prefix.fit);
      expect(new Set(first.visited).size).toBe(first.visited.length);
      routes.add(JSON.stringify(first.visited));
    }
    expect(routes.size).toBeGreaterThan(1);
  });

  it("ends on return to camp and does not apply later commands", async () => {
    const result = await play({
      phase: "expedition",
      commands: ["camp", { site: 0, move: "dig" }],
    });
    expect(result.done).toBe(true);
    expect(result.expedition).toEqual([]);
    expect(result.shovels).toBe(6);
  });
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
