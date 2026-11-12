/**
 * V1 repro: two holes left in `sequential` after wave 2.
 *
 *   1. T5-05 not closed for the live case: `independentLead` keys voters by `d.model ?? d.oracle`,
 *      so two pins of one family (jev-1.13, jev-1.14: error phi 0.785, the members that made
 *      the live lead-by-2 run stop on 178 of 260 items) still count as two independent votes
 *      and settle at two samples. `modelFamily` (calibration.ts) already says they are one.
 *      Fix: key voters by `modelFamily(d.model ?? d.oracle)`.
 *   2. The T4-04 hole in its sibling: a failed-open first member is dropped and the next one
 *      settles alone, so an outage of the cautious member turns review into act. Fix: fail the
 *      run open when any sample failed open (or add `minMembers`/count failures against
 *      `minSamples`), as `ensemble` and batteries now do by default.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/sequential-gaps.ts
 *
 * Exits 1 while either reproduces.
 */
import { sequential } from "../../../../../src/compound/sequential.ts";
import { Engine } from "../../../../../src/engine.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import type { Oracle } from "../../../../../src/types.ts";
import { fixed, scripted } from "../lib.ts";

const q = judge("Is it safe?", { id: "q" });
const pins = await sequential("s", q, {
  members: [
    { oracle: fixed("jev-1.13", 0.8, "jev-1.13") },
    { oracle: fixed("jev-1.14", 0.8, "jev-1.14") },
    { oracle: fixed("haiku-5.5", 0.2, "haiku-5.5") },
  ],
  settleAbove: 0.99,
  settleLead: 2,
  maxSamples: 3,
  correlation: 0.75,
});
console.log(
  `jev-1.13 + jev-1.14 + haiku, settleLead 2: stopped after ${pins.detail.samples} samples (settled ${pins.detail.settled})`,
);

const down: Oracle = scripted("down", () => {
  throw new Error("503");
});
const run = async (first: Oracle) => {
  const engine = new Engine({ oracle: first, ledger: new MemoryLedger(), mode: "enforce" });
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
  return (await gate.ask("s")).action;
};
const answered = await run(fixed("cautious", 0.3, "cautious"));
const failed = await run(down);
console.log(`cautious member answers 0.30 -> ${answered}; cautious member down -> ${failed}`);
process.exitCode = pins.detail.samples === 2 || failed === "act" ? 1 : 0;
