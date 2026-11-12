/**
 * Post-hoc look (a finding for the next wave, not a refit of the frozen combiner): does
 * `fitLogistic` with its defaults (400 iterations, learning rate 0.1, L2 0.01) converge on a
 * battery whose features are member log-odds clamped to +-7? Fits on the moderation fit split
 * of a T3 run with the defaults and with 20,000 iterations, and reads both on the held-out split.
 *
 *   bun experiments/e2e/t3-triage/repro/logistic-convergence.ts <run dir>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { batteryFeatures, fitLogistic, predictLogistic } from "../../../../src/compound/learned.ts";
import { ece } from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, parseJsonlLedger } from "../../../../src/ledger/ledger.ts";
import type { JudgeVerdict } from "../../../../src/types.ts";
import type { ModerationItem } from "../corpus/moderation.ts";
import { loadCorpus } from "../util.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: logistic-convergence.ts <run dir>");
const items = loadCorpus<{ items: ModerationItem[] }>("moderation").items;
const byState = new Map(items.map((i) => [i.state, i]));
const rows = parseJsonlLedger(readFileSync(join(dir, "moderation.jsonl"), "utf8")).filter(
  (r) => r.gateId === "mod.action",
);
const members = ["threat", "harass", "spam", "selfharm"];
const data = rows
  .filter((r) => r.combined === true && !r.failedOpen && r.strategy !== "floored")
  .flatMap((c) => {
    const item = c.state === undefined ? undefined : byState.get(c.state);
    const ms = members.map((q) =>
      rows.find((m: DecisionRecord) => m.requestId === c.requestId && m.questionId === q),
    );
    if (!item || ms.some((m) => !m)) return [];
    return [
      {
        split: item.split,
        x: batteryFeatures(ms.map((m) => m?.verdict as JudgeVerdict)),
        y: item.label.truth,
      },
    ];
  });
const fit = data.filter((d) => d.split === "fit");
const held = data.filter((d) => d.split === "heldout");
const loss = (m: ReturnType<typeof fitLogistic>, xs: typeof fit) =>
  -xs.reduce((s, d) => {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predictLogistic(m, d.x)));
    return s + (d.y ? Math.log(p) : Math.log(1 - p));
  }, 0) / xs.length;
for (const iterations of [400, 2000, 20000]) {
  const m = fitLogistic(fit, { iterations });
  const ps = held.map((d) => predictLogistic(m, d.x));
  const right = held.filter((d, i) => (ps[i] ?? 0.5) >= 0.5 === d.y).length;
  const scored = held.map((d, i) => {
    const p = ps[i] ?? 0.5;
    return { confidence: Math.max(p, 1 - p), correct: p >= 0.5 === d.y };
  });
  console.log(
    `iterations ${String(iterations).padStart(5)}: fit log-loss ${loss(m, fit).toFixed(4)}, weights ${m.weights.map((w) => w.toFixed(2)).join(" ")} bias ${m.bias.toFixed(2)}; held-out accuracy ${right}/${held.length}, ECE ${ece(scored).toFixed(3)}`,
  );
}
