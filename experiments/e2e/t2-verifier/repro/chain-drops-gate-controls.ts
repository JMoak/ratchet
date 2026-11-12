/**
 * Repro (T2-01): `runChain` re-rules the bare `Decision` a step's verifier returns, so when the
 * verifier is a registered gate (the only way chain verifications reach the ledger, per
 * docs/roadmap.md) the gate's floors, one-way doors, shadow mode and blind audits are dropped.
 * The chain commits steps the gate itself said to review, and the ledger row records "review".
 *
 *   bun experiments/e2e/t2-verifier/repro/chain-drops-gate-controls.ts
 *
 * No network. Exits 1 when any case commits a step the gate did not act on.
 */
import { runChain, type Step } from "../../../../src/compound/chain.ts";
import { Engine } from "../../../../src/engine.ts";
import { oneWayDoor, reviewIf } from "../../../../src/floors.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { type GatePolicy, policyFromCosts } from "../../../../src/policy.ts";
import { judge } from "../../../../src/questions.ts";
import type { Action, Oracle } from "../../../../src/types.ts";

const verified = judge("Did the step succeed?", { id: "step.ok" });
/** A verifier that is confident every step succeeded. */
const sure: Oracle = {
  id: "sure",
  decide: async (_s, qs) =>
    qs.map((q) => ({
      verdict: { kind: "judge" as const, questionId: q.id, pYes: 0.97, confidence: 0.97 },
      oracle: "sure",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    })),
};

interface Case {
  readonly name: string;
  readonly engine: Engine;
  readonly policy: GatePolicy;
  readonly gate: Parameters<Engine["gate"]>[0];
}

function cases(): Case[] {
  const mk = (opts: Partial<ConstructorParameters<typeof Engine>[0]> = {}) =>
    new Engine({ oracle: sure, ledger: new MemoryLedger(), seed: 1, ...opts });
  const banded: GatePolicy = { actAbove: 0.9, refuseBelow: 0.1 };
  return [
    {
      name: "review floor on the gate (policy has refuseBelow, so the oracle is still asked)",
      engine: mk({ mode: "enforce" }),
      policy: banded,
      gate: { id: "v1", question: verified, policy: banded, floors: [reviewIf(/DROP TABLE/)] },
    },
    {
      name: "oneWayDoor floor on the gate, chain policy from equal costs (actAbove 0.5)",
      engine: mk({ mode: "enforce" }),
      policy: policyFromCosts(1, 1),
      gate: {
        id: "v2",
        question: verified,
        policy: policyFromCosts(1, 1),
        floors: [oneWayDoor((s) => s.includes("DROP TABLE"))],
      },
    },
    {
      name: "gate left in shadow mode (the default)",
      engine: mk(),
      policy: { actAbove: 0.9 },
      gate: { id: "v3", question: verified, policy: { actAbove: 0.9 } },
    },
    {
      name: "enforce mode with a blind audit on every act (auditRate 1)",
      engine: mk({ mode: "enforce", auditRate: 1 }),
      policy: { actAbove: 0.9 },
      gate: { id: "v4", question: verified, policy: { actAbove: 0.9 } },
    },
  ];
}

let broken = 0;
for (const c of cases()) {
  const gate = c.engine.gate(c.gate);
  const gateActions: Action[] = [];
  const steps: Step<string>[] = [
    {
      name: "migrate",
      maxAttempts: 2,
      propose: async () => "ran: DROP TABLE customers; -- irreversible",
      verify: async (_b, after) => {
        const r = await gate.ask(after);
        gateActions.push(r.action);
        // Wave 2 (T2-01): return the whole AskResult so the chain commits only when the gate
        // acts. Returning the bare `r.decision` still re-rules it on the chain policy alone,
        // by design: a Decision carries no gate action.
        return r;
      },
    },
  ];
  const res = await runChain("start", steps, c.policy);
  const rows = await c.engine.ledger.all();
  const committed = res.trace[0]?.committed === true;
  const gateActed = gateActions.includes("act");
  if (committed && !gateActed) broken++;
  console.log(`${committed && !gateActed ? "BROKEN" : "ok    "} ${c.name}`);
  console.log(
    `       gate actions ${JSON.stringify(gateActions)}, ledger actions ${JSON.stringify(rows.map((r) => r.action))}, chain committed: ${committed}, final state: ${JSON.stringify(res.state)}`,
  );
}
console.log(
  `\n${broken} of ${cases().length} cases committed a step the gate did not act on.` +
    " Fix direction: let a Step's verify return the gate's AskResult (or take a Gate) and commit on its `action`, not on a fresh `rule(decision, policy)`.",
);
process.exit(broken > 0 ? 1 : 0);
