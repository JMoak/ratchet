/**
 * V1 repro (T2-01 incomplete): `runChain` combines a gate verifier's `action` with the chain's
 * own ruling, but never the gate's floor, and reads an action outside the vocabulary as act.
 *
 *   1. A gate in shadow, asked with `baseline: "act"` as runChain's doc comment advises, with a
 *      refuse floor on DROP TABLE: the floor settles the question with a neutral 0.5 decision
 *      (not failed open); the chain's own policy at actAbove 0.5 (equal costs) acts on it, and
 *      the gate's action is the baseline, so the chain commits DROP TABLE.
 *   2. A verification whose action is "REFUSE" (or undefined, "deny") is ignored by
 *      `moreCautious` (CAUTION[x] is undefined), so the chain commits.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/chain-shadow-floor.ts
 *
 * Exits 1 while either commits. Fix: in chain.ts `rulingFor`, rule with
 * `moreCautious(opts.floor ?? "act", v.ruling.floor ?? "act")` as the floor, and treat an action
 * that is not an own key of CAUTION as "refuse" (or review) with a reason.
 */
import { runChain, type Step } from "../../../../../src/compound/chain.ts";
import { Engine } from "../../../../../src/engine.ts";
import { refuseIf } from "../../../../../src/floors.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { rule } from "../../../../../src/policy.ts";
import { judge } from "../../../../../src/questions.ts";
import type { Action } from "../../../../../src/types.ts";
import { fixed, judged } from "../lib.ts";

const verified = judge("Did the step succeed?", { id: "step.ok" });
const step = (verify: Step<string>["verify"]): Step<string>[] => [
  { name: "migrate", propose: async () => "DROP TABLE users;", verify, maxAttempts: 2 },
];

const engine = new Engine({ oracle: fixed("sure", 0.97), ledger: new MemoryLedger(), seed: 1 });
const gate = engine.gate({
  id: "v",
  question: verified,
  policy: { actAbove: 0.9 },
  floors: [refuseIf(/DROP TABLE/)],
});
const a = await runChain(
  "start",
  step((_b, after, _n, tags) => gate.ask(after, { baseline: "act", tags })),
  { actAbove: 0.5 },
);
console.log(
  `shadow gate, refuse floor, baseline act, chain actAbove 0.5: committed ${a.ok} -> "${a.state}" (gate ruling ${a.trace[0]?.attempts[0]?.gate?.ruling.action})`,
);

const d = judged(verified, 0.99);
const b = await runChain(
  "start",
  step(async () => ({
    decision: d,
    ruling: rule(d, { actAbove: 0.9 }),
    action: "REFUSE" as Action,
  })),
  { actAbove: 0.9 },
);
console.log(`gate verification with action "REFUSE": committed ${b.ok} -> "${b.state}"`);
process.exitCode = a.ok || b.ok ? 1 : 0;
