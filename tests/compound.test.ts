import { describe, expect, it } from "vitest";
import { cascade } from "../src/compound/cascade.ts";
import { runChain, type Step } from "../src/compound/chain.ts";
import { ensemble, replicate } from "../src/compound/ensemble.ts";
import { sequential } from "../src/compound/sequential.ts";
import { mean, rng } from "../src/math.ts";
import { failOpen, withFallback } from "../src/oracles/oracle.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge, pick } from "../src/questions.ts";
import type { Decision, Oracle } from "../src/types.ts";

const N = 1500;
const items = Array.from({ length: N }, (_, i) => `item-${i}`);
const truths = new Map<string, Truth>(
  items.map((s, i) => [s, { judge: i % 2 === 0, pick: ["a", "b", "c", "d"][i % 4] as string }]),
);
const truthOf = (s: string) => truths.get(s);
const jq = judge("is it?", { id: "j" });
const pq = pick("which?", ["a", "b", "c", "d"], { id: "p" });

const correctJudge = (s: string, d: Decision) =>
  d.verdict.kind === "judge" && d.verdict.pYes >= 0.5 === truths.get(s)?.judge;
const correctPick = (s: string, d: Decision) =>
  d.verdict.kind === "pick" && d.verdict.choice === truths.get(s)?.pick;

describe("ensemble", () => {
  it("five independent 80% voters reach the Condorcet region", async () => {
    const o = new SimOracle({ accuracy: 0.8, seed: 1 }, truthOf);
    const members = replicate(o, 5);
    let right = 0;
    for (const s of items) if (correctJudge(s, await ensemble(s, jq, { members }))) right++;
    expect(right / N).toBeGreaterThan(0.92);
  });
  it("five perfectly correlated voters are one voter", async () => {
    const o = new SimOracle({ accuracy: 0.8, seed: 1, correlation: 1 }, truthOf);
    const members = replicate(o, 5);
    let right = 0;
    for (const s of items) {
      if (correctJudge(s, await ensemble(s, jq, { members, correlation: 1 }))) right++;
    }
    expect(right / N).toBeGreaterThan(0.75);
    expect(right / N).toBeLessThan(0.85);
  });
  it("shuffled option orders map back by name", async () => {
    const o = new SimOracle({ accuracy: 0.8, seed: 2 }, truthOf);
    const members = replicate(o, 5, { shuffle: true });
    let right = 0;
    for (const s of items) if (correctPick(s, await ensemble(s, pq, { members }))) right++;
    expect(right / N).toBeGreaterThan(0.92);
  });
  it("members that fail open are dropped, all failing is flagged", async () => {
    const dead: Oracle = {
      id: "dead",
      decide: async () => {
        throw new Error("down");
      },
    };
    const live = new SimOracle({ accuracy: 0.9, seed: 3 }, truthOf);
    const mixed = await ensemble("item-0", jq, {
      members: [{ oracle: failOpen(dead) }, { oracle: live }],
    });
    expect(mixed.failedOpen).toBeUndefined();
    expect(mixed.detail).toMatchObject({ pooled: 1, dropped: 1 });
    const all = await ensemble("item-0", jq, { members: [{ oracle: failOpen(dead) }] });
    expect(all.failedOpen).toBe(true);
  });
});

describe("cascade", () => {
  it("escalating only the unsure cases beats the cheap tier at a fraction of the strong cost", async () => {
    const cheap = new SimOracle(
      { accuracy: 0.8, seed: 4, costPerQuestion: 1, id: "cheap" },
      truthOf,
    );
    const strong = new SimOracle(
      { accuracy: 0.97, seed: 5, costPerQuestion: 400, id: "strong" },
      truthOf,
    );
    let right = 0;
    let cost = 0;
    let escalated = 0;
    for (const s of items) {
      const d = await cascade(s, jq, {
        tiers: [
          { oracle: cheap, settleAbove: 0.9 },
          { oracle: strong, settleAbove: 0 },
        ],
      });
      cost += d.cost;
      if (d.detail.escalations > 0) escalated++;
      if (correctJudge(s, d)) right++;
    }
    expect(right / N).toBeGreaterThan(0.86);
    expect(escalated / N).toBeGreaterThan(0.1);
    expect(escalated / N).toBeLessThan(0.9);
    expect(cost / N).toBeLessThan(400);
  });
});

describe("sequential", () => {
  it("settles early on easy items and spends more on hard ones", async () => {
    const o = new SimOracle({ accuracy: 0.8, seed: 6 }, truthOf);
    const members = replicate(o, 9);
    let right = 0;
    const samples: number[] = [];
    for (const s of items) {
      const d = await sequential(s, jq, { members, settleAbove: 0.95, maxSamples: 9 });
      samples.push(d.detail.samples);
      if (correctJudge(s, d)) right++;
    }
    expect(right / N).toBeGreaterThan(0.9);
    expect(mean(samples)).toBeLessThan(6);
    expect(Math.min(...samples)).toBe(1);
  });
});

describe("chain (the ratchet)", () => {
  interface S {
    readonly step: number;
    readonly good: boolean;
    readonly token: number;
  }
  const rand = rng(99);
  const verifierTruth = (state: string): Truth | undefined => ({
    judge: (JSON.parse(state) as S).good,
  });
  const verifier = new SimOracle({ accuracy: 0.9, seed: 8, costPerQuestion: 1 }, verifierTruth);
  const check = judge("did this step succeed?", { id: "v" });
  const mkSteps = (n: number, pStep: number): Step<S>[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `step-${i + 1}`,
      propose: async (s) => ({ step: i + 1, good: s.good && rand() < pStep, token: rand() }),
      verify: async (_before, after) => {
        const [d] = await verifier.decide(JSON.stringify(after), [check]);
        return d as Decision;
      },
      maxAttempts: 3,
    }));

  it("verified commits turn 0.8^8 into something you can ship", async () => {
    const runs = 300;
    let trueSuccess = 0;
    let claimed = 0;
    for (let r = 0; r < runs; r++) {
      const res = await runChain({ step: 0, good: true, token: 0 }, mkSteps(8, 0.8), {
        actAbove: 0.7,
      });
      if (res.ok) claimed++;
      if (res.ok && res.state.good) trueSuccess++;
    }
    expect(trueSuccess / runs).toBeGreaterThan(0.55);
    expect(0.8 ** 8).toBeLessThan(0.17);
    expect(claimed).toBeGreaterThanOrEqual(trueSuccess);
  });

  it("never advances past an unverified proposal and reports where it stopped", async () => {
    const exact: Oracle = {
      id: "exact",
      decide: async (state, qs) =>
        qs.map((qq) => ({
          verdict: {
            kind: "judge" as const,
            questionId: qq.id,
            pYes: (JSON.parse(state) as S).good ? 0.99 : 0.01,
            confidence: 0.99,
          },
          oracle: "exact",
          latencyMs: 0,
          cost: 0,
          at: "now",
        })),
    };
    const steps = mkSteps(3, 0).map((st) => ({
      ...st,
      verify: async (_b: S, a: S) =>
        (await exact.decide(JSON.stringify(a), [check]))[0] as Decision,
    }));
    const res = await runChain({ step: 0, good: true, token: 0 }, steps, { actAbove: 0.7 });
    expect(res.ok).toBe(false);
    expect(res.stoppedAt).toBe("step-1");
    expect(res.stopReason).toBe("exhausted");
    expect(res.state.step).toBe(0);
    expect(res.trace[0]?.attempts.length).toBe(3);
  });

  it("a refuse floor stops the chain immediately", async () => {
    const res = await runChain(
      { step: 0, good: true, token: 0 },
      mkSteps(3, 1),
      { actAbove: 0.7 },
      { floor: "refuse" },
    );
    expect(res.stopReason).toBe("refused");
    expect(res.trace[0]?.attempts.length).toBe(1);
  });
});

describe("negated members and fallback", () => {
  it("a negated member's judge answer is flipped back before pooling", async () => {
    const o = new SimOracle({ accuracy: 0.99, seed: 31 }, (_s, q) => ({ judge: q.id !== "neg" }));
    const neg: Oracle = {
      id: "neg",
      decide: async (state, qs) =>
        o.decide(
          state,
          qs.map((q) => ({ ...q, id: "neg" })),
        ),
    };
    const r = await ensemble("item-0", jq, {
      members: [{ oracle: o }, { oracle: neg, negated: true }],
    });
    expect(r.verdict.kind === "judge" && r.verdict.pYes).toBeGreaterThan(0.9);
    expect(r.agreement).toBe(1);
  });
  it("withFallback answers from the secondary when the primary is down", async () => {
    const dead: Oracle = {
      id: "dead",
      decide: async () => {
        throw new Error("402");
      },
    };
    const live = new SimOracle({ accuracy: 0.95, seed: 32, id: "local" }, truthOf);
    const o = withFallback(dead, live);
    const [d] = await o.decide("item-0", [jq]);
    expect(d?.oracle).toBe("local");
    expect(d?.failedOpen).toBeUndefined();
    const both = withFallback(dead, failOpen(dead));
    const [n] = await both.decide("item-0", [jq]);
    expect(n?.failedOpen).toBe(true);
  });
});
