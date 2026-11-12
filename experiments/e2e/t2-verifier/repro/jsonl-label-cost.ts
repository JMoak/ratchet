/**
 * Repro (T2-08): labelling through `JsonlLedger` rereads and reparses the whole file for every
 * label (`label` calls `all()` to check the id exists; `Engine.label` adds `get` and `request`,
 * each another full read), so a census of n rows costs O(n x file size). A battery multiplies it:
 * one combined label writes one outcome line per member, each with its own full read.
 *
 *   bun experiments/e2e/t2-verifier/repro/jsonl-label-cost.ts
 *
 * Writes scratch ledgers to the OS temp directory and prints label time against ledger size.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import type { Oracle } from "../../../../src/types.ts";

const members = Array.from({ length: 8 }, (_, i) => judge(`member ${i}?`, { id: `m${i}` }));
const oracle: Oracle = {
  id: "fixed",
  decide: async (_s, qs) =>
    qs.map((q) => ({
      verdict: { kind: "judge" as const, questionId: q.id, pYes: 0.8, confidence: 0.8 },
      oracle: "fixed",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    })),
};
const dir = mkdtempSync(join(tmpdir(), "ratchet-t2-"));
try {
  for (const n of [100, 200, 400]) {
    const path = join(dir, `battery-${n}.jsonl`);
    const engine = new Engine({ oracle, ledger: new JsonlLedger(path), keepState: true });
    const gate = engine.gate({ id: "b", question: members, policy: { actAbove: 0.9 } });
    const filler = "x".repeat(1000);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await gate.ask(`state ${i} ${filler}`)).recordId);
    const t0 = performance.now();
    for (const id of ids)
      await engine.label(id, { correct: true, truth: true, source: "review:blind:repro" });
    const ms = performance.now() - t0;
    console.log(
      `${n} battery requests (${n * 9} rows): labelling all took ${(ms / 1000).toFixed(1)} s, ${(ms / n).toFixed(1)} ms per label`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
