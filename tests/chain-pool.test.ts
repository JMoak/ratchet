/**
 * `runChain`'s opt-in options from the verified-chains research (Foundations review 2026-11):
 * state keys (run, instance, candidate and holds tags; repeated candidates not re-verified), a
 * shared attempt pool with one attempt reserved for each later step, a second opinion on held
 * candidates (order a person's queue by default, route, or commit), held candidates on the
 * trace, and a plain-data summary. Without them, `runChain` must behave exactly as before.
 */
import { describe, expect, it } from "vitest";
import {
  type Attempt,
  type ChainOptions,
  type ChainResult,
  chainTags,
  readChainTags,
  runChain,
  type Step,
  type StepTrace,
  summarizeChain,
  type Verification,
} from "../src/compound/chain.ts";
import { Engine } from "../src/engine.ts";
import { oneWayDoor, refuseIf, reviewIf } from "../src/floors.ts";
import { chainAttempt, isUnselected } from "../src/ledger/calibration.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";
import { type Rand, rng } from "../src/math.ts";
import { type GatePolicy, rule } from "../src/policy.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { Action, Decision, JudgeQuestion, Oracle } from "../src/types.ts";

const verified = judge("Did the step succeed?", { id: "step.ok" });

/** A bare verifier answer: p(yes) that the candidate achieved the step. */
const said = (pYes: number, cost = 0.001): Decision => ({
  verdict: judgeVerdictFrom(verified, pYes),
  oracle: "v",
  latencyMs: 0,
  cost,
  at: "2026-11-12T00:00:00.000Z",
});
const failed = (): Decision => ({ ...said(0.5), failedOpen: true, error: "timeout" });

const bar: GatePolicy = { actAbove: 0.9 };

/** The chain as it was before these options, for bare-decision verifiers. */
async function legacy<S>(
  initial: S,
  steps: readonly Step<S>[],
  policy: GatePolicy,
  floor?: Action,
): Promise<ChainResult<S>> {
  let state = initial;
  const checkpoints: S[] = [initial];
  const trace: StepTrace<S>[] = [];
  let cost = 0;
  for (const step of steps) {
    const attempts: Attempt[] = [];
    let committed = false;
    let refused = false;
    for (let attempt = 1; attempt <= (step.maxAttempts ?? 3); attempt++) {
      const after = await step.propose(state, attempt);
      const d = (await step.verify(
        state,
        after,
        attempt,
        chainTags(step.name, attempt),
      )) as Decision;
      const ruling = rule(d, policy, floor);
      cost += d.cost;
      attempts.push({ attempt, decision: d, ruling });
      if (ruling.action === "act") {
        state = after;
        checkpoints.push(after);
        committed = true;
        break;
      }
      if (ruling.action === "refuse") {
        refused = true;
        break;
      }
    }
    trace.push({ name: step.name, attempts, committed });
    if (!committed) {
      return {
        ok: false,
        state,
        checkpoints,
        trace,
        cost,
        stoppedAt: step.name,
        stopReason: refused ? "refused" : "exhausted",
      };
    }
  }
  return { ok: true, state, checkpoints, trace, cost };
}

/** Random steps over numeric states; the same seed builds the same steps and verdicts. */
function randomSteps(seed: number): { steps: Step<number>[]; policy: GatePolicy; floor?: Action } {
  const rand = rng(seed);
  const n = 1 + Math.floor(rand() * 5);
  const steps: Step<number>[] = Array.from({ length: n }, (_, i) => {
    const max = rand() < 0.3 ? undefined : 1 + Math.floor(rand() * 4);
    return {
      name: `s${i}`,
      ...(max !== undefined ? { maxAttempts: max } : {}),
      propose: async (s) => s * 10 + Math.floor(rand() * 10),
      verify: async () => said([0.05, 0.5, 0.95, 0.95][Math.floor(rand() * 4)] as number),
    };
  });
  const policy: GatePolicy = rand() < 0.5 ? bar : { actAbove: 0.9, refuseBelow: 0.1 };
  const floor = (["act", "review", undefined, undefined] as const)[Math.floor(rand() * 4)];
  return { steps, policy, ...(floor !== undefined ? { floor } : {}) };
}

describe("without the new options", () => {
  it("returns exactly what the chain returned before, over many random chains", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const a = randomSteps(seed);
      const b = randomSteps(seed);
      const now = await runChain(0, a.steps, a.policy, {
        ...(a.floor !== undefined ? { floor: a.floor } : {}),
      });
      const before = await legacy(0, b.steps, b.policy, b.floor);
      // Strict: no new key appears, not even one set to undefined.
      expect(now, `seed ${seed}`).toStrictEqual(before);
    }
  });

  it("keeps today's shapes when the verifier is a gate", async () => {
    const sure: Oracle = {
      id: "sure",
      decide: async (_s, qs) =>
        qs.map((q) => ({ ...said(0.97), verdict: judgeVerdictFrom(q as JudgeQuestion, 0.97) })),
    };
    const engine = new Engine({
      oracle: sure,
      ledger: new MemoryLedger(),
      seed: 1,
      mode: "enforce",
    });
    const ok = engine.gate({ id: "ok", question: verified, policy: bar });
    const stop = engine.gate({
      id: "stop",
      question: verified,
      policy: bar,
      floors: [refuseIf(/x/)],
    });
    const step = (g: typeof ok): Step<string> => ({
      name: "s",
      propose: async () => "x",
      verify: async (_b, after, _n, tags) => g.ask(after, { tags }),
    });
    const done = await runChain("start", [step(ok)], bar);
    expect(Object.keys(done).sort()).toEqual(["checkpoints", "cost", "ok", "state", "trace"]);
    expect(Object.keys(done.trace[0] ?? {}).sort()).toEqual(["attempts", "committed", "name"]);
    expect(Object.keys(done.trace[0]?.attempts[0] ?? {}).sort()).toEqual([
      "attempt",
      "decision",
      "gate",
      "ruling",
    ]);
    const refused = await runChain("start", [step(stop)], bar);
    expect(Object.keys(refused).sort()).toEqual([
      "checkpoints",
      "cost",
      "ok",
      "state",
      "stopReason",
      "stoppedAt",
      "trace",
    ]);
    // Rows carry today's three tags and no more.
    for (const r of await engine.ledger.all()) {
      expect(r.tags.filter((t) => t.startsWith("chain"))).toEqual(chainTags("s", 1));
    }
  });
});

describe("keyOf: tags and fresh candidates", () => {
  const keyed: ChainOptions<string> = { keyOf: (s) => `k:${s}`, runId: "run-7" };

  it("adds run, instance, candidate and holds after today's three tags", async () => {
    const seen: (readonly string[])[] = [];
    const steps: Step<string>[] = [
      {
        name: "plan",
        propose: async (_s, n) => `p${n}`,
        verify: async (_b, after, _n, tags) => {
          seen.push(tags);
          return said(after === "p2" ? 0.95 : 0.2);
        },
      },
    ];
    const res = await runChain("start", steps, bar, keyed);
    expect(res.ok).toBe(true);
    expect(seen).toEqual([
      [
        ...chainTags("plan", 1),
        "chain:run:run-7",
        "chain:instance:plan@k:start",
        "chain:candidate:k:p1",
        "chain:holds:0",
      ],
      [
        ...chainTags("plan", 2),
        "chain:run:run-7",
        "chain:instance:plan@k:start",
        "chain:candidate:k:p2",
        "chain:holds:1",
      ],
    ]);
    expect(readChainTags(seen[1])).toEqual({
      step: "plan",
      attempt: 2,
      run: "run-7",
      instance: "plan@k:start",
      candidate: "k:p2",
      holds: 1,
    });
    expect(readChainTags(["chain:step:x"])).toBeUndefined();
    expect(res.runId).toBe("run-7");
    expect(res.trace[0]).toMatchObject({ instance: "plan@k:start", duplicates: [] });
    expect(res.trace[0]?.attempts.map((a) => [a.key, a.holdsBefore])).toEqual([
      ["k:p1", 0],
      ["k:p2", 1],
    ]);
  });

  it("reaches a gate's rows without changing how learning reads them", async () => {
    const sure: Oracle = {
      id: "o",
      decide: async (state, qs) =>
        qs.map((q) => ({
          ...said(0),
          verdict: judgeVerdictFrom(q as JudgeQuestion, state.endsWith("2") ? 0.97 : 0.2),
        })),
    };
    const engine = new Engine({ oracle: sure, ledger: new MemoryLedger(), seed: 1 });
    const gate = engine.gate({ id: "v", question: verified, policy: bar });
    const step: Step<string> = {
      name: "s",
      propose: async (_s, n) => `c${n}`,
      verify: async (_b, after, _n, tags) => gate.ask(after, { tags, baseline: "act" }),
    };
    const first = await runChain("start", [step], bar, { keyOf: (s) => s });
    const second = await runChain("start", [step], bar, { keyOf: (s) => s });
    expect(first.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.runId).not.toBe(first.runId);
    const rows = await engine.ledger.all();
    expect(rows.map((r) => readChainTags(r.tags)?.run)).toEqual([
      first.runId,
      first.runId,
      second.runId,
      second.runId,
    ]);
    expect(rows.map(chainAttempt)).toEqual([1, 2, 1, 2]);
    // Shadow rows: a first attempt is unselected evidence, a retry never is (as before).
    expect(rows.map((r) => isUnselected(r))).toEqual([true, false, true, false]);
  });

  it("does not verify a repeated candidate again, and a repeat uses an attempt", async () => {
    let proposals = 0;
    let verifications = 0;
    const stuck: Step<string> = {
      name: "s",
      maxAttempts: 5,
      propose: async () => {
        proposals++;
        return "same";
      },
      verify: async () => {
        verifications++;
        return said(0.2);
      },
    };
    const res = await runChain("start", [stuck], bar, keyed);
    expect([proposals, verifications]).toEqual([5, 1]);
    expect(res.stopReason).toBe("exhausted");
    expect(res.trace[0]?.duplicates).toEqual(
      [2, 3, 4, 5].map((attempt) => ({ attempt, key: "k:same", repeats: 1 })),
    );
    // A repeat is neither a hold nor a pass: no later verification saw it counted.
    expect(summarizeChain(res).steps[0]).toMatchObject({
      proposals: 5,
      verified: 1,
      holds: 1,
      duplicates: 4,
    });
    // It cannot loop under a pool with no per-step cap either.
    proposals = 0;
    verifications = 0;
    const { maxAttempts: _cap, ...uncapped } = stuck;
    const pooled = await runChain("start", [uncapped], bar, { ...keyed, attemptPool: 7 });
    expect([proposals, verifications]).toEqual([7, 1]);
    expect(pooled.pool).toEqual({ size: 7, used: 7 });
    // Without keyOf a repeat is verified again, as before.
    proposals = 0;
    verifications = 0;
    await runChain("start", [stuck], bar);
    expect([proposals, verifications]).toEqual([5, 5]);
  });

  it("refuses a key that is not a string and an empty run id", async () => {
    const step: Step<string> = {
      name: "s",
      propose: async () => "x",
      verify: async () => said(0.95),
    };
    await expect(
      runChain("start", [step], bar, { keyOf: (s) => s.length as unknown as string }),
    ).rejects.toThrow(/keyOf must return a string/);
    await expect(runChain("start", [step], bar, { keyOf: (s) => s, runId: "" })).rejects.toThrow(
      /runId must be a non-empty string/,
    );
  });
});

/** A step that commits on its `passAt`-th attempt (never when undefined), counting proposals. */
function counted(name: string, passAt: number | undefined, maxAttempts?: number) {
  const calls = { proposals: 0 };
  const step: Step<string> = {
    name,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    propose: async (_s, n) => {
      calls.proposals++;
      return `${name}${n}`;
    },
    verify: async (_b, _a, n) => said(n === passAt ? 0.95 : 0.2),
  };
  return { step, calls };
}

describe("attemptPool", () => {
  it("is checked before anything runs", async () => {
    for (const pool of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "8" as unknown as number,
    ]) {
      const { step, calls } = counted("s", 1);
      await expect(runChain("x", [step], bar, { attemptPool: pool })).rejects.toThrow(
        /attemptPool must be a finite integer of at least 1/,
      );
      expect(calls.proposals).toBe(0);
    }
    const { step, calls } = counted("s", 1);
    await expect(runChain("x", [step, step, step], bar, { attemptPool: 2 })).rejects.toThrow(
      /attemptPool 2 cannot give each of 3 steps an attempt/,
    );
    expect(calls.proposals).toBe(0);
  });

  it("lets a step without a cap of its own go past the default three", async () => {
    const a = counted("a", 5);
    const b = counted("b", 1);
    const res = await runChain("x", [a.step, b.step], bar, { attemptPool: 6 });
    expect(res.ok).toBe(true);
    expect(res.trace.map((t) => [t.allowance, t.attempts.length])).toEqual([
      [5, 5],
      [1, 1],
    ]);
    expect(res.pool).toEqual({ size: 6, used: 6 });
  });

  it("reserves one attempt for each later step: a greedy early step cannot starve them", async () => {
    // Pool 7, two steps: the first may use 6, never the one reserved for the second.
    const a = counted("a", 7);
    const b = counted("b", 1);
    const short = await runChain("x", [a.step, b.step], bar, { attemptPool: 7 });
    expect(short.stopReason).toBe("exhausted");
    expect(short.stoppedAt).toBe("a");
    expect(a.calls.proposals).toBe(6);
    expect(short.pool).toEqual({ size: 7, used: 6 });
    // One more in the pool and the first step's seventh attempt is its own to spend.
    const a2 = counted("a", 7);
    const b2 = counted("b", 1);
    const enough = await runChain("x", [a2.step, b2.step], bar, { attemptPool: 8 });
    expect(enough.ok).toBe(true);
    expect([a2.calls.proposals, b2.calls.proposals]).toEqual([7, 1]);
    // A step that never commits stops at its allowance and leaves the reservation unspent.
    const never = counted("a", undefined);
    const lost = await runChain(
      "x",
      [never.step, counted("b", 1).step, counted("c", 1).step],
      bar,
      {
        attemptPool: 10,
      },
    );
    expect(never.calls.proposals).toBe(8);
    expect(lost.pool).toEqual({ size: 10, used: 8 });
  });

  it("still lets an explicit maxAttempts cap its step", async () => {
    const a = counted("a", 4, 2);
    const res = await runChain("x", [a.step], bar, { attemptPool: 20 });
    expect(res.stopReason).toBe("exhausted");
    expect(a.calls.proposals).toBe(2);
    expect(res.trace[0]?.allowance).toBe(2);
  });

  it("never spends more than the pool, over many random chains", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const n = 1 + Math.floor(rand() * 6);
      const caps = Array.from({ length: n }, () =>
        rand() < 0.5 ? undefined : 1 + Math.floor(rand() * 5),
      );
      const steps = caps.map((cap, i) =>
        counted(`s${i}`, rand() < 0.2 ? undefined : 1 + Math.floor(rand() * 8), cap),
      );
      const pool = n + Math.floor(rand() * 3 * n);
      const res = await runChain(
        "x",
        steps.map((s) => s.step),
        bar,
        { attemptPool: pool },
      );
      const spent = steps.reduce((s, x) => s + x.calls.proposals, 0);
      expect(spent).toBeLessThanOrEqual(pool);
      expect(res.pool).toEqual({ size: pool, used: spent });
      expect(summarizeChain(res).proposals).toBe(spent);
      for (const [i, t] of res.trace.entries()) {
        expect(t.allowance).toBeGreaterThanOrEqual(1);
        const cap = caps[i];
        if (cap !== undefined) expect(steps[i]?.calls.proposals).toBeLessThanOrEqual(cap);
      }
    }
  });
});

/** A step whose primary verifier gives `primary[n - 1]` and second opinion `second[n - 1]`. */
function opinions(
  primary: readonly (number | Decision)[],
  second: readonly (number | Decision)[],
  log: string[] = [],
  name = "s",
): Step<string> {
  const at = (xs: readonly (number | Decision)[], n: number) => {
    const x = xs[n - 1] ?? 0.2;
    return typeof x === "number" ? said(x) : x;
  };
  return {
    name,
    maxAttempts: Math.max(primary.length, 1),
    propose: async (_s, n) => `c${n}`,
    verify: async (_b, _a, n) => {
      log.push(`v${n}`);
      return at(primary, n);
    },
    secondOpinion: async (_b, _a, n, tags) => {
      log.push(`2nd${n}`);
      // Today's three tags first, the tier last; with keyOf the context sits between them.
      expect(tags.slice(0, 3)).toEqual(chainTags(name, n));
      expect(tags.at(-1)).toBe("chain:tier:second");
      return at(second, n);
    },
  };
}

describe("a second opinion", () => {
  it("orders the held candidates at exhaustion by default: nothing committed, no early stop", async () => {
    const log: string[] = [];
    const res = await runChain("start", [opinions([0.3, 0.3, 0.3], [0.2, 0.95, 0.6], log)], bar);
    expect(res.ok).toBe(false);
    expect(res.stopReason).toBe("exhausted");
    expect(res.state).toBe("start");
    expect(res.checkpoints).toEqual(["start"]);
    // Every attempt was proposed and judged by both, in order, though the second opinion passed
    // attempt 2.
    expect(log).toEqual(["v1", "2nd1", "v2", "2nd2", "v3", "2nd3"]);
    expect(res.held?.map((c) => [c.attempt, c.candidate, c.second?.go])).toEqual([
      [2, "c2", 0.95],
      [3, "c3", 0.6],
      [1, "c1", 0.2],
    ]);
    expect(res.held?.every((c) => c.step === "s" && c.ruling.action === "review")).toBe(true);
    expect(res.pending).toBeUndefined();
    expect(res.trace[0]?.attempts.map((a) => a.second?.ruling.action)).toEqual([
      "review",
      "act",
      "review",
    ]);
    // Kept on the result for the queue, not on the trace unless asked.
    expect(res.trace[0]?.held).toBeUndefined();
    // The second opinion's cost counts.
    expect(res.cost).toBeCloseTo(0.006, 12);
  });

  it("puts a held candidate whose second opinion failed open after the scored ones", async () => {
    const res = await runChain("start", [opinions([0.3, 0.3, 0.3], [failed(), 0.1, 0.4])], bar);
    expect(res.held?.map((c) => c.attempt)).toEqual([3, 2, 1]);
  });

  it("is never asked after the primary acts or refuses", async () => {
    const log: string[] = [];
    const acted = await runChain("start", [opinions([0.3, 0.95], [0.1, 0.1], log)], bar);
    expect(acted.ok).toBe(true);
    expect(log).toEqual(["v1", "2nd1", "v2"]);
    expect(acted.trace[0]?.committedBy).toBe("primary");
    log.length = 0;
    const refused = await runChain("start", [opinions([0.3, 0.02, 0.3], [0.1, 0.99, 0.1], log)], {
      actAbove: 0.9,
      refuseBelow: 0.05,
    });
    expect(refused.stopReason).toBe("refused");
    expect(log).toEqual(["v1", "2nd1", "v2"]);
    // The refused candidate is not held for review; the one held before it is.
    expect(refused.held?.map((c) => c.attempt)).toEqual([1]);
  });

  it("routes a passed candidate to a person in route mode, and stops there", async () => {
    const res = await runChain("start", [opinions([0.3, 0.3, 0.3], [0.2, 0.95, 0.99])], bar, {
      secondOpinion: "route",
    });
    expect(res.stopReason).toBe("review");
    expect(res.stoppedAt).toBe("s");
    expect(res.state).toBe("start");
    expect(res.pending).toMatchObject({ step: "s", attempt: 2, candidate: "c2" });
    expect(res.pending?.second?.action).toBe("act");
    expect(res.held?.map((c) => c.attempt)).toEqual([1]);
    expect(res.trace[0]?.attempts).toHaveLength(2);
    const summary = summarizeChain(res);
    expect(summary).toMatchObject({
      outcome: "review",
      pending: { step: "s", attempt: 2 },
      held: 1,
    });
    // A second opinion that holds too: the step resamples as before.
    const held = await runChain("start", [opinions([0.3, 0.3, 0.95], [0.2, 0.2])], bar, {
      secondOpinion: "route",
    });
    expect(held.ok).toBe(true);
    expect(held.state).toBe("c3");
  });

  it("commits on the second opinion's pass only in commit mode, and records the tier", async () => {
    const res = await runChain("start", [opinions([0.3, 0.3, 0.3], [0.2, 0.95])], bar, {
      secondOpinion: "commit",
    });
    expect(res.ok).toBe(true);
    expect(res.state).toBe("c2");
    expect(res.trace[0]).toMatchObject({ committed: true, committedBy: "second" });
    expect(summarizeChain(res).steps[0]).toMatchObject({
      committedBy: "second",
      secondOpinions: { asked: 2, act: 1, review: 1, refuse: 0 },
    });
  });

  it("stops the chain when the second opinion refuses", async () => {
    for (const mode of ["order", "route", "commit"] as const) {
      const res = await runChain(
        "start",
        [opinions([0.3, 0.3], [0.2, 0.01])],
        { actAbove: 0.9, refuseBelow: 0.05 },
        {
          secondOpinion: mode,
        },
      );
      expect(res.stopReason, mode).toBe("refused");
      expect(res.state).toBe("start");
    }
  });

  it("goes through the gate's floors: a floor or one-way door stops a second-opinion commit", async () => {
    const sure: Oracle = {
      id: "sure",
      decide: async (_s, qs) =>
        qs.map((q) => ({ ...said(0.97), verdict: judgeVerdictFrom(q as JudgeQuestion, 0.97) })),
    };
    const DROP = "DROP TABLE customers;";
    const run = async (floors: Parameters<Engine["gate"]>[0]["floors"]) => {
      const engine = new Engine({
        oracle: sure,
        ledger: new MemoryLedger(),
        seed: 1,
        mode: "enforce",
      });
      const gate = engine.gate({
        id: "second",
        question: verified,
        policy: bar,
        ...(floors ? { floors } : {}),
      });
      const step: Step<string> = {
        name: "migrate",
        maxAttempts: 2,
        propose: async () => DROP,
        verify: async () => said(0.2),
        secondOpinion: async (_b, after, _n, tags): Promise<Verification> =>
          gate.ask(after, { tags }),
      };
      return runChain("start", [step], bar, { secondOpinion: "commit" });
    };
    const control = await run(undefined);
    expect(control.ok).toBe(true);
    expect(control.trace[0]?.committedBy).toBe("second");
    for (const floor of [reviewIf(/DROP TABLE/), oneWayDoor((s) => s.includes("DROP"))]) {
      const res = await run([floor]);
      expect(res.ok).toBe(false);
      expect(res.state).toBe("start");
      expect(res.trace[0]?.attempts.every((a) => a.second?.ruling.action === "review")).toBe(true);
    }
    const refused = await run([refuseIf(/DROP TABLE/)]);
    expect(refused.stopReason).toBe("refused");
    expect(refused.trace[0]?.attempts[0]?.second?.gate?.action).toBe("refuse");
  });

  it("cannot release in commit mode what the primary gate held by a floor, baseline or audit", async () => {
    const DROP = "DROP TABLE customers;";
    /** A primary gate that judges every candidate below the chain's bar (0.5), or sure (0.97). */
    const primary = (pYes: number): Oracle => ({
      id: "primary",
      decide: async (_s, qs) =>
        qs.map((q) => ({ ...said(pYes), verdict: judgeVerdictFrom(q as JudgeQuestion, pYes) })),
    });
    const run = async (
      engine: Engine,
      gate: Parameters<Engine["gate"]>[0],
      ask: { baseline?: Action } = {},
    ) => {
      const g = engine.gate(gate);
      const step: Step<string> = {
        name: "migrate",
        maxAttempts: 2,
        propose: async () => DROP,
        verify: async (_b, after, _n, tags) => g.ask(after, { tags, ...ask }),
        secondOpinion: async () => said(0.99),
      };
      return runChain("start", [step], bar, { secondOpinion: "commit" });
    };
    const mk = (pYes: number, mode: "shadow" | "enforce", auditRate = 0) =>
      new Engine({ oracle: primary(pYes), ledger: new MemoryLedger(), seed: 1, mode, auditRate });
    // Control: an enforce gate whose judgement held the candidate (0.5 below the 0.9 bar).
    const judged = await run(mk(0.5, "enforce"), { id: "v", question: verified, policy: bar });
    expect(judged.trace[0]?.committedBy).toBe("second");
    // Its one-way door or review floor: never released.
    for (const floor of [oneWayDoor((s) => s.includes("DROP")), reviewIf(/DROP TABLE/)]) {
      const res = await run(mk(0.97, "enforce"), {
        id: "v",
        question: verified,
        policy: bar,
        floors: [floor],
      });
      expect(res.ok).toBe(false);
      expect(res.trace[0]?.attempts.every((a) => a.second?.ruling.action === "review")).toBe(true);
    }
    // A shadow gate on its default baseline commits nothing, second opinion or not.
    const shadow = await run(mk(0.5, "shadow"), { id: "v", question: verified, policy: bar });
    expect(shadow.ok).toBe(false);
    // With baseline act the caller has said what it does anyway, and a judged hold is releasable.
    const told = await run(
      mk(0.5, "shadow"),
      { id: "v", question: verified, policy: bar },
      {
        baseline: "act",
      },
    );
    expect(told.trace[0]?.committedBy).toBe("second");
    // An audited act is held for a person, not for the second opinion to release.
    const audited = await run(mk(0.97, "enforce", 1), { id: "v", question: verified, policy: bar });
    expect(audited.trace[0]?.attempts[0]?.gate?.audited).toBe(true);
    expect(audited.ok).toBe(false);
  });

  it("validates the mode and the verifier", async () => {
    const step = opinions([0.3], [0.3]);
    await expect(
      runChain("start", [step], bar, { secondOpinion: "release" as unknown as "commit" }),
    ).rejects.toThrow(/secondOpinion must be "order", "route" or "commit"/);
    await expect(
      runChain(
        "start",
        [{ ...step, secondOpinion: "yes" as unknown as Step<string>["verify"] }],
        bar,
      ),
    ).rejects.toThrow(/step s: secondOpinion must be a function/);
  });
});

describe("held candidates and the summary", () => {
  it("keeps held candidates on the trace only when asked", async () => {
    const step: Step<string> = {
      name: "s",
      propose: async (_s, n) => `c${n}`,
      verify: async () => said(0.3),
    };
    const plain = await runChain("start", [step], bar);
    expect(plain.held).toBeUndefined();
    expect(plain.trace[0]?.held).toBeUndefined();
    const kept = await runChain("start", [step], bar, { keepHeld: true });
    expect(kept.trace[0]?.held?.map((c) => c.candidate)).toEqual(["c1", "c2", "c3"]);
    // Without a second opinion the queue is in attempt order.
    expect(kept.held?.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });

  it("is plain data that survives JSON", async () => {
    const res = await runChain(
      "start",
      [opinions([0.3, 0.95], [0.2]), opinions([0.3, 0.3], [0.2, 0.4], [], "t")],
      bar,
      { keyOf: (s) => s, runId: "r", attemptPool: 6 },
    );
    const summary = summarizeChain(res);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(summary).toEqual({
      outcome: "exhausted",
      stoppedAt: "t",
      runId: "r",
      steps: [
        {
          name: "s",
          instance: "s@start",
          proposals: 2,
          verified: 2,
          holds: 1,
          duplicates: 0,
          committed: true,
          committedBy: "primary",
          allowance: 2,
          secondOpinions: { asked: 1, act: 0, review: 1, refuse: 0 },
        },
        {
          name: "t",
          instance: "t@c2",
          proposals: 2,
          verified: 2,
          holds: 2,
          duplicates: 0,
          committed: false,
          allowance: 2,
          secondOpinions: { asked: 2, act: 0, review: 2, refuse: 0 },
        },
      ],
      committed: 1,
      proposals: 4,
      cost: res.cost,
      pool: { size: 6, used: 4 },
      held: 2,
    });
  });
});

describe("the committed state is never a candidate no verifier acted on", () => {
  it("holds over many random chains with every option", async () => {
    const modes = ["order", "route", "commit"] as const;
    for (let seed = 1; seed <= 300; seed++) {
      const rand: Rand = rng(1000 + seed);
      let next = 0;
      const primaryAct = new Set<number>();
      const secondAct = new Set<number>();
      const pick = () => [0.02, 0.3, 0.5, 0.95][Math.floor(rand() * 4)] as number;
      const policy: GatePolicy = { actAbove: 0.9, refuseBelow: 0.05 };
      const n = 1 + Math.floor(rand() * 5);
      const steps: Step<{ id: number }>[] = Array.from({ length: n }, (_, i) => ({
        name: `s${i}`,
        ...(rand() < 0.5 ? { maxAttempts: 1 + Math.floor(rand() * 4) } : {}),
        // Sometimes repeat the last candidate, to exercise duplicates.
        propose: async () => ({ id: rand() < 0.2 && next > 0 ? next : ++next }),
        verify: async (_b, after) => {
          const p = pick();
          if (p >= 0.9) primaryAct.add(after.id);
          return said(p);
        },
        ...(rand() < 0.6
          ? {
              secondOpinion: async (_b: { id: number }, after: { id: number }) => {
                const p = pick();
                if (p >= 0.9) secondAct.add(after.id);
                return said(p);
              },
            }
          : {}),
      }));
      const mode = modes[Math.floor(rand() * 3)] as (typeof modes)[number];
      const res = await runChain({ id: 0 }, steps, policy, {
        secondOpinion: mode,
        ...(rand() < 0.5 ? { keyOf: (s: { id: number }) => String(s.id) } : {}),
        ...(rand() < 0.5 ? { attemptPool: n + Math.floor(rand() * 10) } : {}),
        ...(rand() < 0.5 ? { keepHeld: true } : {}),
      });
      expect(res.state).toBe(res.checkpoints.at(-1));
      for (const c of res.checkpoints.slice(1)) {
        const byPrimary = primaryAct.has(c.id);
        const bySecond = mode === "commit" && secondAct.has(c.id);
        expect(byPrimary || bySecond, `seed ${seed}: committed ${c.id}`).toBe(true);
      }
      for (const h of [...(res.held ?? []), ...(res.pending ? [res.pending] : [])]) {
        expect(res.checkpoints).not.toContain(h.candidate);
      }
    }
  });
});
