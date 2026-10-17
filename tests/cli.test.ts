import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check, checkGate } from "../src/cli/check.ts";
import { groupGates, loadLedger } from "../src/cli/common.ts";
import { HELP, main } from "../src/cli/main.ts";
import { type ReplayResult, replay } from "../src/cli/replay.ts";
import { type LedgerReport, report } from "../src/cli/report.ts";
import { Engine } from "../src/engine.ts";
import { type DecisionRecord, JsonlLedger } from "../src/ledger/ledger.ts";
import { mean } from "../src/math.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { Oracle } from "../src/types.ts";

// The fixture: one gate ("safe") answered by two models, one calibrated and one badly
// overconfident, plus failed-open rows of two error classes; a second gate ("tidy")
// answered by the calibrated model alone. Shadow mode, every row labelled.
const N_A = 160;
const N_B = 160;
const N_DEAD = 20;
const N_HUNG = 10;
const N_TIDY = 120;
const N_LIVE = N_A + N_B;
const N_SAFE = N_LIVE + N_DEAD + N_HUNG;
const items = Array.from({ length: N_SAFE }, (_, i) => `cmd-${i}`);
const truths = new Map<string, Truth>(items.map((s, i) => [s, { judge: i % 5 !== 0 }]));
const truthOf = (s: string) => truths.get(s);
const safe = judge("Is this command safe to run without asking?", { id: "safe" });
const tidy = judge("Is this change tidy?", { id: "tidy" });
const policy = { actAbove: 0.9 };

let dir = "";
let path = "";
let rows: DecisionRecord[] = [];
let safeKey = "";
let tidyKey = "";
let modelA = "";
let modelB = "";

async function askAndLabel(engine: Engine, states: readonly string[], q: typeof safe) {
  for (const s of states) {
    const r = await engine.ask(s, q, { policy, baseline: "review" });
    const truth = truths.get(s)?.judge === true;
    const v = r.decision.verdict;
    const leanedYes = v.kind === "judge" && v.pYes >= 0.5;
    await engine.label(r.recordId, { correct: leanedYes === truth, truth });
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-cli-"));
  path = join(dir, "ledger.jsonl");
  const ledger = new JsonlLedger(path);
  const simA = new SimOracle({ accuracy: 0.92, seed: 21, id: "sim-a" }, truthOf);
  const simB = new SimOracle({ accuracy: 0.75, seed: 22, id: "sim-b", temperature: 3 }, truthOf);
  const dead: Oracle = {
    id: "dead",
    decide: async () => {
      throw new Error("HTTP 503 Service Unavailable");
    },
  };
  const hung: Oracle = { id: "hung", decide: () => new Promise(() => {}) };
  const deadFrom = N_LIVE;
  const hungFrom = N_LIVE + N_DEAD;
  await askAndLabel(new Engine({ oracle: simA, ledger }), items.slice(0, N_A), safe);
  await askAndLabel(new Engine({ oracle: simB, ledger }), items.slice(N_A, N_LIVE), safe);
  await askAndLabel(new Engine({ oracle: dead, ledger }), items.slice(deadFrom, hungFrom), safe);
  const timesOut = new Engine({ oracle: hung, ledger, timeoutMs: 5 });
  await askAndLabel(timesOut, items.slice(hungFrom, N_SAFE), safe);
  await askAndLabel(new Engine({ oracle: simA, ledger }), items.slice(0, N_TIDY), tidy);
  rows = await loadLedger(path, "test");
  // Gate keys are whatever the ledger says (a gate id, or the question id in older rows).
  const groups = groupGates(rows);
  safeKey = groups.find((g) => g.rows[0]?.questionId === "safe")?.key ?? "";
  tidyKey = groups.find((g) => g.rows[0]?.questionId === "tidy")?.key ?? "";
  modelA = rows.find((r) => r.oracle === "sim-a")?.model ?? "";
  modelB = rows.find((r) => r.oracle === "sim-b")?.model ?? "";
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const safeRows = () => rows.filter((r) => r.questionId === "safe");
const live = (rs: readonly DecisionRecord[]) => rs.filter((r) => !r.failedOpen);

describe("fixture", () => {
  it("has two gates, two models and failed-open rows", () => {
    expect(safeKey).not.toBe("");
    expect(tidyKey).not.toBe("");
    expect(modelA).not.toBe(modelB);
    expect(safeRows()).toHaveLength(N_SAFE);
    expect(safeRows().filter((r) => r.failedOpen)).toHaveLength(N_DEAD + N_HUNG);
    expect(rows.every((r) => r.outcome !== undefined)).toBe(true);
  });
});

describe("ratchet report", () => {
  const json = async (...extra: string[]) => {
    const r = await report([path, "--json", "--target", "0.9", ...extra]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.output) as LedgerReport;
  };

  it("groups rows by gate and counts them", async () => {
    const r = await json();
    expect(r.rows).toBe(rows.length);
    expect(r.gates.map((g) => g.gate).sort()).toEqual([safeKey, tidyKey].sort());
    const g = r.gates.find((x) => x.gate === safeKey);
    expect(g?.rows).toBe(N_SAFE);
    expect(g?.labelled).toBe(N_LIVE);
    expect(g?.unselected).toBe(N_LIVE);
    expect(g?.failedOpen).toBe(N_DEAD + N_HUNG);
    expect(g?.errors).toEqual([
      { class: "HTTP 503", rows: N_DEAD },
      { class: "timeout", rows: N_HUNG },
    ]);
    expect(g?.models).toEqual([
      { model: modelA, rows: N_A },
      { model: modelB, rows: N_B },
    ]);
    expect(r.gates.find((x) => x.gate === tidyKey)?.models).toEqual([
      { model: modelA, rows: N_TIDY },
    ]);
  });

  it("reports accuracy, calibration, posture and a fitted bar that agree with the rows", async () => {
    const g = (await json()).gates.find((x) => x.gate === safeKey);
    const labelled = live(safeRows());
    const observed = mean(labelled.map((r) => (r.outcome?.correct ? 1 : 0)));
    const expected = mean(labelled.map((r) => r.confidence));
    expect(g?.accuracy).toBeCloseTo(observed, 12);
    expect(g?.expectedAccuracy).toBeCloseTo(expected, 12);
    // The second model claims far more than it delivers.
    expect(expected - observed).toBeGreaterThan(0.04);
    expect(g?.posture).toBe("overconfident");
    expect(g?.ece ?? 0).toBeGreaterThan(0.03);
    expect(g?.ece ?? 1).toBeLessThan(0.3);
    expect(g?.brier ?? 1).toBeLessThan(0.25);
    expect(g?.fittedFrom).toBe("unselected");
    expect(g?.fitRows).toBe(N_LIVE);
    expect(g?.fitted?.accuracy ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(g?.fitted?.n ?? 0).toBeGreaterThanOrEqual(30);
    expect(g?.fitted?.coverage).toBeCloseTo((g?.fitted?.n ?? 0) / N_LIVE, 12);
    expect(g?.cost ?? 0).toBeGreaterThan(0);
    expect(g?.meanLatencyMs ?? 0).toBeGreaterThan(0);
  });

  it("falls back to all labelled rows when unselected rows are too few, and says so", async () => {
    const g = (await json("--min-support", "1000")).gates.find((x) => x.gate === safeKey);
    expect(g?.fittedFrom).toBe("all");
    expect(g?.fitted).toBeUndefined();
  });

  it("filters to one gate and renders markdown tables by default", async () => {
    const one = await json("--gate", tidyKey);
    expect(one.gates.map((g) => g.gate)).toEqual([tidyKey]);
    const md = await report([path]);
    expect(md.exitCode).toBe(0);
    expect(md.output).toContain("## Calibration and fitted bar");
    expect(md.output).toContain("## Operations");
    expect(md.output).toContain("overconfident");
    expect(md.output).toContain(`HTTP 503 (${N_DEAD}), timeout (${N_HUNG})`);
    expect(md.output).toContain(`unselected (${N_LIVE})`);
    expect(md.output).not.toContain("\u001b[");
  });

  it("exits 2 on usage errors", async () => {
    expect((await report([])).exitCode).toBe(2);
    expect((await report([path, "--target", "1.5"])).exitCode).toBe(2);
    expect((await report([path, "--bogus"])).exitCode).toBe(2);
    expect((await report([join(dir, "missing.jsonl")])).output).toMatch(/not found/);
    const unknown = await report([path, "--gate", "nope"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.output).toContain(safeKey);
  });
});

describe("ratchet check", () => {
  const args = (...extra: string[]) => [path, "--gate", safeKey, ...extra];

  it("passes a kept promise with a one-line summary", async () => {
    const r = await check(args("--promise", "0.8"));
    expect(r.exitCode).toBe(0);
    expect(r.output.trim().split("\n")).toHaveLength(1);
    expect(r.output).toMatch(/^PASS /);
    expect(r.output).toMatch(/shadow acted rows/);
  });

  it("fails a broken promise with the reason", async () => {
    const r = await check(args("--promise", "0.99"));
    expect(r.exitCode).toBe(1);
    expect(r.output.trim().split("\n")).toHaveLength(1);
    expect(r.output).toMatch(/^FAIL .*below the promise 99\.0%/);
  });

  it("judges accuracy on the rows the policy acted on", async () => {
    const result = checkGate(groupGates(rows), {
      gate: safeKey,
      promise: 0.8,
      minRows: 30,
      window: 500,
    });
    const acted = live(safeRows()).filter((r) => r.soft === "act");
    expect(result.acted.n).toBe(acted.length);
    expect(result.acted.accuracy).toBeCloseTo(
      mean(acted.map((r) => (r.outcome?.truth === true ? 1 : 0))),
      12,
    );
    expect(result.acted.accuracy ?? 0).toBeGreaterThan(0.8);
    expect(result.acted.accuracy ?? 1).toBeLessThan(0.99);
  });

  it("does not judge accuracy on too few rows, or outside the window", async () => {
    const few = await check(args("--promise", "0.99", "--min-rows", "100000"));
    expect(few.exitCode).toBe(0);
    expect(few.output).toContain("not judged");
    const recent = checkGate(groupGates(rows), {
      gate: safeKey,
      promise: 0.99,
      minRows: 30,
      window: N_DEAD + N_HUNG,
    });
    // The newest rows all failed open: nothing acted, nothing judged.
    expect(recent.windowRows).toBe(N_DEAD + N_HUNG);
    expect(recent.acted.n).toBe(0);
    expect(recent.pass).toBe(true);
  });

  it("fails when ECE exceeds the bound", async () => {
    const r = await check(args("--promise", "0.8", "--max-ece", "0.01"));
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/^FAIL .*ECE 0\.\d{3} on \d+ unselected rows exceeds 0\.01/);
    expect(r.output).toContain(`on ${N_LIVE} unselected rows exceeds 0.01`);
    expect((await check(args("--promise", "0.8", "--max-ece", "0.5"))).exitCode).toBe(0);
  });

  it("fails when a model other than the pinned one answered", async () => {
    const r = await check(args("--promise", "0.8", "--model", modelA));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(
      `${N_B} of ${N_LIVE} answered rows came from models other than the pinned ${modelA}: ${modelB} (${N_B})`,
    );
    const pinned = await check([path, "--gate", tidyKey, "--promise", "0.8", "--model", modelA]);
    expect(pinned.exitCode).toBe(0);
    expect(pinned.output).toContain(`model ${modelA} on all ${N_TIDY} answered rows`);
  });

  it("exits 2 on usage errors", async () => {
    expect((await check([path, "--gate", safeKey])).exitCode).toBe(2);
    expect((await check([path, "--promise", "0.9"])).exitCode).toBe(2);
    expect((await check(args("--promise", "abc"))).exitCode).toBe(2);
    expect((await check(args("--promise", "0.9", "--window", "0"))).exitCode).toBe(2);
    expect((await check([path, "--gate", "nope", "--promise", "0.9"])).exitCode).toBe(2);
    expect(
      (await check([join(dir, "missing.jsonl"), "--gate", "x", "--promise", "0.9"])).exitCode,
    ).toBe(2);
  });
});

describe("ratchet replay", () => {
  const json = async (...extra: string[]) => {
    const r = await replay([path, "--gate", safeKey, "--json", ...extra]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.output) as ReplayResult;
  };
  const pYes = (r: DecisionRecord) => (r.verdict.kind === "judge" ? r.verdict.pYes : 0.5);

  it("counts rows that change action, by direction", async () => {
    const r = await json("--act-above", "0.97", "--refuse-below", "0.2");
    const answered = live(safeRows());
    const actToReview = answered.filter((x) => x.soft === "act" && pYes(x) < 0.97).length;
    const reviewToRefuse = answered.filter((x) => x.soft === "review" && pYes(x) <= 0.2).length;
    expect(actToReview).toBeGreaterThan(0);
    expect(reviewToRefuse).toBeGreaterThan(0);
    expect(r.goIsYesFrom).toBe("recorded rows");
    expect(r.transitions).toEqual([
      { from: "act", to: "review", rows: actToReview },
      { from: "review", to: "refuse", rows: reviewToRefuse },
    ]);
    expect(r.moreCautious).toBe(actToReview + reviewToRefuse);
    expect(r.lessCautious).toBe(0);
    expect(r.changed).toBe(r.moreCautious);
    // Failed-open rows stay in review under any bar.
    expect(r.actions.replayed.review).toBeGreaterThanOrEqual(N_DEAD + N_HUNG);
  });

  it("reports the accuracy and coverage the new bar would have delivered", async () => {
    const r = await json("--act-above", "0.97");
    const labelled = live(safeRows());
    const acted = labelled.filter((x) => pYes(x) >= 0.97);
    expect(r.labelled.replayed.rows).toBe(N_LIVE);
    expect(r.labelled.replayed.acted).toBe(acted.length);
    expect(r.labelled.replayed.coverage).toBeCloseTo(acted.length / N_LIVE, 12);
    expect(r.labelled.replayed.accuracy).toBeCloseTo(
      mean(acted.map((x) => (x.outcome?.truth === true ? 1 : 0))),
      12,
    );
    const recorded = labelled.filter((x) => x.soft === "act");
    expect(r.labelled.recorded.acted).toBe(recorded.length);
    expect(r.labelled.replayed.coverage).toBeLessThan(r.labelled.recorded.coverage);
    expect(r.labelled.replayed.wrongActs).toBeLessThan(r.labelled.recorded.wrongActs);
    // Every row is a shadow row, so there is no separate unselected slice.
    expect(r.unselected).toBeUndefined();
  });

  it("a lower bar only ever acts more", async () => {
    const r = await json("--act-above", "0.6");
    expect(r.moreCautious).toBe(0);
    expect(r.lessCautious).toBeGreaterThan(0);
    expect(r.transitions.every((t) => t.from === "review" && t.to === "act")).toBe(true);
  });

  it("flips polarity on request", async () => {
    const r = await json("--act-above", "0.9", "--go-is-yes", "false");
    expect(r.goIsYesFrom).toBe("flag");
    expect(r.actions.replayed.act).toBe(live(safeRows()).filter((x) => 1 - pYes(x) >= 0.9).length);
  });

  it("renders markdown and exits 2 on usage errors", async () => {
    const md = await replay([path, "--gate", safeKey, "--act-above", "0.97"]);
    expect(md.exitCode).toBe(0);
    expect(md.output).toContain("## Changes");
    expect(md.output).toContain("more cautious");
    expect(md.output).toContain("| recorded |");
    const bad = [
      [path, "--gate", safeKey],
      [path, "--gate", safeKey, "--act-above", "0.9", "--refuse-below", "0.95"],
      [path, "--gate", safeKey, "--act-above", "0.9", "--go-is-yes", "maybe"],
    ];
    for (const argv of bad) expect((await replay(argv)).exitCode).toBe(2);
  });
});

describe("gates, batteries and older rows", () => {
  const at = "2026-10-17T00:00:00.000Z";
  const base = {
    at,
    kind: "judge",
    prompt: "p",
    questionHash: "h",
    stateHash: "s",
    trustedHash: "s",
    untrusted: [],
    oracle: "sim",
    strategy: "single",
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost: 0.00001,
    latencyMs: 100,
    failedOpen: false,
    tags: [],
  };
  const row = (over: Record<string, unknown>): DecisionRecord => {
    const pYes = typeof over.pYes === "number" ? over.pYes : 0.95;
    const questionId = typeof over.questionId === "string" ? over.questionId : "q";
    return {
      ...base,
      questionId,
      verdict: { kind: "judge", questionId, pYes, confidence: Math.max(pYes, 1 - pYes) },
      go: pYes,
      confidence: Math.max(pYes, 1 - pYes),
      ...over,
    } as unknown as DecisionRecord;
  };

  it("splits a battery's members from the rows that carry its ruling", async () => {
    const batteryPath = join(dir, "battery.jsonl");
    const ledger = new JsonlLedger(batteryPath);
    for (let i = 0; i < 3; i++) {
      const common = { gateId: "stop.done", requestId: `req-${i}` };
      await ledger.append(row({ ...common, id: `m1-${i}`, questionId: "tests", model: "m-1" }));
      await ledger.append(row({ ...common, id: `m2-${i}`, questionId: "claims", model: "m-1" }));
      await ledger.append(
        row({ ...common, id: `c-${i}`, questionId: "done", strategy: "battery", combined: true }),
      );
    }
    await ledger.append(row({ id: "plain", gateId: "bash.safe", requestId: "r", model: "m-1" }));
    const groups = groupGates(await loadLedger(batteryPath, "test"));
    // Each gate comes first, followed by its members, though members were written first.
    expect(groups.map((g) => [g.key, g.rows.length, g.memberOf ?? null])).toEqual([
      ["stop.done", 3, null],
      ["stop.done/tests", 3, "stop.done"],
      ["stop.done/claims", 3, "stop.done"],
      ["bash.safe", 1, null],
    ]);
    const rep = JSON.parse((await report([batteryPath, "--json", "--gate", "stop.done"])).output);
    expect(rep.gates.map((g: { gate: string }) => g.gate)).toEqual([
      "stop.done",
      "stop.done/tests",
      "stop.done/claims",
    ]);
    // The pin is checked on the members, which are the rows a model answered.
    const pin = (model: string) =>
      check([batteryPath, "--gate", "stop.done", "--promise", "0.9", "--model", model]);
    expect((await pin("m-1")).exitCode).toBe(0);
    expect((await pin("m-2")).exitCode).toBe(1);
  });

  it("groups rows without a gate id by question id", () => {
    const old = [row({ id: "a", questionId: "x" }), row({ id: "b", questionId: "y" })];
    expect(groupGates(old).map((g) => g.key)).toEqual(["x", "y"]);
  });
});

describe("ratchet main", () => {
  it("dispatches, explains itself, and uses exit code 2 for nonsense", async () => {
    expect(await main(["help"])).toEqual({ exitCode: 0, output: HELP });
    expect((await main(["help", "check"])).output).toMatch(/^Usage: ratchet check/);
    expect((await main(["check", "--help"])).exitCode).toBe(0);
    expect((await main([])).exitCode).toBe(2);
    expect((await main(["frobnicate"])).exitCode).toBe(2);
    const r = await main(["check", path, "--gate", tidyKey, "--promise", "0.8"]);
    expect(r.exitCode).toBe(0);
  });
});
