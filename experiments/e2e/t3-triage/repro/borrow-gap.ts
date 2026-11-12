/**
 * Repro T3: a gate that borrows a profile's bar loses it, and grades `none`, once it has
 * `minSupport` labelled rows of its own (a point-estimate fitted bar) but fewer than
 * `minEstimated` (an estimate). With the engine's defaults (minSupport 20, minEstimated 30) the
 * walk is borrowed -> none -> estimated; the CLI's defaults (30 and 30) hide it, so the engine
 * and `ratchet report` disagree on the same ledger at 20 to 29 labels.
 *
 *   bun experiments/e2e/t3-triage/repro/borrow-gap.ts
 *
 * Deterministic: a fixed-answer oracle, no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "../../../../src/cli/main.ts";
import { Engine } from "../../../../src/engine.ts";
import { describeGrade } from "../../../../src/ledger/evidence.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { buildProfile } from "../../../../src/ledger/profile.ts";
import { policyFromProfile } from "../../../../src/policy.ts";
import { pick, pickVerdictFrom } from "../../../../src/questions.ts";
import type { Oracle, PickQuestion } from "../../../../src/types.ts";

const MODEL = "fixed-model-1";
/** Answers option "a" at 0.97 on every question: always right, since every truth is "a". */
const oracle: Oracle = {
  id: "fixed",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: pickVerdictFrom(q as PickQuestion, [0.97, 0.02, 0.01]),
      oracle: "fixed",
      model: MODEL,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "t3-borrow-gap-"));
const donorPath = join(dir, "donor.jsonl");
const donor = new Engine({ oracle, ledger: new JsonlLedger(donorPath) });
const dq = pick("donor question", ["a", "b", "c"], { id: "donor" });
donor.gate({ id: "donor", question: dq, policy: { actAbove: 0.9 } });
for (let i = 0; i < 120; i++) {
  const r = await donor.ask(`donor state ${i}`, dq, { policy: { actAbove: 0.9 } });
  await donor.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
}
const profile = buildProfile(
  await donor.ledger.all(),
  { model: MODEL, kind: "pick" },
  { ledgers: [donorPath] },
);
if (!profile) throw new Error("no profile");
const profilePath = join(dir, "profile.json");
await Bun.write(profilePath, JSON.stringify(profile));

const path = join(dir, "sibling.jsonl");
const engine = new Engine({ oracle, ledger: new JsonlLedger(path), profiles: [profile] });
const q = pick("sibling question", ["a", "b", "c"], { id: "sib" });
const gate = engine.gate({
  id: "sib",
  question: q,
  policy: policyFromProfile(profile, 0.9),
  barSource: { profileHash: profile.hash },
});
const ids: string[] = [];
for (let i = 0; i < 40; i++) ids.push((await gate.ask(`sibling state ${i}`)).recordId);

let labelled = 0;
for (const k of [0, 19, 20, 25, 29, 30]) {
  while (labelled < k)
    await engine.label(ids[labelled++] as string, {
      correct: true,
      truth: "a",
      source: "review:blind",
    });
  const engineGrade = (await gate.report({ targetAccuracy: 0.9 })).grade; // engine default minSupport 20
  const cli = JSON.parse(
    (await report([path, "--gate", "sib", "--target", "0.9", "--profile", profilePath, "--json"]))
      .output,
  ) as { gates: { grade: { kind: string } }[] };
  console.log(
    `${String(k).padStart(2)} labels: engine ${engineGrade.kind.padEnd(9)} | ratchet report ${cli.gates[0]?.grade.kind}`,
  );
  if (k === 20) console.log(`           engine says: ${describeGrade(engineGrade)}`);
}
console.log(`
Expected (the claim under test: a profile gives a conservative cold-start bar that the gate's
own rows only tighten): borrowed until the gate has a grade of its own (estimated at 30), on
every surface.
Observed: the engine drops the borrowed bar at 20 labels, when fitThreshold's point estimate
first finds a bar on 20 rows, and grades none until 30; ratchet report (min-support 30) stays
borrowed. src/engine.ts summarize(): "fitted === undefined" decides lending; so does
src/cli/common.ts gradeGroup() with its own minSupport.`);

// Part two: the bar that replaces the borrowed one is a point estimate, so 20 rows can loosen it.
// A sibling that answers at 0.70 and is right 19 times in 20 gets a fitted bar of 0.70 at a 90%
// promise (the borrowed bar was 0.97, read with a 95% Wilson lower bound); the Wilson lower
// bound of 19/20 is 0.76, so on the profile's own rule that bar would not exist.
const loosePath = join(dir, "loose.jsonl");
const looseOracle: Oracle = {
  id: "loose",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: pickVerdictFrom(q as PickQuestion, [0.7, 0.2, 0.1]),
      oracle: "loose",
      model: MODEL,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
};
const loose = new Engine({
  oracle: looseOracle,
  ledger: new JsonlLedger(loosePath),
  profiles: [profile],
});
const lq = pick("loose question", ["a", "b", "c"], { id: "loose" });
const lg = loose.gate({
  id: "loose",
  question: lq,
  policy: policyFromProfile(profile, 0.9),
  barSource: { profileHash: profile.hash },
});
for (let i = 0; i < 20; i++) {
  const r = await lg.ask(`loose state ${i}`);
  await loose.label(r.recordId, {
    correct: i !== 7,
    truth: i !== 7 ? "a" : "b",
    source: "review:blind",
  });
}
const lr = await lg.report({ targetAccuracy: 0.9 });
const { wilsonLower } = await import("../../../../src/ledger/calibration.ts");
console.log(`
loose sibling, 19 of 20 right at confidence 0.70: engine fitted bar ${lr.fitted?.threshold} (fitted on ${lr.fittedFrom}), grade ${lr.grade.kind};
profile bar for the same promise ${profile.bars.find((b) => b.target === 0.9)?.bar}; Wilson lower bound of 19/20 = ${wilsonLower(0.95, 20).toFixed(3)}`);
