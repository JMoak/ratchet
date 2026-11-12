import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LedgerReport, report } from "../src/cli/report.ts";
import { Engine } from "../src/engine.ts";
import { describeActBar, fitActBar } from "../src/ledger/bars.ts";
import { REPORT_DEFAULTS } from "../src/ledger/evidence.ts";
import { JsonlLedger, MemoryLedger } from "../src/ledger/ledger.ts";
import { buildProfile } from "../src/ledger/profile.ts";
import { policyFromProfile } from "../src/policy.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle, PickQuestion } from "../src/types.ts";

/** A judge oracle whose p(yes) is a function of the state. */
const judgeOracle = (pOf: (state: string) => number, model = "m-1"): Oracle => ({
  id: "fixed",
  async decide(state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pOf(state)),
      oracle: "fixed",
      model,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});

/** A pick oracle that always leads with "a" at `c`. */
const pickOracle = (c: number, model = "fixed-model-1"): Oracle => ({
  id: "fixed",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: pickVerdictFrom(q as PickQuestion, [c, (1 - c) / 2, (1 - c) / 2]),
      oracle: "fixed",
      model,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-c-bar-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a judge gate's bar is an act bar (e2e T1-06, T2-04)", () => {
  // The verifier repro: 50 outputs passed at p 0.95 (40 truly good), 150 rejected at 0.10 (all
  // bad). The leading answer is right 190 of 200 times above 0.9, so the old two-sided fit put
  // the bar at 0.9 for 95%; acting at p(yes) >= 0.9 delivered 40 of 50, 80%.
  const verifier = async (goIsYes: boolean) => {
    const pOf = (s: string) => (s.startsWith("pass") ? 0.95 : 0.1);
    const engine = new Engine({
      oracle: judgeOracle((s) => (goIsYes ? pOf(s) : 1 - pOf(s))),
      ledger: new MemoryLedger(),
    });
    const gate = engine.gate({
      id: "out.verify",
      question: judge("Does the output satisfy the request?", { id: "out.ok" }),
      policy: { actAbove: 0.9, goIsYes },
    });
    const items = [
      ...Array.from({ length: 50 }, (_, i) => ({ s: `pass ${i}`, good: i < 40 })),
      ...Array.from({ length: 150 }, (_, i) => ({ s: `fail ${i}`, good: false })),
    ];
    for (const it of items) {
      const r = await gate.ask(it.s);
      // With goIsYes false the question asks the opposite, so its truth is the opposite too.
      const truth = goIsYes ? it.good : !it.good;
      await engine.label(r.recordId, {
        correct: r.decision.verdict.pYes >= 0.5 === truth,
        truth,
        source: "review:blind",
      });
    }
    return gate.report({ targetAccuracy: 0.95, minSupport: 20 });
  };

  it("finds no bar where no bar keeps the promise acting", async () => {
    for (const goIsYes of [true, false]) {
      const rep = await verifier(goIsYes);
      // Leading-answer accuracy is still reported as it was: 190 of 200.
      expect(rep.accuracy).toBeCloseTo(0.95, 12);
      expect(rep.fitted, `goIsYes ${goIsYes}`).toBeUndefined();
      expect(rep.pointFitted, `goIsYes ${goIsYes}`).toBeUndefined();
      expect(rep.fittedFrom).toBe("unselected");
    }
  });

  it("puts a bar where acting keeps the promise, on the side the policy acts on", async () => {
    // 120 acts at go 0.97, all right; 80 holds at go 0.6, half right. Read with goIsYes false,
    // so the bar sits on 1 - p(yes), which is what actAbove reads.
    const engine = new Engine({
      oracle: judgeOracle((s) => (s.startsWith("sure") ? 0.03 : 0.4)),
    });
    const gate = engine.gate({
      id: "publish",
      question: judge("Does this post need moderation?", { id: "needs" }),
      policy: { actAbove: 0.9, goIsYes: false },
    });
    for (let i = 0; i < 200; i++) {
      const sure = i < 120;
      const r = await gate.ask(`${sure ? "sure" : "unsure"} ${i}`);
      const needs = sure ? false : i % 2 === 0;
      await engine.label(r.recordId, {
        correct: r.decision.verdict.pYes >= 0.5 === needs,
        truth: needs,
        source: "review:blind",
      });
    }
    const rep = await gate.report({ targetAccuracy: 0.95, minSupport: 30 });
    expect(rep.fitted?.threshold).toBeCloseTo(0.97, 12);
    expect(rep.fitted?.n).toBe(120);
    expect(rep.fitted?.accuracy).toBe(1);
    // Acting at the bar on these rows keeps the promise.
    const rows = await engine.ledger.all();
    const acts = rows.filter((r) => r.go >= (rep.fitted?.threshold ?? 2));
    expect(acts.every((r) => r.outcome?.truth === false)).toBe(true);
  });
});

describe("the conservative bar beside the point bar (e2e T1-01)", () => {
  it("keeps a point bar a lucky run clears out of actAbove, and says why", async () => {
    // 19 right of 20 at 0.70 clears 90% as a point estimate; its Wilson lower bound is 0.76.
    const engine = new Engine({ oracle: pickOracle(0.7) });
    const q = pick("route?", ["a", "b", "c"], { id: "route" });
    const gate = engine.gate({ id: "route", question: q, policy: { actAbove: 0.9 } });
    for (let i = 0; i < 20; i++) {
      const r = await gate.ask(`state ${i}`);
      await engine.label(r.recordId, { correct: i !== 7, truth: i !== 7 ? "a" : "b" });
    }
    const rep = await gate.report({ targetAccuracy: 0.9, minSupport: 20 });
    expect(rep.pointFitted?.threshold).toBe(0.7);
    expect(rep.fitted).toBeUndefined();
    const text = describeActBar(rep, rep.levers);
    expect(text).toMatch(/^no act bar: too few rows for one at 90\.0%/);
    expect(text).toContain("the point estimate clears it above 0.700");
    // The lower end of the two-sided 95% interval: a one-sided 97.5% bound.
    expect(text).toContain("the lower end of its 95% interval is 76.4%");
  });

  it("acts on a bar whose lower bound clears the promise, and prints both in the CLI", async () => {
    const path = join(dir, "sure.jsonl");
    const engine = new Engine({ oracle: pickOracle(0.97), ledger: new JsonlLedger(path) });
    const q = pick("route?", ["a", "b", "c"], { id: "route" });
    const gate = engine.gate({ id: "route", question: q, policy: { actAbove: 0.9 } });
    for (let i = 0; i < 100; i++) {
      const r = await gate.ask(`state ${i}`);
      await engine.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
    }
    const rep = await gate.report({ targetAccuracy: 0.95, minSupport: 30 });
    expect(rep.fitted).toMatchObject({ threshold: 0.97, n: 100, accuracy: 1 });
    expect(rep.pointFitted?.threshold).toBe(0.97);
    const md = (await report([path, "--target", "0.95"])).output;
    expect(md).toContain("| act bar | point |");
    expect(md).toContain("## Act bars");
    expect(md).toMatch(/- route: act above 0\.970: acting was right on 100\.0% of the 100 rows/);
    // The library fit and the report agree.
    expect(fitActBar(await engine.ledger.all(), { target: 0.95, minSupport: 30 }).fitted).toEqual(
      rep.fitted,
    );
  });
});

describe("one set of default levers (e2e T3-04)", () => {
  it("grades one ledger the same in Gate.report() and ratchet report, and says with what", async () => {
    // Sixty clean acts complete a 95% plan (59) and fall short of a 98% one (149): before, the
    // engine read 95% by default and said measured, the CLI 98% and said estimated.
    const path = join(dir, "levers.jsonl");
    const engine = new Engine({ oracle: pickOracle(0.97), ledger: new JsonlLedger(path) });
    const q = pick("route?", ["a", "b", "c"], { id: "route" });
    const gate = engine.gate({ id: "route", question: q, policy: { actAbove: 0.9 } });
    for (let i = 0; i < 60; i++) {
      const r = await gate.ask(`state ${i}`);
      await engine.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
    }
    const api = await gate.report();
    const cli = JSON.parse(
      (await report([path, "--gate", "route", "--json"])).output,
    ) as LedgerReport;
    expect(api.grade).toEqual(cli.gates[0]?.grade);
    expect(api.grade.kind).toBe("estimated");
    expect(api.levers).toEqual(REPORT_DEFAULTS);
    expect([cli.target, cli.minSupport, cli.minEstimated]).toEqual([
      REPORT_DEFAULTS.target,
      REPORT_DEFAULTS.minSupport,
      REPORT_DEFAULTS.minEstimated,
    ]);
    expect((await engine.report()).byGate.route?.grade).toEqual(api.grade);
  });
});

describe("a profile lends until the gate's own labels grade it (e2e T3-03)", () => {
  it("never drops from borrowed to none at 20 to 29 labels, on any surface", async () => {
    const donorPath = join(dir, "donor.jsonl");
    const donor = new Engine({ oracle: pickOracle(0.97), ledger: new JsonlLedger(donorPath) });
    const dq = pick("donor question", ["a", "b", "c"], { id: "donor" });
    for (let i = 0; i < 120; i++) {
      const r = await donor.ask(`donor state ${i}`, dq, { policy: { actAbove: 0.9 } });
      await donor.label(r.recordId, { correct: true, truth: "a", source: "review:blind" });
    }
    const profile = buildProfile(
      await donor.ledger.all(),
      { model: "fixed-model-1", kind: "pick" },
      { ledgers: [donorPath] },
    );
    if (!profile) throw new Error("no profile");
    const profilePath = join(dir, "profile.json");
    await writeFile(profilePath, JSON.stringify(profile));

    const path = join(dir, "sibling.jsonl");
    const engine = new Engine({
      oracle: pickOracle(0.97),
      ledger: new JsonlLedger(path),
      profiles: [profile],
    });
    const gate = engine.gate({
      id: "sib",
      question: pick("sibling question", ["a", "b", "c"], { id: "sib" }),
      policy: policyFromProfile(profile, 0.9),
      barSource: { profileHash: profile.hash },
    });
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await gate.ask(`sibling state ${i}`)).recordId);
    let labelled = 0;
    const seen: string[] = [];
    for (const k of [0, 19, 20, 25, 29, 30]) {
      while (labelled < k) {
        await engine.label(ids[labelled++] as string, {
          correct: true,
          truth: "a",
          source: "review:blind",
        });
      }
      // The engine with its old default support of 20, and the CLI with its 30.
      const api = (await gate.report({ targetAccuracy: 0.9, minSupport: 20 })).grade;
      const out = (
        await report([path, "--gate", "sib", "--target", "0.9", "--profile", profilePath, "--json"])
      ).output;
      const cli = (JSON.parse(out) as LedgerReport).gates[0]?.grade;
      expect(api).toEqual(cli);
      seen.push(api.kind);
    }
    expect(seen).toEqual(["borrowed", "borrowed", "borrowed", "borrowed", "borrowed", "estimated"]);
  });
});
