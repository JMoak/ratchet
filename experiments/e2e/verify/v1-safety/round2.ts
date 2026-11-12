/**
 * V1 round 2: attacks on the code wave 2 wrote to close V1's defects (rollout `verify`,
 * `readAction`, `modelFamily` voters, `maxFailedSamples`, failOpen plain copies,
 * `checkStrategy`). Offline and deterministic.
 *
 *   bun experiments/e2e/verify/v1-safety/round2.ts
 */
import { runChain, type Step } from "../../../../src/compound/chain.ts";
import type { Member } from "../../../../src/compound/ensemble.ts";
import { independentLead, sequential } from "../../../../src/compound/sequential.ts";
import { Engine } from "../../../../src/engine.ts";
import type { GateSpec } from "../../../../src/gate.ts";
import { modelFamily } from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { failOpen } from "../../../../src/oracles/oracle.ts";
import { readAction, rule } from "../../../../src/policy.ts";
import { judge, pick } from "../../../../src/questions.ts";
import type { RolloutCheckpoint } from "../../../../src/rollout.ts";
import type { Action, Decision, Oracle, Question } from "../../../../src/types.ts";
import { attack, describeError, fixed, judged, report, scripted } from "./lib.ts";

const q = judge("Is it safe to run this command without asking?", { id: "bash.safe" });

// --- 1. rollout `verify` ---------------------------------------------------------------------
const spec = (checkpoint?: unknown): GateSpec => ({
  id: "r",
  question: q,
  policy: { actAbove: 0.9 },
  evidenceVersion: "v1",
  promisedAccuracy: 0.5,
  rollout: {
    confidence: 0.5,
    ...(checkpoint ? { checkpoint: checkpoint as RolloutCheckpoint } : {}),
  },
});
const SRC = "review:blind:v1";
const restoreOn = async (ledger: MemoryLedger, cp: unknown) => {
  const gate = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 }).gate(spec(cp));
  const s = await gate.rollout.evaluate();
  return { mode: s.mode, reason: s.reason, written: gate.rollout.checkpoint() };
};

/**
 * One act labelled right before the controller existed, then the controller's own phase whose
 * planned act (n = 1) is labelled wrong: the honest controller rejects the configuration.
 */
async function rejectedAfterPassingPrehistory() {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 });
  const gate = engine.gate(spec());
  const early = await gate.ask("an act from before the controller");
  await engine.label(early.recordId, { correct: true, truth: true, source: SRC });
  await gate.rollout.evaluate();
  const wrong = await gate.ask("the controller's planned act");
  await engine.label(wrong.recordId, { correct: false, truth: false, source: SRC });
  const honest = await gate.rollout.evaluate();
  return {
    ledger,
    early,
    wrong,
    honest,
    cp: gate.rollout.checkpoint() as Extract<RolloutCheckpoint, { format: 3 }>,
  };
}

const h = await rejectedAfterPassingPrehistory();
await attack(
  "rollout",
  "V1-1",
  "baseline: honest controller rejected (its own phase's planned act was wrong)",
  () => ({
    held: h.honest.mode === "shadow" && h.cp.rejected === true,
    observed: `${h.honest.mode}: ${h.honest.reason.slice(0, 90)}`,
  }),
);
await attack(
  "rollout",
  "V1-1",
  "format 3 forgery resting on the earlier passing (pre-controller) sample while the later planned window failed",
  async () => {
    const r = await restoreOn(h.ledger, {
      format: 3,
      scopeHash: h.cp.scopeHash,
      mode: "enforce",
      afterId: h.cp.afterId,
      rejected: false,
      accepted: { from: null, sample: [h.early.recordId] },
    });
    return { held: r.mode === "shadow", observed: `${r.mode}: ${r.reason.slice(0, 100)}` };
  },
);
await attack(
  "rollout",
  "V1-1",
  "format 2 forgery on the same ledger (earliest passing sample is the pre-controller one)",
  async () => {
    const r = await restoreOn(h.ledger, {
      format: 2,
      scopeHash: h.cp.scopeHash,
      mode: "enforce",
      afterId: h.cp.afterId,
      rejected: false,
    });
    return { held: r.mode === "shadow", observed: `${r.mode}: ${r.reason.slice(0, 100)}` };
  },
);

/** An honest promotion on a 1-act plan, plus two more labelled-right shadow acts before it. */
async function honestPromotion() {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle: fixed("sure", 0.99), ledger, seed: 1 });
  const gate = engine.gate(spec());
  await gate.ask("before the controller");
  await gate.rollout.evaluate();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await gate.ask(`act ${i}`);
    ids.push(r.recordId);
  }
  // Labels arrive after all three acts; the planned sample is the first.
  for (const id of ids) await engine.label(id, { correct: true, truth: true, source: SRC });
  const s = await gate.rollout.evaluate();
  return {
    ledger,
    ids,
    s,
    cp: gate.rollout.checkpoint() as Extract<RolloutCheckpoint, { format: 3 }>,
  };
}
const p = await honestPromotion();
await attack(
  "rollout",
  "V1-1",
  "honest format 2 enforce checkpoint is re-derived and written back as format 3",
  async () => {
    const legacy = {
      format: 2,
      scopeHash: p.cp.scopeHash,
      mode: "enforce",
      afterId: p.cp.afterId,
      rejected: false,
    };
    const r = await restoreOn(p.ledger, legacy);
    return {
      held: p.s.mode === "enforce" && r.mode === "enforce" && r.written?.format === 3,
      observed: `${p.s.mode} -> ${r.mode}; written back ${JSON.stringify(r.written).slice(0, 120)}`,
    };
  },
);
await attack(
  "rollout",
  "V1-1",
  "legacy format 2 checkpoint after the accepted act's label was flipped wrong (later acts still pass)",
  async () => {
    const ledger = new MemoryLedger();
    for (const r of await p.ledger.all()) await ledger.append(r as DecisionRecord);
    await ledger.label(p.ids[0] as string, {
      correct: false,
      truth: false,
      source: SRC,
      at: "2026-11-12T12:00:00.000Z",
    });
    const legacy = {
      format: 2,
      scopeHash: p.cp.scopeHash,
      mode: "enforce",
      afterId: p.cp.afterId,
      rejected: false,
    };
    const r = await restoreOn(ledger, legacy);
    return { held: r.mode === "shadow", observed: `${r.mode}: ${r.reason.slice(0, 110)}` };
  },
);
await attack(
  "rollout",
  "V1-1",
  "legacy checkpoint whose accepted act's label is now from an unregistered source",
  async () => {
    const ledger = new MemoryLedger();
    for (const r of await p.ledger.all()) await ledger.append(r as DecisionRecord);
    for (const id of p.ids)
      await ledger.label(id, {
        correct: true,
        truth: true,
        source: "Review:blind",
        at: "2026-11-12T12:00:00.000Z",
      });
    const legacy = { format: 1, scopeHash: p.cp.scopeHash, mode: "enforce", afterId: p.cp.afterId };
    const r = await restoreOn(ledger, legacy);
    return { held: r.mode === "shadow", observed: `${r.mode}: ${r.reason.slice(0, 110)}` };
  },
);

// --- 3. readAction and the chain -------------------------------------------------------------
const actLike: [string, unknown][] = [
  ["{ toString: () => 'act' }", { toString: () => "act" }],
  ["new String('act')", new String("act")],
  ["'act ' (trailing space)", "act "],
  ["'ACT'", "ACT"],
  ["Symbol('act')", Symbol("act")],
  ["['act']", ["act"]],
  [
    "{ valueOf: () => 'act', [Symbol.toPrimitive]: () => 'act' }",
    { valueOf: () => "act", [Symbol.toPrimitive]: () => "act" },
  ],
];
for (const [name, x] of actLike) {
  await attack(
    "readAction",
    "V1-3",
    `readAction(${name}) is never act; as a gate action, a floor and onFailOpen`,
    async () => {
      const a = readAction(x);
      const d = judged(q, 0.99);
      const chain = await runChain(
        "start",
        [
          {
            name: "s",
            propose: async () => "next",
            verify: async () => ({
              decision: d,
              ruling: rule(d, { actAbove: 0.9 }),
              action: x as Action,
            }),
          },
        ] as Step<string>[],
        { actAbove: 0.9 },
      );
      const floored = rule(d, { actAbove: 0.9 }, x as Action).action;
      const failed = rule({ ...d, failedOpen: true } as Decision, {
        actAbove: 0.9,
        onFailOpen: x as Action,
      }).action;
      return {
        held: a !== "act" && !chain.ok && floored !== "act" && failed !== "act",
        observed: `readAction ${a}; chain committed ${chain.ok}; as floor ${floored}; as onFailOpen ${failed}`,
      };
    },
  );
}
await attack(
  "chain",
  "V1-3",
  "gate verification whose ruling is missing (cannot read the gate's floor)",
  async () => {
    const d = judged(q, 0.99);
    const chain = await runChain(
      "start",
      [
        {
          name: "s",
          propose: async () => "next",
          verify: async () => ({ decision: d, ruling: undefined, action: "act" }) as never,
        },
      ] as Step<string>[],
      { actAbove: 0.9 },
    );
    return { held: !chain.ok, observed: `committed ${chain.ok}` };
  },
);

// --- 4. modelFamily voters -------------------------------------------------------------------
await attack(
  "voters",
  "V1-4",
  "one model with and without an owner prefix (gpt-4o, openai/gpt-4o) is one voter",
  () => {
    const a = modelFamily("gpt-4o");
    const b = modelFamily("openai/gpt-4o");
    return { held: a === b, observed: `"${a}" vs "${b}"` };
  },
);
await attack(
  "voters",
  "V1-4",
  "a merge can only make settleLead later, never earlier (merging the minority)",
  () => {
    // Votes: yes from three families; no from two models that modelFamily merges ("gpt-4o",
    // "gpt-5"). Unmerged the lead is 3 - 2 = 1; merged it is 3 - 1 = 2.
    const mk = (model: string, pYes: number) => judged(q, pYes, { model, oracle: model });
    const ds = [
      mk("claude-3-opus", 0.9),
      mk("gpt-4o", 0.1),
      mk("gemini-2.5-pro", 0.9),
      mk("gpt-5", 0.1),
      mk("llama-3.1-70b", 0.9),
    ];
    const lead = independentLead(ds);
    return {
      held: lead <= 1,
      observed: `independentLead ${lead} (families ${ds.map((d) => modelFamily(d.model as string)).join(",")})`,
    };
  },
);
await attack(
  "voters",
  "V1-4",
  "sequential: merging the minority settles a lead-by-2 earlier and acts where the unmerged run reviews",
  async () => {
    const run = async (noModels: [string, string]) => {
      const engine = new Engine({
        oracle: fixed("x", 0.5),
        ledger: new MemoryLedger(),
        mode: "enforce",
      });
      const members: Member[] = [
        { oracle: fixed("claude", 0.8, "claude-3-opus") },
        { oracle: fixed("n1", 0.3, noModels[0]) },
        { oracle: fixed("gemini", 0.8, "gemini-2.5-pro") },
        { oracle: fixed("n2", 0.3, noModels[1]) },
        { oracle: fixed("llama", 0.8, "llama-3.1-70b") },
        { oracle: fixed("n3", 0.001, "mistral-large-2") },
      ];
      const gate = engine.gate({
        id: "s",
        question: q,
        policy: { actAbove: 0.9 },
        mode: "enforce",
        strategy: {
          sequential: { members, settleAbove: 0.999, settleLead: 2, maxSamples: 6, correlation: 0 },
        },
      });
      const r = await gate.ask("s");
      const pv = r.decision.verdict.kind === "judge" ? r.decision.verdict.pYes : Number.NaN;
      return `${r.action} after ${String(r.decision.detail.samples)} samples (pYes ${pv.toFixed(3)})`;
    };
    const merged = await run(["gpt-4o", "gpt-5"]);
    const apart = await run(["gpt-4o", "command-r"]);
    return {
      held: !(merged.startsWith("act") && !apart.startsWith("act")),
      observed: `no-voters gpt-4o + gpt-5 (one family): ${merged}; gpt-4o + command-r: ${apart}`,
    };
  },
);
await attack(
  "voters",
  "V1-4",
  "an empty model string does not merge every oracle into one voter",
  () => {
    const ds = [
      judged(q, 0.9, { model: "", oracle: "a" }),
      judged(q, 0.9, { model: "", oracle: "b" }),
    ];
    return {
      held: independentLead(ds) === 2,
      observed: `independentLead ${independentLead(ds)} (two different oracles, model "")`,
    };
  },
);

// --- 5. maxFailedSamples with negated members ------------------------------------------------
const negate = (state: string, question: Question) => ({
  state,
  question: {
    ...question,
    id: `${question.id}.not`,
    prompt: `NOT: ${question.prompt}`,
  } as Question,
});
const down: Oracle = scripted("down", () => {
  throw new Error("503");
});
await attack(
  "sequential",
  "V1-5",
  "a failed negated (cautious) member fails the run open by default",
  async () => {
    const s = await sequential("s", q, {
      members: [
        { oracle: failOpen(down), label: "negated", transform: negate, negated: true },
        { oracle: fixed("bold", 0.97, "bold"), label: "bold" },
      ],
      settleAbove: 0.95,
      maxSamples: 2,
      correlation: 0,
    });
    return { held: s.failedOpen === true, observed: `failedOpen ${s.failedOpen}; ${s.error}` };
  },
);
await attack(
  "sequential",
  "V1-5",
  "maxFailedSamples 1 lets the bold member act alone (documented trade-off)",
  async () => {
    const s = await sequential("s", q, {
      members: [
        { oracle: failOpen(down), label: "negated", transform: negate, negated: true },
        { oracle: fixed("bold", 0.97, "bold"), label: "bold" },
      ],
      settleAbove: 0.95,
      maxSamples: 2,
      maxFailedSamples: 1,
      correlation: 0,
    });
    const pv = s.verdict.kind === "judge" ? s.verdict.pYes : Number.NaN;
    return {
      held: true,
      observed: `failedOpen ${s.failedOpen}; pYes ${pv.toFixed(3)} (recorded, not a contract)`,
    };
  },
);
for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  await attack("sequential", "V1-5", `maxFailedSamples ${bad} is refused at registration`, () => {
    const engine = new Engine({ oracle: fixed("x", 0.9), ledger: new MemoryLedger() });
    try {
      engine.gate({
        id: "s",
        question: q,
        policy: { actAbove: 0.9 },
        strategy: {
          sequential: {
            members: [{ oracle: fixed("x", 0.9) }],
            settleAbove: 0.9,
            maxSamples: 2,
            maxFailedSamples: bad,
          },
        },
      });
      return { held: false, observed: "registered" };
    } catch (e) {
      return { held: true, observed: describeError(e).slice(0, 100) };
    }
  });
}

// --- 6. failOpen against lying Proxies -------------------------------------------------------
const pq = pick("Which queue?", ["a", "b"], { id: "q.pick" });
const proxies: [string, Question, () => unknown][] = [
  [
    "pick probabilities whose ownKeys hides 'b' (get still answers 0.1)",
    pq,
    () => ({
      kind: "pick",
      questionId: pq.id,
      choice: "a",
      confidence: 0.9,
      probabilities: new Proxy({ a: 0.9, b: 0.1 }, { ownKeys: () => ["a"] }),
    }),
  ],
  [
    "pick probabilities whose ownKeys lists keys that do not exist",
    pq,
    () => ({
      kind: "pick",
      questionId: pq.id,
      choice: "a",
      confidence: 1,
      probabilities: new Proxy({ a: 1 }, { ownKeys: () => ["a", "b", "zzz"] }),
    }),
  ],
  [
    "pick probabilities whose ownKeys returns duplicates (invariant TypeError)",
    pq,
    () => ({
      kind: "pick",
      questionId: pq.id,
      choice: "a",
      confidence: 0.9,
      probabilities: new Proxy({ a: 0.9, b: 0.1 }, { ownKeys: () => ["a", "a", "b"] }),
    }),
  ],
  [
    "a revoked Proxy as the verdict",
    q,
    () => {
      const r = Proxy.revocable({}, {});
      r.revoke();
      return r.proxy;
    },
  ],
  [
    "a judge verdict Proxy whose get answers 0.99 for pYes but whose ownKeys/has deny it",
    q,
    () =>
      new Proxy(
        { kind: "judge", questionId: q.id, pYes: 0.2, confidence: 0.8 },
        {
          get: (t, k) => (k === "pYes" ? 0.99 : Reflect.get(t, k)),
          has: () => false,
          ownKeys: () => [],
        },
      ),
  ],
];
for (const [name, question, verdict] of proxies) {
  await attack(
    "failOpen",
    "V1-6",
    `${name}: never throws, never acts on an unvalidated value`,
    async () => {
      const inner = scripted("proxy", () => [
        {
          verdict: verdict(),
          oracle: "proxy",
          latencyMs: 1,
          cost: 0,
          at: "2026-11-12T12:00:00.000Z",
        },
      ]);
      try {
        const [d] = await failOpen(inner).decide("s", [question]);
        const r = rule(d as Decision, { actAbove: 0.95 });
        // The last case is consistent once read (0.99 with confidence 0.8 is not): it must fail open.
        return {
          held: r.action !== "act" || d?.failedOpen !== true,
          observed: `failedOpen ${d?.failedOpen}; ruled ${r.action}; ${d?.error ?? ""}`.slice(
            0,
            160,
          ),
        };
      } catch (e) {
        return { held: false, observed: `failOpen threw ${describeError(e)}` };
      }
    },
  );
}

// --- 7-9. checkStrategy versus a strategy that does not come from a gate spec ----------------
await attack(
  "strategy",
  "V1-9",
  "engine.ask with a per-ask sequential strategy, maxSamples Infinity, an oracle that never settles",
  async () => {
    let calls = 0;
    const capped = scripted("unsure", (qs) => {
      calls++;
      if (calls > 2000) throw new Error("harness stop");
      return qs.map((x) => judged(x, 0.6, { cost: 0.001, model: "unsure" }));
    });
    const engine = new Engine({ oracle: capped, ledger: new MemoryLedger(), budgetUsd: 0.01 });
    try {
      await engine.ask("s", q, {
        policy: { actAbove: 0.9 },
        strategy: {
          sequential: {
            members: [{ oracle: capped }],
            settleAbove: 0.99,
            maxSamples: Number.POSITIVE_INFINITY,
          },
        },
      });
      return {
        held: calls < 100,
        observed: `${calls} oracle calls in one ask under budgetUsd 0.01 (stopped only by the harness at 2,000); engine.spent ${engine.spent.toFixed(3)}`,
      };
    } catch (e) {
      return {
        held: calls === 0,
        observed: `threw "${describeError(e).slice(0, 80)}" after ${calls} calls`,
      };
    }
  },
);
await attack(
  "strategy",
  "V1-9",
  "engine.ask with a per-ask ensemble whose minMembers is 5 of 2",
  async () => {
    const engine = new Engine({ oracle: fixed("a", 0.97), ledger: new MemoryLedger() });
    try {
      const r = await engine.ask("s", q, {
        policy: { actAbove: 0.9 },
        strategy: {
          ensemble: {
            members: [{ oracle: fixed("a", 0.97, "a") }, { oracle: fixed("b", 0.97, "b") }],
            minMembers: 5,
          },
        },
      });
      return { held: r.ruling.action !== "act", observed: r.ruling.action };
    } catch (e) {
      return { held: true, observed: `refused: ${describeError(e).slice(0, 100)}` };
    }
  },
);

const broken = report("V1 round 2: the wave 2 fixes to V1's defects");
process.exitCode = broken > 0 ? 1 : 0;
