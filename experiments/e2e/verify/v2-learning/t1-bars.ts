/**
 * V2, post hoc on T1's live ledgers: the act bar the new `ratchet report` recommends on T1's fit
 * rows alone, at promises of 0.95 and 0.98, and what acting at it (and at the point bar beside
 * it) would have delivered on the evidence, challenge and drift rows. Post hoc: every answer
 * here was bought and labelled in wave 1, the bars are read from the fit rows only, and nothing
 * is refitted on the rows it is scored on. Offline.
 *
 *   bun experiments/e2e/verify/v2-learning/t1-bars.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "./recompute.ts";
import {
  actRight,
  exactLower,
  fitTrusted,
  ledgerLines,
  pct,
  type Row,
  readLedger,
  rowGoIsYes,
  settled,
} from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");
const T1 = join(ROOT, "experiments", "out", "e2e", "t1-toolgate", "2026-11-12T10-22-04-541Z-live");

type Json = Record<string, unknown>;

/** Acting at `bar`: answered, not floored below act, go at or above the bar. */
function deliver(rows: readonly Row[], bar: number) {
  let acts = 0;
  let right = 0;
  let approvals = 0;
  let approvalsActed = 0;
  for (const r of rows) {
    if (r.outcome === undefined || !fitTrusted(r)) continue;
    const g = rowGoIsYes(r) ?? true;
    const truth = r.outcome.truth;
    if (truth === g) approvals++;
    if (settled(r) || r.failedOpen) continue;
    const p = g ? (r.pYes ?? 0) : 1 - (r.pYes ?? 1);
    if (p < bar) continue;
    acts++;
    const ok = actRight(r, g) === true;
    if (ok) {
      right++;
      approvalsActed++;
    }
  }
  return { acts, right, approvals, approvalsActed };
}

function cell(d: ReturnType<typeof deliver>): string {
  if (d.acts === 0) return `no acts (0 of ${d.approvals} approvals)`;
  return `${d.right}/${d.acts} = ${pct(d.right / d.acts)} (exact lower ${pct(exactLower(d.right, d.acts))}); ${pct(d.approvalsActed / Math.max(1, d.approvals))} of approvals`;
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const fitPath = join(OUT, "t1-fit-only.jsonl");
  const rawFitPath = join(OUT, "t1-raw-fit-only.jsonl");
  writeFileSync(
    fitPath,
    ledgerLines(join(T1, "ledger.jsonl"), (r) => r.evidenceVersion === "t1-toolgate-fit-v1"),
  );
  const split = (r: Json, s: string) => Array.isArray(r.tags) && r.tags.includes(`split:${s}`);
  writeFileSync(
    rawFitPath,
    ledgerLines(join(T1, "raw-ledger.jsonl"), (r) => split(r, "fit")),
  );

  const main = readLedger(join(T1, "ledger.jsonl"));
  const raw = readLedger(join(T1, "raw-ledger.jsonl"));
  const has = (r: Row, s: string) => r.tags.includes(`split:${s}`);
  const slices: readonly { name: string; rows: Row[] }[] = [
    {
      name: "evidence, with floors (frozen gate rows)",
      rows: main.filter((r) => r.evidenceVersion === "t1-toolgate-frozen-v1"),
    },
    { name: "evidence, no floors (raw)", rows: raw.filter((r) => has(r, "evidence")) },
    { name: "challenge, no floors (raw)", rows: raw.filter((r) => has(r, "challenge")) },
    { name: "drift, no floors (raw)", rows: raw.filter((r) => has(r, "drift")) },
    {
      name: "fit, with floors (in-sample)",
      rows: main.filter((r) => r.evidenceVersion === "t1-toolgate-fit-v1"),
    },
  ];
  const lines: string[] = [
    "# T1 act bars from the fit rows, read on held-out rows (post hoc)",
    "",
    "Post hoc: every answer was bought and labelled in wave 1. The bar is what `ratchet report`",
    "now recommends on the fit rows alone (`t1-fit-only.jsonl`: the fit configuration of",
    "`ledger.jsonl`, 152 answered; and `t1-raw-fit-only.jsonl`: the raw gate's 180 fit rows, no",
    "floors). Nothing was refitted on the rows it is scored on. Acting means p(approve) at or",
    "above the bar on an answered row; a floored row never acts.",
    "",
  ];
  for (const [label, path] of [
    ["fit rows with floors", fitPath],
    ["raw fit rows", rawFitPath],
  ] as const) {
    for (const target of [0.95, 0.98]) {
      const res = cli(["report", path, "--json", "--target", String(target)]);
      const rep = JSON.parse(res.out) as { gates: Json[] };
      const g = rep.gates[0] ?? {};
      const fitted = g.fitted as Json | undefined;
      const point = g.pointFitted as Json | undefined;
      const text = cli(["report", path, "--target", String(target)]).out;
      const sentence = /## Act bars\n\n- [^:]+: (.*)/.exec(text)?.[1] ?? "";
      lines.push(`## ${label}, promise ${target}`, "", `report: ${sentence}`, "");
      lines.push("| bar | slice | acts right (exact 95% lower) | approvals acted on |");
      lines.push("| --- | --- | --- | --- |");
      for (const [kind, b] of [
        ["act bar (conservative)", fitted],
        ["point bar", point],
      ] as const) {
        if (b === undefined) {
          lines.push(`| ${kind}: none | | | |`);
          continue;
        }
        const t = Number(b.threshold);
        for (const s of slices) {
          const d = deliver(s.rows, t);
          const [acted, share] = cell(d).split("; ");
          lines.push(`| ${kind} ${t.toFixed(3)} | ${s.name} | ${acted} | ${share ?? ""} |`);
        }
      }
      lines.push("");
    }
  }
  // The pre-registered wave-1 bar and the post-hoc 0.8, for comparison.
  lines.push("## For comparison: wave 1's frozen 0.62 and its post-hoc 0.8", "");
  lines.push("| bar | slice | acts right (exact 95% lower) | approvals acted on |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of [0.62, 0.8]) {
    for (const s of slices) {
      const [acted, share] = cell(deliver(s.rows, t)).split("; ");
      lines.push(`| ${t} | ${s.name} | ${acted} | ${share ?? ""} |`);
    }
  }
  lines.push("");
  const md = lines.join("\n");
  writeFileSync(join(OUT, "t1-bars.md"), md);
  process.stdout.write(md);
}

if (import.meta.main) main();
