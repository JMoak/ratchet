import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../src/cli/check.ts";
import { loadLedger } from "../src/cli/common.ts";
import { main } from "../src/cli/main.ts";
import { profile } from "../src/cli/profile.ts";
import { type LedgerReport, report } from "../src/cli/report.ts";
import { type Trail, trail } from "../src/cli/trail.ts";
import { Engine } from "../src/engine.ts";
import { HOOK_PLAN, hookGateSpec, hookPolicy, hookQuestion } from "../src/hook/gate.ts";
import { parseProfile } from "../src/ledger/borrow.ts";
import { type DecisionRecord, hashQuestion, JsonlLedger } from "../src/ledger/ledger.ts";
import { buildProfile, type CalibrationProfile, profileVia } from "../src/ledger/profile.ts";
import { policyFromProfile } from "../src/policy.ts";
import { judge } from "../src/questions.ts";
import type { Oracle } from "../src/types.ts";

// The fixture. A donor ledger where model m-1 kept 90% from 0.75 up (80 of 80 right), from
// which the CLI builds a profile with a 0.75 bar at a 90% promise. Then a ledger of gates that
// might borrow it, read at --target 0.9: "fresh" (m-1, 10 labels: no fitted bar, no grade of
// its own), "fitted" (m-1, enforcing, 40 labelled acts: a fitted bar from selected rows, still
// no grade, so it still borrows), "other" (m-2: the key does not match), "sourced" (m-1, built
// from the profile with policyFromProfile and barSource) and "moved" (the same, then answered by
// m-2).
const Q = judge("Safe to run?", { id: "safe" });
const truthOf = (s: string): boolean => !s.endsWith("-no");

/** Answers yes at the confidence its state names, as model `model`. */
const scripted = (model: string): Oracle => ({
  id: `scripted-${model}`,
  decide: async (state, questions) =>
    questions.map((q) => {
      const p = Number(state.split("@")[1]);
      return {
        verdict: {
          kind: "judge" as const,
          questionId: q.id,
          pYes: p,
          confidence: Math.max(p, 1 - p),
        },
        oracle: `scripted-${model}`,
        model,
        cost: 0,
        latencyMs: 1,
        at: new Date().toISOString(),
      };
    }),
});

let dir = "";
let donorPath = "";
let gatesPath = "";
let profilePath = "";
let p: CalibrationProfile;
let gateRows: DecisionRecord[] = [];

async function ask(
  engine: Engine,
  id: string,
  states: readonly string[],
  labelled: number,
  extra: Partial<Parameters<Engine["gate"]>[0]> = {},
): Promise<void> {
  const gate = engine.gate({ id, question: Q, policy: { actAbove: 0.9 }, ...extra });
  for (const [i, s] of states.entries()) {
    const r = await gate.ask(s);
    if (i >= labelled) continue;
    const v = r.decision.verdict;
    const truth = truthOf(s);
    await engine.label(r.recordId, {
      correct: (v.kind === "judge" && v.pYes >= 0.5) === truth,
      truth,
    });
  }
}

const states = (n: number, p: number, tag = "") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}@${p}`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-profile-"));
  donorPath = join(dir, "donor.jsonl");
  gatesPath = join(dir, "gates.jsonl");
  profilePath = join(dir, "profile.json");
  const donor = new Engine({ oracle: scripted("m-1"), ledger: new JsonlLedger(donorPath) });
  await ask(donor, "donor", [...states(40, 0.95), ...states(40, 0.75)], 80);
  const built = await profile([
    "build",
    donorPath,
    "--model",
    "m-1",
    "--kind",
    "judge",
    "--target",
    "0.9",
    "--out",
    profilePath,
  ]);
  expect(built.exitCode).toBe(0);
  p = parseProfile(JSON.parse(await readFile(profilePath, "utf8")));

  const ledger = new JsonlLedger(gatesPath);
  const m1 = new Engine({ oracle: scripted("m-1"), ledger });
  const m2 = new Engine({ oracle: scripted("m-2"), ledger });
  const sourced = { policy: policyFromProfile(p, 0.9), barSource: { profileHash: p.hash } };
  await ask(m1, "fresh", states(20, 0.8), 10);
  await ask(
    new Engine({ oracle: scripted("m-1"), ledger, mode: "enforce" }),
    "fitted",
    states(40, 0.97),
    40,
  );
  await ask(m2, "other", states(20, 0.8), 10);
  await ask(m1, "sourced", states(20, 0.8), 10, sourced);
  await ask(m1, "moved", states(10, 0.8), 5, sourced);
  await ask(m2, "moved", states(10, 0.8, "late"), 5, sourced);
  gateRows = await loadLedger(gatesPath, "test");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ratchet profile build", () => {
  it("writes the profile and says what it holds", async () => {
    const json = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "format",
      "key",
      "targets",
      "minSupport",
      "resolution",
      "bars",
      "bins",
      "from",
      "hash",
    ]);
    expect(json).toMatchObject({
      format: 1,
      key: { model: "m-1", kind: "judge" },
      targets: [0.9],
      minSupport: 30,
      resolution: 100,
      bars: [{ target: 0.9, bar: 0.75, support: 80 }],
      from: { rows: 80, gates: ["donor"], ledgers: [donorPath] },
    });
    const printed = await profile([
      "build",
      donorPath,
      "--model",
      "m-1",
      "--kind",
      "judge",
      "--target",
      "0.9",
    ]);
    expect(printed.exitCode).toBe(0);
    expect(JSON.parse(printed.output)).toEqual(p);
  });

  it("exits 2 on a usage error, a missing ledger or no rows to read", async () => {
    const base = ["build", donorPath, "--model", "m-1", "--kind", "judge"];
    expect((await profile(["build", donorPath, "--kind", "judge"])).exitCode).toBe(2);
    expect((await profile([...base.slice(0, 4), "--kind", "vote"])).output).toContain(
      "--kind must be judge, pick or rate",
    );
    expect((await profile([...base, "--target", "1.5"])).exitCode).toBe(2);
    expect((await profile([...base, "--resolution", "0"])).exitCode).toBe(2);
    expect((await profile([...base, "--resolution", "1001"])).exitCode).toBe(2);
    const tenths = await profile([...base, "--target", "0.9", "--resolution", "10"]);
    expect(JSON.parse(tenths.output)).toMatchObject({
      resolution: 10,
      bars: [{ target: 0.9, bar: 0.7, support: 80 }],
    });
    expect((await profile([...base, "--json"])).exitCode).toBe(2);
    expect((await profile(["build", join(dir, "nope.jsonl"), ...base.slice(2)])).exitCode).toBe(2);
    const none = await profile(["build", donorPath, "--model", "m-9", "--kind", "judge"]);
    expect(none.exitCode).toBe(2);
    expect(none.output).toContain(
      "no labelled unselected row of a trusted source for m-9 judge questions; answers a model gave alone, by model and kind: m-1 judge (80)",
    );
    expect((await profile([])).exitCode).toBe(2);
    expect((await profile(["frob"])).output).toContain('unknown subcommand "frob"');
    expect((await profile(["--help"])).exitCode).toBe(0);
    expect((await main(["help", "profile"])).output).toContain("ratchet profile build");
  });
});

describe("ratchet profile show and merge", () => {
  it("shows the bars, each donor gate's own bar and the bins, or the checked JSON", async () => {
    const text = await profile(["show", profilePath]);
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain(
      `Profile ${p.hash} of m-1 judge questions, from 80 rows of gate donor`,
    );
    expect(text.output).toMatch(/\| 90\.0% +\| 0\.750 \| 80 +\| 0\.800 +\|/);
    expect(text.output).toMatch(/\| donor \| 80 +\| 0\.750 \(80\) +\|/);
    // The hundred stored bins read in tenths; the JSON keeps every one.
    expect(text.output).toContain("## Bins, in tenths (the profile holds 100; --json lists them)");
    expect(text.output).toMatch(/\| donor +\| 0\.9 to 1\.0 +\| 40 +\| 0\.950 +\| 100\.0% +\|/);
    expect(p.bins.map((b) => [b.lo, b.n])).toEqual([
      [0.75, 40],
      [0.95, 40],
    ]);
    expect(JSON.parse((await profile(["show", profilePath, "--json"])).output)).toEqual(p);
    const tampered = join(dir, "tampered.json");
    await writeFile(
      tampered,
      JSON.stringify({ ...p, bars: [{ target: 0.9, bar: 0.5, support: 80 }] }),
    );
    const refused = await profile(["show", tampered]);
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain("bars and hash must be what its bins give");
    expect((await profile(["show", join(dir, "nope.json")])).output).toContain("profile not found");
  });

  it("merges profiles of disjoint ledgers, and refuses the rest with exit 2", async () => {
    const otherPath = join(dir, "other.json");
    const second = buildProfile(
      gateRows,
      { model: "m-1", kind: "judge" },
      {
        ledgers: [gatesPath],
        targets: [0.9],
      },
    ) as CalibrationProfile;
    await writeFile(otherPath, JSON.stringify(second));
    const out = join(dir, "merged.json");
    const merged = await profile(["merge", profilePath, otherPath, "--out", out]);
    expect(merged.exitCode).toBe(0);
    expect(merged.output).toMatch(
      /^wrote .*merged\.json: profile [0-9a-f]{8} of m-1 judge questions: /,
    );
    const back = parseProfile(JSON.parse(await readFile(out, "utf8")));
    expect(back.from.rows).toBe(p.from.rows + second.from.rows);
    expect((await profile(["merge", profilePath, profilePath, "--out", out])).output).toContain(
      "would count twice",
    );
    expect((await profile(["merge", profilePath, otherPath])).exitCode).toBe(2);
    expect((await profile(["merge", profilePath, "--out", out])).exitCode).toBe(2);
  });
});

describe("--profile on report, check and trail", () => {
  const json = async (...extra: string[]) => {
    const r = await report([gatesPath, "--json", "--target", "0.9", ...extra]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.output) as LedgerReport;
  };
  const gradeIn = (r: LedgerReport, gate: string) => r.gates.find((g) => g.gate === gate)?.grade;

  it("borrows for a gate whose key matches until its own labels grade it estimated", async () => {
    const without = await json();
    expect(gradeIn(without, "fresh")?.kind).toBe("none");
    const r = await json("--profile", profilePath);
    expect(r.profiles).toEqual([{ hash: p.hash, key: { model: "m-1", kind: "judge" } }]);
    expect(gradeIn(r, "fresh")).toEqual({
      kind: "borrowed",
      via: profileVia(p, 0.9),
      at: p.from.lastAt,
    });
    // A bar of its own fitted on selected rows is no grade of its own, so the profile still
    // lends (e2e T3-03): lending stops at estimated, not at the first fitted bar.
    expect(r.gates.find((g) => g.gate === "fitted")?.fitted).toBeDefined();
    expect(gradeIn(r, "fitted")?.kind).toBe("borrowed");
    expect(gradeIn(r, "other")?.kind).toBe("none");
    expect(gradeIn(r, "sourced")).toEqual({
      kind: "borrowed",
      via: profileVia(p, 0.9),
      at: p.from.lastAt,
    });
    // The profile has no bar for a 99% promise, so nothing is borrowed at it.
    const strict = await report([
      gatesPath,
      "--json",
      "--target",
      "0.99",
      "--profile",
      profilePath,
    ]);
    expect(gradeIn(JSON.parse(strict.output) as LedgerReport, "fresh")?.kind).toBe("none");
    expect((await report([gatesPath, "--profile", join(dir, "nope.json")])).exitCode).toBe(2);
  });

  it("reads a gate that moved off its profile's model as borrowed (stale)", async () => {
    const r = await json("--profile", profilePath);
    expect(gradeIn(r, "moved")).toMatchObject({ kind: "borrowed", stale: true });
    const md = (await report([gatesPath, "--target", "0.9", "--profile", profilePath])).output;
    expect(
      md
        .split("\n")
        .find((l) => l.startsWith("| moved "))
        ?.split("|")[2]
        ?.trim(),
    ).toBe("borrowed (stale)");
    expect(md).toContain(
      `- moved: borrowed (stale) as of ${p.from.lastAt.slice(0, 10)}: bar 0.750`,
    );
    expect(md).toContain(
      `Profiles offered with --profile: ${p.hash.slice(0, 8)} (m-1 judge questions).`,
    );
    expect(md).toContain(
      `- fresh: borrowed as of ${p.from.lastAt.slice(0, 10)}: bar 0.750 from profile`,
    );
  });

  it("puts the borrowed grade on check's line, where it never passes", async () => {
    const run = (...extra: string[]) =>
      check([gatesPath, "--gate", "fresh", "--promise", "0.9", "--profile", profilePath, ...extra]);
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(
      /^FAIL fresh: requires estimated evidence, has borrowed as of .*, 0 rows here;/,
    );
    // A pin overrides the rows' model, so a gate pinned elsewhere borrows nothing.
    expect((await run("--model", "m-2")).output).toContain("has none: 10 labelled unselected rows");
    const other = await check([
      gatesPath,
      "--gate",
      "other",
      "--promise",
      "0.9",
      "--model",
      "m-1",
      "--profile",
      profilePath,
    ]);
    // Pinned to m-1 while m-2 answers: the bar describes a model that no longer answers.
    expect(other.output).toContain("has borrowed (stale) as of");
    expect((await run("--min-support", "0")).exitCode).toBe(2);
  });

  it("grades trail bars the same way and names the bar's source on each row", async () => {
    const t = JSON.parse(
      (await trail([gatesPath, "--json", "--target", "0.9", "--profile", profilePath])).output,
    ) as Trail;
    const kinds = Object.fromEntries(t.bars.map((b) => [b.gate, b.grade.kind]));
    expect(kinds).toMatchObject({
      fresh: "borrowed",
      fitted: "borrowed",
      other: "none",
      sourced: "borrowed",
    });
    expect([t.minSupport, t.profiles?.[0]?.hash]).toEqual([30, p.hash]);
    const text = (
      await trail([
        gatesPath,
        "--gate",
        "sourced",
        "--last",
        "1",
        "--target",
        "0.9",
        "--profile",
        profilePath,
      ])
    ).output;
    expect(text).toContain(`bar borrowed from profile ${p.hash.slice(0, 8)}`);
    expect(text).toMatch(/- sourced: act bar .*; borrowed as of /);
    const plain = (await trail([gatesPath, "--gate", "sourced", "--last", "1"])).output;
    expect(plain).not.toContain("Profiles offered");
  });
});

describe("the engine", () => {
  it("writes barSource into the detail of every row of a gate that declares it, and only those", () => {
    const of = (gate: string) => gateRows.filter((r) => r.gateId === gate);
    expect(of("sourced").length).toBe(20);
    for (const r of [...of("sourced"), ...of("moved")]) {
      expect(r.detail).toEqual({ barSource: { profileHash: p.hash } });
    }
    for (const r of [...of("fresh"), ...of("fitted"), ...of("other")])
      expect(r.detail).toBeUndefined();
    expect(() =>
      new Engine({ oracle: scripted("m-1") }).gate({
        id: "bad",
        question: Q,
        policy: { actAbove: 0.9 },
        barSource: { profileHash: " " },
      }),
    ).toThrow(/barSource/);
  });

  it("reports the same borrowed grades as the CLI, and reads a rollout's pin first", async () => {
    const engine = new Engine({
      oracle: scripted("m-1"),
      ledger: new JsonlLedger(gatesPath),
      profiles: [p],
    });
    const api = await engine.report({ targetAccuracy: 0.9 });
    const cli = JSON.parse(
      (await report([gatesPath, "--json", "--target", "0.9", "--profile", profilePath])).output,
    ) as LedgerReport;
    for (const gate of ["fresh", "fitted", "other", "sourced", "moved"]) {
      expect(api.byGate[gate]?.grade).toEqual(cli.gates.find((g) => g.gate === gate)?.grade);
    }
    engine.gate({
      id: "other",
      question: Q,
      policy: { actAbove: 0.9 },
      rollout: { evidence: { version: "v1", model: "m-1" } },
    });
    expect((await engine.gateReport("other", { targetAccuracy: 0.9 })).grade.kind).toBe("borrowed");
    const plain = new Engine({ oracle: scripted("m-1"), ledger: new JsonlLedger(gatesPath) });
    expect((await plain.gateReport("fresh", { targetAccuracy: 0.9 })).grade.kind).toBe("none");
    expect(
      () => new Engine({ oracle: scripted("m-1"), profiles: [{ ...p, hash: "f".repeat(16) }] }),
    ).toThrow(/bars and hash/);
  });
});

describe("hookGateSpec", () => {
  // 200 of 200 right at 0.9 bounds accuracy at 0.981, past the hook's 98% promise.
  const rows = Array.from(
    { length: 200 },
    (_, i): DecisionRecord => ({
      id: `h${i}`,
      at: "2026-10-20T00:00:00.000Z",
      gateId: "agent.tool.keywork",
      requestId: `h${i}`,
      questionId: hookQuestion.id,
      kind: "judge",
      prompt: hookQuestion.prompt,
      questionHash: hashQuestion(hookQuestion),
      stateHash: `h${i}`,
      trustedHash: `h${i}`,
      untrusted: [],
      oracle: "o",
      model: "m-1",
      strategy: "single",
      verdict: { kind: "judge", questionId: hookQuestion.id, pYes: 0.9, confidence: 0.9 },
      go: 0.9,
      confidence: 0.9,
      agreement: 1,
      soft: "act",
      action: "review",
      mode: "shadow",
      cost: 0,
      latencyMs: 0,
      failedOpen: false,
      tags: [],
      outcome: {
        at: "2026-10-20T00:00:00.000Z",
        correct: true,
        truth: true,
        source: "keywork:person",
      },
    }),
  );
  const judged = buildProfile(rows, { model: "m-1", kind: "judge" }, { ledgers: ["k.jsonl"] });

  it("keeps its default without a profile and starts from one when given", () => {
    const plain = hookGateSpec("claude-code");
    expect(plain.policy).toBe(hookPolicy);
    expect(plain.barSource).toBeUndefined();
    expect(hookGateSpec("claude-code", {})).toEqual(plain);
    const from = hookGateSpec("claude-code", { profile: judged as CalibrationProfile });
    expect(from.policy).toEqual(policyFromProfile(judged as CalibrationProfile, HOOK_PLAN.target));
    expect(from.policy).toEqual({ actAbove: 0.95 });
    expect(from.barSource).toEqual({ profileHash: judged?.hash });
    expect({ ...from, policy: plain.policy, barSource: undefined }).toEqual({
      ...plain,
      barSource: undefined,
    });
  });

  it("refuses a profile of another kind or rubric", () => {
    const keyed = buildProfile(
      rows,
      { model: "m-1", kind: "judge", questionHash: hashQuestion(hookQuestion) },
      {
        ledgers: ["k.jsonl"],
      },
    );
    expect(hookGateSpec("codex", { profile: keyed as CalibrationProfile }).barSource).toBeDefined();
    const pick = {
      ...(judged as CalibrationProfile),
      key: { model: "m-1", kind: "pick" as const },
    };
    expect(() => hookGateSpec("codex", { profile: pick })).toThrow(
      /not this gate's judge question/,
    );
    const elsewhere = {
      ...(judged as CalibrationProfile),
      key: { model: "m-1", kind: "judge" as const, questionHash: "0".repeat(16) },
    };
    expect(() => hookGateSpec("codex", { profile: elsewhere })).toThrow(
      /not this gate's judge question/,
    );
  });
});
