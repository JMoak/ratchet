import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLedger } from "../src/cli/common.ts";
import { main } from "../src/cli/main.ts";
import { buildTrail, inferBars, selectTrail, type Trail, trail } from "../src/cli/trail.ts";
import { Engine } from "../src/engine.ts";
import { reviewIf } from "../src/floors.ts";
import { type DecisionRecord, JsonlLedger, parseJsonlLedger } from "../src/ledger/ledger.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { Oracle } from "../src/types.ts";

// The fixture: one judge gate asked four ways in shadow (single, ensemble, cascade with a
// weak first tier, sequential), one row fixed by a floor, one failed open, and a battery gate.
const safe = judge("Is this command safe to run without asking?", { id: "safe" });
const done = [
  judge("Do the tests pass?", { id: "tests" }),
  judge("Does the diff match the claim?", { id: "claims" }),
];
const truthOf = (): Truth | undefined => ({ judge: true });
const policy = { actAbove: 0.9 };

let dir = "";
let path = "";
let rows: DecisionRecord[] = [];
let ensembleId = "";
let cascadeRequest = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-trail-"));
  path = join(dir, "ledger.jsonl");
  const ledger = new JsonlLedger(path);
  const strong = new SimOracle({ accuracy: 0.95, seed: 3, id: "strong" }, truthOf);
  const weak = new SimOracle({ accuracy: 0.6, seed: 4, id: "weak", temperature: 2 }, truthOf);
  const dead: Oracle = {
    id: "dead",
    decide: async () => {
      throw new Error("HTTP 503 Service Unavailable");
    },
  };
  // A gate's strategy is fixed by its spec, so the mixed strategies go through engine.ask and
  // land on the ad hoc gate for the question, "adhoc:safe".
  const engine = new Engine({ oracle: strong, ledger, floors: [reviewIf(/rm -rf/)] });
  for (let i = 0; i < 6; i++) await engine.ask(`ls -la ${i}`, safe, { policy });
  const e = await engine.ask("git status", safe, { policy, strategy: { ensemble: { k: 3 } } });
  ensembleId = e.recordId;
  await engine.label(e.recordId, { correct: true, truth: true, source: "review:blind" });
  const c = await engine.ask("cat README.md", safe, {
    policy,
    strategy: {
      cascade: {
        tiers: [
          { oracle: weak, settleAbove: 0.99, label: "weak" },
          { oracle: strong, settleAbove: 0.5, label: "strong" },
        ],
      },
    },
  });
  cascadeRequest = c.requestId;
  await engine.ask("pwd", safe, {
    policy,
    strategy: { sequential: { settleAbove: 0.9, maxSamples: 4 } },
  });
  await engine.ask("rm -rf build", safe, { policy });
  await new Engine({ oracle: dead, ledger }).ask("whoami", safe, { policy });
  const battery = engine.gate({ id: "stop.done", question: done, policy: { actAbove: 0.95 } });
  const b = await battery.ask("tests: 12 passed; diff: fixes rounding");
  await engine.label(b.recordId, { correct: false, truth: false });
  rows = await loadLedger(path, "test");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recorded member answers", () => {
  it("compound rows keep every member and the strategy's detail; single rows keep neither", () => {
    const ensemble = rows.find((r) => r.id === ensembleId);
    expect(ensemble?.members).toHaveLength(3);
    expect(
      ensemble?.members?.every((m) => m.verdict.kind === "judge" && m.oracle === "strong"),
    ).toBe(true);
    expect(ensemble?.detail).toMatchObject({ pooled: 3, dropped: 0, correlation: 0.75 });
    const cascade = rows.find((r) => r.requestId === cascadeRequest);
    expect(cascade?.members).toHaveLength(2);
    expect(cascade?.detail).toMatchObject({ tier: 1, tierLabel: "strong", escalations: 1 });
    const single = rows.find((r) => r.strategy === "single");
    expect(single).toBeDefined();
    expect(single?.members).toBeUndefined();
    expect(single?.detail).toBeUndefined();
    const combined = rows.find((r) => r.combined === true);
    expect(combined?.members).toBeUndefined();
    expect(combined?.detail).toMatchObject({ members: 2, combine: "logodds" });
  });

  it("reads bare rows as decisions, as a downloaded in-memory ledger writes them", () => {
    const text = `${rows
      .slice(0, 2)
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`;
    expect(parseJsonlLedger(text).map((r) => r.id)).toEqual(rows.slice(0, 2).map((r) => r.id));
  });
});

describe("buildTrail", () => {
  it("makes one entry per decision with battery members attached and the request's spend", () => {
    const entries = buildTrail(rows);
    // 6 single + ensemble + cascade + sequential + floored + failed open, then the battery.
    expect(entries).toHaveLength(12);
    expect(entries.map((e) => e.at)).toEqual(
      entries
        .map((e) => e.at)
        .slice()
        .sort(),
    );
    const battery = entries.find((e) => e.gate === "stop.done");
    expect(battery?.strategy).toBe("battery");
    expect(battery?.members.map((m) => m.name)).toEqual(["tests", "claims"]);
    expect(battery?.members.every((m) => typeof m.correct === "boolean")).toBe(true);
    expect(battery?.cost).toBeGreaterThan(0);
    expect(battery?.outcome).toMatchObject({ correct: false, truth: false });
    const cascade = entries.find((e) => e.requestId === cascadeRequest);
    expect(cascade?.members.map((m) => m.role)).toEqual(["escalated", "settled"]);
    expect(cascade?.members[0]?.name).toBe("weak");
    const floored = entries.find((e) => e.fixed);
    expect(floored).toMatchObject({
      strategy: "floored",
      answer: "no answer bought",
      soft: "review",
    });
    const failed = entries.find((e) => e.failedOpen);
    expect(failed?.error).toContain("503");
    expect(failed?.answer).toBe("failed open");
  });

  it("infers each gate's act bar from its rulings and excludes fixed, failed and floored rows", () => {
    const bars = inferBars(buildTrail(rows));
    const safeBar = bars.find((b) => b.gate === "adhoc:safe");
    expect(safeBar).toBeDefined();
    expect(safeBar?.consistent).toBe(true);
    expect(safeBar?.rows).toBe(9);
    if (safeBar?.atOrBelow !== undefined) expect(safeBar.atOrBelow).toBeGreaterThanOrEqual(0.9);
    if (safeBar?.above !== undefined) expect(safeBar.above).toBeLessThan(0.9);
    const synthetic = buildTrail(rows).map(({ floor: _floor, ...e }, i) => ({
      ...e,
      gate: "x",
      fixed: false,
      failedOpen: false,
      go: i % 2 === 0 ? 0.95 : 0.5,
      soft: i % 2 === 0 ? ("review" as const) : ("act" as const),
    }));
    expect(inferBars(synthetic)[0]?.consistent).toBe(false);
  });
});

describe("ratchet trail", () => {
  it("prints the newest requests oldest first with members, floors, failures and labels", async () => {
    const r = await trail([path, "--gate", "adhoc:safe", "--last", "5"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("# ratchet trail:");
    expect(r.output).toContain("5 of 11 decisions of gate adhoc:safe");
    expect(r.output).toContain("adhoc:safe: act bar");
    expect(r.output).toContain("\ncascade(weak>strong) \u00B7");
    expect(r.output).toContain('settled at tier 2 "strong" after 1 escalation');
    expect(r.output).toContain("| escalated");
    expect(r.output).toContain("fixed by a floor: no answer was bought");
    expect(r.output).toContain("failed open: HTTP 503");
    expect(r.output).toContain("2 samples, settled; confidence 0.79 > 0.99");
    expect(r.output.indexOf("ensemble")).toBeLessThan(r.output.indexOf("cascade"));
    expect(r.output).not.toContain("stop.done");
    expect(r.output).not.toContain("001b[");
  });

  it("finds one request by a prefix of its id, and returns JSON in the Trail shape", async () => {
    const r = await trail([path, "--request", cascadeRequest.slice(0, 8), "--json"]);
    expect(r.exitCode).toBe(0);
    const t = JSON.parse(r.output) as Trail;
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]?.requestId).toBe(cascadeRequest);
    expect(t.total).toBe(12);
    expect(t.bars.map((b) => b.gate).sort()).toEqual(["adhoc:safe", "stop.done"]);
    const batteryTrail = await trail([path, "--gate", "stop.done"]);
    expect(batteryTrail.output).toContain("2 members combined by logodds");
    expect(batteryTrail.output).toContain("label wrong, truth false");
  });

  it("rejects bad flags with exit 2 and names the gates it knows", async () => {
    expect((await trail([path, "--request", "abc"])).exitCode).toBe(2);
    expect((await trail([path, "--request", "zzzzzzzz"])).output).toContain(
      "no request or decision",
    );
    expect((await trail([path, "--last", "0"])).exitCode).toBe(2);
    expect((await trail([path, "--bogus"])).output).toContain("unknown flag");
    const missing = await trail([path, "--gate", "nope"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("adhoc:safe");
    expect((await main(["help", "trail"])).output).toContain("Usage: ratchet trail");
    expect(() => selectTrail(path, rows, { request: "abc" })).toThrow(/6 characters/);
  });
});
