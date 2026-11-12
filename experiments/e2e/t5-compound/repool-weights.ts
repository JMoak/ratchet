/**
 * T5 follow-up: pair-aware pooling for a heterogeneous ensemble. One scalar rho shrinks every
 * member alike; when two members are near-duplicates (jev-1.13 and jev-1.14) and the third is
 * independent (haiku), the duplicates should share one vote's weight instead. Weights
 * w = R^-1 1 (generalised least squares on the fit split's pairwise phi matrix) are compared
 * with the scalar options on the held-out rows of the diverse3 ledger. No calls are made.
 *
 *   bun experiments/e2e/t5-compound/repool-weights.ts <run dir>
 */
import { join } from "node:path";
import { pool } from "../../../src/compound/aggregate.ts";
import { brier, ece, memberCorrelation, type Scored } from "../../../src/ledger/calibration.ts";
import { JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { Verdict } from "../../../src/types.ts";
import { type Domain, questionOf } from "./gates.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: repool-weights.ts <run dir>");
const rows = await new JsonlLedger(join(dir, "diverse3.jsonl")).all();
const split = (r: (typeof rows)[number]) => r.tags.find((t) => t.startsWith("split:"))?.slice(6);
const fit = rows.filter((r) => split(r) === "fit");
const held = rows.filter((r) => split(r) === "held" && r.outcome);
const keys = ["jev113", "jev114", "haiku55"];
const mc = memberCorrelation(fit);
const rho = (a: string, b: string) =>
  a === b ? 1 : (mc.pairs.find((p) => p.keys.includes(a) && p.keys.includes(b))?.correlation ?? 0);
// Solve R w = 1 for three members (Cramer's rule keeps this dependency-free).
const R = keys.map((a) => keys.map((b) => Math.max(0, rho(a, b))));
const det3 = (m: number[][]) => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
};
const D = det3(R);
const gls = keys.map((_, j) => det3(R.map((row) => row.map((x, k) => (k === j ? 1 : x)))) / D);
const right = (v: Verdict, t: unknown) =>
  v.kind === "judge" ? v.pYes >= 0.5 === t : v.kind === "pick" ? v.choice === t : false;
const pTrue = (v: Verdict, t: unknown) =>
  v.kind === "judge"
    ? t === true
      ? v.pYes
      : 1 - v.pYes
    : v.kind === "pick"
      ? (v.probabilities[String(t)] ?? 0)
      : 0;
function score(label: string, opts: { correlation?: number; weights?: number[] }) {
  const sc: Scored[] = [];
  let nll = 0;
  for (const r of held) {
    const ms = keys.map((k) => r.members?.find((m) => m.key === k));
    if (ms.some((m) => !m || m.failedOpen)) continue;
    const q = questionOf(r.gateId.replace("t5.", "") as Domain);
    const v = pool(
      q,
      ms.map((m) => (m as NonNullable<typeof m>).verdict),
      opts,
    );
    const t = r.outcome?.truth;
    sc.push({ confidence: v.confidence, correct: right(v, t) });
    nll -= Math.log(Math.min(1 - 1e-6, Math.max(1e-6, pTrue(v, t))));
  }
  const acc = sc.filter((s) => s.correct).length / sc.length;
  process.stdout.write(
    `| ${label} | ${sc.length} | ${(100 * acc).toFixed(1)}% | ${ece(sc).toFixed(3)} | ${brier(sc).toFixed(3)} | ${(nll / sc.length).toFixed(3)} |\n`,
  );
}
process.stdout.write(
  `fit-split phi: ${mc.pairs.map((p) => `${p.keys.join("~")} ${p.correlation?.toFixed(2) ?? "none"}`).join(", ")}\n`,
);
process.stdout.write(
  `GLS weights (jev113, jev114, haiku55): ${gls.map((w) => w.toFixed(3)).join(", ")}\n\n`,
);
process.stdout.write(
  "| pooling | n | accuracy | ECE | Brier | log loss |\n| --- | --- | --- | --- | --- | --- |\n",
);
score("rho 0 (engine default for explicit members)", { correlation: 0 });
score(`rho ${(mc.mean ?? 0).toFixed(2)} (memberCorrelation mean)`, { correlation: mc.mean ?? 0 });
score("rho 0.5 (proposed second-opinion default)", { correlation: 0.5 });
score("rho 0.75 (replica default)", { correlation: 0.75 });
score("GLS weights from the phi matrix, rho 0", { correlation: 0, weights: gls });
