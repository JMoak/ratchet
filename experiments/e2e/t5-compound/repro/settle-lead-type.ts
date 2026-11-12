/**
 * Repro T5-10 (fixed in wave 2): `settleLead` works through a gate, and the engine's types now
 * declare it.
 *
 * `sequential()` takes `settleLead` (first-to-ahead-by-k), and the architecture lists
 * "sequential() with settleLead" as a recipe. In wave 1 `StrategySpec`'s sequential variant did
 * not declare it, so the literal spec below was a compile error held by a `@ts-expect-error`;
 * the fix declares the field and passes it to `sequential()` explicitly, so the directive is
 * gone and this file type-checks as written.
 *
 * Since wave 2 the lead is counted in independent votes (`independentLead`): these four
 * members are one oracle, one voice, so lead-by-2 can no longer settle on their agreement.
 *
 *   bun experiments/e2e/t5-compound/repro/settle-lead-type.ts
 *   bun x tsc -p tsconfig.json --noEmit   (no error from this file)
 */
import type { StrategySpec } from "../../../../src/engine.ts";
import { Engine } from "../../../../src/engine.ts";
import { judge } from "../../../../src/questions.ts";
import { fixedJudge, say } from "./fixtures.ts";

// Agreeing but unsure members: lead-by-2 settles after two samples; the 0.99 bar never does.
const oracle = fixedJudge("unsure", () => 0.6);
const members = [
  { oracle, label: "m1" },
  { oracle, label: "m2" },
  { oracle, label: "m3" },
  { oracle, label: "m4" },
];
const withLead: StrategySpec = {
  sequential: { members, settleAbove: 0.99, maxSamples: 4, settleLead: 2, correlation: 0.9 },
};
const withoutLead: StrategySpec = {
  sequential: { members, settleAbove: 0.99, maxSamples: 4, correlation: 0.9 },
};
const engine = new Engine({ oracle, mode: "shadow" });
const g1 = engine.gate({
  id: "lead",
  question: judge("q?", { id: "q.lead" }),
  policy: { actAbove: 0.9 },
  strategy: withLead,
});
const g2 = engine.gate({
  id: "nolead",
  question: judge("q?", { id: "q.nolead" }),
  policy: { actAbove: 0.9 },
  strategy: withoutLead,
});
const a = await g1.ask("s");
const b = await g2.ask("s");
say(`with settleLead 2: samples ${JSON.stringify(a.decision.detail)}`);
say(`without:           samples ${JSON.stringify(b.decision.detail)}`);
say("FIXED: StrategySpec declares settleLead (this file type-checks with no @ts-expect-error).");
say(
  a.decision.members.length === 2 && b.decision.members.length === 4
    ? "settleLead settled on agreeing replicas of one oracle (counted as independent votes)."
    : "settleLead counts one oracle's replicas as one vote, so agreeing replicas do not settle it.",
);
