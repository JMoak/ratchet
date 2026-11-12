/**
 * Wave 2, package A: `runChain` and gate verifiers.
 *
 * T2-01: a step verified by a gate commits only when the gate's own action is act (its floors,
 * one-way doors, mode and audits hold) and the chain's policy agrees; a gate's refuse stops the
 * chain. Before the fix the chain re-ruled the bare decision and committed a DROP TABLE step the
 * gate had said to review, in all four cases of experiments/e2e/t2-verifier/repro/
 * chain-drops-gate-controls.ts.
 * T2-03: each verification can carry chain, step and attempt tags (`chainTags`).
 * T2-09: a non-finite or non-integer attempt budget is refused before anything runs.
 */
import { describe, expect, it } from "vitest";
import {
  chainTags,
  isGateVerification,
  runChain,
  type Step,
  type Verification,
} from "../src/compound/chain.ts";
import { Engine, type EngineOptions } from "../src/engine.ts";
import { oneWayDoor, refuseIf, reviewIf } from "../src/floors.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";
import { type GatePolicy, policyFromCosts } from "../src/policy.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { Action, Decision, JudgeQuestion, Oracle } from "../src/types.ts";

const verified = judge("Did the step succeed?", { id: "step.ok" });

/** A verifier that is sure (0.97) every step succeeded. */
const sure: Oracle = {
  id: "sure",
  decide: async (_s, qs) =>
    qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, 0.97),
      oracle: "sure",
      latencyMs: 0,
      cost: 0.001,
      at: "2026-11-12T00:00:00.000Z",
    })),
};

const DROP = "ran: DROP TABLE customers; -- irreversible";
const mk = (opts: Partial<EngineOptions> = {}) =>
  new Engine({ oracle: sure, ledger: new MemoryLedger(), seed: 1, ...opts });

/** One migration step, verified by `gate.ask` with the chain's tags. */
function migration(
  ask: (state: string, tags: readonly string[]) => Promise<Verification>,
  maxAttempts = 2,
): Step<string>[] {
  return [
    {
      name: "migrate",
      maxAttempts,
      propose: async () => DROP,
      verify: async (_b, after, _attempt, tags) => ask(after, tags),
    },
  ];
}

describe("T2-01: a gate verifier's controls hold inside a chain", () => {
  const banded: GatePolicy = { actAbove: 0.9, refuseBelow: 0.1 };
  const cases: {
    name: string;
    engine: Engine;
    policy: GatePolicy;
    gate: Parameters<Engine["gate"]>[0];
  }[] = [
    {
      name: "review floor on the gate (refuseBelow set, so the oracle is still asked)",
      engine: mk({ mode: "enforce" }),
      policy: banded,
      gate: { id: "v1", question: verified, policy: banded, floors: [reviewIf(/DROP TABLE/)] },
    },
    {
      name: "oneWayDoor floor, chain policy from equal costs (actAbove 0.5)",
      engine: mk({ mode: "enforce" }),
      policy: policyFromCosts(1, 1),
      gate: {
        id: "v2",
        question: verified,
        policy: policyFromCosts(1, 1),
        floors: [oneWayDoor((s) => s.includes("DROP TABLE"))],
      },
    },
    {
      name: "gate left in shadow (the default)",
      engine: mk(),
      policy: { actAbove: 0.9 },
      gate: { id: "v3", question: verified, policy: { actAbove: 0.9 } },
    },
    {
      name: "enforce with a blind audit on every act",
      engine: mk({ mode: "enforce", auditRate: 1 }),
      policy: { actAbove: 0.9 },
      gate: { id: "v4", question: verified, policy: { actAbove: 0.9 } },
    },
  ];
  for (const c of cases) {
    it(`does not commit what the gate held back: ${c.name}`, async () => {
      const gate = c.engine.gate(c.gate);
      const actions: Action[] = [];
      const res = await runChain(
        "start",
        migration(async (s, tags) => {
          const r = await gate.ask(s, { tags });
          actions.push(r.action);
          return r;
        }),
        c.policy,
      );
      expect(actions).not.toContain("act");
      expect(res.ok).toBe(false);
      expect(res.trace[0]?.committed).toBe(false);
      expect(res.state).toBe("start");
      for (const a of res.trace[0]?.attempts ?? []) {
        expect(a.ruling.action).not.toBe("act");
        expect(a.gate?.action).toBe(actions[a.attempt - 1]);
        expect(a.gate?.recordId).toBeDefined();
      }
    });
  }

  it("commits when the gate acts and the chain's policy agrees, and records both", async () => {
    const engine = mk({ mode: "enforce" });
    const gate = engine.gate({ id: "ok", question: verified, policy: { actAbove: 0.9 } });
    const res = await runChain(
      "start",
      migration((s, tags) => gate.ask(s, { tags })),
      { actAbove: 0.9 },
    );
    expect(res.ok).toBe(true);
    expect(res.state).toBe(DROP);
    const a = res.trace[0]?.attempts[0];
    expect(a?.gate).toMatchObject({ action: "act", mode: "enforce", audited: false });
    expect(a?.ruling.action).toBe("act");
    expect(res.cost).toBeCloseTo(0.001, 12);
  });

  it("the chain's own policy still binds: a gate act below the chain's bar is held back", async () => {
    const engine = mk({ mode: "enforce" });
    const gate = engine.gate({ id: "lax", question: verified, policy: { actAbove: 0.5 } });
    const res = await runChain(
      "start",
      migration((s, tags) => gate.ask(s, { tags })),
      { actAbove: 0.99 },
    );
    expect(res.ok).toBe(false);
    expect(res.trace[0]?.attempts.every((a) => a.gate?.action === "act")).toBe(true);
    expect(res.trace[0]?.attempts.every((a) => a.ruling.action === "review")).toBe(true);
    expect(res.stopReason).toBe("exhausted");
  });

  it("a gate that refuses stops the chain", async () => {
    const engine = mk({ mode: "enforce" });
    const gate = engine.gate({
      id: "stop",
      question: verified,
      policy: { actAbove: 0.9 },
      floors: [refuseIf(/DROP TABLE/)],
    });
    const res = await runChain(
      "start",
      migration((s, tags) => gate.ask(s, { tags }), 3),
      { actAbove: 0.9 },
    );
    expect(res.stopReason).toBe("refused");
    expect(res.trace[0]?.attempts).toHaveLength(1);
    expect(res.trace[0]?.attempts[0]?.ruling.reason).toMatch(/floor refuse overrides/);
    expect(res.trace[0]?.attempts[0]?.gate?.action).toBe("refuse");
  });

  it("a shadow gate with baseline act lets the chain's own policy decide while it records", async () => {
    const engine = mk();
    const gate = engine.gate({ id: "sh", question: verified, policy: { actAbove: 0.9 } });
    const res = await runChain(
      "start",
      migration((s, tags) => gate.ask(s, { tags, baseline: "act" })),
      { actAbove: 0.9 },
    );
    expect(res.ok).toBe(true);
    const [row] = await engine.ledger.all();
    expect(row).toMatchObject({ mode: "shadow", action: "act", soft: "act" });
  });

  it("a bare decision is ruled by the chain's policy alone, as before", async () => {
    const engine = mk({ mode: "enforce" });
    const gate = engine.gate({
      id: "bare",
      question: verified,
      policy: { actAbove: 0.9 },
      floors: [refuseIf(/DROP TABLE/)],
    });
    // The floor settles the row without asking (neutral 0.5), so even the bare decision of a
    // refusing gate holds back here; with a sure verifier and no floor it would commit.
    const res = await runChain(
      "start",
      migration(async (s, tags) => (await gate.ask(s, { tags })).decision),
      { actAbove: 0.9 },
    );
    expect(res.ok).toBe(false);
    expect(res.trace[0]?.attempts[0]?.gate).toBeUndefined();
    const d: Decision = {
      verdict: judgeVerdictFrom(verified, 0.97),
      oracle: "sure",
      latencyMs: 0,
      cost: 0,
      at: "now",
    };
    expect(isGateVerification(d)).toBe(false);
    const committed = await runChain(
      "start",
      [{ name: "s", propose: async () => "next", verify: async () => d }],
      { actAbove: 0.9 },
    );
    expect(committed.ok).toBe(true);
  });
});

describe("T2-01 (V1): a gate's floor binds the chain in every mode", () => {
  const step = (verify: Step<string>["verify"]): Step<string>[] => [
    { name: "migrate", propose: async () => "DROP TABLE users;", verify, maxAttempts: 2 },
  ];
  it("a shadow gate asked with baseline act cannot commit what its refuse floor matches", async () => {
    const engine = mk();
    const gate = engine.gate({
      id: "v",
      question: verified,
      policy: { actAbove: 0.9 },
      floors: [refuseIf(/DROP TABLE/)],
    });
    const res = await runChain(
      "start",
      step((_b, after, _n, tags) => gate.ask(after, { baseline: "act", tags })),
      { actAbove: 0.5 },
    );
    expect(res.ok).toBe(false);
    expect(res.state).toBe("start");
    expect(res.stopReason).toBe("refused");
    expect(res.trace[0]?.attempts[0]?.gate?.action).toBe("act");
  });
  it("a review floor or a one-way door holds the step back at any chain bar", async () => {
    for (const floor of [reviewIf(/DROP TABLE/), oneWayDoor((s) => s.includes("DROP"))]) {
      const engine = mk();
      const gate = engine.gate({
        id: "v",
        question: verified,
        policy: { actAbove: 0.9 },
        floors: [floor],
      });
      const res = await runChain(
        "start",
        step((_b, after, _n, tags) => gate.ask(after, { baseline: "act", tags })),
        { actAbove: 0 },
      );
      expect(res.ok).toBe(false);
      expect(res.trace[0]?.attempts.every((a) => a.ruling.action === "review")).toBe(true);
    }
  });
  it("without a gate floor, a shadow gate with baseline act still lets the chain decide", async () => {
    const engine = mk();
    const gate = engine.gate({ id: "v", question: verified, policy: { actAbove: 0.9 } });
    const res = await runChain(
      "start",
      step((_b, after, _n, tags) => gate.ask(after, { baseline: "act", tags })),
      { actAbove: 0.9 },
    );
    expect(res.ok).toBe(true);
  });
  it("reads a gate action outside the vocabulary cautiously, never as act", async () => {
    const d: Decision = {
      verdict: judgeVerdictFrom(verified, 0.99),
      oracle: "sure",
      latencyMs: 0,
      cost: 0,
      at: "now",
    };
    const ruling = {
      action: "act" as Action,
      go: 0.99,
      soft: "act" as Action,
      floor: "act" as Action,
      reason: "ok",
    };
    const cases: [unknown, Action][] = [
      ["REFUSE", "refuse"],
      ["deny", "refuse"],
      [undefined, "review"],
      ["ACT", "review"],
      [1, "review"],
    ];
    for (const [action, read] of cases) {
      const res = await runChain(
        "start",
        step(async () => ({ decision: d, ruling, action: action as Action })),
        { actAbove: 0.9 },
      );
      expect(res.ok, String(action)).toBe(false);
      expect(res.trace[0]?.attempts[0]?.ruling.action).toBe(read);
      expect(res.trace[0]?.attempts[0]?.gate?.action).toBe(read);
    }
    // A ruling whose floor is outside the vocabulary binds too; a missing ruling reads as review.
    const garbled = { ...ruling, floor: "BLOCK" as Action };
    const blocked = await runChain(
      "start",
      step(async () => ({ decision: d, ruling: garbled, action: "act" as Action })),
      { actAbove: 0.9 },
    );
    expect(blocked.stopReason).toBe("refused");
    const unruled = await runChain(
      "start",
      step(async () => ({ decision: d, ruling: undefined as never, action: "act" as Action })),
      { actAbove: 0.9 },
    );
    expect(unruled.ok).toBe(false);
  });
});

describe("T2-03: chain tags", () => {
  it("names the chain, the step and the attempt, and reaches the gate's rows", async () => {
    expect(chainTags("migrate", 2)).toEqual(["chain", "chain:step:migrate", "chain:attempt:2"]);
    const engine = mk({ mode: "enforce" });
    const gate = engine.gate({
      id: "t",
      question: verified,
      policy: { actAbove: 0.9 },
      floors: [reviewIf(/DROP/)],
    });
    const seen: (readonly string[])[] = [];
    await runChain(
      "start",
      migration((s, tags) => {
        seen.push(tags);
        return gate.ask(s, { tags });
      }, 3),
      { actAbove: 0.9 },
    );
    expect(seen).toEqual([
      chainTags("migrate", 1),
      chainTags("migrate", 2),
      chainTags("migrate", 3),
    ]);
    const rows = await engine.ledger.all();
    expect(rows.map((r) => r.tags.filter((t) => t.startsWith("chain:attempt:")))).toEqual([
      ["chain:attempt:1"],
      ["chain:attempt:2"],
      ["chain:attempt:3"],
    ]);
  });
});

describe("T2-09: attempt budgets are finite integers of at least 1", () => {
  const unsure: Decision = {
    verdict: judgeVerdictFrom(verified, 0.5),
    oracle: "unsure",
    latencyMs: 0,
    cost: 0,
    at: "now",
  };
  for (const maxAttempts of [
    Number.POSITIVE_INFINITY,
    Number.NaN,
    0,
    -1,
    1.5,
    "3" as unknown as number,
  ]) {
    it(`refuses maxAttempts ${String(maxAttempts)} before proposing anything`, async () => {
      let proposals = 0;
      const steps: Step<number>[] = [
        { name: "first", propose: async (s) => s + 1, verify: async () => unsure, maxAttempts: 1 },
        {
          name: "bad",
          maxAttempts,
          propose: async (s) => {
            proposals++;
            return s + 1;
          },
          verify: async () => unsure,
        },
      ];
      await expect(runChain(0, steps, { actAbove: 0.9 })).rejects.toThrow(
        /bad: maxAttempts must be a finite integer of at least 1/,
      );
      expect(proposals).toBe(0);
    });
  }
  it("accepts the default and a finite integer budget", async () => {
    let proposals = 0;
    const res = await runChain(
      0,
      [
        {
          name: "s",
          maxAttempts: 4,
          propose: async (s) => {
            proposals++;
            return s + 1;
          },
          verify: async () => unsure,
        },
      ],
      { actAbove: 0.9 },
    );
    expect(proposals).toBe(4);
    expect(res.stopReason).toBe("exhausted");
  });
});
