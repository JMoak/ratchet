import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check, checkGate } from "../src/cli/check.ts";
import { groupGates, loadLedger } from "../src/cli/common.ts";
import { type GateReport, type LedgerReport, report } from "../src/cli/report.ts";
import { type Trail, trail } from "../src/cli/trail.ts";
import { Engine } from "../src/engine.ts";
import { type BorrowedVia, gradeOf } from "../src/ledger/evidence.ts";
import { type DecisionRecord, JsonlLedger } from "../src/ledger/ledger.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

// The fixture: one ledger, four gates, one grade each by construction rather than by luck.
// "met" is answered by an oracle that is always right, so the first 149 shadow acts (the plan
// for the default 98% promise) are all right: measured. "open" is a seeded simulation whose
// acts are left unlabelled, so its planned sample can never be read, while its held rows are
// labelled: estimated. "thin" has 12 labelled rows: none, or borrowed when a caller supplies
// evidence from elsewhere. "live" enforces from its first row with every act blind-audited, so
// it has audits enough to estimate and no shadow phase to measure.
const N_MET = 320;
const N_OPEN = 120;
const N_THIN = 40;
const N_LIVE = 80;
const THIN_LABELS = 12;
const MET = "adhoc:met";
const OPEN = "adhoc:open";
const THIN = "adhoc:thin";
const LIVE = "adhoc:live";
const policy = { actAbove: 0.9 };
const truthOf = (s: string): boolean => Number(s.split("-")[1]) % 2 === 0;

/** Always right and sure of it. */
const believer: Oracle = {
  id: "believer",
  decide: async (state, questions) =>
    questions.map((q) => ({
      verdict: {
        kind: "judge" as const,
        questionId: q.id,
        pYes: truthOf(state) ? 0.97 : 0.03,
        confidence: 0.97,
      },
      oracle: "believer",
      model: "believer-v1",
      cost: 0,
      latencyMs: 1,
      at: new Date().toISOString(),
    })),
};

const disagreement: BorrowedVia = {
  type: "disagreement",
  rate: 0.25,
  pairs: 40,
  models: ["model-a", "model-b"],
};

let dir = "";
let path = "";
let rows: DecisionRecord[] = [];
let openLabelled = 0;

async function ask(
  engine: Engine,
  q: JudgeQuestion,
  n: number,
  label: (i: number, acted: boolean) => boolean,
): Promise<number> {
  let labelled = 0;
  for (let i = 0; i < n; i++) {
    const s = `${q.id}-${i}`;
    const r = await engine.ask(s, q, { policy, baseline: "review" });
    if (!label(i, r.ruling.action === "act")) continue;
    const v = r.decision.verdict;
    const truth = truthOf(s);
    await engine.label(r.recordId, {
      correct: (v.kind === "judge" && v.pYes >= 0.5) === truth,
      truth,
    });
    labelled++;
  }
  return labelled;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-evidence-"));
  path = join(dir, "ledger.jsonl");
  const ledger = new JsonlLedger(path);
  const truths = (s: string): Truth => ({ judge: truthOf(s) });
  const sim = new SimOracle({ accuracy: 0.85, seed: 31, id: "sim" }, truths);
  await ask(
    new Engine({ oracle: believer, ledger }),
    judge("Safe to run?", { id: "met" }),
    N_MET,
    () => true,
  );
  openLabelled = await ask(
    new Engine({ oracle: sim, ledger }),
    judge("Safe to edit?", { id: "open" }),
    N_OPEN,
    (_, acted) => !acted,
  );
  await ask(
    new Engine({ oracle: sim, ledger }),
    judge("Safe to push?", { id: "thin" }),
    N_THIN,
    (i) => i < THIN_LABELS,
  );
  await ask(
    new Engine({ oracle: believer, ledger, mode: "enforce", auditRate: 1, seed: 1 }),
    judge("Safe to deploy?", { id: "live" }),
    N_LIVE,
    () => true,
  );
  rows = await loadLedger(path, "test");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fixture", () => {
  it("has four gates, and enough held rows labelled on the open one to estimate", () => {
    expect(groupGates(rows).map((g) => [g.key, g.rows.length])).toEqual([
      [MET, N_MET],
      [OPEN, N_OPEN],
      [THIN, N_THIN],
      [LIVE, N_LIVE],
    ]);
    // Most simulated answers are held, not acted on; the margin over 30 is wide.
    expect(openLabelled).toBeGreaterThanOrEqual(40);
    expect(openLabelled).toBeLessThan(N_OPEN);
  });
});

describe("ratchet report", () => {
  const json = async (...extra: string[]) => {
    const r = await report([path, "--json", ...extra]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.output) as LedgerReport;
  };
  const gradeIn = (r: LedgerReport, key: string): GateReport["grade"] | undefined =>
    r.gates.find((g) => g.gate === key)?.grade;

  it("grades each gate with the strongest evidence its rows support", async () => {
    const r = await json();
    expect(r.minEstimated).toBe(30);
    expect(gradeIn(r, MET)).toMatchObject({
      kind: "measured",
      errors: 0,
      sampleSize: 149,
      plan: { target: 0.98, confidence: 0.95, maxErrors: 0, sampleSize: 149 },
      sources: { blind: 0, census: 0, moment: 0, unknown: 149 },
    });
    expect(gradeIn(r, OPEN)).toMatchObject({ kind: "estimated", n: openLabelled });
    // An enforcing gate estimates from its blind audits, which are half its rows.
    expect(gradeIn(r, LIVE)).toMatchObject({ kind: "estimated", n: N_LIVE / 2, accuracy: 1 });
    expect(gradeIn(r, THIN)).toEqual({
      kind: "none",
      reason: "12 labelled unselected rows; estimated needs 30",
      labelled: THIN_LABELS,
      unselected: THIN_LABELS,
    });
    // The one producer reads the CLI's rows the same way, with a borrowed input when given.
    const thin = groupGates(rows).find((g) => g.key === THIN)?.rows ?? [];
    expect(gradeOf(thin, { borrowed: disagreement }).kind).toBe("borrowed");
  });

  it("carries the union unchanged in --json", async () => {
    const r = await json();
    expect(Object.keys(gradeIn(r, MET) ?? {})).toEqual([
      "kind",
      "plan",
      "lowerBound",
      "errors",
      "sampleSize",
      "sources",
      "at",
    ]);
    expect(Object.keys(gradeIn(r, OPEN) ?? {})).toEqual([
      "kind",
      "accuracy",
      "lower",
      "upper",
      "n",
      "confidence",
      "sources",
      "at",
    ]);
    expect(Object.keys(gradeIn(r, THIN) ?? {})).toEqual([
      "kind",
      "reason",
      "labelled",
      "unselected",
    ]);
    // Dated by the label that completed the planned sample, not by when the report ran.
    const sample = rows.filter((x) => x.questionId === "met" && x.soft === "act").slice(0, 149);
    const completed = sample
      .map((x) => x.outcome?.at ?? "")
      .sort()
      .at(-1);
    expect(gradeIn(r, MET)).toHaveProperty("at", completed);
  });

  it("moves the grade with its levers", async () => {
    const strict = await json("--min-estimated", "1000");
    expect(gradeIn(strict, MET)?.kind).toBe("measured");
    expect(gradeIn(strict, OPEN)?.kind).toBe("none");
    expect(gradeIn(await json("--min-estimated", "10"), THIN)?.kind).toBe("estimated");
    expect((await report([path, "--min-estimated", "0"])).exitCode).toBe(2);
  });

  it("prints the word alone in its column and one provenance line per gate", async () => {
    const md = (await report([path])).output;
    const lines = md.split("\n");
    expect(lines.find((l) => l.startsWith("| gate"))).toMatch(/^\| gate +\| grade +\| rows /);
    for (const [key, kind] of [
      [MET, "measured"],
      [OPEN, "estimated"],
      [THIN, "none"],
    ] as const) {
      const cells = lines.find((l) => l.startsWith(`| ${key} `))?.split("|");
      expect(cells?.[2]?.trim()).toBe(kind);
    }
    expect(md).toContain("Grades: measured on a planned sample for a 98.0% promise");
    expect(md).toContain("## Evidence");
    expect(md).toMatch(
      /- adhoc:met: measured as of \d{4}-\d{2}-\d{2}: exact 95% lower bound 98\.01% >= promised 98\.0% on a planned sample of 149 acts, 0 wrong \(labels: unsourced 149\)/,
    );
    expect(md).toMatch(
      /- adhoc:open: estimated as of \d{4}-\d{2}-\d{2}: .* points wide, not a planned sample/,
    );
    expect(md).toContain("- adhoc:thin: none: 12 labelled unselected rows; estimated needs 30");
  });
});

describe("ratchet check --require", () => {
  const run = (key: string, ...extra: string[]) =>
    check([path, "--gate", key, "--promise", "0.98", ...extra]);
  const SHADOW_DEFAULT =
    "requiring estimated: this gate is in shadow; pass --require measured to insist";

  it("asks a shadow gate for an estimate by default and says so", async () => {
    const r = await run(OPEN);
    expect(r.exitCode).toBe(0);
    expect(r.output.trim().split("\n")).toHaveLength(1);
    expect(r.output).toMatch(/^PASS adhoc:open: requiring estimated: this gate is in shadow; /);
    expect(r.output).toContain("; estimated as of ");
    const insisted = await run(OPEN, "--require", "measured");
    expect(insisted.exitCode).toBe(1);
    expect(insisted.output).toMatch(
      /^FAIL adhoc:open: requires measured evidence, has estimated as of .*not a planned sample; requiring measured, as --require asks/,
    );
  });

  it("asks a gate that enforces for a measured grade by default and says so", async () => {
    const r = await run(LIVE);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(
      /^FAIL adhoc:live: requires measured evidence, has estimated as of .*; requiring measured: this gate enforces/,
    );
    const relaxed = await run(LIVE, "--require", "estimated");
    expect(relaxed.exitCode).toBe(0);
    expect(relaxed.output).toContain("requiring estimated, as --require asks");
  });

  it("passes a measured gate under either requirement, reading the whole history", async () => {
    const r = await run(MET);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`${SHADOW_DEFAULT}; measured as of `);
    expect((await run(MET, "--require", "measured")).exitCode).toBe(0);
    // A window past the planned sample does not unmeasure it.
    expect((await run(MET, "--require", "measured", "--window", "10")).exitCode).toBe(0);
  });

  it("fails a gate with no grade under any requirement, saying what it lacks", async () => {
    for (const extra of [[], ["--require", "measured"], ["--require", "estimated"]]) {
      const r = await run(THIN, ...extra);
      const required = extra[1] ?? "estimated";
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain(
        `requires ${required} evidence, has none: 12 labelled unselected rows; estimated needs 30`,
      );
    }
  });

  it("fails borrowed evidence under either requirement", () => {
    for (const require of ["measured", "estimated"] as const) {
      const r = checkGate(groupGates(rows), {
        gate: THIN,
        promise: 0.98,
        minRows: 30,
        window: 500,
        require,
        borrowed: disagreement,
      });
      expect(r.pass).toBe(false);
      expect([r.grade.kind, r.requiredBy]).toEqual(["borrowed", "flag"]);
      expect(r.line).toContain(`requires ${require} evidence, has borrowed as of `);
      expect(r.line).toContain(": at least 25.0% wrong on this slice, 40 pairs");
    }
  });

  it("defaults by mode, spells the fallback ECE source as all, and exits 2 on nonsense", async () => {
    const groups = groupGates(rows);
    const base = { promise: 0.98, minRows: 30, window: 500 };
    const shadow = checkGate(groups, { ...base, gate: OPEN });
    const enforcing = checkGate(groups, { ...base, gate: LIVE });
    expect([shadow.require, shadow.requiredBy]).toEqual(["estimated", "shadow"]);
    expect([enforcing.require, enforcing.requiredBy]).toEqual(["measured", "enforce"]);
    expect(shadow.ece?.from).toBe("unselected");
    expect(checkGate(groups, { ...base, gate: OPEN, minRows: 1000 }).ece?.from).toBe("all");
    expect((await run(OPEN, "--require", "borrowed")).exitCode).toBe(2);
    expect((await run(OPEN, "--min-estimated", "0")).exitCode).toBe(2);
    // No planned sample bounds a promise of 1: insisting on measured is a usage error, and an
    // enforcing gate held to it by default fails with the reason.
    const one = (gate: string, ...extra: string[]) =>
      check([path, "--gate", gate, "--promise", "1", ...extra]);
    const insisted = await one(MET, "--require", "measured");
    expect(insisted.exitCode).toBe(2);
    expect(insisted.output).toContain("--require estimated");
    expect((await one(MET)).exitCode).toBe(0);
    expect((await one(LIVE)).output).toContain(
      "requires measured evidence, which no planned sample can give a promise of 1",
    );
  });
});

describe("ratchet trail and Engine.report", () => {
  it("end each gate's bar line with its grade", async () => {
    const text = (await trail([path, "--gate", MET, "--last", "1"])).output;
    expect(text).toContain(
      "Grades are read against a 98.0% promise; estimated needs 30 labelled unselected rows.",
    );
    expect(text).toMatch(
      /- adhoc:met: act bar above 0\.030 and at or below 0\.970 under policy [0-9a-f]{8}, from 320 rows; measured as of \d{4}-\d{2}-\d{2}: exact 95% lower bound 98\.01%/,
    );
    const t = JSON.parse((await trail([path, "--json"])).output) as Trail;
    expect(t.bars.map((b) => [b.gate, b.grade.kind])).toEqual([
      [MET, "measured"],
      [OPEN, "estimated"],
      [THIN, "none"],
      [LIVE, "estimated"],
    ]);
    const loose = JSON.parse(
      (await trail([path, "--json", "--target", "0.9", "--min-estimated", "10"])).output,
    ) as Trail;
    expect([loose.target, loose.minEstimated]).toEqual([0.9, 10]);
    expect(loose.bars.find((b) => b.gate === THIN)?.grade.kind).toBe("estimated");
  });

  it("report the same grades per gate and per question as the CLI", async () => {
    const engine = new Engine({ oracle: believer, ledger: new JsonlLedger(path) });
    const api = await engine.report({ targetAccuracy: 0.98 });
    const cli = JSON.parse((await report([path, "--json"])).output) as LedgerReport;
    // Dated by their labels, the two reads agree exactly, date included.
    for (const key of [MET, OPEN, THIN, LIVE]) {
      expect(api.byGate[key]?.grade).toEqual(cli.gates.find((g) => g.gate === key)?.grade);
    }
    expect(api.byQuestion.met?.grade.kind).toBe("measured");
    expect((await engine.gateReport(THIN, { targetAccuracy: 0.98 })).grade).toMatchObject({
      kind: "none",
      unselected: THIN_LABELS,
    });
    // The engine's own default promise is 95%: 59 planned acts.
    expect((await engine.gateReport(MET)).grade).toMatchObject({
      kind: "measured",
      sampleSize: 59,
    });
  });
});
