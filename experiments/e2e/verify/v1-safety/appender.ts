/**
 * Child process for ledger.ts: append `count` decision rows with ids `<prefix>-<i>` to a JSONL
 * ledger through JsonlLedger, as a second writer would.
 *
 *   bun experiments/e2e/verify/v1-safety/appender.ts <ledger.jsonl> <prefix> <count>
 */
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";

const [path, prefix, count] = process.argv.slice(2);
if (!path || !prefix || !count) throw new Error("usage: appender.ts <ledger> <prefix> <count>");
const ledger = new JsonlLedger(path);
for (let i = 0; i < Number(count); i++) {
  const id = `${prefix}-${i}`;
  await ledger.append({
    id,
    at: "2026-11-12T12:00:00.000Z",
    gateId: "g",
    requestId: `req-${id}`,
    questionId: "q",
    kind: "judge",
    prompt: "q?",
    questionHash: "0000000000000000",
    stateHash: "s",
    trustedHash: "s",
    untrusted: [],
    // A large state so a single append is many bytes.
    state: "x".repeat(4096 + (i % 7) * 1000),
    oracle: "o",
    strategy: "single",
    verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
    go: 0.9,
    confidence: 0.9,
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost: 0.001,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
  } as DecisionRecord);
}
