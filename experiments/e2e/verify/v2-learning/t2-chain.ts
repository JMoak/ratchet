/**
 * V2, T2-03 on T2's live chain ledger: wave 1's harness tagged chain rows `attempt:<n>`, which
 * the new reader does not know (it reads `chain:attempt:<n>`, the tag `chainTags` gives
 * `verify`). This re-reads the verified chain run as recorded and with its tags renamed to the
 * new spelling, and compares the act bar each yields with the held-out holistic gate's bar.
 * Post hoc, offline.
 *
 *   bun experiments/e2e/verify/v2-learning/t2-chain.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "./recompute.ts";
import { ledgerLines } from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");
const T2 = join(
  ROOT,
  "experiments",
  "out",
  "e2e",
  "t2-verifier",
  "2026-11-12T10-32-34-553Z-live",
  "ledgers",
);

type Json = Record<string, unknown>;

function bar(path: string, target: number): string {
  const rep = JSON.parse(cli(["report", path, "--json", "--target", String(target)]).out) as {
    gates: Json[];
  };
  const g = rep.gates[0] ?? {};
  const f = g.fitted as Json | undefined;
  const p = g.pointFitted as Json | undefined;
  const fmt = (b: Json | undefined) =>
    b === undefined
      ? "none"
      : `${Number(b.threshold).toFixed(3)} (${Number(b.n)} rows, ${(100 * Number(b.accuracy)).toFixed(1)}%)`;
  return `${String(g.fittedFrom)} ${String(g.fitRows)} | ${fmt(f)} | ${fmt(p)}`;
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const verified = (r: Json) => Array.isArray(r.tags) && r.tags.includes("run:verified");
  const asIs = join(OUT, "t2-chain-verified.jsonl");
  const renamed = join(OUT, "t2-chain-verified-chaintags.jsonl");
  const text = ledgerLines(join(T2, "chain.jsonl"), verified);
  writeFileSync(asIs, text);
  // Rename only the tag inside decision records; outcome lines carry no tags.
  writeFileSync(renamed, text.replace(/"attempt:(\d+)"/g, '"chain:attempt:$1"'));
  const rows: string[] = [
    "# T2 chain rows: retries read as unselected, and excluded (post hoc)",
    "",
    "The verified chain run of T2's live chain ledger (run:verified, 1,723 rows), as recorded",
    "(wave 1 tagged `attempt:<n>`) and with the tag renamed to `chain:attempt:<n>`, which the new",
    "reader excludes from unselected evidence when n >= 2. Bars are `ratchet report`'s.",
    "",
    "| ledger | promise | fitted on | act bar (conservative) | point bar |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const t of [0.9, 0.95, 0.98]) {
    rows.push(`| chain, tags as recorded | ${t} | ${bar(asIs, t)} |`);
    rows.push(`| chain, chain:attempt tags | ${t} | ${bar(renamed, t)} |`);
    rows.push(
      `| held-out holistic (reference) | ${t} | ${bar(join(T2, "heldout-holistic.jsonl"), t)} |`,
    );
    rows.push(`| fit holistic (reference) | ${t} | ${bar(join(T2, "fit-holistic.jsonl"), t)} |`);
  }
  const md = `${rows.join("\n")}\n`;
  writeFileSync(join(OUT, "t2-chain.md"), md);
  process.stdout.write(md);
}

if (import.meta.main) main();
