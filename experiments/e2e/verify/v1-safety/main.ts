/**
 * Wave 3 verifier V1 (safety and engine integrity): run every attack script and minimal repro
 * in this folder, offline, and write each one's raw output to
 * experiments/out/e2e/verify/v1-safety/. Prints one summary line per script.
 *
 *   bun experiments/e2e/verify/v1-safety/main.ts
 *
 * An attack script exits 1 when any attack broke its contract; a repro exits 1 while its
 * defect reproduces. This runner always exits 0 and reports both.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const out = join(here, "..", "..", "..", "out", "e2e", "verify", "v1-safety");
mkdirSync(out, { recursive: true });

const scripts = [
  "failopen.ts",
  "chain.ts",
  "compound.ts",
  "budget.ts",
  "rules.ts",
  "rollout.ts",
  "ledger.ts",
  "round2.ts",
  "repro/checkpoint-forgery.ts",
  "repro/torn-append-lost.ts",
  "repro/chain-shadow-floor.ts",
  "repro/sequential-gaps.ts",
  "repro/failopen-throws.ts",
  "repro/r2-rejection-erased.ts",
  "repro/r2-ask-strategy-unbounded.ts",
  "repro/r2-minority-merge.ts",
];

for (const s of scripts) {
  const r = spawnSync(process.execPath, [join(here, s)], { encoding: "utf8", timeout: 300_000 });
  const text = `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}\n[exit ${r.status}]\n`;
  writeFileSync(join(out, `${s.replace(/[/\\]/g, "-").replace(/\.ts$/, "")}.txt`), text);
  const summary = (r.stdout ?? "").match(/(\d+) attacks, (\d+) broke a contract\./);
  const line = summary
    ? `${summary[1]} attacks, ${summary[2]} broke`
    : r.status === 0
      ? "does not reproduce"
      : "REPRODUCES";
  process.stdout.write(`${s.padEnd(32)} ${line}\n`);
}
process.stdout.write(`\nraw output: ${out}\n`);
