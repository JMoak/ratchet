/**
 * Worker for the concurrent-append attack: one engine appending `n` rows with large states to a
 * shared JSONL ledger. Run two at once: `bun workers/append.ts <ledger> <tag> <n> <stateChars>`.
 */
import { Engine, JsonlLedger, judge, type Oracle } from "../../../../src/index.ts";

const [path, tag, nRaw, charsRaw] = process.argv.slice(2);
if (!path || !tag) throw new Error("usage: append.ts <ledger> <tag> <n> <stateChars>");
const n = Number(nRaw ?? 200);
const chars = Number(charsRaw ?? 20_000);
const oracle: Oracle = {
  id: `worker-${tag}`,
  decide: async (_s, qs) =>
    qs.map((q) => ({
      verdict: { kind: "judge", questionId: q.id, pYes: 0.3, confidence: 0.7 },
      oracle: `worker-${tag}`,
      latencyMs: 0,
      cost: 0.00001,
      at: new Date().toISOString(),
    })),
};
const engine = new Engine({ oracle, ledger: new JsonlLedger(path), keepState: true });
const gate = engine.gate({
  id: "g",
  question: judge("Is this safe?", { id: "safe" }),
  policy: { actAbove: 0.9 },
});
const pad = `${tag}`.repeat(Math.ceil(chars / tag.length)).slice(0, chars);
const states = Array.from({ length: n }, (_, i) => `row ${i} of ${tag}\n${pad}`);
await gate.askMany(states, { concurrency: 8 });
