/**
 * V1 round 2 repro: a rejection the ledger records is erased by a checkpoint edit, against
 * docs/rollout.md ("Flipping `rejected` to false re-opens a configuration only while its
 * ledger holds no failed planned sample").
 *
 * An act from before the controller started is labelled right; the controller's own planned
 * act is labelled wrong and it rejects the configuration. A forged enforce checkpoint (format 3
 * resting on the earlier act, or format 2 with no sample) restores enforce: `verify` checks
 * only windows that start before the sample it rests on, and the failed one starts after it.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/r2-rejection-erased.ts
 *
 * Exits 1 while either forgery restores enforce. Fix: in `verify` (and `accept`), also refuse
 * when a complete planned window starting after the accepted sample's first act and before the
 * anchor failed (`failedWindow` without the `before` cut-off, or from the sample's start).
 */
import { Engine } from "../../../../../src/engine.ts";
import type { GateSpec } from "../../../../../src/gate.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import type { RolloutCheckpoint } from "../../../../../src/rollout.ts";
import { fixed } from "../lib.ts";

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
const SRC = "review:blind:x";
const ledger = new MemoryLedger();
const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 });
const gate = engine.gate(spec());
const early = await gate.ask("an act from before the controller");
await engine.label(early.recordId, { correct: true, truth: true, source: SRC });
await gate.rollout.evaluate();
const planned = await gate.ask("the controller's planned act");
await engine.label(planned.recordId, { correct: false, truth: false, source: SRC });
const honest = await gate.rollout.evaluate();
const cp = gate.rollout.checkpoint() as Extract<RolloutCheckpoint, { format: 3 }>;
console.log(`honest: ${honest.mode}, rejected ${cp.rejected} (${honest.reason.slice(0, 60)})`);

const restore = async (forged: unknown) => {
  const g = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 }).gate(spec(forged));
  return (await g.rollout.evaluate()).mode;
};
const base = { scopeHash: cp.scopeHash, mode: "enforce", afterId: cp.afterId, rejected: false };
const v3 = await restore({
  ...base,
  format: 3,
  accepted: { from: null, sample: [early.recordId] },
});
const v2 = await restore({ ...base, format: 2 });
console.log(`format 3 resting on the earlier act: ${v3}; format 2: ${v2}`);
process.exitCode = v3 === "enforce" || v2 === "enforce" ? 1 : 0;
