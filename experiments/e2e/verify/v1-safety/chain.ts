/**
 * V1 attacks on T2-01 (runChain honours a gate verifier), T2-03 (chainTags) and T2-09
 * (maxAttempts validation). Offline and deterministic.
 *
 *   bun experiments/e2e/verify/v1-safety/chain.ts
 */
import { chainTags, runChain, type Step } from "../../../../src/compound/chain.ts";
import { Engine } from "../../../../src/engine.ts";
import { refuseIf, reviewIf } from "../../../../src/floors.ts";
import { isUnselected } from "../../../../src/ledger/calibration.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { rule } from "../../../../src/policy.ts";
import { judge } from "../../../../src/questions.ts";
import type { Action } from "../../../../src/types.ts";
import { attack, describeError, fixed, judged, report } from "./lib.ts";

const verified = judge("Did the step succeed?", { id: "step.ok" });
const policy = { actAbove: 0.9 };

/** A one-step chain whose verify returns whatever `verify` gives. */
function oneStep(verify: Step<string>["verify"], maxAttempts = 2): Step<string>[] {
  return [{ name: "migrate", propose: async () => "DROP TABLE users;", verify, maxAttempts }];
}

// --- forged gate verifications ----------------------------------------------------------------
await attack(
  "chain",
  "T2-01",
  "forged {action:'act'} over a 0.5 decision still needs the chain's own policy",
  async () => {
    const d = judged(verified, 0.5);
    const r = await runChain(
      "start",
      oneStep(async () => ({
        decision: d,
        ruling: rule(d, { actAbove: 0 }),
        action: "act" as Action,
      })),
      policy,
    );
    return { held: !r.ok, observed: `completed ${r.ok}, final ${r.state}` };
  },
);

for (const bogus of ["Act", "REFUSE", "deny", undefined, "__proto__", "toString"]) {
  await attack(
    "chain",
    "T2-01",
    `gate verification with action ${JSON.stringify(bogus)} over a 0.99 decision is not read as act`,
    async () => {
      const d = judged(verified, 0.99);
      const r = await runChain(
        "start",
        oneStep(async () => ({
          decision: d,
          ruling: rule(d, policy),
          action: bogus as unknown as Action,
        })),
        policy,
      );
      return {
        held: !r.ok,
        observed: `completed ${r.ok}; attempt actions ${r.trace[0]?.attempts.map((a) => a.ruling.action).join(",")}`,
      };
    },
  );
}

// --- a real gate in shadow, as the chain docs advise (baseline act) ---------------------------
for (const [name, floor, chainPolicy] of [
  ["refuse floor, chain actAbove 0.9", refuseIf(/DROP TABLE/), { actAbove: 0.9 }],
  [
    "refuse floor, chain policy from equal costs (actAbove 0.5)",
    refuseIf(/DROP TABLE/),
    { actAbove: 0.5 },
  ],
  [
    "review floor (gate policy has refuseBelow), chain actAbove 0.9",
    reviewIf(/DROP TABLE/),
    { actAbove: 0.9 },
  ],
] as const) {
  await attack(
    "chain",
    "T2-01",
    `shadow gate with a ${name}, ask with baseline 'act' (docs: "lets the chain's own policy decide")`,
    async () => {
      const ledger = new MemoryLedger();
      const engine = new Engine({ oracle: fixed("sure", 0.97), ledger, seed: 1 });
      const gate = engine.gate({
        id: "v",
        question: verified,
        policy: { actAbove: 0.9, refuseBelow: 0.1 },
        floors: [floor],
      });
      const r = await runChain(
        "start",
        oneStep((_b, after, _a, tags) => gate.ask(after, { baseline: "act", tags })),
        chainPolicy,
      );
      const rows = await ledger.all();
      return {
        held: !r.ok,
        observed: `chain committed ${r.ok} ("${r.state}"); gate ruling ${rows.map((x) => `${x.soft}/floor ${x.floor}`).join(",")}, gate action ${r.trace[0]?.attempts[0]?.gate?.action}`,
      };
    },
  );
}

await attack("chain", "T2-01", "enforce gate refuse floor stops the chain", async () => {
  const engine = new Engine({
    oracle: fixed("sure", 0.97),
    ledger: new MemoryLedger(),
    mode: "enforce",
  });
  const gate = engine.gate({
    id: "v",
    question: verified,
    policy: { actAbove: 0.9 },
    mode: "enforce",
    floors: [refuseIf(/DROP TABLE/)],
  });
  const r = await runChain(
    "start",
    oneStep((_b, after, _a, tags) => gate.ask(after, { tags })),
    policy,
  );
  return {
    held: !r.ok && r.stopReason === "refused",
    observed: `completed ${r.ok}, stopReason ${r.stopReason}`,
  };
});

// --- T2-09: maxAttempts -----------------------------------------------------------------------
for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
  await attack(
    "chain",
    "T2-09",
    `maxAttempts ${String(bad)} (${typeof bad}) throws before any step runs`,
    async () => {
      let proposed = 0;
      const steps: Step<string>[] = [
        {
          name: "ok",
          propose: async () => {
            proposed++;
            return "a";
          },
          verify: async () => judged(verified, 0.99),
        },
        {
          name: "bad",
          propose: async () => "b",
          verify: async () => judged(verified, 0.99),
          maxAttempts: bad as number,
        },
      ];
      try {
        await runChain("start", steps, policy);
        return { held: false, observed: `ran; step 1 proposed ${proposed} times` };
      } catch (e) {
        return {
          held: proposed === 0,
          observed: `threw "${describeError(e)}" after ${proposed} proposals`,
        };
      }
    },
  );
}

// --- T2-03: chainTags and selection -----------------------------------------------------------
await attack(
  "chain",
  "T2-03",
  "a gate verifier's retry rows are not unselected; attempt 1 is",
  async () => {
    const ledger = new MemoryLedger();
    // Verifier says 0.5 on the first proposal, 0.97 on the second.
    let call = 0;
    const oracle = {
      id: "v",
      decide: async (_s: string, qs: readonly import("../../../../src/types.ts").Question[]) =>
        qs.map((q) => judged(q, ++call === 1 ? 0.5 : 0.97)),
    };
    const engine = new Engine({ oracle, ledger });
    const gate = engine.gate({ id: "v", question: verified, policy });
    const steps: Step<string>[] = [
      {
        name: "migrate",
        propose: async (_s, a) => `attempt ${a}`,
        verify: (_b, after, _a, tags) => gate.ask(after, { baseline: "act", tags }),
      },
    ];
    await runChain("start", steps, policy);
    const rows = await ledger.all();
    const flags = rows.map((r) => `${r.tags.join("+")}=${isUnselected(r)}`);
    const ok =
      rows.length === 2 && isUnselected(rows[0] as never) && !isUnselected(rows[1] as never);
    return { held: ok, observed: flags.join("; ") };
  },
);

await attack("chain", "T2-03", "chainTags shape", () => {
  const t = chainTags("migrate", 2);
  return {
    held: JSON.stringify(t) === JSON.stringify(["chain", "chain:step:migrate", "chain:attempt:2"]),
    observed: JSON.stringify(t),
  };
});

const broken = report("V1: chains (T2-01, T2-03, T2-09)");
process.exitCode = broken > 0 ? 1 : 0;
