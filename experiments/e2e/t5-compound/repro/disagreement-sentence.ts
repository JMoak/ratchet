/**
 * Repro T5: what "borrowed: at least N% wrong on this slice" can mean.
 *
 * The engine's only disagreement support is `BorrowedVia { type: "disagreement", rate, pairs,
 * models }`, which the caller computes and passes to `gradeOf`; the `disagreement(rows)` reader
 * the evidence-grades design describes (WP4) does not exist. The rate bounds from below the
 * share of rows on which at least one of the two judges is wrong, nothing else. Read on a gate,
 * "at least 30% wrong on this slice" says the gate is wrong at least 30% of the time; here the
 * gate's own oracle is never wrong and the second opinion is wrong on 30% of rows. The only
 * check on the pair is that the two model strings differ, so two pins of one family pass.
 *
 *   bun experiments/e2e/t5-compound/repro/disagreement-sentence.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { describeGrade, gradeOf } from "../../../../src/ledger/evidence.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import { fixedJudge, say } from "./fixtures.ts";

const truthOf = (state: string) => Number(state.split(" ")[1]) % 2 === 0;
// The gate's oracle is always right; the second opinion is wrong on every tenth-of-three rows.
const primary = fixedJudge("vendor/model-1.13", (_q, s) => (truthOf(s) ? 0.9 : 0.1));
const second = fixedJudge("vendor/model-1.14", (_q, s) => {
  const i = Number(s.split(" ")[1]);
  const right = i % 10 >= 3;
  return truthOf(s) === right ? 0.9 : 0.1;
});
const ledger = new MemoryLedger();
const engine = new Engine({ oracle: primary, ledger, mode: "shadow", keepState: true });
const gate = engine.gate({
  id: "pair",
  question: judge("Is it allowed?", { id: "allowed" }),
  policy: { actAbove: 0.9 },
  strategy: {
    ensemble: {
      members: [
        { oracle: primary, label: "primary" },
        { oracle: second, label: "second" },
      ],
    },
  },
});
for (let i = 0; i < 100; i++) await gate.ask(`state ${i}`);
const rows = await ledger.all();
let disagree = 0;
let primaryWrong = 0;
let pooledWrong = 0;
for (const r of rows) {
  const [a, b] = r.members ?? [];
  const truth = truthOf(r.state ?? "");
  if (!a || !b || a.verdict.kind !== "judge" || b.verdict.kind !== "judge") continue;
  if (a.verdict.pYes >= 0.5 !== b.verdict.pYes >= 0.5) disagree++;
  if (a.verdict.pYes >= 0.5 !== truth) primaryWrong++;
  if (r.verdict.kind === "judge" && r.verdict.pYes >= 0.5 !== truth) pooledWrong++;
}
const rate = disagree / rows.length;
// Since wave 2 (T5-03) two pins of one model family are refused as a second opinion; that
// refusal is the fixed behaviour, so report it rather than crash.
let grade: ReturnType<typeof gradeOf>;
try {
  grade = gradeOf(rows, {
    borrowed: {
      type: "disagreement",
      rate,
      pairs: rows.length,
      models: ["vendor/model-1.13", "vendor/model-1.14"],
    },
    borrowedAt: "2026-11-12T00:00:00.000Z",
  });
} catch (e) {
  say(`FIXED: two pins of one family are refused: ${(e as Error).message}`);
  process.exit(0);
}
say(`printed: "${describeGrade(grade)}"`);
say(
  `truth: the gate's oracle is wrong on ${primaryWrong} of ${rows.length}; the pooled verdict on ${pooledWrong}; the pair disagrees on ${disagree}.`,
);
say(
  primaryWrong === 0 && rate >= 0.25
    ? "REPRODUCED: the sentence reads as the gate's error rate, which is 0%; it bounds only 'at least one of the two is wrong'."
    : "not reproduced",
);
