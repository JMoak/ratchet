/**
 * Reading labels under "confirm-wrong": every "wrong" needs a second blind reviewer, a tie needs
 * a third. The vote table, the acceptance test that may ask for it, a real Rollout reading
 * through it, and the review queue that collects the votes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { labelTables } from "../sim/labels.ts";
import {
  type AcceptancePlan,
  acceptanceProgress,
  acceptanceSample,
  cannotPass,
  earliestAccepted,
  evaluateAcceptance,
  failedWindow,
  type ResolvedPlan,
  resolvePlan,
  rightToAct,
} from "../src/acceptance.ts";
import { main, type ReviewIo } from "../src/cli/main.ts";
import { Engine } from "../src/engine.ts";
import type { GateSpec } from "../src/gate.ts";
import {
  actRightUnder,
  adjudicateRows,
  type LabelReading,
  readLabel,
} from "../src/ledger/labels.ts";
import {
  type DecisionRecord,
  hashState,
  JsonlLedger,
  MemoryLedger,
  type Outcome,
} from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { RolloutCheckpoint } from "../src/rollout.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------
// Rows and votes
// ---------------------------------------------------------------------------------------------

/** An act on a judge gate; `goIsYes` false is a gate that acts on "no" (pYes 0.03, go 0.97). */
function act(id: string, goIsYes = true): DecisionRecord {
  const pYes = goIsYes ? 0.97 : 0.03;
  return {
    id,
    at: "2026-11-12T00:00:00.000Z",
    gateId: "g",
    requestId: id,
    questionId: "q",
    kind: "judge",
    prompt: "ok?",
    questionHash: "0123456789abcdef",
    stateHash: id,
    trustedHash: id,
    untrusted: [],
    oracle: "o",
    strategy: "single",
    verdict: { kind: "judge", questionId: "q", pYes, confidence: 0.97 },
    go: 0.97,
    confidence: 0.97,
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: false,
    tags: [],
  };
}

let clock = 0;
/** A label saying acting was right or wrong, from `source` (absent: unsourced), on `row`'s gate. */
function vote(row: DecisionRecord, right: boolean, source?: string): Outcome {
  const goIsYes = row.verdict.kind === "judge" && row.go === row.verdict.pYes;
  const truth = right === goIsYes;
  const lean = row.verdict.kind === "judge" && row.verdict.pYes >= 0.5;
  clock++;
  return {
    at: `2026-11-12T00:00:${String(clock).padStart(2, "0")}.000Z`,
    correct: lean === truth,
    truth,
    ...(source !== undefined ? { source } : {}),
  };
}

/** The row as the ledger shows it after these labels, in order. */
function labelled(row: DecisionRecord, labels: readonly Outcome[]): DecisionRecord {
  const last = labels.at(-1);
  if (last === undefined) return row;
  return { ...row, outcome: last, ...(labels.length > 1 ? { labels } : {}) };
}

/** One label: right or wrong to act on, and its source (absent: unsourced). */
type V = readonly [boolean, (string | undefined)?];
const history = (row: DecisionRecord, votes: readonly V[]): DecisionRecord =>
  labelled(
    row,
    votes.map(([right, source]) => vote(row, right, source)),
  );

const status = (r: LabelReading) =>
  r.status === "settled"
    ? { status: r.status, right: r.right, votes: r.votes }
    : r.status === "awaiting"
      ? { status: r.status, needs: r.needs, votes: r.votes }
      : { status: r.status };

const ANA = "review:blind:ana";
const BEN = "review:blind:ben";
const CY = "review:blind:cy";

// ---------------------------------------------------------------------------------------------
// The vote table
// ---------------------------------------------------------------------------------------------

describe.each([
  ["yes", true],
  ["no", false],
])("the confirm-wrong vote table, on a gate whose go side is %s", (_side, goIsYes) => {
  const base = act("x", goIsYes);
  const read = (votes: readonly V[], filter = {}) =>
    status(readLabel(history(base, votes), "confirm-wrong", filter));

  it("no votes is unlabelled; one right settles right; one wrong awaits a second review", () => {
    expect(read([])).toEqual({ status: "unlabelled" });
    expect(read([[true, ANA]])).toEqual({
      status: "settled",
      right: true,
      votes: { right: 1, wrong: 0 },
    });
    expect(read([[false, ANA]])).toEqual({
      status: "awaiting",
      needs: "second-review",
      votes: { right: 0, wrong: 1 },
    });
  });

  it("a second reviewer's wrong settles wrong; a second reviewer's right is a tie", () => {
    const confirmed = readLabel(
      history(base, [
        [false, ANA],
        [false, BEN],
      ]),
      "confirm-wrong",
    );
    expect(status(confirmed)).toEqual({
      status: "settled",
      right: false,
      votes: { right: 0, wrong: 2 },
    });
    // The settling outcome is the latest label on the winning side.
    expect(confirmed.status === "settled" && confirmed.outcome.source).toBe(BEN);
    expect(
      read([
        [false, ANA],
        [true, BEN],
      ]),
    ).toEqual({ status: "awaiting", needs: "tie-break", votes: { right: 1, wrong: 1 } });
  });

  it("a third reviewer breaks a tie either way", () => {
    const right = readLabel(
      history(base, [
        [false, ANA],
        [true, BEN],
        [true, CY],
      ]),
      "confirm-wrong",
    );
    expect(status(right)).toEqual({
      status: "settled",
      right: true,
      votes: { right: 2, wrong: 1 },
    });
    expect(right.status === "settled" && right.outcome.source).toBe(CY);
    expect(
      read([
        [false, ANA],
        [true, BEN],
        [false, CY],
      ]),
    ).toEqual({ status: "settled", right: false, votes: { right: 1, wrong: 2 } });
    // The winning side's latest label settles it, even when a later label lost.
    const outvoted = readLabel(
      history(base, [
        [true, ANA],
        [true, BEN],
        [false, CY],
      ]),
      "confirm-wrong",
    );
    expect(outvoted.status === "settled" && outvoted.outcome.source).toBe(BEN);
  });

  it("one reviewer correcting themselves counts once, as their latest label", () => {
    expect(
      read([
        [false, ANA],
        [true, ANA],
      ]),
    ).toEqual({ status: "settled", right: true, votes: { right: 1, wrong: 0 } });
    expect(
      read([
        [true, ANA],
        [false, ANA],
      ]),
    ).toEqual({ status: "awaiting", needs: "second-review", votes: { right: 0, wrong: 1 } });
    expect(
      read([
        [false, ANA],
        [false, ANA],
      ]),
    ).toEqual({ status: "awaiting", needs: "second-review", votes: { right: 0, wrong: 1 } });
    // Ana's correction moves her vote after Ben's: the tie-break order follows the latest votes.
    const moved = readLabel(
      history(base, [
        [false, ANA],
        [false, BEN],
        [false, ANA],
      ]),
      "confirm-wrong",
    );
    expect(moved.status === "settled" && moved.outcome.source).toBe(ANA);
  });

  it("two labels from one source without a name are one reviewer", () => {
    for (const source of ["review:blind", "keywork:person", undefined]) {
      expect(
        read([
          [false, source],
          [false, source],
        ]),
        String(source),
      ).toEqual({ status: "awaiting", needs: "second-review", votes: { right: 0, wrong: 1 } });
    }
    // Different sources are different reviewers, named or not.
    expect(
      read([
        [false, "keywork:person"],
        [false, "review:blind"],
      ]),
    ).toEqual({ status: "settled", right: false, votes: { right: 0, wrong: 2 } });
  });

  it("a label from a source the filter does not admit is not a vote", () => {
    for (const source of ["reverted:git", "desk:assisted", "Reverted:git"]) {
      expect(
        read([
          [false, ANA],
          [false, source],
        ]),
        source,
      ).toEqual({ status: "awaiting", needs: "second-review", votes: { right: 0, wrong: 1 } });
      expect(read([[false, source]]), source).toEqual({ status: "unlabelled" });
    }
    // A filter that reads moment labels counts one.
    expect(
      read(
        [
          [false, ANA],
          [false, "desk:assisted"],
        ],
        { sources: ["blind", "moment"] },
      ),
    ).toEqual({ status: "settled", right: false, votes: { right: 0, wrong: 2 } });
  });

  it("a vote is read exactly as the acceptance test reads a label", () => {
    const unreadable: DecisionRecord = {
      ...base,
      verdict: { kind: "judge", questionId: "q", pYes: 0.5, confidence: 0.5 },
      go: 0.5,
    };
    const failed = { ...base, failedOpen: true };
    for (const row of [base, unreadable, failed]) {
      for (const right of [true, false]) {
        const o = vote(base, right, ANA);
        expect(actRightUnder(row, o)).toBe(rightToAct({ ...row, outcome: o }));
      }
    }
    // An unreadable act's every label is a wrong vote, so it can never settle right.
    expect(status(readLabel(history(unreadable, [[true, ANA]]), "confirm-wrong"))).toEqual({
      status: "awaiting",
      needs: "second-review",
      votes: { right: 0, wrong: 1 },
    });
  });

  it("latest reads only the row's outcome, as every reader always has", () => {
    const disputed = history(base, [
      [false, ANA],
      [true, BEN],
    ]);
    expect(status(readLabel(disputed, "latest"))).toEqual({
      status: "settled",
      right: true,
      votes: { right: 1, wrong: 0 },
    });
    const masked = history(base, [
      [true, ANA],
      [false, "reverted:git"],
    ]);
    expect(readLabel(masked, "latest")).toEqual({ status: "unlabelled" });
    // Under confirm-wrong the earlier trusted label still counts: a later untrusted one is no vote.
    expect(status(readLabel(masked, "confirm-wrong"))).toMatchObject({ right: true });
  });
});

describe("adjudicateRows: the rows a reader sees under a rule", () => {
  const settled = history(act("s"), [
    [false, ANA],
    [false, BEN],
    [true, CY],
  ]);
  const awaiting = history(act("w"), [[false, ANA]]);
  const tied = history(act("t"), [
    [false, ANA],
    [true, BEN],
  ]);
  const untrusted = history(act("u"), [[false, "reverted:git"]]);
  const plain = act("p");
  const rows = [settled, awaiting, tied, untrusted, plain];

  it("returns the rows as they are under latest", () => {
    const out = adjudicateRows(rows, "latest");
    expect(out).toEqual(rows);
    out.forEach((r, i) => {
      expect(r).toBe(rows[i]);
    });
  });

  it("under confirm-wrong: the settling label, no outcome while awaiting, the rest as they are", () => {
    const [s, w, t, u, p] = adjudicateRows(rows, "confirm-wrong");
    expect(s?.outcome?.source).toBe(BEN);
    expect(s?.labels).toEqual(settled.labels);
    expect(w).not.toHaveProperty("outcome");
    expect(t).not.toHaveProperty("outcome");
    expect(t?.labels).toEqual(tied.labels);
    expect(u).toBe(untrusted);
    expect(p).toBe(plain);
  });
});

// ---------------------------------------------------------------------------------------------
// The acceptance test under confirm-wrong
// ---------------------------------------------------------------------------------------------

describe("acceptance under confirm-wrong", () => {
  const target = 0.95;
  const confirm: AcceptancePlan = { target, adjudication: "confirm-wrong" };
  const plan = resolvePlan(confirm);
  const latest = resolvePlan({ target });
  const n = plan.sampleSize;
  const DISPUTED = 10;

  /** A complete sample, every act right by Ana, but act 10 labelled with `disputed` votes. */
  function sample(disputed: readonly V[]): DecisionRecord[] {
    return Array.from({ length: n }, (_, i) => {
      const r = act(`a${i}`);
      return history(r, i === DISPUTED ? disputed : [[true, ANA]]);
    });
  }

  /** Every reader of the module, under one plan, on one set of rows. */
  function readers(rows: readonly DecisionRecord[], p: AcceptancePlan | ResolvedPlan) {
    const resolved = "hash" in p ? p : resolvePlan(p);
    return {
      result: evaluateAcceptance(rows, p),
      progress: acceptanceProgress(rows, p),
      cannotPass: cannotPass(acceptanceSample(rows, resolved), resolved),
      failed: failedWindow(rows, resolved)?.map((r) => r.id),
      earliest: earliestAccepted(rows, resolved)?.map((r) => r.id),
    };
  }

  it("resolves into the plan and its identity only when it is confirm-wrong", () => {
    expect(plan.adjudication).toBe("confirm-wrong");
    expect(plan.hash).not.toBe(latest.hash);
    expect(latest).not.toHaveProperty("adjudication");
    expect(resolvePlan({ target, adjudication: "latest" })).toEqual(latest);
    // The default plan's identity is what it was before label rules existed.
    const before = { target, confidence: 0.95, maxErrors: 0, sampleSize: n, group: null };
    expect(latest.hash).toBe(hashState(JSON.stringify(before)));
    expect(() => resolvePlan({ target, adjudication: "majority" as unknown as "latest" })).toThrow(
      /adjudication must be "latest" or "confirm-wrong"/,
    );
  });

  it("one wrong label holds a complete sample awaiting labels, with the count, and rejects nothing", () => {
    const rows = sample([[false, ANA]]);
    const r = readers(rows, plan);
    expect(r.result).toEqual({
      status: "awaiting-labels",
      plan,
      unlabelled: 1,
      awaitingAdjudication: 1,
      sample: rows.map((x) => x.id),
    });
    expect(r.progress).toMatchObject({
      acts: n,
      labelled: n - 1,
      wrong: 0,
      untrusted: 0,
      awaitingAdjudication: 1,
      prefix: { acts: DISPUTED, right: DISPUTED, wrong: 0 },
      cannotPass: false,
    });
    expect(r.cannotPass).toBe(false);
    expect(r.failed).toBeUndefined();
    expect(r.earliest).toBeUndefined();
    // Read as today, the same rows reject.
    expect(readers(rows, latest).result).toMatchObject({ status: "rejected", errors: 1 });
  });

  it("a second reviewer's confirmation rejects, and every reader agrees", () => {
    const rows = sample([
      [false, ANA],
      [false, BEN],
    ]);
    const r = readers(rows, plan);
    expect(r.result).toMatchObject({ status: "rejected", errors: 1 });
    expect(r.result).not.toHaveProperty("awaitingAdjudication");
    expect(r.progress).toMatchObject({ labelled: n, wrong: 1, cannotPass: true });
    expect(r.progress).not.toHaveProperty("awaitingAdjudication");
    expect(r.cannotPass).toBe(true);
    expect(r.failed).toEqual(rows.map((x) => x.id));
    expect(r.earliest).toBeUndefined();
  });

  it("a second reviewer's right leaves it awaiting a tie-break, and a third right lets it pass", () => {
    const tied = sample([
      [false, ANA],
      [true, BEN],
    ]);
    const t = readers(tied, plan);
    expect(t.result).toMatchObject({
      status: "awaiting-labels",
      unlabelled: 1,
      awaitingAdjudication: 1,
    });
    expect(t.progress).toMatchObject({ awaitingAdjudication: 1, wrong: 0, cannotPass: false });
    expect(t.cannotPass).toBe(false);
    expect(t.failed).toBeUndefined();

    const settled = sample([
      [false, ANA],
      [true, BEN],
      [true, CY],
    ]);
    const s = readers(settled, plan);
    expect(s.result).toMatchObject({ status: "accepted", errors: 0 });
    expect(s.progress).toMatchObject({ labelled: n, wrong: 0, cannotPass: false });
    expect(s.progress).not.toHaveProperty("awaitingAdjudication");
    expect(s.cannotPass).toBe(false);
    expect(s.failed).toBeUndefined();
    expect(s.earliest).toEqual(settled.map((x) => x.id));
  });

  it("counts an act labelled only from a source the plan does not read as untrusted, not awaiting", () => {
    const rows = sample([[false, "reverted:git"]]);
    expect(evaluateAcceptance(rows, plan)).toEqual({
      status: "awaiting-labels",
      plan,
      unlabelled: 1,
      untrusted: 1,
      sample: rows.map((x) => x.id),
    });
  });

  it("changes nothing under the default: the same calls without the setting give the same results", () => {
    const cases = [
      sample([[false, ANA]]),
      sample([
        [false, ANA],
        [false, BEN],
      ]),
      sample([
        [false, ANA],
        [true, BEN],
      ]),
      sample([
        [false, ANA],
        [true, BEN],
        [true, CY],
      ]),
      sample([[false, "reverted:git"]]),
      sample([]),
      sample([[true, ANA]]).slice(0, n - 3),
    ];
    for (const rows of cases) {
      expect(readers(rows, { target, adjudication: "latest" })).toEqual(readers(rows, { target }));
      expect(readers(rows, latest)).toEqual(readers(rows, { target }));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Through a real Rollout
// ---------------------------------------------------------------------------------------------

class Fixed implements Oracle {
  readonly id = "fixed";
  async decide(_s: string, qs: readonly JudgeQuestion[]) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q, 0.99),
      oracle: this.id,
      cost: 0,
      latencyMs: 1,
      at: "2026-11-12T00:00:00.000Z",
    }));
  }
}

/** A promise of 50% at 50% confidence: a one-act plan, stated openly (as in b-rollout). */
const spec = (rollout: GateSpec["rollout"] = {}): GateSpec => ({
  id: "r",
  question: judge("Is it safe to run this command without asking?", { id: "bash.safe" }),
  policy: { actAbove: 0.9 },
  evidenceVersion: "v1",
  promisedAccuracy: 0.5,
  auditRate: 0.2,
  rollout: { confidence: 0.5, minAuditRows: 3, adjudication: "confirm-wrong", ...rollout },
});

describe("a Rollout under confirm-wrong", () => {
  it("holds a disputed label in shadow without rejecting, promotes once it settles, and verifies it on restart", async () => {
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: new Fixed(), ledger });
    const gate = engine.gate(spec());
    await gate.ask("before the controller");
    await gate.rollout.evaluate();
    const r = await gate.ask("the one planned act");
    const label = (right: boolean, source: string) =>
      engine.label(r.recordId, { correct: right, truth: right, source });

    await label(false, ANA);
    const disputed = await gate.rollout.evaluate();
    expect(disputed.mode).toBe("shadow");
    expect(disputed.reason).toMatch(/^holding: the planned sample is complete; 1 of its 1 acts/);
    expect(disputed.acceptance).toMatchObject({
      status: "awaiting-labels",
      awaitingAdjudication: 1,
    });
    expect(gate.rollout.checkpoint()).toMatchObject({ mode: "shadow", rejected: false });
    expect(await gate.rollout.progress()).toMatchObject({
      phase: "shadow",
      acceptance: { awaitingAdjudication: 1, cannotPass: false },
    });

    await label(true, BEN);
    const tied = await gate.rollout.evaluate();
    expect(tied.mode).toBe("shadow");
    expect(tied.acceptance).toMatchObject({ awaitingAdjudication: 1 });
    expect(gate.rollout.checkpoint()).toMatchObject({ rejected: false });

    await label(true, CY);
    const promoted = await gate.rollout.evaluate();
    expect(promoted.mode).toBe("enforce");
    expect(promoted.reason).toMatch(/^promoted: 0 wrong of 1 planned acts/);
    // Ana restates her "wrong" after the promotion: still one outvoted reviewer, but now the
    // latest label, so only the confirm-wrong reading keeps the sample passing.
    await label(false, ANA);
    const checkpoint = gate.rollout.checkpoint();
    expect(checkpoint).toMatchObject({ mode: "enforce", accepted: { sample: [r.recordId] } });

    const restored = new Engine({ oracle: new Fixed(), ledger });
    const again = restored.gate(spec({ checkpoint: checkpoint as RolloutCheckpoint }));
    const back = await again.rollout.evaluate();
    expect(back.mode).toBe("enforce");
    // The plan's rule is part of its identity: the same checkpoint under the default rule is
    // another configuration, which starts a fresh phase.
    const other = new Engine({ oracle: new Fixed(), ledger });
    const latestGate = other.gate(
      spec({ adjudication: "latest", checkpoint: checkpoint as RolloutCheckpoint }),
    );
    const reset = await latestGate.rollout.evaluate();
    expect(reset.mode).toBe("shadow");
    expect(reset.reason).toContain("evidence configuration changed");
    // Read as today, the promoted sample would no longer pass.
    const phase = (await ledger.all()).filter((x) => x.id === r.recordId);
    expect(evaluateAcceptance(phase, { target: 0.5, confidence: 0.5 }).status).toBe("rejected");
  });

  it("grades a shadow phase as the plan reads its labels, so the grade agrees with the test", async () => {
    const engine = new Engine({ oracle: new Fixed(), ledger: new MemoryLedger() });
    // A 90% promise at 50% confidence: a seven-act plan, so one disputed act holds the sample
    // while enough later rows are labelled to grade the phase estimated.
    const gate = engine.gate({ ...spec(), promisedAccuracy: 0.9 });
    await gate.rollout.evaluate();
    const first = await gate.ask("the disputed act");
    const label = (right: boolean, source: string) =>
      engine.label(first.recordId, { correct: right, truth: right, source });
    for (let i = 0; i < 34; i++) {
      const r = await gate.ask(`a clean act ${i}`);
      await engine.label(r.recordId, { correct: true, truth: true, source: ANA });
    }

    // One "wrong" vote: acceptance waits for a second review, and the grade does not count the
    // act wrong either. Read by its latest label it was 34 of 35.
    await label(false, ANA);
    const disputed = await gate.rollout.evaluate();
    expect(disputed.acceptance).toMatchObject({ status: "awaiting-labels" });
    expect(disputed.grade).toMatchObject({ kind: "estimated", n: 34, accuracy: 1 });

    // Wrong, wrong, then right: the latest label is the losing vote. The test rejects, and the
    // grade reads the act wrong with it, at the rejection and on every status after.
    await label(false, BEN);
    await label(true, CY);
    const rejected = await gate.rollout.evaluate();
    expect(rejected.reason).toMatch(/^rejected: 1 wrong of 7 planned acts/);
    expect(rejected.grade).toMatchObject({ kind: "estimated", n: 35, accuracy: 34 / 35 });
    // The rejection starts a fresh phase, which is graded the same way while it is held: a new
    // disputed act is unlabelled to the grade, not one wrong of 31.
    for (let i = 0; i < 30; i++) {
      const r = await gate.ask(`a later act ${i}`);
      await engine.label(r.recordId, { correct: true, truth: true, source: ANA });
    }
    const later = await gate.ask("a later disputed act");
    await engine.label(later.recordId, { correct: false, truth: false, source: ANA });
    const held = await gate.rollout.evaluate();
    expect(held.reason).toMatch(/^holding shadow: this configuration was rejected/);
    expect(held.grade).toMatchObject({ kind: "estimated", n: 30, accuracy: 1 });
  });

  it("refuses an unknown rule as an invalid plan, holding shadow", async () => {
    const engine = new Engine({ oracle: new Fixed(), ledger: new MemoryLedger() });
    const gate = engine.gate(spec({ adjudication: "vote" as unknown as "latest" }));
    const s = await gate.rollout.evaluate();
    expect(s.mode).toBe("shadow");
    expect(s.reason).toContain("invalid acceptance plan: adjudication must be");
  });
});

// ---------------------------------------------------------------------------------------------
// The review command's adjudication queue
// ---------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function scripted(answers: readonly string[]): ReviewIo & { printed: string[] } {
  const queue = [...answers];
  const io = {
    printed: [] as string[],
    print: (text: string) => {
      io.printed.push(text);
    },
    ask: async () => queue.shift(),
  };
  return io;
}

/** pYes by state; "s6" is held for review (0.6 < 0.8), every other state is an act. */
const byState: Oracle = {
  id: "table",
  async decide(state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, state === "s6" ? 0.6 : 0.9),
      oracle: "table",
      latencyMs: 0,
      cost: 0,
      at: "2026-11-12T00:00:00.000Z",
    }));
  },
};

/**
 * A gate whose acts carry every kind of label history:
 * s0 wrong by Ana (awaits a second review), s1 wrong by Ana and right by Ben (a tie), s2 right by
 * Ana, s3 wrong by Ana and Ben (settled), s4 unlabelled, s5 wrong by Ben, s6 a held row labelled
 * wrong (not an act), s7 wrong by a census label, s8 wrong only by a revert (not a vote).
 */
async function disputedLedger() {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-adjudicate-"));
  dirs.push(dir);
  const path = join(dir, "ledger.jsonl");
  const engine = new Engine({ oracle: byState, ledger: new JsonlLedger(path), keepState: true });
  const gate = engine.gate({
    id: "tool",
    question: judge("ok?", { id: "ok" }),
    policy: { actAbove: 0.8 },
  });
  const ids: Record<string, string> = {};
  for (let i = 0; i <= 8; i++) ids[`s${i}`] = (await gate.ask(`s${i}`)).recordId;
  const label = (s: string, right: boolean, source: string) =>
    engine.label(ids[s] as string, { correct: right, truth: right, source });
  await label("s0", false, ANA);
  await label("s1", false, ANA);
  await label("s1", true, BEN);
  await label("s2", true, ANA);
  await label("s3", false, ANA);
  await label("s3", false, BEN);
  await label("s5", false, BEN);
  await label("s6", false, ANA);
  await label("s7", false, "keywork:person");
  await label("s8", false, "reverted:git");
  return { path, ids };
}

const items = (io: { printed: string[] }) =>
  [...io.printed.join("").matchAll(/--- \d+ of \d+ ---\n(s\d)\n/g)].map((m) => m[1]);

describe("ratchet review --adjudicate", () => {
  it("queues exactly the acts awaiting a vote this reviewer has not given, shown blind", async () => {
    const { path, ids } = await disputedLedger();
    const io = scripted(["n", "y"]);

    const result = await main(
      ["review", path, "--gate", "tool", "--adjudicate", "--reviewer", "ben"],
      io,
    );

    expect(result.exitCode).toBe(0);
    // s1 and s5 await a vote, but Ben has given one; s2, s3 are settled, s4 unlabelled, s6 not an
    // act, s8's only label not a vote.
    expect(items(io)).toEqual(["s0", "s7"]);
    const shown = io.printed.join("");
    expect(shown).toContain(
      "Blind review of tool: every act awaiting adjudication that ben has not labelled, 2 of 4 rows.",
    );
    // Neither the model's answer nor any earlier label is shown before the answers.
    expect(shown).not.toMatch(/ana|keywork|truth|true|false|wrong|0\.9|lean/);
    const rows = new Map((await new JsonlLedger(path).all()).map((r) => [r.id, r]));
    for (const s of ["s0", "s7"]) {
      const row = rows.get(ids[s] as string);
      expect(row?.outcome?.source).toBe(BEN);
      expect(row?.labels).toHaveLength(2);
    }
    expect(result.output).toContain(
      "Recorded 2 blind labels for tool (every act awaiting adjudication).",
    );
    expect(result.output).toContain(
      "Adjudicated 2: 1 now settled wrong to act on, 0 settled right, 1 still awaiting a tie-break.\n",
    );

    // Cy's queue: the tie at s1, Ben's lone wrong at s5, and the tie Ben just made at s7.
    const cy = scripted(["y", "y", "n"]);
    const third = await main(
      ["review", path, "--gate", "tool", "--adjudicate", "--reviewer", "cy"],
      cy,
    );
    expect(items(cy)).toEqual(["s1", "s5", "s7"]);
    expect(third.output).toContain(
      "Adjudicated 3: 1 now settled wrong to act on, 1 settled right, 1 still awaiting a tie-break.\n",
    );

    // Only s5 still awaits a vote, and Ben has given one.
    const none = await main(
      ["review", path, "--gate", "tool", "--adjudicate", "--reviewer", "ben"],
      scripted([]),
    );
    expect(none.exitCode).toBe(2);
    expect(none.output).toContain("already carries a label from review:blind:ben");
  });

  it("refuses to combine with another queue, or to run without a reviewer's name", async () => {
    const { path } = await disputedLedger();
    for (const other of ["--denied", "--audits"]) {
      const r = await main(
        ["review", path, "--gate", "tool", "--adjudicate", other, "--reviewer", "ben"],
        scripted([]),
      );
      expect(r.exitCode, other).toBe(2);
      expect(r.output).toContain("--adjudicate is a separate queue from --denied and --audits");
    }
    const anonymous = await main(["review", path, "--gate", "tool", "--adjudicate"], scripted([]));
    expect(anonymous.exitCode).toBe(2);
    expect(anonymous.output).toContain("--adjudicate needs --reviewer <name>");
    expect(anonymous.output).toContain('Run "ratchet help review" for usage.');
  });

  it("says so when nothing awaits adjudication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ratchet-adjudicate-"));
    dirs.push(dir);
    const path = join(dir, "ledger.jsonl");
    const engine = new Engine({ oracle: byState, ledger: new JsonlLedger(path), keepState: true });
    const gate = engine.gate({
      id: "tool",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.8 },
    });
    const r = await gate.ask("s0");
    await engine.label(r.recordId, { correct: true, truth: true, source: ANA });
    const res = await main(
      ["review", path, "--gate", "tool", "--adjudicate", "--reviewer", "ben"],
      scripted([]),
    );
    expect(res.exitCode).toBe(2);
    expect(res.output).toContain("whose label awaits a second review or a tie-break");
  });

  it("leaves the other queues as they were: histories do not put a reviewed row back in them", async () => {
    const { path } = await disputedLedger();
    const io = scripted(Array(10).fill("s"));
    await main(["review", path, "--gate", "tool", "--seed", "3", "--sample", "10"], io);
    // The rows whose latest label is not a review: s4 (none), s7 (census), s8 (revert).
    expect(new Set(items(io))).toEqual(new Set(["s4", "s7", "s8"]));
    expect(io.printed.join("")).toContain("Blind review of tool: 3 of 3 unreviewed rows, seed 3.");
    const denied = scripted(Array(10).fill("s"));
    await main(["review", path, "--gate", "tool", "--denied"], denied);
    expect(items(denied)).toEqual(["s7", "s8"]);
  });
});

/** What a sim table prints, captured from the console. */
function printed(run: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("sim/labels.ts reproduces the foundations review's figures", () => {
  it("prints the pass probabilities and extra reviews the research note gives", () => {
    const out = printed(labelTables);
    // One review: a perfect gate at e1 1.25% and 2%; a 99% gate at 1.25% (e2 10%).
    expect(out).toMatch(/\| 100\.0% +\| 1\.25% +\| 15\.3% +\| 95\.5% +\| 0\.031% +\| 3\.7 +\|/);
    expect(out).toMatch(/\| 100\.0% +\| 2\.00% +\| 4\.9% +\|/);
    // Protocol P1 on a 99% gate: 0.040 to 0.252 for 5.1 extra reviews; 0.123 to 0.262 for 2.9.
    expect(out).toMatch(/\| 99\.0% +\| 1\.25% +\| 4\.0% +\| 25\.2% +\| 0\.031% +\| 5\.1 +\|/);
    expect(out).toMatch(/\| 99\.0% +\| 0\.50% +\| 12\.3% +\| 26\.2% +\| 0\.005% +\| 2\.9 +\|/);
  });
});
