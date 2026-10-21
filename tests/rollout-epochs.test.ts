import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import type { Gate, GateSpec } from "../src/gate.ts";
import { hashQuestion, MemoryLedger } from "../src/ledger/ledger.ts";
import { hashPolicy } from "../src/policy.ts";
import { judge } from "../src/questions.ts";
import { Rollout, type RolloutCheckpoint } from "../src/rollout.ts";
import type { Oracle } from "../src/types.ts";

const oracle = (model = "model-v1"): Oracle => ({
  id: "epoch-fixture",
  decide: async (_state, questions) =>
    questions.map((q) => ({
      oracle: "epoch-fixture",
      model,
      verdict: { kind: "judge" as const, questionId: q.id, pYes: 0.95, confidence: 0.95 },
      cost: 0,
      latencyMs: 0,
      // Deliberate ties: rollout boundaries must not depend on timestamps.
      at: "2026-01-01T00:00:00Z",
    })),
});
const spec = {
  id: "epoch-gate",
  question: judge("Is this safe?", { id: "safe" }),
  policy: { actAbove: 0.8 },
  evidenceVersion: "fixture-v1",
  promisedAccuracy: 0.9,
  rollout: {
    evidence: { version: "fixture-v1", model: "model-v1" },
    minShadowRows: 10,
    minAuditRows: 1,
    minActed: 10,
  },
} as const;

async function label(gate: Gate, truth = true) {
  const r = await gate.ask("state");
  await gate.engine.label(r.recordId, { correct: truth, truth });
  return r.recordId;
}

async function promote(gate: Gate) {
  await gate.rollout.evaluate();
  for (let i = 0; i < 10; i++) await label(gate);
  expect((await gate.rollout.evaluate()).mode).toBe("enforce");
  const checkpoint = gate.rollout.checkpoint();
  if (!checkpoint) throw new Error("Missing checkpoint");
  return checkpoint;
}

describe("rollout evidence epochs", () => {
  it("requires fresh shadow evidence after a bad audit demotes the gate", async () => {
    const engine = new Engine({ oracle: oracle(), auditRate: 1 });
    const gate = engine.gate(spec);
    await gate.rollout.evaluate();
    for (let i = 0; i < 10; i++) {
      const r = await gate.ask(`good-${i}`);
      await engine.label(r.recordId, { correct: true, truth: true });
    }
    expect((await gate.rollout.evaluate()).mode).toBe("enforce");
    const bad = await gate.ask("bad");
    await engine.label(bad.recordId, { correct: false, truth: false });
    expect((await gate.rollout.evaluate()).mode).toBe("shadow");
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: false,
      window: { n: 0, acted: 0 },
    });
  });

  it("does not promote a fresh configuration from the old gate's successes", async () => {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: oracle(), ledger }).gate(spec);
    for (let i = 0; i < 10; i++) {
      const r = await old.ask(`old-${i}`);
      await old.engine.label(r.recordId, { correct: true, truth: true });
    }
    const next = new Engine({ oracle: oracle("model-v2"), ledger }).gate({
      ...spec,
      policy: { actAbove: 0.1 },
      rollout: { ...spec.rollout, evidence: { version: "fixture-v2", model: "model-v2" } },
      evidenceVersion: "fixture-v2",
    });
    expect(await next.rollout.evaluate()).toMatchObject({ mode: "shadow", window: { n: 0 } });
  });

  it("consumes unlabelled rows at each transition and ignores their late labels", async () => {
    const gate = new Engine({ oracle: oracle(), auditRate: 1 }).gate(spec);
    await gate.rollout.evaluate();
    for (let i = 0; i < 10; i++) await label(gate);
    const oldShadow = await gate.ask("old unlabelled shadow");
    expect((await gate.rollout.evaluate()).mode).toBe("enforce");
    await label(gate, false);
    const oldAudit = await gate.ask("old unlabelled audit");
    expect((await gate.rollout.evaluate()).mode).toBe("shadow");
    await gate.engine.label(oldShadow.recordId, { correct: true, truth: true });
    await gate.engine.label(oldAudit.recordId, { correct: true, truth: true });
    expect((await gate.rollout.evaluate()).window.n).toBe(0);
    for (let i = 0; i < 10; i++) await label(gate);
    expect((await gate.rollout.evaluate()).mode).toBe("enforce");
    expect((await gate.rollout.evaluate()).window.n).toBe(0);
  });

  it("restores a validated checkpoint, then demotes on only the new audit phase", async () => {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: oracle(), ledger, auditRate: 1 }).gate(spec);
    const checkpoint = JSON.parse(JSON.stringify(await promote(old))) as RolloutCheckpoint;
    const fresh = new Engine({ oracle: oracle(), ledger, auditRate: 1 }).gate({
      ...spec,
      rollout: { ...spec.rollout, checkpoint },
    });
    expect(await fresh.rollout.evaluate()).toMatchObject({
      mode: "enforce",
      changed: true,
      window: { n: 0 },
    });
    await label(fresh, false);
    expect((await fresh.rollout.evaluate()).mode).toBe("shadow");
    const demoted = fresh.rollout.checkpoint();
    if (!demoted) throw new Error("Missing demotion checkpoint");
    const restarted = new Engine({ oracle: oracle(), ledger }).gate({
      ...spec,
      rollout: { ...spec.rollout, checkpoint: demoted },
    });
    expect(await restarted.rollout.evaluate()).toMatchObject({ mode: "shadow", window: { n: 0 } });
  });

  it.each([
    ["policy", { policy: { actAbove: 0.7 } }],
    ["rubric", { question: judge("A changed question?", { id: "safe" }) }],
    [
      "version",
      {
        evidenceVersion: "fixture-v2",
        rollout: { ...spec.rollout, evidence: { version: "fixture-v2", model: "model-v1" } },
      },
    ],
    [
      "model",
      {
        rollout: { ...spec.rollout, evidence: { version: "fixture-v1", model: "model-v2" } },
      },
    ],
  ] as const)("rejects a checkpoint after changing %s", async (_name, changes) => {
    const ledger = new MemoryLedger();
    const gate = new Engine({ oracle: oracle(), ledger }).gate(spec);
    const checkpoint = await promote(gate);
    const next = new Engine({ oracle: oracle(), ledger, mode: "enforce" }).gate({
      ...spec,
      ...changes,
      rollout: { ...spec.rollout, ...("rollout" in changes ? changes.rollout : {}), checkpoint },
    });
    expect(await next.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: true,
      reason: expect.stringContaining("configuration changed"),
      window: { n: 0 },
    });
  });

  it("rejects missing, malformed and foreign anchors without enforcing", async () => {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: oracle(), ledger }).gate(spec);
    const checkpoint = await promote(old);
    const source = (await ledger.all())[0];
    if (!source) throw new Error("Missing source row");
    const foreign = { ...source, id: "foreign", gateId: "other" };
    // The source row exists and is complete; changing gateId must make the anchor invalid.
    await ledger.append(foreign);
    for (const afterId of ["missing", "foreign"]) {
      const gate = new Engine({ oracle: oracle(), ledger, mode: "enforce" }).gate({
        ...spec,
        rollout: { ...spec.rollout, checkpoint: { ...checkpoint, afterId } },
      });
      expect(await gate.rollout.evaluate()).toMatchObject({
        mode: "shadow",
        reason: expect.stringContaining("anchor missing"),
      });
    }
    for (const invalid of [
      null,
      { ...checkpoint, format: 2 },
      { ...checkpoint, afterId: 7 },
      { ...checkpoint, mode: "active" },
      { ...checkpoint, extra: "untrusted" },
    ]) {
      const gate = new Engine({ oracle: oracle(), ledger, mode: "enforce" }).gate({
        ...spec,
        rollout: { ...spec.rollout, checkpoint: invalid as RolloutCheckpoint },
      });
      expect(await gate.rollout.evaluate()).toMatchObject({
        mode: "shadow",
        reason: expect.stringContaining("invalid checkpoint"),
      });
    }
  });

  it("does not recover enforce without a checkpoint or from an unanchored empty checkpoint", async () => {
    const ledger = new MemoryLedger();
    const gate = new Engine({ oracle: oracle(), ledger }).gate(spec);
    await gate.rollout.evaluate();
    const empty = gate.rollout.checkpoint();
    if (!empty) throw new Error("Missing initial checkpoint");
    for (let i = 0; i < 10; i++) await label(gate);
    const checkpointless = new Engine({ oracle: oracle(), ledger, mode: "enforce" }).gate(spec);
    expect(await checkpointless.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: true,
      window: { n: 0 },
    });
    const restored = new Engine({ oracle: oracle(), ledger }).gate({
      ...spec,
      rollout: { ...spec.rollout, checkpoint: empty },
    });
    expect(await restored.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      reason: expect.stringContaining("no verifiable anchor"),
    });
  });

  it("excludes missing or mismatched row identity even after warmup", async () => {
    const ledger = new MemoryLedger();
    const gate = new Engine({ oracle: oracle(), ledger }).gate(spec);
    await gate.rollout.evaluate();
    const source = new Engine({ oracle: oracle() }).gate(spec);
    await label(source);
    const row = (await source.engine.ledger.all())[0];
    if (!row) throw new Error("Missing source row");
    for (const [index, change] of [
      { evidenceVersion: "older" },
      { policyHash: hashPolicy({ actAbove: 0.1 }) },
      { questionHash: hashQuestion(judge("Different rubric")) },
      { model: "model-v2" },
    ].entries())
      await ledger.append({ ...row, ...change, id: `mismatch-${index}` });
    const { policyHash: _policy, evidenceVersion: _version, ...legacy } = row;
    await ledger.append({ ...legacy, id: "legacy" });
    expect((await gate.rollout.evaluate()).window.n).toBe(0);
  });

  it("serializes concurrent evaluations and treats manual mode changes as a fresh phase", async () => {
    const gate = new Engine({ oracle: oracle() }).gate(spec);
    await gate.rollout.evaluate();
    for (let i = 0; i < 10; i++) await label(gate);
    const results = await Promise.all([gate.rollout.evaluate(), gate.rollout.evaluate()]);
    expect(results.map((r) => r.changed)).toEqual([true, false]);
    expect(results.map((r) => r.window.n)).toEqual([10, 0]);
    gate.mode = "shadow";
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      reason: expect.stringContaining("outside this controller"),
      window: { n: 0 },
    });
    expect((await gate.rollout.evaluate()).window.n).toBe(0);
  });

  it("detects effective policy edits on an existing controller", async () => {
    const policy = { actAbove: 0.8 };
    const gate = new Engine({ oracle: oracle() }).gate({ ...spec, policy });
    await promote(gate);
    policy.actAbove = 0.7;
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      reason: expect.stringContaining("configuration changed"),
    });
  });

  it("returns to shadow when the provider reports a different model, even before a label", async () => {
    const ledger = new MemoryLedger();
    const gate = new Engine({ oracle: oracle(), ledger }).gate(spec);
    await promote(gate);
    const unexpected = new Engine({ oracle: oracle("unexpected-model"), ledger }).gate(spec);
    await unexpected.ask("provider changed");
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      changed: true,
      reason: expect.stringContaining("differs from the pinned model"),
    });
  });

  it("does not mistake unrelated engine policies or versions for current model drift", async () => {
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: oracle(), ledger });
    const gate = engine.gate(spec);
    const rollout = new Rollout({
      engine,
      ...spec.rollout,
      promisedAccuracy: spec.promisedAccuracy,
      evidence: {
        ...spec.rollout.evidence,
        policyHash: hashPolicy(spec.policy),
        questionHash: hashQuestion(spec.question),
      },
    });
    await rollout.evaluate();
    for (let i = 0; i < 10; i++) await label(gate);
    expect((await rollout.evaluate()).mode).toBe("enforce");
    const other = new Engine({ oracle: oracle("another-model"), ledger });
    await other.ask("different policy", spec.question, {
      policy: { actAbove: 0.1 },
      evidenceVersion: spec.evidenceVersion,
    });
    await other.ask("different deployment version", spec.question, {
      policy: spec.policy,
      evidenceVersion: "another-version",
    });
    expect(await rollout.evaluate()).toMatchObject({ mode: "enforce", window: { n: 0 } });
  });

  it("requires explicit engine identity and a caller version", async () => {
    const engine = new Engine({ oracle: oracle(), mode: "enforce" });
    expect(await new Rollout({ engine, promisedAccuracy: 0.9 }).evaluate()).toMatchObject({
      mode: "shadow",
      reason: expect.stringContaining("version is required"),
    });
    expect(
      await new Rollout({
        engine,
        promisedAccuracy: 0.9,
        evidence: { version: "v1" },
      }).evaluate(),
    ).toMatchObject({
      mode: "shadow",
      reason: expect.stringContaining("explicit policyHash and questionHash"),
    });
  });

  it("hashes effective defaults consistently and captures policy before an oracle wait", async () => {
    expect(hashPolicy({ actAbove: 0.8 })).toBe(
      hashPolicy({
        onFailOpen: "review",
        goIsYes: true,
        actAbove: 0.8,
      }),
    );
    let release: (() => void) | undefined;
    const waiting: Oracle = {
      ...oracle(),
      decide: async (state, questions) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return oracle().decide(state, questions);
      },
    };
    const policy = { actAbove: 0.8 };
    const gate = new Engine({ oracle: waiting }).gate({ ...spec, policy } satisfies GateSpec);
    const pending = gate.ask("in flight");
    policy.actAbove = 0.99;
    release?.();
    const result = await pending;
    const row = (await gate.engine.ledger.all())[0];
    expect(result.ruling.action).toBe("act");
    expect(row?.policyHash).toBe(hashPolicy({ actAbove: 0.8 }));
  });
});
