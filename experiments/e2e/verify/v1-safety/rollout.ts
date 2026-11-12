/**
 * V1 attacks on T4-10 (an enforce checkpoint carries its accepted sample and is re-verified on
 * restore). The attacker can edit the checkpoint (the T4-10 threat), not the ledger. Offline.
 *
 *   bun experiments/e2e/verify/v1-safety/rollout.ts
 */
import { resolvePlan } from "../../../../src/acceptance.ts";
import { Engine } from "../../../../src/engine.ts";
import type { GateSpec } from "../../../../src/gate.ts";
import { type DecisionRecord, MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import type { RolloutCheckpoint } from "../../../../src/rollout.ts";
import { attack, fixed, report } from "./lib.ts";

const q = judge("Is it safe to run this command without asking?", { id: "bash.safe" });
const PROMISE = 0.9;
const CONFIDENCE = 0.8;
const n = resolvePlan({ target: PROMISE, confidence: CONFIDENCE }).sampleSize;
const SOURCE = "review:blind:v1";

const spec = (checkpoint?: unknown): GateSpec => ({
  id: "r",
  question: q,
  policy: { actAbove: 0.9 },
  evidenceVersion: "v1",
  promisedAccuracy: PROMISE,
  auditRate: 0.2,
  rollout: {
    confidence: CONFIDENCE,
    minAuditRows: 3,
    ...(checkpoint !== undefined ? { checkpoint: checkpoint as RolloutCheckpoint } : {}),
  },
});

/**
 * A gate whose first planned sample has one wrong act (so the configuration is rejected), then
 * `extra` more acts, all right. Returns the ledger and the controller's honest checkpoint.
 */
async function rejectedHistory(extra: number) {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 7 });
  const gate = engine.gate(spec());
  await gate.ask("before the controller");
  await gate.rollout.evaluate();
  const ids: string[] = [];
  for (let i = 0; i < n + extra; i++) {
    const r = await gate.ask(`command ${i}`);
    ids.push(r.recordId);
    const wrong = i === 2;
    await engine.label(r.recordId, { correct: !wrong, truth: !wrong, source: SOURCE });
  }
  const status = await gate.rollout.evaluate();
  return { ledger, ids, status, checkpoint: gate.rollout.checkpoint() };
}

async function restore(ledger: MemoryLedger, checkpoint: unknown) {
  const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 7 });
  const gate = engine.gate(spec(checkpoint));
  const status = await gate.rollout.evaluate();
  return { gate, status };
}

const honest = await rejectedHistory(n + 5);
process.stdout.write(
  `plan: promise ${PROMISE} at confidence ${CONFIDENCE} -> ${n} planned acts; honest status: ${honest.status.mode} (${honest.status.reason.slice(0, 90)})\n\n`,
);

await attack(
  "rollout",
  "T4-10",
  "baseline: the honest controller rejected this configuration",
  () => ({
    held:
      honest.status.mode === "shadow" &&
      (honest.checkpoint as { rejected?: boolean })?.rejected === true,
    observed: `mode ${honest.status.mode}, checkpoint ${JSON.stringify(honest.checkpoint)}`,
  }),
);

await attack(
  "rollout",
  "T4-10",
  "downgrade: the rejected format 3 checkpoint rewritten as format 2 with mode enforce",
  async () => {
    const cp = honest.checkpoint as Extract<RolloutCheckpoint, { format: 3 }>;
    const forged = {
      format: 2,
      scopeHash: cp.scopeHash,
      mode: "enforce",
      afterId: cp.afterId,
      rejected: false,
    };
    const back = await restore(honest.ledger, forged);
    return {
      held: back.status.mode === "shadow",
      observed: `restored mode ${back.status.mode}: ${back.status.reason.slice(0, 100)}`,
    };
  },
);

await attack(
  "rollout",
  "T4-10",
  "downgrade to format 1 (no rejected flag at all) with mode enforce",
  async () => {
    const cp = honest.checkpoint as Extract<RolloutCheckpoint, { format: 3 }>;
    const forged = { format: 1, scopeHash: cp.scopeHash, mode: "enforce", afterId: cp.afterId };
    const back = await restore(honest.ledger, forged);
    return { held: back.status.mode === "shadow", observed: `restored mode ${back.status.mode}` };
  },
);

await attack(
  "rollout",
  "T4-10",
  "window shift: format 3 enforce whose accepted.from skips past the wrong act (ledger untouched)",
  async () => {
    const cp = honest.checkpoint as Extract<RolloutCheckpoint, { format: 3 }>;
    const wrongAct = honest.ids[2] as string;
    const sample = honest.ids.slice(3, 3 + n);
    const forged = {
      format: 3,
      scopeHash: cp.scopeHash,
      mode: "enforce",
      afterId: cp.afterId,
      rejected: false,
      accepted: { from: wrongAct, sample },
    };
    const back = await restore(honest.ledger, forged);
    return {
      held: back.status.mode === "shadow",
      observed: `restored mode ${back.status.mode}: ${back.status.reason.slice(0, 100)}`,
    };
  },
);

// Tampering the fixers' tests already cover, re-run on a passing history -------------------------
async function acceptedHistory() {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 7 });
  const gate = engine.gate(spec());
  await gate.ask("before the controller");
  await gate.rollout.evaluate();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await gate.ask(`command ${i}`);
    ids.push(r.recordId);
    await engine.label(r.recordId, { correct: true, truth: true, source: SOURCE });
  }
  const status = await gate.rollout.evaluate();
  return {
    engine,
    ledger,
    ids,
    status,
    checkpoint: gate.rollout.checkpoint() as Extract<RolloutCheckpoint, { format: 3 }>,
  };
}

const good = await acceptedHistory();
await attack("rollout", "T4-10", "baseline: an honest promotion restores enforce", async () => {
  const back = await restore(good.ledger, JSON.parse(JSON.stringify(good.checkpoint)));
  return {
    held: good.status.mode === "enforce" && back.status.mode === "enforce",
    observed: `${good.status.mode} -> ${back.status.mode}`,
  };
});

await attack("rollout", "T4-10", "sample ids swapped (first two) holds shadow", async () => {
  const s = [...(good.checkpoint.accepted?.sample ?? [])];
  [s[0], s[1]] = [s[1] as string, s[0] as string];
  const back = await restore(good.ledger, {
    ...good.checkpoint,
    accepted: { from: good.checkpoint.accepted?.from ?? null, sample: s },
  });
  return { held: back.status.mode === "shadow", observed: back.status.reason.slice(0, 100) };
});

await attack(
  "rollout",
  "T4-10",
  "rows deleted from the ledger (one sample row) holds shadow",
  async () => {
    const rows = (await good.ledger.all()).filter((r) => r.id !== good.ids[4]);
    const ledger = new MemoryLedger();
    for (const r of rows) await ledger.append(r as DecisionRecord);
    const back = await restore(ledger, good.checkpoint);
    return { held: back.status.mode === "shadow", observed: back.status.reason.slice(0, 100) };
  },
);

await attack("rollout", "T4-10", "a label flipped after acceptance holds shadow", async () => {
  const rows = await good.ledger.all();
  const ledger = new MemoryLedger();
  for (const r of rows) await ledger.append(r as DecisionRecord);
  await ledger.label(good.ids[1] as string, {
    correct: false,
    truth: false,
    source: SOURCE,
    at: "2026-11-12T12:00:00.000Z",
  });
  const back = await restore(ledger, good.checkpoint);
  return { held: back.status.mode === "shadow", observed: back.status.reason.slice(0, 100) };
});

await attack(
  "rollout",
  "T4-10",
  "a label's source changed to an unregistered one holds shadow",
  async () => {
    const rows = await good.ledger.all();
    const ledger = new MemoryLedger();
    for (const r of rows) await ledger.append(r as DecisionRecord);
    await ledger.label(good.ids[0] as string, {
      correct: true,
      truth: true,
      source: "Review:blind",
      at: "2026-11-12T12:00:00.000Z",
    });
    const back = await restore(ledger, good.checkpoint);
    return { held: back.status.mode === "shadow", observed: back.status.reason.slice(0, 100) };
  },
);

await attack(
  "rollout",
  "T4-10",
  "accepted on a shadow checkpoint, extra keys, empty sample, duplicate ids are invalid",
  async () => {
    const cp = good.checkpoint;
    const variants = [
      { ...cp, mode: "shadow" },
      { ...cp, extra: 1 },
      { ...cp, accepted: { from: cp.accepted?.from ?? null, sample: [] } },
      { ...cp, accepted: { from: cp.accepted?.from ?? null, sample: [good.ids[0], good.ids[0]] } },
      {
        ...cp,
        accepted: { from: cp.accepted?.from ?? null, sample: cp.accepted?.sample, note: "x" },
      },
    ];
    const modes = [];
    for (const v of variants) modes.push((await restore(good.ledger, v)).status.mode);
    return { held: modes.every((m) => m === "shadow"), observed: modes.join(",") };
  },
);

const broken = report("V1: rollout checkpoints (T4-10)");
process.exitCode = broken > 0 ? 1 : 0;
