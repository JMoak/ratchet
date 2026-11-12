/**
 * Difficulty readout for a T5 pilot run: accuracy of each single model by domain, family,
 * variant and rule wording, from the run's ledgers. Pilots calibrate the generator's mix; their
 * items never enter the evaluation.
 *
 *   bun experiments/e2e/t5-compound/pilot-summary.ts <run dir> <pilot corpus file>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { CorpusFile, CorpusItem } from "./corpus-gen.ts";

const [dir, file] = process.argv.slice(2);
if (!dir || !file) throw new Error("usage: pilot-summary.ts <run dir> <pilot corpus file>");
const corpus = JSON.parse(
  readFileSync(new URL(file, new URL("./", import.meta.url)), "utf8"),
) as CorpusFile;
const models = ["single-jev113", "single-jev114", "single-haiku"];
const right = new Map<string, Map<string, boolean>>();
const conf = new Map<string, Map<string, number>>();
for (const m of models) {
  const ok = new Map<string, boolean>();
  const c = new Map<string, number>();
  for (const r of await new JsonlLedger(join(dir, `${m}.jsonl`)).all()) {
    const id = r.tags.find((t) => t.startsWith("item:"))?.slice(5);
    if (!id || !r.outcome) continue;
    ok.set(id, r.outcome.correct);
    c.set(id, r.confidence);
  }
  right.set(m, ok);
  conf.set(m, c);
}
const acc = (m: string, its: readonly CorpusItem[]) =>
  its.filter((i) => right.get(m)?.get(i.id) === true).length / Math.max(1, its.length);
const line = (k: string, its: readonly CorpusItem[]) =>
  `${k.padEnd(56)} n=${String(its.length).padStart(3)}  ${models
    .map((m) => `${m.replace("single-", "")} ${(100 * acc(m, its)).toFixed(0).padStart(3)}%`)
    .join("  ")}`;
function by(title: string, key: (i: CorpusItem) => string): void {
  process.stdout.write(`\n${title}\n`);
  const g = new Map<string, CorpusItem[]>();
  for (const it of corpus.items) g.set(key(it), [...(g.get(key(it)) ?? []), it]);
  for (const [k, its] of [...g].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`${line(k, its)}\n`);
  }
}
process.stdout.write(`${line("overall", corpus.items)}\n`);
by("by domain", (i) => i.domain);
by("by domain and wording", (i) => `${i.domain} ${i.form ?? ""}`);
by("by family", (i) => `${i.domain}/${i.family}`);
by("by variant", (i) => `${i.family}/${i.variant}`);
const wrongAll = corpus.items.filter((i) => models.every((m) => right.get(m)?.get(i.id) === false));
process.stdout.write(`\nitems every model got wrong: ${wrongAll.length}\n`);
for (const i of wrongAll)
  process.stdout.write(`  ${i.id} ${i.family}/${i.variant} truth=${i.truth}\n`);
for (const m of models) {
  const cs = [...(conf.get(m)?.values() ?? [])];
  const mean = cs.reduce((s, x) => s + x, 0) / Math.max(1, cs.length);
  process.stdout.write(
    `${m}: accuracy ${(100 * acc(m, corpus.items)).toFixed(1)}%, mean confidence ${mean.toFixed(3)}\n`,
  );
}
