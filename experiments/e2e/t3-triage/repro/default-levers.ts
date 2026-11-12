/**
 * Repro T3: the engine's report and the CLI grade the same ledger differently under their
 * defaults, and policyFromProfile can return a policy that cannot act.
 *
 * 1. `Gate.report()` defaults to a 95% promise and minSupport 20 (src/engine.ts:429-430);
 *    `ratchet report`, `check` and `trail` default to 98% and 30 (src/cli/report.ts:351-352).
 *    Sixty clean shadow acts are a completed 95% plan (59 acts) and short of a 98% one (149):
 *    the engine prints "measured", the CLI "estimated", on one ledger. Live in this track, the
 *    sibling routing gate read measured in the engine and estimated in ratchet report from 80
 *    labels on, both under defaults.
 * 2. policyFromProfile puts the act bar at the borrowed bar plus 0.05 and clamps it to 1
 *    (src/policy.ts:110), so a profile bar at 0.95 or above yields actAbove 1: nothing below
 *    certainty acts, no planned sample can fill, and nothing says so.
 *
 *   bun experiments/e2e/t3-triage/repro/default-levers.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "../../../../src/cli/main.ts";
import { Engine } from "../../../../src/engine.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { buildProfile } from "../../../../src/ledger/profile.ts";
import { policyFromProfile } from "../../../../src/policy.ts";
import { pick, pickVerdictFrom } from "../../../../src/questions.ts";
import type { Oracle, PickQuestion } from "../../../../src/types.ts";

const at = (c: number): Oracle => ({
  id: "fixed",
  async decide(_s, qs) {
    return qs.map((q) => ({
      verdict: pickVerdictFrom(q as PickQuestion, [c, (1 - c) / 2, (1 - c) / 2]),
      oracle: "fixed",
      model: "fixed-1",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});
const dir = mkdtempSync(join(tmpdir(), "t3-levers-"));
const path = join(dir, "gate.jsonl");
const engine = new Engine({ oracle: at(0.97), ledger: new JsonlLedger(path) });
const q = pick("route?", ["a", "b", "c"], { id: "route" });
const gate = engine.gate({ id: "route", question: q, policy: { actAbove: 0.9 } });
for (let i = 0; i < 60; i++) {
  const r = await gate.ask(`state ${i}`);
  await engine.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
}
const cli = JSON.parse((await report([path, "--gate", "route", "--json"])).output) as {
  gates: { grade: { kind: string } }[];
};
console.log(
  `1. same ledger, defaults: Gate.report() grade ${(await gate.report()).grade.kind}; ratchet report grade ${cli.gates[0]?.grade.kind}`,
);

// 2. A profile whose bar is 0.97 at a 90% promise.
const donorPath = join(dir, "donor.jsonl");
const donor = new Engine({ oracle: at(0.97), ledger: new JsonlLedger(donorPath) });
const dq = pick("donor?", ["a", "b", "c"], { id: "donor" });
donor.gate({ id: "donor", question: dq, policy: { actAbove: 0.9 } });
for (let i = 0; i < 60; i++) {
  const r = await donor.ask(`donor ${i}`, dq, { policy: { actAbove: 0.9 } });
  await donor.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
}
const profile = buildProfile(
  await donor.ledger.all(),
  { model: "fixed-1", kind: "pick" },
  { ledgers: [donorPath] },
);
if (!profile) throw new Error("no profile");
console.log(
  `2. profile bar at 90%: ${profile.bars.find((b) => b.target === 0.9)?.bar}; policyFromProfile(profile, 0.9) = ${JSON.stringify(policyFromProfile(profile, 0.9))}`,
);
console.log(`
Expected: one default promise and support across the engine and the CLI (or each surface
printing the levers it used next to the grade, which the CLI does and Gate.report() does not);
and policyFromProfile refusing or warning when bar + halfWidth >= 1, since that policy acts only
on certainty and its acceptance sample may never fill.`);
