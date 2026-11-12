/**
 * V1 repro (T4-10 not closed): a configuration the controller REJECTED is restored in enforce
 * by editing only the checkpoint, two ways, with the ledger untouched:
 *
 *   1. downgrade: rewrite the format 3 checkpoint as format 2 (or 1) with mode "enforce";
 *      legacy enforce checkpoints are honoured unverified (rollout.ts `legacy`).
 *   2. window shift: a format 3 enforce checkpoint whose `accepted.from` is the wrong act, so
 *      `unverified()` re-derives the planned sample from the window after it, which passes.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/checkpoint-forgery.ts
 *
 * Exits 1 while either forgery restores enforce.
 */
import { Engine } from "../../../../../src/engine.ts";
import type { GateSpec } from "../../../../../src/gate.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import type { RolloutCheckpoint } from "../../../../../src/rollout.ts";
import { fixed } from "../lib.ts";

// One planned act at a 50% promise and 50% confidence keeps the repro small.
const spec = (checkpoint?: unknown): GateSpec => ({
  id: "r",
  question: judge("Is it safe to run this command without asking?", { id: "bash.safe" }),
  policy: { actAbove: 0.9 },
  evidenceVersion: "v1",
  promisedAccuracy: 0.5,
  rollout: {
    confidence: 0.5,
    ...(checkpoint ? { checkpoint: checkpoint as RolloutCheckpoint } : {}),
  },
});

const ledger = new MemoryLedger();
const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 });
const gate = engine.gate(spec());
await gate.ask("before the controller");
await gate.rollout.evaluate();
const wrong = await gate.ask("the planned act, labelled wrong");
await engine.label(wrong.recordId, { correct: false, truth: false, source: "review:blind:x" });
const rejected = await gate.rollout.evaluate();
const later = await gate.ask("a later act, labelled right");
await engine.label(later.recordId, { correct: true, truth: true, source: "review:blind:x" });
await gate.rollout.evaluate();
const cp = gate.rollout.checkpoint() as Extract<RolloutCheckpoint, { format: 3 }>;
console.log(`honest: ${rejected.mode} (${rejected.reason}); checkpoint ${JSON.stringify(cp)}`);

const restore = async (forged: unknown) => {
  const g = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 }).gate(spec(forged));
  return (await g.rollout.evaluate()).mode;
};
const downgrade = await restore({
  format: 2,
  scopeHash: cp.scopeHash,
  mode: "enforce",
  afterId: cp.afterId,
  rejected: false,
});
// The anchor is also the attacker's to choose: any row at or after the shifted window's end.
const shifted = await restore({
  ...cp,
  mode: "enforce",
  afterId: later.recordId,
  rejected: false,
  accepted: { from: wrong.recordId, sample: [later.recordId] },
});
console.log(`format 2 downgrade restores: ${downgrade}`);
console.log(`format 3 with accepted.from moved past the wrong act restores: ${shifted}`);
process.exitCode = downgrade === "enforce" || shifted === "enforce" ? 1 : 0;
