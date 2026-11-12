/**
 * Repro T5: the default correlation depends on how an ensemble is spelled, not on what it is.
 *
 * `{ ensemble: { k: 3 } }` replicates the engine's oracle and pools at correlation 0.75.
 * `{ ensemble: { members: [...] } }` pools at 0, even when every member is the same model
 * asked the same question (a framing ensemble, or replicas a caller listed by hand). The vision
 * says "when there is none [measured], default to pessimism"; for explicit members the engine
 * defaults to the most optimistic value. Three identical 0.8 answers become 0.985 through one
 * spelling and 0.86 through the other.
 *
 *   bun experiments/e2e/t5-compound/repro/explicit-members-default.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { judge } from "../../../../src/questions.ts";
import { fixedJudge, say } from "./fixtures.ts";

const oracle = fixedJudge("same-model", () => 0.8);
const engine = new Engine({ oracle, mode: "shadow" });
const replicated = engine.gate({
  id: "spelled.k",
  question: judge("Is it safe?", { id: "safe.k" }),
  policy: { actAbove: 0.95 },
  strategy: { ensemble: { k: 3 } },
});
const listed = engine.gate({
  id: "spelled.members",
  question: judge("Is it safe?", { id: "safe.members" }),
  policy: { actAbove: 0.95 },
  strategy: {
    ensemble: {
      members: [
        { oracle, label: "a" },
        { oracle, label: "b" },
        { oracle, label: "c" },
      ],
    },
  },
});
const a = await replicated.ask("state");
const b = await listed.ask("state");
const p = (r: typeof a) =>
  r.decision.verdict.kind === "judge" ? r.decision.verdict.pYes : Number.NaN;
say(
  `{ k: 3 }        -> pYes ${p(a).toFixed(4)}, detail ${JSON.stringify(a.decision.detail)}, ruling ${a.ruling.action}`,
);
say(
  `{ members: x3 } -> pYes ${p(b).toFixed(4)}, detail ${JSON.stringify(b.decision.detail)}, ruling ${b.ruling.action}`,
);
say(
  p(b) > 0.95 && p(a) < 0.95
    ? "REPRODUCED: the same three answers clear a 0.95 bar when listed as members (rho 0) and do not when replicated (rho 0.75)."
    : "not reproduced",
);
