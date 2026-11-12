/**
 * Repro (T2-04, T2-05): what the ledger can say about a battery's members.
 *
 * 1. `memberCorrelation` reads `members` on a row, which battery combined rows never carry
 *    (their members are rows of their own), so over a battery ledger it finds no pairs. The
 *    gate docs say to state a battery's correlation and "Measure it from the ledger"; the one
 *    function that measures it cannot see battery members.
 * 2. `Engine.label` on a combined row gives every member the battery's truth. For a decomposed
 *    (conjunctive) battery that is the wrong target: a member that correctly says "the numbers
 *    are right" on an output that fails only for a missing requirement is marked wrong, so the
 *    per-member report says the most accurate member is the least accurate.
 *
 *   bun experiments/e2e/t2-verifier/repro/battery-ledger-readers.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { memberCorrelation } from "../../../../src/ledger/calibration.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import type { Oracle } from "../../../../src/types.ts";

const numbers = judge("Do the numbers match the sources?", { id: "m.numbers" });
const complete = judge("Is every requested item present?", { id: "m.complete" });

/** A perfect member oracle: answers each sub-question from the state's own facts. */
const perfect: Oracle = {
  id: "perfect",
  decide: async (state, qs) =>
    qs.map((q) => {
      const ok =
        q.id === "m.numbers" ? !state.includes("numbers:bad") : !state.includes("complete:bad");
      const pYes = ok ? 0.98 : 0.02;
      return {
        verdict: {
          kind: "judge" as const,
          questionId: q.id,
          pYes,
          confidence: Math.max(pYes, 1 - pYes),
        },
        oracle: "perfect",
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      };
    }),
};

const ledger = new MemoryLedger();
const engine = new Engine({ oracle: perfect, ledger, seed: 1 });
const gate = engine.gate({
  id: "verify.battery",
  question: [numbers, complete],
  combine: "min",
  policy: { actAbove: 0.9 },
});
// 20 outputs: 10 correct, 5 with a wrong number, 5 missing a requirement.
const states = [
  ...Array.from({ length: 10 }, (_, i) => ({ s: `item ${i} numbers:ok complete:ok`, truth: true })),
  ...Array.from({ length: 5 }, (_, i) => ({
    s: `item ${10 + i} numbers:bad complete:ok`,
    truth: false,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    s: `item ${15 + i} numbers:ok complete:bad`,
    truth: false,
  })),
];
for (const { s, truth } of states) {
  const r = await gate.ask(s);
  await engine.label(r.recordId, {
    correct: r.decision.verdict.pYes >= 0.5 === truth,
    truth,
    source: "review:blind:repro",
  });
}
const report = await engine.report();
const corr = memberCorrelation(await ledger.all());
console.log(`battery gate accuracy: ${report.byGate["verify.battery"]?.accuracy}`);
console.log(
  `member m.numbers accuracy per report: ${report.byQuestion["m.numbers"]?.accuracy} (it answered its own question right 20 of 20 times)`,
);
console.log(
  `member m.complete accuracy per report: ${report.byQuestion["m.complete"]?.accuracy} (also 20 of 20 on its own question)`,
);
console.log(
  `memberCorrelation over the battery ledger: n=${corr.n}, pairs=${corr.pairs.length}, mean=${corr.mean}`,
);
const wrong = (report.byQuestion["m.numbers"]?.accuracy ?? 1) < 1 || corr.pairs.length === 0;
process.exit(wrong ? 1 : 0);
