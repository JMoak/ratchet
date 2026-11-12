/**
 * Repro T5: `sequential` ignores `Member.negated`.
 *
 * `ensemble` asks a negated member the complement and flips its answer back before pooling
 * (`untransform(..., negated)`). `sequential` takes the same `Member` type but never reads
 * `negated`: the complement's pYes is pooled as if it answered the original question, so a
 * consistent oracle's two framings cancel instead of agreeing. The same members through a gate
 * give opposite-looking verdicts depending only on the strategy.
 *
 *   bun experiments/e2e/t5-compound/repro/sequential-negated.ts
 */
import type { Member } from "../../../../src/compound/ensemble.ts";
import { Engine } from "../../../../src/engine.ts";
import { judge } from "../../../../src/questions.ts";
import { fixedJudge, say } from "./fixtures.ts";

const q = judge("Is the request compliant?", { id: "req.ok" });
const neg = judge("Does the request violate the policy?", { id: "req.ok.neg" });
// A perfectly consistent oracle: 0.9 that the request is compliant, so 0.1 that it violates.
const oracle = fixedJudge("consistent", (asked) => (asked.id === "req.ok.neg" ? 0.1 : 0.9));
const members: Member[] = [
  { oracle, label: "orig" },
  { oracle, label: "neg", transform: (state) => ({ state, question: neg }), negated: true },
];

const engine = new Engine({ oracle, mode: "shadow" });
const ens = engine.gate({
  id: "via.ensemble",
  question: q,
  policy: { actAbove: 0.9 },
  strategy: { ensemble: { members } },
});
const seq = engine.gate({
  id: "via.sequential",
  question: { ...q, id: "req.ok.seq" },
  policy: { actAbove: 0.9 },
  strategy: { sequential: { members, settleAbove: 0.99, maxSamples: 2 } },
});

const a = await ens.ask("Request: refund of $40 within 10 days, unopened.");
const b = await seq.ask("Request: refund of $40 within 10 days, unopened.");
const pa = a.decision.verdict.kind === "judge" ? a.decision.verdict.pYes : Number.NaN;
const pb = b.decision.verdict.kind === "judge" ? b.decision.verdict.pYes : Number.NaN;
say(
  `ensemble   pooled pYes ${pa.toFixed(4)}  members ${JSON.stringify(a.decision.members.map((m) => m.verdict.kind === "judge" && m.verdict.pYes))}`,
);
say(
  `sequential pooled pYes ${pb.toFixed(4)}  members ${JSON.stringify(b.decision.members.map((m) => m.verdict.kind === "judge" && m.verdict.pYes))}`,
);
say(
  pb > 0.45 && pb < 0.55 && pa > 0.95
    ? "REPRODUCED: the negated member is flipped by ensemble but pooled unflipped by sequential (0.9 and 0.1 cancel to 0.5)."
    : "not reproduced",
);
