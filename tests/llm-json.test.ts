import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { LlmJsonOracle } from "../src/oracles/llm-json.ts";
import { judge, pick, rate } from "../src/questions.ts";

const questions = [
  judge("Is this safe?", { id: "safe" }),
  pick("Which route?", ["a", "b"], { id: "route" }),
  rate("How good?", ["poor", "good"], { id: "quality" }),
] as const;

function oracleFor(content: string): LlmJsonOracle {
  const fetchImpl = (async () =>
    Response.json({
      model: "test-model",
      choices: [{ message: { content } }],
      usage: { cost: 0.03 },
    })) as unknown as typeof fetch;
  return new LlmJsonOracle({ apiKey: "test", model: "test-model", fetch: fetchImpl });
}

describe("LLM JSON answers", () => {
  it("maps batched answers by id and tolerates only rounding error", async () => {
    const oracle = oracleFor(
      JSON.stringify({
        answers: [
          { id: "quality", probabilities: [0.1, 0.9] },
          { id: "safe", probabilities: [0.01, 0.99] },
          { id: "route", probabilities: [0.2, 0.7999] },
        ],
      }),
    );
    const decisions = await oracle.decide("state", questions);
    expect(decisions.map((d) => d.verdict.questionId)).toEqual(["safe", "route", "quality"]);
    expect(decisions[0]?.verdict).toMatchObject({ pYes: 0.99, confidence: 0.99 });
    expect(decisions[1]?.verdict).toMatchObject({ choice: "b" });
    expect(decisions[1]?.verdict.confidence).toBeCloseTo(0.7999 / 0.9999, 9);
    expect(decisions[2]?.verdict).toMatchObject({ level: "good", score: 0.9 });
    expect(decisions.every((d) => d.cost === 0.01 && d.model === "test-model")).toBe(true);
  });

  it.each([
    ["negative mass", "[-1,1]"],
    ["out-of-range mass", "[0,2]"],
    ["zero mass", "[0,0]"],
    ["underfull mass", "[0,0.9]"],
    ["overfull mass", "[0.9,0.9]"],
    ["non-finite mass", "[0,1e999]"],
    ["null mass", "[null,1]"],
    ["string mass", '["0",1]'],
    ["empty vector", "[]"],
    ["missing vector", "null"],
  ])("rejects %s before it can authorize an act", async (_name, vector) => {
    for (const question of questions) {
      const oracle = oracleFor(`{"answers":[{"id":"${question.id}","probabilities":${vector}}]}`);
      await expect(oracle.decide("state", [question])).rejects.toThrow(/malformed answer/);
      const engine = new Engine({ oracle, mode: "enforce" });
      const result = await engine.ask("state", question, { policy: { actAbove: 0.5 } });
      expect(result.action).toBe("review");
      expect(result.decision.failedOpen).toBe(true);
      expect((await engine.ledger.all())[0]?.failedOpen).toBe(true);
    }
  });

  it.each([
    "{}",
    '{"answers":[]}',
    '{"answers":[{"id":"other","probabilities":[0,1]}]}',
    '{"answers":[{"id":"safe"}]}',
  ])("fails open on an absent answer: %s", async (content) => {
    const engine = new Engine({ oracle: oracleFor(content), mode: "enforce" });
    const result = await engine.ask("state", questions[0], { policy: { actAbove: 0.5 } });
    expect(result.action).toBe("review");
    expect(result.decision.failedOpen).toBe(true);
  });

  it("rejects duplicate answer ids rather than choosing the last distribution", async () => {
    const oracle = oracleFor(
      '{"answers":[{"id":"safe","probabilities":[1,0]},{"id":"safe","probabilities":[0,1]}]}',
    );
    await expect(oracle.decide("state", questions.slice(0, 2))).rejects.toThrow(
      /duplicate answer ids/,
    );
  });
});
