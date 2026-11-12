/**
 * V1 repro (T4-02 incomplete): after a crash leaves a torn last line, the next append is
 * written onto the end of that line, so the merged line does not parse and the new record is
 * lost: `label()` returns false, a restart sees no row (its cost is not counted toward the
 * daily cap on reload), and the ledger never says the request happened.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/torn-append-lost.ts
 *
 * Exits 1 while the appended row is lost. Fix: in JsonlLedger.writeNow, when the file is
 * non-empty and its last byte is not "\n", prefix the append with "\n" (the torn fragment then
 * stays one skipped line and the new line is whole).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../../../src/engine.ts";
import { JsonlLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import { fixed } from "../lib.ts";

const dir = mkdtempSync(join(tmpdir(), "v1-torn-"));
try {
  const path = join(dir, "ledger.jsonl");
  // What a crash mid-append leaves: a fragment with no newline.
  writeFileSync(path, '{"type":"decision","record":{"id":"crashed-mid-wri');
  const engine = new Engine({
    oracle: fixed("s", 0.95, undefined, 0.01),
    ledger: new JsonlLedger(path),
  });
  const gate = engine.gate({
    id: "g",
    question: judge("Is it safe?", { id: "q" }),
    policy: { actAbove: 0.9 },
  });
  const r = await gate.ask("ls");
  const labelled = await engine.label(r.recordId, {
    correct: true,
    truth: true,
    source: "review:blind:x",
  });
  const reread = new JsonlLedger(path);
  const rows = await reread.all();
  console.log(`label() returned ${labelled}`);
  console.log(
    `a restart reads ${rows.length} rows; skipped ${reread.skipped}; the ask's row is ${rows.some((x) => x.id === r.recordId) ? "present" : "LOST"}`,
  );
  console.log(`file: ${JSON.stringify(readFileSync(path, "utf8").slice(0, 90))}...`);
  process.exitCode = rows.some((x) => x.id === r.recordId) && labelled ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
