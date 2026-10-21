import { describe, expect, it, vi } from "vitest";
import { createLiveRuntime } from "../examples/arcade/live.ts";
import { Engine, judge, judgeVerdictFrom, type Oracle, type Question } from "../src/index.ts";

const question = judge("Is this a useful reversible game move?", { id: "game.move" });
function backend(cost = 0): Oracle {
  return {
    id: "test-live",
    decide: vi.fn(async (_state: string, questions: readonly Question[]) =>
      questions.map((q) => {
        if (q.kind !== "judge") throw new Error("Expected judge.");
        return {
          verdict: judgeVerdictFrom(q, 0.95),
          oracle: "test-live",
          model: "test-v1",
          cost,
          latencyMs: 0,
          at: new Date(0).toISOString(),
        };
      }),
    ),
  };
}

describe("optional live arcade", () => {
  it("requires explicit backend configuration", () => {
    const runtime = createLiveRuntime();
    expect(runtime.status().liveAvailable).toBe(false);
    expect(() => runtime.round()).toThrow("disabled");
  });

  it("replays the same observation without rebuying or sharing mutable results", async () => {
    const model = backend();
    const runtime = createLiveRuntime(model);
    const [first, concurrent] = await Promise.all([
      runtime.round().decide("turn 1, load 3", [question]),
      runtime.round().decide("turn 1, load 3", [question]),
    ]);
    first.pop();
    const replay = await runtime.round().decide("turn 1, load 3", [question]);
    expect(replay).toHaveLength(1);
    expect(concurrent[0]?.verdict).toEqual(replay[0]?.verdict);
    expect(replay[0]?.vendor?.arcadeCacheHit).toBe(true);
    expect(model.decide).toHaveBeenCalledTimes(1);
    await runtime.round().decide("turn 2, load 3", [question]);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(runtime.status()).toMatchObject({
      acceptingNewRequests: true,
      remainingCalls: 98,
      blockedReason: null,
    });
  });

  it("charges a cached answer only once across separate engine decisions", async () => {
    const runtime = createLiveRuntime(backend(0.001));
    const engine = new Engine({ oracle: runtime.round() });
    const first = await engine.ask("same observation", question, { policy: { actAbove: 0.9 } });
    const replay = await engine.ask("same observation", question, { policy: { actAbove: 0.9 } });
    expect(first.decision.cost).toBe(0.001);
    expect(replay.decision.cost).toBe(0);
    expect(runtime.status().reportedCost).toBe(0.001);
  });

  it("caps new calls per round and server, while preserving cached history", async () => {
    const model = backend();
    const runtime = createLiveRuntime(model, { maxCalls: 2, maxRoundCalls: 1 });
    const round = runtime.round();
    await round.decide("one", [question]);
    await expect(round.decide("two", [question])).rejects.toThrow("limit");
    await expect(runtime.round().decide("two", [question])).rejects.toThrow("limit");
    await runtime.round().decide("three", [question]);
    await expect(runtime.round().decide("four", [question])).rejects.toThrow("limit");
    await expect(runtime.round().decide("one", [question])).resolves.toHaveLength(1);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(runtime.status()).toMatchObject({
      acceptingNewRequests: false,
      remainingCalls: 0,
      blockedReason: "Live request limit reached",
    });
  });

  it("stops after the reported cost cutoff; it does not claim a prepaid guarantee", async () => {
    const model = backend(0.06);
    const runtime = createLiveRuntime(model, { stopAfterUsd: 0.1 });
    await runtime.round().decide("one", [question]);
    await runtime.round().decide("two", [question]);
    expect(runtime.status().reportedCost).toBeCloseTo(0.12);
    await expect(runtime.round().decide("three", [question])).rejects.toThrow("cutoff");
    expect(model.decide).toHaveBeenCalledTimes(2);
  });

  it("keeps failed replays in review and stops further purchases when cost is unknown", async () => {
    const model: Oracle = {
      id: "broken",
      decide: vi.fn(async () => {
        throw new Error("Private provider failure body");
      }),
    };
    const runtime = createLiveRuntime(model);
    const ask = () =>
      new Engine({ oracle: runtime.round(), mode: "enforce" }).ask("same turn", question, {
        policy: { actAbove: 0.9 },
      });
    const first = await ask();
    const replay = await ask();
    expect(first.action).toBe("review");
    expect(replay.decision.failedOpen).toBe(true);
    expect(JSON.stringify(replay)).not.toContain("Private provider");
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(runtime.status().unknownCost).toBe(true);
    expect(runtime.status().acceptingNewRequests).toBe(false);
    await expect(runtime.round().decide("next turn", [question])).rejects.toThrow("cutoff");
  });

  it("bounds a nonresponsive provider and aborts its request", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const runtime = createLiveRuntime(
        {
          id: "hanging",
          decide: async (_state, _questions, options) => {
            signal = options?.signal;
            return new Promise(() => {});
          },
        },
        { timeoutMs: 100 },
      );
      const result = new Engine({ oracle: runtime.round(), mode: "enforce" }).ask(
        "turn",
        question,
        {
          policy: { actAbove: 0.9 },
        },
      );
      await vi.advanceTimersByTimeAsync(110);
      expect((await result).action).toBe("review");
      expect(signal?.aborted).toBe(true);
      expect(runtime.status().unknownCost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
