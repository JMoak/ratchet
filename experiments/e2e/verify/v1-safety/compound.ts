/**
 * V1 attacks on T4-03/T5-04 (sequential un-negates), T5-05 (settleLead counts distinct voters),
 * T4-04 (ensemble minMembers) and T5-01 (rho defaults by voter identity). Offline, deterministic.
 *
 *   bun experiments/e2e/verify/v1-safety/compound.ts
 */
import { ensemble, type Member } from "../../../../src/compound/ensemble.ts";
import { sequential } from "../../../../src/compound/sequential.ts";
import { Engine } from "../../../../src/engine.ts";
import { modelFamily } from "../../../../src/ledger/calibration.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { failOpen } from "../../../../src/oracles/oracle.ts";
import { judge } from "../../../../src/questions.ts";
import type { Oracle, Question } from "../../../../src/types.ts";
import { attack, describeError, fixed, report, scripted } from "./lib.ts";

const q = judge("Is it safe to run this command without asking?", { id: "q.safe" });
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

// --- T4-03 / T5-04 -------------------------------------------------------------------------------
await attack(
  "sequential",
  "T4-03",
  "ensemble and sequential agree with a negated member",
  async () => {
    const members: Member[] = [
      { oracle: fixed("a", 0.9, "model-a"), label: "a" },
      // Asked "is it NOT safe?", says yes 0.95: dangerous. Flipped back: p(safe) 0.05.
      { oracle: fixed("b", 0.95, "model-b"), label: "b", transform: negate, negated: true },
    ];
    const e = await ensemble("s", q, { members, correlation: 0 });
    const s = await sequential("s", q, {
      members,
      settleAbove: 0.999,
      maxSamples: 2,
      correlation: 0,
    });
    const ep = e.verdict.kind === "judge" ? e.verdict.pYes : Number.NaN;
    const sp = s.verdict.kind === "judge" ? s.verdict.pYes : Number.NaN;
    const stored = s.members.map((m) => (m.verdict.kind === "judge" ? m.verdict.pYes : -1));
    return {
      held: Math.abs(ep - sp) < 1e-9 && sp < 0.5 && Math.abs((stored[1] ?? 0) - 0.05) < 1e-9,
      observed: `ensemble ${ep.toFixed(4)}, sequential ${sp.toFixed(4)}, stored member pYes ${stored.map((x) => x.toFixed(2)).join(",")}`,
    };
  },
);

await attack(
  "sequential",
  "T4-03/T5-05",
  "settleLead reads a negated member's vote the right way (no false lead)",
  async () => {
    const members: Member[] = [
      { oracle: fixed("a", 0.9, "model-a"), label: "a" },
      { oracle: fixed("b", 0.9, "model-b"), label: "b", transform: negate, negated: true },
      { oracle: fixed("c", 0.9, "model-c"), label: "c" },
    ];
    const s = await sequential("s", q, {
      members,
      settleAbove: 0.9999,
      settleLead: 2,
      maxSamples: 3,
      correlation: 0,
    });
    return {
      held: s.detail.samples === 3 && !s.detail.settled,
      observed: `samples ${s.detail.samples}, settled ${s.detail.settled}`,
    };
  },
);

// --- T5-05 --------------------------------------------------------------------------------------
await attack(
  "sequential",
  "T5-05",
  "two pins of one family (jev-1.13, jev-1.14) do not settle a lead-by-2 on their own (the live case)",
  async () => {
    const members: Member[] = [
      { oracle: fixed("jev-1.13", 0.8, "jev-1.13"), label: "jev113" },
      { oracle: fixed("jev-1.14", 0.8, "jev-1.14"), label: "jev114" },
      { oracle: fixed("haiku-5.5", 0.2, "haiku-5.5"), label: "haiku" },
    ];
    const s = await sequential("s", q, {
      members,
      settleAbove: 0.99,
      settleLead: 2,
      maxSamples: 3,
      correlation: 0.75,
    });
    return {
      held: s.detail.samples === 3,
      observed: `stopped after ${s.detail.samples} samples, settled ${s.detail.settled}; modelFamily says both are "${modelFamily("jev-1.13")}"/"${modelFamily("jev-1.14")}"`,
    };
  },
);

await attack("sequential", "T5-05", "replicas of one model never settle a lead", async () => {
  const o = fixed("jev", 0.8, "jev-1.13");
  const members: Member[] = [1, 2, 3, 4].map((i) => ({ oracle: o, label: `r${i}` }));
  const s = await sequential("s", q, {
    members,
    settleAbove: 0.999,
    settleLead: 2,
    maxSamples: 4,
    correlation: 0.9,
  });
  return { held: s.detail.samples === 4, observed: `samples ${s.detail.samples}` };
});

await attack(
  "sequential",
  "T5-05",
  "same model behind two oracle ids that report no model (unseeable, documented limit)",
  async () => {
    const members: Member[] = [
      { oracle: fixed("proxy-1", 0.8), label: "p1" },
      { oracle: fixed("proxy-2", 0.8), label: "p2" },
      { oracle: fixed("other", 0.2), label: "o" },
    ];
    const s = await sequential("s", q, {
      members,
      settleAbove: 0.999,
      settleLead: 2,
      maxSamples: 3,
      correlation: 0.75,
    });
    // Not a contract: recorded so the coordinator sees the documented blind spot.
    return { held: true, observed: `samples ${s.detail.samples} (2 = counted as independent)` };
  },
);

// --- T4-04 --------------------------------------------------------------------------------------
await attack(
  "ensemble",
  "T4-04",
  "a failed cautious member fails the ensemble open by default",
  async () => {
    const members: Member[] = [
      { oracle: failOpen(down), label: "cautious" },
      { oracle: fixed("bold", 0.97, "bold"), label: "bold" },
    ];
    const e = await ensemble("s", q, { members, correlation: 0 });
    return {
      held: e.failedOpen === true,
      observed: `failedOpen ${e.failedOpen}, error ${e.error}`,
    };
  },
);

for (const bad of [3, 0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
  await attack("ensemble", "T4-04", `minMembers ${bad} with 2 members`, async () => {
    const members: Member[] = [
      { oracle: fixed("a", 0.97, "a"), label: "a" },
      { oracle: fixed("b", 0.97, "b"), label: "b" },
    ];
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: members[0]?.oracle as Oracle, ledger, mode: "enforce" });
    let registered = true;
    let gate: ReturnType<Engine["gate"]> | undefined;
    try {
      gate = engine.gate({
        id: "e",
        question: q,
        policy: { actAbove: 0.9 },
        strategy: { ensemble: { members, minMembers: bad } },
      });
    } catch (e) {
      registered = false;
      return { held: true, observed: `refused at registration: ${describeError(e)}` };
    }
    try {
      const r = await gate.ask("s");
      return { held: false, observed: `registered ${registered}; ask ruled ${r.ruling.action}` };
    } catch (e) {
      return {
        held: true,
        observed: `registered ${registered}; every ask throws "${describeError(e)}" (${(await ledger.all()).length} rows)`,
      };
    }
  });
}

// --- the same hole in sequential (not covered by the T4-04 fix) --------------------------------
await attack(
  "sequential",
  "T4-04 (sibling)",
  "sequential: a failed cautious first member lets the next one settle and act alone",
  async () => {
    const run = async (first: Oracle) => {
      const ledger = new MemoryLedger();
      const engine = new Engine({ oracle: first, ledger, mode: "enforce" });
      const gate = engine.gate({
        id: "s",
        question: q,
        policy: { actAbove: 0.95 },
        mode: "enforce",
        strategy: {
          sequential: {
            members: [
              { oracle: first, label: "cautious" },
              { oracle: fixed("bold", 0.97, "bold"), label: "bold" },
            ],
            settleAbove: 0.95,
            maxSamples: 2,
            correlation: 0,
          },
        },
      });
      const r = await gate.ask("s");
      const p = r.decision.verdict.kind === "judge" ? r.decision.verdict.pYes : Number.NaN;
      return `${r.ruling.action} (pYes ${p.toFixed(3)}, samples ${String(r.decision.detail.samples)})`;
    };
    const answered = await run(fixed("cautious", 0.3, "cautious"));
    const failed = await run(down);
    return {
      held: !failed.startsWith("act"),
      observed: `cautious member answers 0.30: ${answered}; cautious member down: ${failed}`,
    };
  },
);

// --- T5-01 --------------------------------------------------------------------------------------
async function rhoOf(members: Member[], kind: "ensemble" | "sequential" = "ensemble") {
  const engine = new Engine({ oracle: members[0]?.oracle as Oracle, ledger: new MemoryLedger() });
  const strategy =
    kind === "ensemble"
      ? { ensemble: { members } }
      : { sequential: { members, settleAbove: 0.9999, maxSamples: members.length } };
  const gate = engine.gate({ id: "r", question: q, policy: { actAbove: 0.9 }, strategy });
  const r = await gate.ask("s");
  return r.decision.detail as { correlation?: number; rhoSource?: string; rhoFrom?: string };
}

await attack(
  "rho",
  "T5-01",
  "two oracle ids advertising one model pin pool as replicas",
  async () => {
    const a = { ...fixed("a", 0.9, "jev-1.13"), model: "jev-1.13" } as Oracle;
    const b = { ...fixed("b", 0.9, "jev-1.13"), model: "jev-1.13" } as Oracle;
    const d = await rhoOf([{ oracle: a }, { oracle: b }]);
    return { held: d.correlation === 0.75, observed: JSON.stringify(d) };
  },
);

await attack(
  "rho",
  "T5-01",
  "two oracle ids whose answers record one model rise to replica",
  async () => {
    const d = await rhoOf([
      { oracle: fixed("a", 0.9, "jev-1.13") },
      { oracle: fixed("b", 0.9, "jev-1.13") },
    ]);
    return { held: d.correlation === 0.75, observed: JSON.stringify(d) };
  },
);

await attack(
  "rho",
  "T5-01",
  "sequential: one member sampled twice is a replica of itself",
  async () => {
    const engine = new Engine({ oracle: fixed("a", 0.7, "m"), ledger: new MemoryLedger() });
    const gate = engine.gate({
      id: "r",
      question: q,
      policy: { actAbove: 0.9 },
      strategy: {
        sequential: {
          members: [{ oracle: fixed("a", 0.7, "m") }],
          settleAbove: 0.9999,
          maxSamples: 3,
        },
      },
    });
    const r = await gate.ask("s");
    const d = r.decision.detail as { correlation?: number; rhoSource?: string };
    return {
      held: d.correlation === 0.75,
      observed: JSON.stringify({ correlation: d.correlation, rhoSource: d.rhoSource }),
    };
  },
);

await attack(
  "rho",
  "T5-01 (scope note)",
  "two pins of one family (jev-1.13, jev-1.14; measured error phi 0.785) default to rho 0",
  async () => {
    const d = await rhoOf([
      { oracle: fixed("a", 0.9, "jev-1.13") },
      { oracle: fixed("b", 0.9, "jev-1.14") },
    ]);
    return { held: (d.correlation ?? 0) > 0, observed: JSON.stringify(d) };
  },
);

await attack(
  "rho",
  "T5-01",
  "a large maxSamples does not make the default-rho computation quadratic in maxSamples",
  async () => {
    const engine = new Engine({ oracle: fixed("a", 0.999, "m"), ledger: new MemoryLedger() });
    const gate = engine.gate({
      id: "r",
      question: q,
      policy: { actAbove: 0.9 },
      strategy: {
        sequential: {
          members: [{ oracle: fixed("a", 0.999, "m") }, { oracle: fixed("b", 0.999, "n") }],
          settleAbove: 0.9,
          maxSamples: 20_000,
        },
      },
    });
    const t0 = performance.now();
    const r = await gate.ask("s");
    const ms = performance.now() - t0;
    return {
      held: ms < 500,
      observed: `one ask that settled after ${String(r.decision.detail.samples)} sample(s) took ${ms.toFixed(0)} ms (maxSamples 20,000)`,
    };
  },
);

const broken = report("V1: compound strategies (T4-03, T5-05, T4-04, T5-01)");
process.exitCode = broken > 0 ? 1 : 0;
