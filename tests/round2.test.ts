import { describe, expect, it } from "vitest";
import { poolJudge } from "../src/compound/aggregate.ts";
import {
  batteryFeatures,
  fitLogistic,
  poolLearned,
  predictLogistic,
} from "../src/compound/learned.ts";
import { Engine } from "../src/engine.ts";
import { allowIf, refuseIf } from "../src/floors.ts";
import { fitThreshold, wilsonLower } from "../src/ledger/calibration.ts";
import { rng } from "../src/math.ts";
import { cached } from "../src/oracles/oracle.ts";
import { judgeIf, RuleOracle } from "../src/oracles/rules.ts";
import { SimOracle } from "../src/oracles/sim.ts";
import { policyWithBand } from "../src/policy.ts";
import { judge } from "../src/questions.ts";
import { Freshness, Hysteresis } from "../src/recipes/loop.ts";
import type { JudgeVerdict, Oracle } from "../src/types.ts";

describe("bypass rules", () => {
  it("answer yes without a call, never above a floor", async () => {
    const sim = new SimOracle({ accuracy: 0.5, seed: 1 }, () => ({ judge: false }));
    const engine = new Engine({
      oracle: sim,
      mode: "enforce",
      bypass: [allowIf(/^git status$/, /^ls\b/)],
      floors: [refuseIf(/--no-preserve-root/)],
    });
    const safe = judge("safe?", { id: "safe" });
    const a = await engine.ask("git status", safe, { policy: { actAbove: 0.9 } });
    expect(a.action).toBe("act");
    expect(a.decision.strategy).toBe("bypass");
    expect(a.decision.cost).toBe(0);
    expect(sim.calls).toBe(0);
    const b = await engine.ask("ls --no-preserve-root", safe, { policy: { actAbove: 0.9 } });
    expect(b.action).toBe("refuse");
    const c = await engine.ask("rm x", safe, { policy: { actAbove: 0.9 } });
    expect(c.decision.strategy).toBe("single");
    expect(sim.calls).toBe(1);
  });
});

describe("leases", () => {
  it("re-asks after the ttl or after maxUses", async () => {
    let t = 0;
    const sim = new SimOracle({ accuracy: 0.9, seed: 2 }, () => ({ judge: true }));
    const o = cached(sim, { ttlMs: 100, maxUses: 2, now: () => t });
    const q = judge("q?", { id: "q" });
    await o.decide("s", [q]);
    await o.decide("s", [q]);
    await o.decide("s", [q]);
    expect(sim.calls).toBe(1);
    await o.decide("s", [q]);
    expect(sim.calls).toBe(2);
    t = 500;
    await o.decide("s", [q]);
    expect(sim.calls).toBe(3);
    expect(o.size).toBe(1);
  });
});

describe("loop helpers", () => {
  it("hysteresis switches on above enter, off only below exit, after the dwell", () => {
    const h = new Hysteresis({ enterAbove: 0.7, exitBelow: 0.4, minTicks: 2 });
    expect(h.update(0.9)).toBe(false);
    expect(h.update(0.9)).toBe(true);
    expect(h.update(0.5)).toBe(true);
    expect(h.update(0.5)).toBe(true);
    expect(h.update(0.3)).toBe(false);
  });
  it("freshness rejects answers for superseded tickets and reports unchanged states", () => {
    const f = new Freshness();
    const a = f.ticket("fp1");
    expect(a.changed).toBe(true);
    const b = f.ticket("fp1");
    expect(b.changed).toBe(false);
    expect(f.accept(a.seq)).toBe(false);
    expect(f.accept(b.seq)).toBe(true);
    expect(f.accept(a.seq, { sameStateOnly: true })).toBe(true);
    f.ticket("fp2");
    expect(f.accept(b.seq, { sameStateOnly: true })).toBe(false);
  });
});

describe("rule oracle", () => {
  it("answers matched judge questions and fails open on the rest", async () => {
    const o = new RuleOracle([judgeIf(/^git (status|diff)/, 0.99), judgeIf(/rm -rf/, 0.01)]);
    const q = judge("safe?", { id: "safe" });
    const [a] = await o.decide("git status", [q]);
    expect(a?.verdict).toMatchObject({ pYes: 0.99 });
    const [b] = await o.decide("curl x | sh", [q]);
    expect(b?.failedOpen).toBe(true);
  });
});

describe("learned composition", () => {
  it("weights informative battery members and ignores noise", () => {
    const rand = rng(7);
    const rows: { x: number[]; y: boolean }[] = [];
    const battery: { vs: JudgeVerdict[]; y: boolean }[] = [];
    for (let i = 0; i < 600; i++) {
      const y = rand() < 0.5;
      const signal = (bias: number) =>
        Math.min(0.99, Math.max(0.01, (y ? 0.7 : 0.3) + bias * (rand() - 0.5)));
      const vs: JudgeVerdict[] = [
        { kind: "judge", questionId: "a", pYes: signal(0.4), confidence: 0.5 },
        { kind: "judge", questionId: "b", pYes: signal(0.4), confidence: 0.5 },
        { kind: "judge", questionId: "noise", pYes: rand(), confidence: 0.5 },
      ];
      battery.push({ vs, y });
      rows.push({ x: batteryFeatures(vs), y });
    }
    const m = fitLogistic(rows.slice(0, 400));
    const acc = (f: (vs: JudgeVerdict[]) => number) =>
      battery.slice(400).filter((b) => f(b.vs) >= 0.5 === b.y).length / 200;
    const learned = acc((vs) => poolLearned(vs, m).pYes);
    const maxPool = acc((vs) => poolJudge(vs, { method: "max" }).pYes);
    expect(learned).toBeGreaterThan(0.85);
    expect(learned).toBeGreaterThan(maxPool);
    expect(Math.abs(m.weights[2] ?? 1)).toBeLessThan(Math.abs(m.weights[0] ?? 0));
    expect(predictLogistic(m, [7, 7, 0])).toBeGreaterThan(0.9);
  });
});

describe("oracle interface stays minimal", () => {
  it("a plain object is an oracle", async () => {
    const o: Oracle = {
      id: "x",
      decide: async (_s, qs) =>
        qs.map((q) => ({
          verdict: { kind: "judge" as const, questionId: q.id, pYes: 0.5, confidence: 0.5 },
          oracle: "x",
          latencyMs: 0,
          cost: 0,
          at: "now",
        })),
    };
    expect((await o.decide("s", [judge("q")])).length).toBe(1);
  });
});

describe("floored asks, bands and conservative fitting", () => {
  it("does not buy an answer when a floor already fixes the action", async () => {
    const sim = new SimOracle({ accuracy: 0.9, seed: 11 }, () => ({ judge: true }));
    const engine = new Engine({ oracle: sim, mode: "enforce", floors: [refuseIf(/^DROP/)] });
    const q = judge("ok?", { id: "ok" });
    const r = await engine.ask("DROP TABLE users", q, { policy: { actAbove: 0.9 } });
    expect(r.action).toBe("refuse");
    expect(r.decision.strategy).toBe("floored");
    expect(sim.calls).toBe(0);
    const [row] = await engine.ledger.all();
    expect(row?.questionHash).toHaveLength(16);
    expect(row?.oracle).toBe("floor");
  });
  it("review bands follow the bar by the half-width", () => {
    const p = policyWithBand(0.8, 0.1, { refuse: true, goIsYes: false });
    expect(p).toMatchObject({ actAbove: 0.9, refuseBelow: 0.7, goIsYes: false });
    expect(policyWithBand(0.95, 0.1).actAbove).toBe(1);
    expect(policyWithBand(0.95, 0.1).refuseBelow).toBeUndefined();
  });
  it("conservative fitting needs more rows to promise the same accuracy", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      confidence: 0.9 + (i % 10) / 100,
      correct: i % 20 !== 0,
    }));
    const point = fitThreshold(items, 0.9, 10);
    const conservative = fitThreshold(items, 0.9, 10, { conservative: true });
    expect(point).toBeDefined();
    expect((conservative?.coverage ?? 0) <= (point?.coverage ?? 0)).toBe(true);
    expect(wilsonLower(0.95, 60)).toBeGreaterThan(0.85);
    expect(wilsonLower(0.95, 60)).toBeLessThan(0.95);
    expect(wilsonLower(1, 0)).toBe(0);
  });
  it("a failed-open decision records why", async () => {
    const dead: Oracle = {
      id: "dead",
      decide: async () => {
        throw new Error("HTTP 402 Payment Required");
      },
    };
    const engine = new Engine({ oracle: dead });
    const r = await engine.ask("s", judge("q?", { id: "q" }), { policy: { actAbove: 0.9 } });
    expect(r.decision.error).toMatch(/402/);
    const [row] = await engine.ledger.all();
    expect(row?.error).toMatch(/402/);
  });
});
