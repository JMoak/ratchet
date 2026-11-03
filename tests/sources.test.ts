import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptanceSample, evaluateAcceptance, resolvePlan } from "../src/acceptance.ts";
import { check } from "../src/cli/check.ts";
import { buildReport, type LedgerReport, report } from "../src/cli/report.ts";
import { Engine } from "../src/engine.ts";
import { isUnselected, scoredFromLedger, scoredWithTruth } from "../src/ledger/calibration.ts";
import { type DecisionRecord, hashState, MemoryLedger } from "../src/ledger/ledger.ts";
import {
  COUNTED_SOURCES,
  DEFAULT_TRUST,
  type FitClass,
  parseSource,
  TRUSTED_SOURCES,
  type TrustClass,
  trustOf,
  trustRegistry,
} from "../src/ledger/sources.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

/** Says yes at a fixed confidence to every judge question, so only the labels vary. */
const fixed = (pYes: number): Oracle => ({
  id: "fixed",
  decide: async (_state, questions) =>
    questions.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
      oracle: "fixed",
      model: "fixed-v1",
      cost: 0,
      latencyMs: 1,
      at: new Date().toISOString(),
    })),
});

// One label route per trust class, plus the two routes that must read as unknown. Moment and
// consequence labels all say the model was wrong, so a fit that read either would lose its bar.
const ROUTES = [
  { name: "blind", source: "review:blind:jordan", correct: true, fits: true, counted: true },
  { name: "census", source: "keywork:person", correct: true, fits: true, counted: true },
  { name: "moment", source: "desk:assisted", correct: false, fits: false, counted: true },
  { name: "consequence", source: "reverted:commit", correct: false, fits: false, counted: false },
  { name: "unsourced", source: undefined, correct: true, fits: true, counted: true },
  { name: "unregistered", source: "sms:reply", correct: true, fits: true, counted: true },
] as const;
const PER_ROUTE = 30;
const GATE = "bash.safe";
const q = judge("Is this command safe to run without asking?", { id: "safe" });

let ledger: MemoryLedger;
let rows: readonly DecisionRecord[] = [];
const routeOf = (name: string): readonly DecisionRecord[] => {
  const route = ROUTES.find((r) => r.name === name);
  return rows.filter((r) => r.outcome !== undefined && r.outcome.source === route?.source);
};

beforeAll(async () => {
  ledger = new MemoryLedger();
  const engine = new Engine({ oracle: fixed(0.9), ledger });
  const gate = engine.gate({ id: GATE, question: q, policy: { actAbove: 0.8 } });
  for (const route of ROUTES) {
    for (let i = 0; i < PER_ROUTE; i++) {
      const r = await gate.ask(`${route.name} ${i}`);
      // One label date for every route, so routes that read alike grade alike to the day.
      await engine.label(r.recordId, {
        at: "2026-10-30T00:00:00.000Z",
        correct: route.correct,
        truth: route.correct,
        ...(route.source !== undefined ? { source: route.source } : {}),
      });
    }
  }
  rows = await ledger.all();
});

describe("label sources", () => {
  it("parses <channel>:<kind>[:<name>] and nothing looser", () => {
    expect(parseSource("review:blind")).toEqual({ channel: "review", kind: "blind" });
    expect(parseSource("review:blind:jordan:late")).toEqual({
      channel: "review",
      kind: "blind",
      name: "jordan:late",
    });
    for (const bad of ["person", ":blind", "review:", "review::jordan", "review:blind:"]) {
      expect(parseSource(bad), bad).toBeUndefined();
    }
  });

  it("classifies every source the trust table names", () => {
    const table: Readonly<Record<string, TrustClass>> = {
      "review:blind": "blind",
      "review:blind:jordan": "blind",
      "keywork:person": "census",
      "claude-code:person": "census",
      "codex:person": "census",
      "desk:assisted": "moment",
      "accepted:merge": "consequence",
      "reverted:commit": "consequence",
      "silence:24h": "consequence",
    };
    for (const [source, cls] of Object.entries(table)) expect(trustOf(source), source).toBe(cls);
  });

  it("reads no source, an unregistered prefix or a malformed one as unknown", () => {
    for (const source of [undefined, "sms:reply", "review:quick", "person", "reverted"]) {
      expect(trustOf(source), String(source)).toBe("unknown");
    }
  });

  it("lays extensions over the defaults, an exact kind before its channel's wildcard", () => {
    const registry = trustRegistry({
      "desk:assisted": "census",
      "sms:*": "moment",
      "reverted:manual": "blind",
    });
    expect(trustOf("desk:assisted", registry)).toBe("census");
    expect(trustOf("sms:reply:jordan", registry)).toBe("moment");
    expect(trustOf("reverted:manual", registry)).toBe("blind");
    expect(trustOf("reverted:commit", registry)).toBe("consequence");
    expect(trustOf("desk:assisted")).toBe("moment");
    expect(trustRegistry()).toBe(DEFAULT_TRUST);
    expect(() => trustRegistry({ desk: "census" })).toThrow(/<channel>:<kind>/);
    expect(() => trustRegistry({ "review:blind:jordan": "blind" })).toThrow(/<channel>:<kind>/);
    expect(() =>
      trustRegistry({ "desk:assisted": "trusted" } as unknown as Record<string, TrustClass>),
    ).toThrow(/must be one of/);
  });
});

describe("trust in fitting", () => {
  it("reads each class into scoring, the unselected slice and fitting as the table says", () => {
    for (const route of ROUTES) {
      const mine = routeOf(route.name);
      const fit = route.fits ? PER_ROUTE : 0;
      expect(mine, route.name).toHaveLength(PER_ROUTE);
      expect(scoredFromLedger(mine), route.name).toHaveLength(fit);
      expect(scoredFromLedger(mine, { unselectedOnly: true }), route.name).toHaveLength(fit);
      expect(scoredWithTruth(mine), route.name).toHaveLength(fit);
      expect(
        mine.filter((r) => isUnselected(r)),
        route.name,
      ).toHaveLength(fit);
      expect(scoredFromLedger(mine, { sources: COUNTED_SOURCES }), route.name).toHaveLength(
        route.counted ? PER_ROUTE : 0,
      );
    }
  });

  it("counts consequence labels in their own column and fits the bar on trusted labels alone", async () => {
    const engine = new Engine({ oracle: fixed(0.9), ledger });
    const opts = { targetAccuracy: 0.95, minSupport: 20 };
    const all = await engine.report(opts);
    const g = all.byGate[GATE];
    expect(all.labelled).toBe(5 * PER_ROUTE);
    expect(all.consequence).toBe(PER_ROUTE);
    expect(g).toMatchObject({
      n: 6 * PER_ROUTE,
      labelled: 5 * PER_ROUTE,
      unselected: 4 * PER_ROUTE,
      consequence: PER_ROUTE,
      fittedFrom: "unselected",
      fitted: { threshold: 0.9, accuracy: 1, n: 4 * PER_ROUTE },
    });
    // Moment labels still grade the oracle: 120 right of 150.
    expect(g?.accuracy).toBeCloseTo(0.8, 12);

    // Reclassify the moment route as census and its wrong labels reach the fit.
    const lever = new Engine({
      oracle: fixed(0.9),
      ledger,
      labelTrust: { "desk:assisted": "census" },
    });
    const moved = (await lever.report(opts)).byGate[GATE];
    expect(moved?.unselected).toBe(5 * PER_ROUTE);
    expect(moved?.fitted).toBeUndefined();
  });

  it("an unregistered prefix reads exactly as an unsourced label", () => {
    const opts = { target: 0.95, minSupport: 20 };
    const sms = buildReport("x", routeOf("unregistered"), opts).gates[0];
    const none = buildReport("x", routeOf("unsourced"), opts).gates[0];
    expect(sms).toBeDefined();
    expect(sms).toEqual(none);
    expect(sms).toMatchObject({ labelled: PER_ROUTE, unselected: PER_ROUTE, consequence: 0 });
  });
});

/** Acts the policy took, each labelled right, the acceptance test's raw material. */
function acts(n: number, source: (i: number) => string | undefined): DecisionRecord[] {
  return rows
    .filter((r) => r.outcome?.source === undefined)
    .slice(0, n)
    .map((r, i) => {
      const s = source(i);
      return {
        ...r,
        outcome: {
          at: r.at,
          correct: true,
          truth: true,
          ...(s !== undefined ? { source: s } : {}),
        },
      };
    });
}

describe("trust in acceptance", () => {
  // A promise of 50% at 95% needs 5 clean acts.
  const plan = resolvePlan({ target: 0.5 });

  it("reads blind, census and unsourced labels, and an untrusted label leaves its act unread", () => {
    expect(plan.sampleSize).toBe(5);
    for (const route of ROUTES) {
      const sample = acts(plan.sampleSize, () => route.source);
      const result = evaluateAcceptance(sample, plan);
      if (route.fits) expect(result.status, route.name).toBe("accepted");
      else {
        expect(result, route.name).toMatchObject({
          status: "awaiting-labels",
          unlabelled: plan.sampleSize,
          untrusted: plan.sampleSize,
        });
      }
    }
  });

  it("never lets a label's source choose the sample", () => {
    const mixed = acts(8, (i) => (i < 2 ? "reverted:commit" : "review:blind"));
    const bare = mixed.map(({ outcome: _outcome, ...r }) => r);
    expect(acceptanceSample(mixed, plan).map((r) => r.id)).toEqual(
      acceptanceSample(bare, plan).map((r) => r.id),
    );
    expect(evaluateAcceptance(mixed, plan)).toMatchObject({
      status: "awaiting-labels",
      unlabelled: 2,
      untrusted: 2,
    });
  });

  it("reads through a registry and a narrower plan", () => {
    const moment = acts(5, () => "desk:assisted");
    const census = trustRegistry({ "desk:assisted": "census" });
    expect(evaluateAcceptance(moment, plan, census).status).toBe("accepted");
    const blindOnly = resolvePlan({ target: 0.5, sources: ["blind"] });
    expect(
      evaluateAcceptance(
        acts(5, () => "keywork:person"),
        blindOnly,
      ).status,
    ).toBe("awaiting-labels");
    expect(
      evaluateAcceptance(
        acts(5, () => "review:blind"),
        blindOnly,
      ).status,
    ).toBe("accepted");
  });

  it("keeps a default plan's hash and refuses consequence labels outright", () => {
    const legacy = { target: 0.98, confidence: 0.95, maxErrors: 0, sampleSize: 149, group: null };
    expect(resolvePlan({ target: 0.98 }).hash).toBe(hashState(JSON.stringify(legacy)));
    expect(resolvePlan({ target: 0.98, sources: ["unknown", "census", "blind", "blind"] })).toEqual(
      resolvePlan({ target: 0.98 }),
    );
    expect(resolvePlan({ target: 0.98 }).sources).toEqual(TRUSTED_SOURCES);
    expect(resolvePlan({ target: 0.98, sources: ["blind"] }).hash).not.toBe(
      resolvePlan({ target: 0.98 }).hash,
    );
    const as = (s: readonly string[]) => s as unknown as readonly FitClass[];
    expect(() => resolvePlan({ target: 0.98, sources: as(["consequence"]) })).toThrow(
      /never feed acceptance/,
    );
    expect(() => resolvePlan({ target: 0.98, sources: as(["trusted"]) })).toThrow(/unknown trust/);
    expect(() => resolvePlan({ target: 0.98, sources: [] })).toThrow(/at least one/);
  });

  it("a gate's rollout reads labels through its engine's labelTrust", async () => {
    const run = async (labelTrust?: Record<string, TrustClass>) => {
      const engine = new Engine({ oracle: fixed(0.97), ...(labelTrust ? { labelTrust } : {}) });
      const gate = engine.gate({
        id: "deploy.ok",
        question: judge("Is this deploy safe?", { id: "deploy" }),
        policy: { actAbove: 0.8 },
        evidenceVersion: "v1",
        promisedAccuracy: 0.5,
      });
      await gate.rollout.evaluate();
      for (let i = 0; i < 5; i++) {
        const r = await gate.ask(`deploy ${i}`);
        await engine.label(r.recordId, { correct: true, truth: true, source: "desk:assisted" });
      }
      return gate.rollout.evaluate();
    };
    const held = await run();
    expect(held).toMatchObject({ mode: "shadow", acceptance: { status: "awaiting-labels" } });
    expect(held.reason).toContain(
      "5 of them carry only labels from sources the plan does not read",
    );
    expect(await run({ "desk:assisted": "census" })).toMatchObject({
      mode: "enforce",
      acceptance: { status: "accepted", errors: 0 },
    });
  });
});

describe("--trust", () => {
  let dir = "";
  let path = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratchet-sources-"));
    path = join(dir, "ledger.jsonl");
    await writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("report and check take repeatable <prefix>=<class> entries laid over the defaults", async () => {
    const json = async (...extra: string[]) => {
      const r = await report([path, "--json", "--target", "0.95", "--min-support", "20", ...extra]);
      expect(r.exitCode).toBe(0);
      return JSON.parse(r.output) as LedgerReport;
    };
    const plain = await json();
    expect(plain.labelTrust).toBeUndefined();
    expect(plain.gates[0]).toMatchObject({ labelled: 150, unselected: 120, consequence: 30 });
    const moved = await json("--trust", "desk:assisted=census", "--trust=reverted:*=unknown");
    expect(moved.labelTrust).toEqual({ "desk:assisted": "census", "reverted:*": "unknown" });
    expect(moved.gates[0]).toMatchObject({ labelled: 180, unselected: 180, consequence: 0 });
    expect(moved.gates[0]?.fitted).toBeUndefined();

    const md = await report([path, "--trust", "desk:assisted=census"]);
    expect(md.output).toContain("| consequence |");
    expect(md.output).toContain("Label sources read with --trust: desk:assisted=census.");

    const args = [path, "--gate", GATE, "--promise", "0.9"];
    const pass = await check(args);
    expect(pass.exitCode).toBe(0);
    expect(pass.output).toContain("on 120 shadow acted rows");
    const fail = await check([...args, "--trust", "desk:assisted=census"]);
    expect(fail.exitCode).toBe(1);
    expect(fail.output).toContain("on 150 shadow acted rows");
    expect(fail.output).toContain("trust desk:assisted=census");
  });

  it("rejects a malformed entry, an unknown class or a prefix given twice with exit 2", async () => {
    for (const entry of [
      ["--trust", "desk=census"],
      ["--trust", "desk:assisted=trusted"],
      ["--trust", "desk:assisted"],
      ["--trust", "=census"],
      ["--trust", "a:b=census", "--trust", "a:b=blind"],
      ["--trust"],
    ]) {
      const r = await report([path, ...entry]);
      expect(r.exitCode, entry.join(" ")).toBe(2);
      expect(r.output, entry.join(" ")).toContain("--trust");
    }
    expect(
      (await check([path, "--gate", GATE, "--promise", "0.9", "--trust", "x=y"])).exitCode,
    ).toBe(2);
  });
});
