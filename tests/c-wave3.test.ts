import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkGate } from "../src/cli/check.ts";
import { describeHealth, groupGates, readLedgerRows } from "../src/cli/common.ts";
import { buildReport, renderReport } from "../src/cli/report.ts";
import { trail } from "../src/cli/trail.ts";
import { poolJudge, poolPick, poolWeights } from "../src/compound/aggregate.ts";
import { fitLogistic } from "../src/compound/learned.ts";
import { Engine } from "../src/engine.ts";
import { describeBattery } from "../src/ledger/bars.ts";
import { borrowFor } from "../src/ledger/borrow.ts";
import { memberCorrelation, modelFamily } from "../src/ledger/calibration.ts";
import {
  currentConfiguration,
  describeGrade,
  gradeOf,
  strayQuestions,
} from "../src/ledger/evidence.ts";
import { type DecisionRecord, MemoryLedger } from "../src/ledger/ledger.ts";
import { buildProfile } from "../src/ledger/profile.ts";
import { rng } from "../src/math.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../src/questions.ts";
import { relevance } from "../src/recipes/screen.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../src/types.ts";

const v = (p: number): JudgeVerdict => judgeVerdictFrom(judge("q?", { id: "q" }), p);
const logit = (p: number) => Math.log(p / (1 - p));

const fixed = (pOf: (q: string) => number, model = "m-1"): Oracle => ({
  id: "fixed",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pOf(q.id)),
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
  dir = await mkdtemp(join(tmpdir(), "ratchet-c-wave3-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a correlation matrix never pools more evidence than the members hold (wave 3, G0/G)", () => {
  it("drops a member the others account for and solves again (the measured G0 matrix)", () => {
    // A generalist wrong wherever either of two specialists is; the specialists never together.
    const at = "2026-11-12T00:00:00.000Z";
    const member = (key: string, right: boolean) => ({
      key,
      oracle: key,
      model: `vendor/${key}`,
      cost: 0,
      latencyMs: 0,
      verdict: {
        kind: "judge" as const,
        questionId: "q",
        pYes: right ? 0.9 : 0.1,
        confidence: 0.9,
      },
    });
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      at,
      failedOpen: false,
      mode: "shadow",
      tags: [],
      verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
      members: [member("a", i >= 20), member("b", i >= 10), member("c", !(i >= 10 && i < 20))],
      outcome: { at, correct: true, truth: true },
    })) as unknown as DecisionRecord[];
    const mc = memberCorrelation(rows);
    const opts = { correlations: mc.matrix ?? {}, memberKeys: ["a", "b", "c"] };
    const w = poolWeights(3, opts);
    // Before: weights 0, 3, 3 and 6 effective members of 3.
    expect(w.weights[0]).toBe(0);
    expect(w.weights[1]).toBeCloseTo(1, 12);
    expect(w.weights[2]).toBeCloseTo(1, 12);
    expect(w.effectiveN).toBeCloseTo(2, 12);
    const pooled = poolJudge([v(0.8), v(0.8), v(0.8)], opts).pYes;
    expect(pooled).toBeLessThan(poolJudge([v(0.8), v(0.8), v(0.8)]).pYes);
  });

  it("matches non-negative GLS on matrices that are not positive definite", () => {
    const keys = ["a", "b", "c"];
    const notPsd = poolWeights(3, { correlations: { a: { b: 0.99, c: 0.99 } }, memberKeys: keys });
    expect(notPsd.effectiveN).toBeCloseTo(2 / 1.99, 9);
    const suppressor = poolWeights(3, {
      correlations: { a: { b: 0.7, c: 0.7 }, b: { c: 0 } },
      memberKeys: keys,
    });
    expect(suppressor.weights).toEqual([0, 1, 1]);
  });

  it("property: for any non-negative matrix, weights in [0, 1], n_eff <= n, never NaN, never more confident than at rho 0", () => {
    const rand = rng(20261112);
    for (let trial = 0; trial < 400; trial++) {
      const n = 2 + Math.floor(rand() * 5);
      const keys = Array.from({ length: n }, (_, i) => `m${i}`);
      const matrix: Record<string, Record<string, number>> = {};
      for (let i = 0; i < n; i++) {
        const row: Record<string, number> = {};
        for (let j = i + 1; j < n; j++) {
          // Mostly arbitrary, often near 1, sometimes exactly 0 or 1: rarely a correlation matrix.
          const u = rand();
          row[`m${j}`] = u < 0.1 ? 0 : u > 0.9 ? 1 : u;
        }
        matrix[`m${i}`] = row;
      }
      const opts = { correlations: matrix, memberKeys: keys };
      const w = poolWeights(n, opts);
      expect(w.weights.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
      expect(w.effectiveN).toBeLessThanOrEqual(n + 1e-9);
      // Answers on one side, then answers that disagree.
      const same = keys.map(() => 0.55 + 0.44 * rand());
      const mixed = keys.map(() => 0.01 + 0.98 * rand());
      for (const ps of [same, mixed]) {
        const p = poolJudge(ps.map(v), opts).pYes;
        const independent = poolJudge(ps.map(v)).pYes;
        expect(Number.isFinite(p)).toBe(true);
        expect(Math.abs(logit(p))).toBeLessThanOrEqual(Math.abs(logit(independent)) + 1e-9);
      }
      // A pick pooled with the matrix is no more confident than at rho 0 either.
      const q = pick("route?", ["a", "b", "c"], { id: "r" });
      const vs = keys.map(() => {
        const a = rand();
        const b = rand() * (1 - a);
        return pickVerdictFrom(q, [a, b, 1 - a - b]);
      });
      const out = poolPick(q, vs, opts);
      expect(Number.isFinite(out.confidence)).toBe(true);
      expect(out.confidence).toBeLessThanOrEqual(poolPick(q, vs).confidence + 1e-9);
    }
  });
});

describe("the configuration is matched per question, the evidence version per gate (wave 3, A1/A6)", () => {
  it("keeps every question of a gate current under its own policy", async () => {
    // A6: two questions asked together, each with a policy of its own.
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: fixed(() => 0.96), ledger });
    const g = e.gate({ id: "pair", question: judge("x?", { id: "x" }), policy: { actAbove: 0.9 } });
    const qs = [judge("Is it safe?", { id: "safe" }), judge("Is it in scope?", { id: "scope" })];
    for (let i = 0; i < 20; i++) {
      await g.askAll(`s ${i}`, qs, (q) => ({ policy: { actAbove: q.id === "safe" ? 0.95 : 0.8 } }));
    }
    const { current, older } = currentConfiguration(await ledger.all());
    expect([current.length, older.length]).toEqual([40, 0]);
  });

  it("retires a renamed question's rows once the evidence version moves, and says so", async () => {
    // A1: a rubric edit that renames its question id is a new question; its old rows stay
    // current until the gate's evidence version is bumped, as the docs say to do.
    const run = async (bump: boolean) => {
      const ledger = new MemoryLedger();
      const old = new Engine({ oracle: fixed(() => 0.97), ledger });
      const g1 = old.gate({
        id: "g",
        question: judge("Safe to run?", { id: "safe.v1" }),
        policy: { actAbove: 0.9 },
        evidenceVersion: "v1",
      });
      for (let i = 0; i < 40; i++) {
        const r = await g1.ask(`old ${i}`);
        await old.label(r.recordId, { correct: true, truth: true });
      }
      const now = new Engine({ oracle: fixed(() => 0.95), ledger });
      const g2 = now.gate({
        id: "g",
        question: judge("Would the user probably not mind this?", { id: "safe.v2" }),
        policy: { actAbove: 0.9 },
        evidenceVersion: bump ? "v2" : "v1",
      });
      for (let i = 0; i < 10; i++) await g2.ask(`new ${i}`);
      return gradeOf(await ledger.all());
    };
    expect((await run(false)).kind).toBe("estimated");
    expect(await run(true)).toMatchObject({ kind: "none", older: 40 });
  });
});

describe("modelFamily is the first name token, coarse on purpose (wave 3, F, rounds 1 and 2)", () => {
  it("reads builds, spellings and hosts of one model as one family, and two vendors as two", () => {
    const one = [
      ["typesafe/jev-1.13-instruct", "typesafe/jev-1.14-instruct"],
      ["typesafe/jev-1.13-fp8", "typesafe/jev-1.14-fp8"],
      ["meta-llama/llama-3.1-70b-instruct", "meta-llama/llama-3.1-8b-instruct"],
      ["qwen2.5-72b-instruct", "qwen2.5-7b-instruct-awq"],
      ["mixtral-8x7b-instruct-v0.1", "mixtral-8x22b"],
      // Round 2: false splits that made gates less cautious.
      ["typesafe/jev-1.13", "jev-1.13"],
      ["anthropic/claude-sonnet-4.5", "claude-sonnet-4-5"],
      ["anthropic/claude-3-5-sonnet", "anthropic/claude-sonnet-4.5"],
      ["meta-llama/llama-3.1-70b-instruct", "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo"],
      ["typesafe/jev-1.13", "typesafe/jev-router"],
      ["openai/gpt-4o", "gpt-4o"],
      ["jev113.orig", "jev113.para"],
      ["jev113@openrouter", "typesafe/jev-1.14"],
    ];
    for (const [a, b] of one)
      expect(modelFamily(a ?? ""), `${a} ~ ${b}`).toBe(modelFamily(b ?? ""));
    const two = [
      ["anthropic/claude-haiku-5.5", "typesafe/jev-1.13"],
      ["haiku", "jev"],
      ["openai/gpt-4o", "anthropic/claude-sonnet-4.5"],
      ["google/gemini-2.5-pro", "openai/gpt-4o"],
    ];
    for (const [a, b] of two) {
      expect(modelFamily(a ?? ""), `${a} vs ${b}`).not.toBe(modelFamily(b ?? ""));
    }
    expect(() =>
      gradeOf([], {
        borrowed: {
          type: "disagreement",
          rate: 0.1,
          pairs: 40,
          models: ["typesafe/jev-1.13-instruct", "typesafe/jev-1.14-instruct"],
        },
      }),
    ).toThrow(/two model families/);
  });
});

describe("a partial memberTruths map leaves unnamed members unlabelled (wave 3, M1)", () => {
  it("labels the named member on its own truth and no other", async () => {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: fixed((id) => (id === "spam" ? 0.99 : 0.03)), ledger });
    const gate = e.gate({
      id: "mod",
      question: ["threat", "harass", "spam"].map((id) => judge(`${id}?`, { id })),
      policy: { actAbove: 0.9, goIsYes: false },
      combine: "any",
    });
    for (let i = 0; i < 5; i++) {
      const r = await gate.ask(`spam ${i}`);
      await e.label(r.recordId, { correct: true, truth: true, memberTruths: { spam: true } });
    }
    const rows = await ledger.all();
    const by = (id: string) => rows.filter((r) => r.questionId === id);
    expect(by("spam").every((r) => r.outcome?.correct === true && r.outcome.truth === true)).toBe(
      true,
    );
    // Before, harass took the composite's truth and read wrong on every spam post.
    expect(by("harass").every((r) => r.outcome === undefined)).toBe(true);
    expect(by("threat").every((r) => r.outcome === undefined)).toBe(true);
  });
});

describe("fitLogistic says when no finite fit exists (wave 3, L)", () => {
  it("reports one class and separable rows without a penalty as not converged", () => {
    const one = fitLogistic(Array.from({ length: 20 }, (_, i) => ({ x: [i / 20], y: true })));
    expect([one.converged, one.reason]).toEqual([false, "one class"]);
    // The smoothed frequency, not a bias of 19.2.
    expect(one.bias).toBeCloseTo(Math.log(20.5 / 0.5), 12);
    const sep = Array.from({ length: 40 }, (_, i) => ({ x: [i < 20 ? 0 : 1], y: i >= 20 }));
    const free = fitLogistic(sep, { l2: 0 });
    expect([free.converged, free.reason]).toEqual([false, "separable"]);
    expect(free.weights.every(Number.isFinite)).toBe(true);
    const ridged = fitLogistic(sep);
    expect(ridged.converged).toBe(true);
    expect(ridged.reason).toBeUndefined();
  });
});

describe("the battery readout's advice follows the combiner (wave 3, W1)", () => {
  it("never tells a learned combiner to fit a learned combiner", () => {
    const at = (combine: string) =>
      describeBattery({ combine, verdicts: 100, saturated: 50, share: 0.5 });
    expect(at("learned")).not.toContain("fit a learned combiner");
    expect(at("learned")).toContain("converged");
    expect(at("logodds")).toContain('"any"');
    expect(at("any")).not.toContain(":");
    expect(at("max")).toContain("members themselves");
  });
});

describe("the report's calibration columns read the current configuration (wave 3, item 7)", () => {
  it("counts older rows beside figures that leave them out", async () => {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: fixed(() => 0.9), ledger });
    const g1 = old.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.8 },
    });
    for (let i = 0; i < 30; i++) {
      const r = await g1.ask(`old ${i}`);
      await old.label(r.recordId, { correct: false, truth: false });
    }
    const now = new Engine({ oracle: fixed(() => 0.9), ledger });
    const g2 = now.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.85 },
    });
    for (let i = 0; i < 10; i++) {
      const r = await g2.ask(`new ${i}`);
      await now.label(r.recordId, { correct: true, truth: true });
    }
    const rows = await ledger.all();
    const cli = buildReport("x", rows, {}).gates[0];
    const api = await g2.report();
    for (const r of [cli, api]) {
      expect(r).toMatchObject({ older: 30, labelled: 10, unselected: 10, accuracy: 1 });
    }
    expect(cli?.rows).toBe(40);
    expect(api.n).toBe(40);
  });
});

describe("a profile matched to a pin is stale once the oracle answers off it (wave 3, P3)", () => {
  it("lends the bar marked stale", async () => {
    const donorLedger = new MemoryLedger();
    const donor = new Engine({ oracle: fixed(() => 0.97, "m-A"), ledger: donorLedger });
    const dq = judge("donor?", { id: "donor" });
    for (let i = 0; i < 80; i++) {
      const r = await donor.ask(`d ${i}`, dq, { policy: { actAbove: 0.9 } });
      await donor.label(r.recordId, { correct: true, truth: true });
    }
    const profile = buildProfile(
      await donorLedger.all(),
      { model: "m-A", kind: "judge" },
      { ledgers: ["donor"] },
    );
    if (!profile) throw new Error("no profile");
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: fixed(() => 0.9, "m-B"), ledger });
    for (let i = 0; i < 5; i++)
      await e.ask(`s ${i}`, judge("ok?", { id: "ok" }), { policy: { actAbove: 0.9 } });
    const lent = borrowFor(await ledger.all(), [profile], { target: 0.9, model: "m-A" });
    expect(lent?.stale).toBe(true);
    const g = gradeOf(await ledger.all(), {
      ...(lent ? { borrowed: lent.via, stale: lent.stale } : {}),
    });
    expect(describeGrade(g)).toMatch(/^borrowed \(stale\) as of/);
  });
});

describe("rows whose verdict numbers are not numbers are skipped and counted (wave 3, V1)", () => {
  it("keeps trail from crashing on a string p(yes)", async () => {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: fixed(() => 0.9), ledger });
    for (let i = 0; i < 3; i++)
      await e.ask(`s ${i}`, judge("ok?", { id: "ok" }), { policy: { actAbove: 0.8 } });
    const rows = (await ledger.all()) as unknown as Record<string, unknown>[];
    const bad = {
      ...rows[0],
      id: "bad",
      go: "0.9",
      verdict: { kind: "judge", questionId: "ok", pYes: "0.9", confidence: 0.9 },
    };
    const read = readLedgerRows([...rows, bad]);
    expect([read.rows.length, read.malformed]).toEqual([3, 1]);
    expect(
      describeHealth({ skipped: 0, duplicates: 0, torn: false } as never, read.malformed),
    ).toBe("skipped 1 decision row whose verdict numbers are not numbers.");
    const path = join(dir, "bad.jsonl");
    await writeFile(
      path,
      `${[...rows, bad].map((r) => JSON.stringify({ type: "decision", record: r })).join("\n")}\n`,
    );
    const out = await trail([path]);
    expect(out.exitCode).toBe(0);
    expect(out.output).not.toContain("internal error");
    expect(groupGates(read.rows)).toHaveLength(1);
  });
});

describe("a glued version is cut greedily (wave 3 round 2)", () => {
  it("keeps every letter of the name", () => {
    // The lazy pattern ate the name's last letter: "jev113" read "je", "dev2" read "de".
    expect(modelFamily("jev113")).toBe("jev");
    expect(modelFamily("dev2")).toBe("dev");
    expect(modelFamily("qwen2.5-72b")).toBe("qwen");
    expect(modelFamily("o3-mini")).toBe("o3");
  });
});

describe("a policy the newest request did not use retires its rows (wave 3 round 2, S1)", () => {
  it("loosening a relevance gate whose items are asked once grades nothing on the old labels", async () => {
    const engine = new Engine({ oracle: fixed(() => 0.9), ledger: new MemoryLedger() });
    const gate = engine.gate({
      id: "context.keep",
      question: judge("needed?", { id: "keep" }),
      policy: { actAbove: 0.95 },
    });
    const items = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `item-${from + i}`, summary: `s ${from + i}` }));
    const strict = await relevance(gate, "task", items(0, 40), {
      policy: { actAbove: 0.95 },
      perRequest: 10,
    });
    for (const r of strict.results) await engine.label(r.recordId, { correct: true, truth: true });
    // Every item is asked once, so a per-question rule alone kept the 0.95 labels current.
    await relevance(gate, "task", items(40, 10), { policy: { actAbove: 0.1 }, perRequest: 10 });
    const rows = (await engine.ledger.all()).filter((r) => r.gateId === "context.keep");
    const { current, older } = currentConfiguration(rows);
    expect([current.length, older.length]).toEqual([10, 40]);
    expect(gradeOf(rows)).toMatchObject({ kind: "none", older: 40 });
    const chk = checkGate(groupGates(rows), {
      gate: "context.keep",
      promise: 0.9,
      minRows: 30,
      window: 500,
    });
    expect(chk.pass).toBe(false);
    // The relevance gate is quiet: its newest request asked ten questions.
    expect(strayQuestions(rows)).toEqual([]);
  });
});

describe("report and check name a renamed question still grading the gate (wave 3 round 2, A1)", () => {
  async function renamed(bump: boolean) {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: fixed(() => 0.97), ledger });
    const g1 = old.gate({
      id: "g",
      question: judge("Safe to run?", { id: "safe.v1" }),
      policy: { actAbove: 0.9 },
      evidenceVersion: "v1",
    });
    for (let i = 0; i < 40; i++) {
      const r = await g1.ask(`old ${i}`);
      await old.label(r.recordId, { correct: true, truth: true });
    }
    const now = new Engine({ oracle: fixed(() => 0.95), ledger });
    const g2 = now.gate({
      id: "g",
      question: judge("Would the user probably not mind this?", { id: "safe.v2" }),
      policy: { actAbove: 0.9 },
      evidenceVersion: bump ? "v2" : "v1",
    });
    for (let i = 0; i < 10; i++) await g2.ask(`new ${i}`);
    return ledger.all();
  }

  it("flags the old question on the check line and in the report, never failing on it", async () => {
    const rows = await renamed(false);
    const [stray] = strayQuestions(rows);
    expect(stray).toMatchObject({ questionId: "safe.v1", rows: 40, labels: 40 });
    const day = (stray?.lastAt ?? "").slice(0, 10);
    const flag = `question \`safe.v1\`: 40 labels, last asked ${day}, not in the newest request; bump evidenceVersion to retire it`;
    const chk = checkGate(groupGates(rows), { gate: "g", promise: 0.95, minRows: 30, window: 500 });
    expect(chk.line).toContain(flag);
    expect(chk.strays).toHaveLength(1);
    const md = renderReport(buildReport("x", rows, {}));
    expect(md).toContain("## Questions not in the newest request");
    expect(md).toContain(`- g: ${flag}`);
  });

  it("is quiet once the evidence version moves", async () => {
    const rows = await renamed(true);
    expect(strayQuestions(rows)).toEqual([]);
    const chk = checkGate(groupGates(rows), { gate: "g", promise: 0.95, minRows: 30, window: 500 });
    expect(chk.line).not.toContain("not in the newest request");
  });
});
