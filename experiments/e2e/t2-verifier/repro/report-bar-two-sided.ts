/**
 * Repro (T2-02): a judge gate's `report().fitted` bar is fitted on the leading answer's
 * confidence, max(p, 1 - p), so confident "no" answers count toward the promised accuracy. The
 * bar is then used as `actAbove` on p(yes) (examples/tool-gate.ts does exactly this), where only
 * "yes" answers act. When the oracle is better at "no" than at "yes" (a verifier that spots
 * broken outputs easily but passes subtle errors), the bar keeps a promise acting never made.
 *
 *   bun experiments/e2e/t2-verifier/repro/report-bar-two-sided.ts
 *
 * Deterministic: 50 outputs the oracle passes at p = 0.95 (40 truly good), 150 it rejects at
 * p = 0.10 (all truly bad). Exits 1 when acting at the reported bar misses the target.
 */
import { Engine } from "../../../../src/engine.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import type { Oracle } from "../../../../src/types.ts";

const q = judge("Does the output satisfy the request?", { id: "out.ok" });
const pOf = (s: string): number => (s.startsWith("pass") ? 0.95 : 0.1);
const oracle: Oracle = {
  id: "asym",
  decide: async (s, qs) =>
    qs.map((x) => ({
      verdict: {
        kind: "judge" as const,
        questionId: x.id,
        pYes: pOf(s),
        confidence: Math.max(pOf(s), 1 - pOf(s)),
      },
      oracle: "asym",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    })),
};
const engine = new Engine({ oracle, ledger: new MemoryLedger(), seed: 1 });
const gate = engine.gate({ id: "out.verify", question: q, policy: { actAbove: 0.9 } });
const items = [
  ...Array.from({ length: 50 }, (_, i) => ({ s: `pass ${i}`, truth: i < 40 })),
  ...Array.from({ length: 150 }, (_, i) => ({ s: `fail ${i}`, truth: false })),
];
for (const it of items) {
  const r = await gate.ask(it.s);
  await engine.label(r.recordId, {
    correct: r.decision.verdict.pYes >= 0.5 === it.truth,
    truth: it.truth,
    source: "review:blind:repro",
  });
}
const target = 0.95;
const rep = await gate.report({ targetAccuracy: target, minSupport: 20 });
const bar = rep.fitted?.threshold ?? Number.NaN;
const acts = items.filter((it) => pOf(it.s) >= bar);
const precision = acts.filter((it) => it.truth).length / acts.length;
console.log(
  `report: fitted bar ${bar} from ${rep.fittedFrom}, promising ${rep.fitted?.accuracy} accuracy on ${rep.fitted?.n} rows (target ${target})`,
);
console.log(`acting at p(yes) >= ${bar}: ${acts.length} acts, precision ${precision.toFixed(3)}`);
console.log(
  "a one-sided fit on the same rows finds no bar: no set of passes reaches 0.95 precision.",
);
process.exit(precision < target ? 1 : 0);
