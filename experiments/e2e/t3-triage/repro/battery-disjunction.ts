/**
 * Repro T3: a battery of different risks ("any of these needs action") under the gate's default
 * combiner, logodds at correlation 0, reads one strong yes against three strong noes as a
 * confident no. At a 0.9 publish bar a clear spam post and a clear threat are published with
 * go above 0.998. The same battery's member rows then inherit the battery's truth, so a perfectly
 * right threat member is scored wrong on every spam post, and the report calls it badly
 * overconfident. Live in this track: 51 of 56 held-out posts that needed action were published
 * by the default gate; members scored 99-100% on their own questions and 56-70% in the report.
 *
 *   bun experiments/e2e/t3-triage/repro/battery-disjunction.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { judge, judgeVerdictFrom } from "../../../../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../../../../src/types.ts";

const ANSWERS: Record<string, Record<string, number>> = {
  "post: Buy followers cheap at spam.example": {
    threat: 0.02,
    harass: 0.03,
    spam: 0.99,
    selfharm: 0.02,
  },
  "post: @kim I will break your jaw at the ramp": {
    threat: 0.98,
    harass: 0.06,
    spam: 0.01,
    selfharm: 0.01,
  },
  "post: Caught three fluke this morning": {
    threat: 0.01,
    harass: 0.02,
    spam: 0.02,
    selfharm: 0.01,
  },
};
const oracle: Oracle = {
  id: "fixed",
  async decide(state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, ANSWERS[state]?.[q.id] ?? 0.5),
      oracle: "fixed",
      model: "fixed-1",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
};
const members = ["threat", "harass", "spam", "selfharm"].map((id) => judge(`${id}?`, { id }));
const policy = { actAbove: 0.9, goIsYes: false }; // act = publish unmoderated

for (const combine of [undefined, "max"] as const) {
  const engine = new Engine({ oracle });
  const gate = engine.gate({
    id: "mod",
    question: members,
    policy,
    ...(combine ? { combine } : {}),
  });
  console.log(`\ncombine: ${combine ?? "default (logodds, correlation 0)"}`);
  for (const [state, needsAction] of [
    ["post: Buy followers cheap at spam.example", true],
    ["post: @kim I will break your jaw at the ramp", true],
    ["post: Caught three fluke this morning", false],
  ] as const) {
    const r = await gate.ask(state);
    const pYes = r.decision.verdict.pYes;
    console.log(
      `  ${state.padEnd(46)} pYes(needs action) ${pYes.toFixed(4)}  go ${r.ruling.go.toFixed(4)}  soft ${r.ruling.action.padEnd(6)} truth ${needsAction}`,
    );
    await engine.label(r.recordId, {
      correct: pYes >= 0.5 === needsAction,
      truth: needsAction,
      source: "review:blind",
    });
  }
  const rep = await engine.report();
  console.log(
    `  report, member threat: accuracy ${rep.byQuestion.threat?.accuracy} (expected ${rep.byQuestion.threat?.expectedAccuracy?.toFixed(3)}); on its own question it was right 3 of 3`,
  );
}
console.log(`
Expected: the default combiner of a gate whose members ask different questions should not turn
a clear yes on one member into a confident no; or the docs should say logodds pools evidence
for one proposition and a disjunction takes "max" or a learned model. src/gate.ts:135 (default
combine), docs/vision.md:97 and docs/architecture.md:224,367 ("combined in log-odds").
Member scoring: src/ledger/ledger.ts:190 scores every member against the battery's truth.`);
