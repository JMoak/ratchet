import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodeTasks, digest, renderCandidate } from "../experiments/tournament/corpus.ts";
import { Purchases } from "../experiments/tournament/live.ts";
import { pairedInterval } from "../experiments/tournament/report.ts";
import {
  collect,
  EMPTY_BARS,
  fitBars,
  readScoredTasks,
  select,
  simulatedOracles,
} from "../experiments/tournament/runner.ts";
import { buildSqlTasks } from "../experiments/tournament/sql.ts";
import type { ScoredTask } from "../experiments/tournament/types.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";

describe("repair tournament", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records billed requests and stops further purchasing on a cutoff or unknown bill", async () => {
    const network = vi.fn(
      async () =>
        new Response(JSON.stringify({ model: "test", usage: { cost: 0.01 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", network);
    const purchases = new Purchases(0.015, () => {});
    await purchases.fetch("https://example.invalid");
    await expect(purchases.fetch("https://example.invalid")).rejects.toThrow("cutoff");
    expect(purchases.spent).toBe(0.01);
    expect(purchases.stopped).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    network.mockResolvedValue(new Response(JSON.stringify({ model: "test" }), { status: 200 }));
    const unknown = new Purchases(1, () => {});
    await expect(unknown.fetch("https://example.invalid")).rejects.toThrow("billing");
    await expect(unknown.fetch("https://example.invalid")).rejects.toThrow("cutoff");
    expect(unknown.receipts[0]?.cost).toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("seals family splits, executes every authored candidate, and preserves an abstention population", async () => {
    const tasks = [...buildCodeTasks(), ...(await buildSqlTasks())];
    expect(tasks).toHaveLength(54);
    expect(new Set(tasks.map((t) => t.family)).size).toBe(18);
    expect(tasks.every((t) => t.candidates.length === 4)).toBe(true);
    expect(tasks.filter((t) => !t.candidates.some((c) => c.hiddenPass))).toHaveLength(18);
    for (const family of new Set(tasks.map((t) => t.family))) {
      expect(new Set(tasks.filter((t) => t.family === family).map((t) => t.split)).size).toBe(1);
    }
    expect(
      tasks.every((t) => t.candidates.filter((c) => c.hiddenPass).every((c) => c.publicPass)),
    ).toBe(true);
    expect(tasks.some((t) => t.candidates.some((c) => c.publicPass && !c.hiddenPass))).toBe(true);
    expect(digest(buildCodeTasks())).toBe(digest(buildCodeTasks()));
  });

  it("does not expose labels, ids, or hidden-test results to the judge", () => {
    const task = buildCodeTasks()[0];
    if (!task) throw new Error("missing task");
    const candidate = task.candidates[0];
    if (!candidate) throw new Error("missing candidate");
    const text = renderCandidate(task, candidate);
    expect(text).toBe(
      renderCandidate(
        { ...task, id: "secret-task", family: "secret-family" },
        { ...candidate, hiddenPass: !candidate.hiddenPass, hiddenChecks: 999, id: "secret-label" },
      ),
    );
    expect(text).not.toContain(candidate.id);
  });

  it("fits exclusively on labelled shadow ledgers and refuses evaluation contamination", async () => {
    const tasks = buildCodeTasks(1).filter((t) => t.split === "fit");
    const oracles = simulatedOracles(tasks);
    const ledger = new MemoryLedger();
    await collect(tasks, oracles.cheap, ledger, "cheap");
    await collect(tasks, oracles.strong, ledger, "strong");
    const rows = await ledger.all();
    const scored = readScoredTasks(tasks, rows);
    expect(scored).toHaveLength(tasks.length);
    expect(() => fitBars(scored.map((t) => ({ ...t, split: "evaluation" })))).toThrow("Only fit");
    expect(() => readScoredTasks(tasks, rows.slice(1))).toThrow("Missing");
    expect(() => readScoredTasks(tasks, [...rows, ...rows])).toThrow("Duplicate");
  });

  it("never lets a failed judgment or failed public test authorize acceptance", () => {
    const task = scoredTask();
    const bars = { cheap: 0.5, strong: 0.5, cascadeCheap: 0.5, cascadeStrong: 0.5 };
    expect(select(task, "cascade", bars).selected).toBe("good");
    expect(select(task, "cascade", bars).calls).toBe(3);
    expect(select(task, "cascade", bars).cost).toBeCloseTo(0.03);
    const onlyFailures = { ...task, candidates: task.candidates.slice(0, 2) };
    expect(select(onlyFailures, "cascade", bars).selected).toBeNull();
    expect(select(task, "cheap-fit", EMPTY_BARS).calls).toBe(0);
  });

  it("changes grading but not selection when hidden labels change", () => {
    const task = scoredTask();
    const altered = {
      ...task,
      candidates: task.candidates.map((c) => ({ ...c, hiddenPass: !c.hiddenPass })),
    };
    for (const arm of [
      "first",
      "tests",
      "cheap-fixed",
      "cheap-fit",
      "strong-fit",
      "cascade",
      "two-keys",
    ] as const) {
      const bars = { cheap: 0.5, strong: 0.5, cascadeCheap: 0.5, cascadeStrong: 0.5 };
      expect(select(task, arm, bars).selected).toBe(select(altered, arm, bars).selected);
    }
  });

  it("pairs bootstrap tasks by identity and rejects mismatched populations", () => {
    const task = scoredTask();
    const a = select(task, "tests", EMPTY_BARS);
    const b = select(task, "first", EMPTY_BARS);
    expect(pairedInterval([a], [b], 100).clusters).toBe(1);
    expect(() => pairedInterval([a], [{ ...b, task: "different" }])).toThrow("Mismatched");
  });
});

function scoredTask(): ScoredTask {
  const score = { p: 0.99, failed: false, cost: 0.01, latencyMs: 1, model: "test" };
  const candidate = {
    source: "() => true",
    publicPass: true,
    hiddenPass: true,
    publicChecks: 1,
    hiddenChecks: 1,
    cheap: score,
    strong: score,
  };
  return {
    id: "task",
    family: "family",
    domain: "boundaries",
    split: "fit",
    requirement: "x",
    language: "javascript",
    publicExamples: [],
    candidates: [
      { ...candidate, id: "public-failure", publicPass: false },
      {
        ...candidate,
        id: "oracle-failure",
        cheap: { ...score, failed: true },
        strong: { ...score, failed: true },
      },
      { ...candidate, id: "good" },
    ],
  };
}
