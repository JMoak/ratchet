import { describe, expect, it } from "vitest";
import { acceptanceProgress, resolvePlan } from "../src/acceptance.ts";
import {
  type DetectorSpec,
  type DetectorState,
  detectorStatistic,
  falseAlarmBound,
  fewestAlarmErrors,
  outgoingQualityLimit,
  startDetector,
  stepDetector,
  worstOutgoingQuality,
} from "../src/anytime.ts";
import { Engine } from "../src/engine.ts";
import type { Gate, GateSpec } from "../src/gate.ts";
import {
  type DecisionRecord,
  hashQuestion,
  hashState,
  MemoryLedger,
} from "../src/ledger/ledger.ts";
import { rng } from "../src/math.ts";
import { hashPolicy } from "../src/policy.ts";
import { judge } from "../src/questions.ts";
import {
  type DemotionSettings,
  describeProgress,
  type RolloutCheckpoint,
  type RolloutSettings,
  type RolloutStatus,
} from "../src/rollout.ts";
import type { Oracle } from "../src/types.ts";

const AT = "2026-11-12T00:00:00.000Z";
const question = judge("Is this call safe to run without asking?", { id: "safe" });

/** Always sure the call is safe: every ask is an act, and the label alone says if it was right. */
const oracle: Oracle = {
  id: "demotion-fixture",
  decide: async (_state, questions) =>
    questions.map((q) => ({
      oracle: "demotion-fixture",
      verdict: { kind: "judge" as const, questionId: q.id, pYes: 0.95, confidence: 0.95 },
      cost: 0,
      latencyMs: 0,
      at: AT,
    })),
};

/**
 * A deliberately weak plan, stated openly: six clean acts at 10% confidence promote. These tests
 * are about demotion; the promise is a real 98%, so the detector bets as it would in use.
 */
const PLAN = resolvePlan({ target: 0.98, confidence: 0.1 });

/** Every enforce act is audited (rate 1) unless a test says otherwise. */
function spec(rollout: RolloutSettings = {}, extra: Partial<GateSpec> = {}): GateSpec {
  return {
    id: "demotion-gate",
    question,
    policy: { actAbove: 0.8 },
    evidenceVersion: "demotion-v1",
    promisedAccuracy: 0.98,
    auditRate: 1,
    ...extra,
    rollout: { confidence: 0.1, now: () => AT, ...rollout },
  };
}

const gateWith = (
  rollout: RolloutSettings = {},
  extra: Partial<GateSpec> = {},
  ledger?: MemoryLedger,
) => new Engine({ oracle, ...(ledger !== undefined ? { ledger } : {}) }).gate(spec(rollout, extra));

/** Right or wrong to act on, optionally from a named source; undefined leaves the act unlabelled. */
type Label = boolean | { readonly right: boolean; readonly source: string } | undefined;

const outcome = (label: boolean | { readonly right: boolean; readonly source: string }) =>
  typeof label === "boolean"
    ? { correct: label, truth: label }
    : { correct: label.right, truth: label.right, source: label.source };

let asked = 0;

/** Ask a new state (a repeated one is a retry) and label it. */
async function ask(gate: Gate, label?: Label): Promise<string> {
  const r = await gate.ask(`state-${++asked}`);
  if (label !== undefined) await gate.engine.label(r.recordId, outcome(label));
  return r.recordId;
}

/** An enforce act that the gate's audit draw sent to review. */
async function audit(gate: Gate, label?: Label): Promise<string> {
  const r = await gate.ask(`state-${++asked}`);
  expect(r.audited).toBe(true);
  if (label !== undefined) await gate.engine.label(r.recordId, outcome(label));
  return r.recordId;
}

/** Initialize, collect the planned sample with every act right, and promote. */
async function promote(gate: Gate, acts = PLAN.sampleSize): Promise<RolloutStatus> {
  await gate.rollout.evaluate();
  for (let i = 0; i < acts; i++) await ask(gate, true);
  const s = await gate.rollout.evaluate();
  expect(s.mode).toBe("enforce");
  return s;
}

const SR: DetectorSpec = { promise: 0.98, threshold: 1000 };
const feed = (outcomes: readonly boolean[], s = SR): DetectorState =>
  outcomes.reduce((state, wrong) => stepDetector(s, state, wrong), startDetector(s));

describe("the window rule is untouched", () => {
  it("gives today's statuses, reasons and scope hash with no setting and with { kind: 'window' }", async () => {
    const ledger = new MemoryLedger();
    const today = gateWith({ minAuditRows: 3 }, {}, ledger);
    const explicit = gateWith({ minAuditRows: 3, demotion: { kind: "window" } }, {}, ledger);
    // Both controllers read the same ledger; only `today`'s gate asks.
    const both = async (): Promise<RolloutStatus> => {
      const a = await today.rollout.evaluate();
      const b = await explicit.rollout.evaluate();
      expect(b).toEqual(a);
      expect(a).not.toHaveProperty("demotion");
      expect(explicit.rollout.checkpoint()).toEqual(today.rollout.checkpoint());
      expect(explicit.mode).toBe(today.mode);
      return a;
    };
    await both();
    // The scope hash is the one this release computed before demotion kinds existed.
    const scopeHash = hashState(
      JSON.stringify({
        gateId: "demotion-gate",
        questionId: null,
        version: "demotion-v1",
        model: null,
        policyHash: hashPolicy({ actAbove: 0.8 }),
        questionHash: hashQuestion(question),
        plan: PLAN.hash,
        window: 200,
        minAuditRows: 3,
      }),
    );
    expect(today.rollout.checkpoint()?.scopeHash).toBe(scopeHash);
    for (let i = 0; i < PLAN.sampleSize; i++) await ask(today, true);
    const promoted = await both();
    expect(promoted.reason).toMatch(
      /^promoted: 0 wrong of 6 planned acts; exact 10% lower bound [\d.]+% >= promised 98\.0%$/,
    );
    for (let i = 0; i < 3; i++) await audit(today, true);
    expect((await both()).reason).toBe(
      "live: 3 current-phase audited rows; 3 audited acts at 100.0% hold the promised 98.0%",
    );
    await audit(today, false);
    const demoted = await both();
    expect(demoted).toMatchObject({
      mode: "shadow",
      changed: true,
      reason: "demoted: 4 audited acts at 75.0% below promised 98.0%",
      audits: { n: 4, acted: 4, accuracy: 0.75 },
    });
    expect((await today.rollout.progress()).phase).toBe("shadow");
  });
});

describe("the detector", () => {
  it("demotes after four consecutive audited errors at threshold 1000 for a 98% promise, not three", async () => {
    expect(fewestAlarmErrors(SR)).toBe(4);
    const gate = gateWith({ demotion: { kind: "detector" } });
    const promoted = await promote(gate);
    expect(promoted.reason).toContain(
      "; demotion: a Shiryaev-Roberts detector at threshold 1000; 4 consecutive audited errors can demote it, about 4 acts at an audit rate of 1",
    );
    expect(promoted).not.toHaveProperty("demotion");
    for (let i = 0; i < 3; i++) await audit(gate, false);
    const three = await gate.rollout.evaluate();
    expect(three).toMatchObject({
      mode: "enforce",
      changed: false,
      demotion: {
        kind: "detector",
        rule: "shiryaev-roberts",
        audited: 3,
        read: 3,
        wrong: 3,
        pending: 0,
        untrusted: 0,
        overdue: false,
        threshold: 1000,
        falseAlarmBound: 0.003,
        alarmed: false,
      },
    });
    expect(three).not.toHaveProperty("audits");
    expect(three.demotion?.kind === "detector" && three.demotion.statistic).toBe(
      detectorStatistic(feed([true, true, true])),
    );
    expect(three.reason).toMatch(
      /^live: 3 current-phase audited acts; the Shiryaev-Roberts detector read 3, 3 wrong: statistic [\d.]+ below threshold 1000$/,
    );

    await audit(gate, false);
    const four = await gate.rollout.evaluate();
    expect(four).toMatchObject({
      mode: "shadow",
      changed: true,
      demotion: { read: 4, wrong: 4, alarmed: true, falseAlarmBound: 0.004 },
    });
    expect(four.reason).toMatch(
      /^demoted: the Shiryaev-Roberts detector alarmed on 4 audited acts read in ledger order, 4 wrong: statistic \d+ reached threshold 1000; for a gate that keeps its promised 98\.0%, an alarm within 4 audits has probability at most 0\.40%$/,
    );
    expect(four.demotion?.kind === "detector" && four.demotion.statistic).toBe(
      detectorStatistic(feed([true, true, true, true])),
    );

    // A fresh shadow phase, then a fresh detector: the old phase's errors are not carried over.
    expect((await gate.rollout.evaluate()).acceptance).toMatchObject({
      status: "collecting",
      acts: 0,
    });
    for (let i = 0; i < PLAN.sampleSize; i++) await ask(gate, true);
    expect((await gate.rollout.evaluate()).mode).toBe("enforce");
    for (let i = 0; i < 3; i++) await audit(gate, false);
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "enforce",
      demotion: { audited: 3, read: 3, alarmed: false },
    });
  });

  it("states the fewest errors in acts at the gate's audit rate", async () => {
    const gate = gateWith({ demotion: { kind: "detector" } }, { auditRate: 0.2 });
    const promoted = await promote(gate);
    expect(promoted.reason).toContain(
      "4 consecutive audited errors can demote it, about 20 acts at an audit rate of 0.2",
    );
    const cusum = gateWith(
      { demotion: { kind: "detector", rule: "cusum", threshold: 100 } },
      {
        auditRate: 0.2,
      },
    );
    expect((await promote(cusum)).reason).toContain(
      "a CUSUM detector at threshold 100; 3 consecutive audited errors can demote it, about 15 acts",
    );
  });

  it("demotes gates exactly at their promise within n/A, each exactly when the detector alarms", async () => {
    // 200 independent gates, each with 500 audited acts wrong with probability exactly 0.02, at
    // A = 2,500: the bound n/A is 20%. The cost is gates x audits rows read by the real
    // controller, and at a fixed n/A the standard error depends on the number of gates alone, so
    // shorter streams keep the test as sharp as 2,000 audits at A = 10,000 did, at a quarter of
    // the cost. 500 audits still exceed the window rule's default 200, so a phase cut to a window
    // would show.
    const gates = 200;
    const audits = 500;
    const threshold = 2_500;
    const settings: RolloutSettings = { demotion: { kind: "detector", threshold } };
    const detector: DetectorSpec = { promise: 0.98, threshold };
    // Promote once, through a real planned sample, and audit one real act. Every gate starts from
    // the same promotion rows and is restored from the same checkpoint, which each restore
    // verifies against its own ledger; its audits are built from that real audited row, each with
    // its own id and label.
    const shared = new MemoryLedger();
    const promoted = gateWith(settings, {}, shared);
    await promote(promoted);
    const template = (await shared.get(await audit(promoted, true))) as DecisionRecord;
    const checkpoint = promoted.rollout.checkpoint() as RolloutCheckpoint;
    const base = (await shared.all()).filter((r) => r.id !== template.id);
    const rand = rng(1112);
    let demoted = 0;
    for (let g = 0; g < gates; g++) {
      const ledger = new MemoryLedger();
      for (const r of base) await ledger.append(r);
      // The module's detector on the same stream says where, if anywhere, it alarms.
      let state = startDetector(detector);
      for (let i = 0; i < audits; i++) {
        const right = rand() >= 0.02;
        if (!state.alarmed) state = stepDetector(detector, state, !right);
        const id = `${g}-audit-${i}`;
        await ledger.append({
          ...template,
          id,
          requestId: id,
          stateHash: id,
          trustedHash: id,
          outcome: { at: AT, correct: right, truth: right },
        });
      }
      const s = await gateWith({ ...settings, checkpoint }, {}, ledger).rollout.evaluate();
      // Exactly the module's decision, at the audit that raised it; otherwise every audit read.
      expect(s.mode).toBe(state.alarmed ? "shadow" : "enforce");
      expect(s.demotion).toMatchObject({ audited: audits, read: state.audits, pending: 0 });
      if (s.mode === "shadow") demoted++;
    }
    const bound = falseAlarmBound(audits, threshold);
    // The guarantee bounds the true rate by n/A. Over 200 independent gates the observed share has
    // a standard error of at most sqrt(0.2 x 0.8 / 200) = 0.028 at the bound, so exceeding it by
    // three of them happens with probability under 0.2% for a controller that keeps the guarantee.
    const se = Math.sqrt((bound * (1 - bound)) / gates);
    expect(demoted / gates).toBeLessThanOrEqual(bound + 3 * se);
    // A controller that never read the audits would never alarm; the module alone alarms on about
    // 8.9% of such streams (20,000 seeded runs), so no alarm in 200 gates has probability below 1e-8.
    expect(demoted).toBeGreaterThan(0);
  });

  it("stops at an unlabelled audit and reads nothing after it until it is labelled", async () => {
    const gate = gateWith({ demotion: { kind: "detector" } });
    await promote(gate);
    const waiting = await audit(gate);
    for (let i = 0; i < 4; i++) await audit(gate, false);
    const held = await gate.rollout.evaluate();
    expect(held).toMatchObject({
      mode: "enforce",
      demotion: {
        audited: 5,
        read: 0,
        wrong: 0,
        pending: 1,
        untrusted: 0,
        firstPending: { id: waiting, later: 4 },
        overdue: false,
        statistic: 0,
        alarmed: false,
      },
    });
    expect(held.reason).toContain(
      "; 1 still without a label the plan reads, and the detector reads nothing past the first of them",
    );
    await gate.engine.label(waiting, { correct: true, truth: true });
    const demoted = await gate.rollout.evaluate();
    expect(demoted).toMatchObject({
      mode: "shadow",
      demotion: { audited: 5, read: 5, wrong: 4, pending: 0, alarmed: true },
    });
    expect(demoted.demotion?.kind === "detector" && demoted.demotion.statistic).toBe(
      detectorStatistic(feed([false, true, true, true, true])),
    );
  });

  it("reads a label only from a source the plan reads", async () => {
    const gate = gateWith({ demotion: { kind: "detector" } });
    await promote(gate);
    const reverted: string[] = [];
    for (let i = 0; i < 4; i++)
      reverted.push(await audit(gate, { right: false, source: "reverted:git" }));
    const held = await gate.rollout.evaluate();
    expect(held).toMatchObject({
      mode: "enforce",
      demotion: { audited: 4, read: 0, wrong: 0, pending: 4, untrusted: 4 },
    });
    expect(held.reason).toContain("(4 labelled only from sources it does not read)");
    // A blind review of the same audits is read.
    for (const id of reverted) {
      await gate.engine.label(id, { correct: false, truth: false, source: "review:blind:r" });
    }
    expect(await gate.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      demotion: { read: 4, wrong: 4, untrusted: 0, alarmed: true },
    });
  });

  it("reproduces its readout from the ledger after a restart, storing nothing new", async () => {
    const ledger = new MemoryLedger();
    const settings: RolloutSettings = { demotion: { kind: "detector" } };
    const gate = gateWith(settings, {}, ledger);
    await promote(gate);
    await audit(gate, false);
    await audit(gate, true);
    await audit(gate);
    await audit(gate, false);
    const before = await gate.rollout.evaluate();
    expect(before.demotion).toMatchObject({ audited: 4, read: 2, wrong: 1, pending: 1 });
    const checkpoint = JSON.parse(JSON.stringify(gate.rollout.checkpoint())) as RolloutCheckpoint;
    expect(Object.keys(checkpoint).sort()).toEqual([
      "accepted",
      "afterId",
      "format",
      "mode",
      "rejected",
      "scopeHash",
    ]);
    const restarted = gateWith({ ...settings, checkpoint }, {}, ledger);
    const after = await restarted.rollout.evaluate();
    expect(after).toMatchObject({ mode: "enforce", changed: true });
    expect(after.demotion).toEqual(before.demotion);
  });
});

describe("overdue audits", () => {
  it.each(["report", "demote"] as const)(
    "%s an audit left unlabelled while later ones are audited",
    async (action) => {
      const gate = gateWith({ demotion: { kind: "detector", overdue: { after: 2, action } } });
      await promote(gate);
      const missing = await audit(gate);
      await audit(gate, true);
      expect(await gate.rollout.evaluate()).toMatchObject({
        mode: "enforce",
        demotion: { overdue: false, firstPending: { id: missing, later: 1 } },
      });
      await audit(gate, true);
      const s = await gate.rollout.evaluate();
      // Never a step of the detector: the missing label is not read as an error.
      expect(s.demotion).toMatchObject({ read: 0, wrong: 0, statistic: 0, overdue: true });
      if (action === "report") {
        expect(s.mode).toBe("enforce");
        expect(s.reason).toContain(
          `; overdue: audit ${missing} has had no label the plan reads while 2 later ones were audited`,
        );
      } else {
        expect(s).toMatchObject({ mode: "shadow", changed: true });
        expect(s.reason).toBe(
          `demoted: audit ${missing} has had no label the plan reads while 2 later ones were audited, at least the 2 allowed; a missing label is never read as an error, so an overdue audit returns the gate to shadow instead`,
        );
      }
    },
  );

  it("reports by default once 30 later audits exist, and works the same under first-error", async () => {
    const gate = gateWith({ demotion: { kind: "detector" } });
    await promote(gate);
    const missing = await audit(gate);
    for (let i = 0; i < 29; i++) await audit(gate, true);
    expect((await gate.rollout.evaluate()).demotion).toMatchObject({ overdue: false });
    await audit(gate, true);
    const s = await gate.rollout.evaluate();
    expect(s).toMatchObject({
      mode: "enforce",
      demotion: { overdue: true, firstPending: { id: missing, later: 30 } },
    });

    const first = gateWith({
      demotion: { kind: "first-error", overdue: { after: 1, action: "demote" } },
    });
    await promote(first);
    await audit(first);
    await audit(first, true);
    expect(await first.rollout.evaluate()).toMatchObject({
      mode: "shadow",
      demotion: { kind: "first-error", read: 1, wrong: 0, overdue: true },
    });
  });
});

describe("first-error", () => {
  it("demotes at the first wrong audited act, which a pending audit cannot hide", async () => {
    const gate = gateWith({ demotion: { kind: "first-error" } });
    const promoted = await promote(gate);
    expect(promoted.reason).toContain("; demotion: the first audited error returns it to shadow");
    await audit(gate, true);
    const pending = await audit(gate);
    await audit(gate, true);
    const live = await gate.rollout.evaluate();
    expect(live).toMatchObject({
      mode: "enforce",
      demotion: {
        kind: "first-error",
        audited: 3,
        read: 2,
        wrong: 0,
        pending: 1,
        firstPending: { id: pending, later: 1 },
        overdue: false,
      },
    });
    expect(live.reason).toBe(
      "live: 3 current-phase audited acts; 2 labelled, none wrong; the first audited error returns the gate to shadow; 1 still without a label the plan reads",
    );
    const wrong = await audit(gate, false);
    const demoted = await gate.rollout.evaluate();
    expect(demoted).toMatchObject({
      mode: "shadow",
      changed: true,
      demotion: { audited: 4, read: 3, wrong: 1, pending: 1 },
    });
    expect(demoted.reason).toBe(
      `demoted: audited act ${wrong} was wrong to act on, and the first audited error returns the gate to shadow (3 labelled of 4 audited acts read, 1 wrong)`,
    );
  });

  it("states the outgoing-quality limit of a zero-error plan, and none when the plan allows errors", async () => {
    // The default plan for 98%: 149 acts, none wrong, so the clearance is 149 consecutive right acts.
    const zero = gateWith(
      { confidence: 0.95, demotion: { kind: "first-error" } },
      { auditRate: 0.2 },
    );
    const promoted = await promote(zero, 149);
    expect((100 * outgoingQualityLimit(149, 0.2).limit).toPrecision(3)).toBe("0.479");
    expect((100 * worstOutgoingQuality(149, 0.2)).toPrecision(3)).toBe("2.60");
    expect(promoted.reason).toContain(
      "; demotion: the first audited error returns it to shadow; as a continuous sampling plan with a 149-act clearance, at most 0.479% of act-eligible decisions become wrong executed acts at any stationary error rate, and 2.60% against any error sequence that cannot see the audit draw, if audit labels are correct and prompt",
    );

    const allowing = { confidence: 0.1, maxErrors: 1, demotion: { kind: "first-error" } } as const;
    const loose = gateWith(allowing, { auditRate: 0.2 });
    const size = resolvePlan({ target: 0.98, confidence: 0.1, maxErrors: 1 }).sampleSize;
    const reason = (await promote(loose, size)).reason;
    expect(reason).toContain(
      "; demotion: the first audited error returns it to shadow; no outgoing-quality limit is stated, because the plan allows 1 wrong act in its planned sample",
    );
    expect(reason).not.toContain("act-eligible");
  });
});

describe("audits off", () => {
  it.each([{ kind: "detector" }, { kind: "first-error" }] as const)(
    "nothing can demote under $kind, and the status says so",
    async (demotion) => {
      const gate = gateWith({ demotion }, { auditRate: 0 });
      const promoted = await promote(gate);
      expect(promoted.reason).toContain(
        "; audits are off, so no evidence can demote this gate: set an audit rate to watch it",
      );
      expect(promoted.reason).not.toContain("demotion:");
      for (let i = 0; i < 5; i++) await ask(gate, false);
      expect(await gate.rollout.evaluate()).toMatchObject({
        mode: "enforce",
        reason:
          "live: 0 current-phase audited acts; audits are off, so nothing can demote this gate",
        demotion: { kind: demotion.kind, audited: 0, read: 0, wrong: 0, pending: 0 },
      });
    },
  );
});

describe("the demotion setting is part of the configuration", () => {
  const hashOf = async (demotion?: DemotionSettings) => {
    const gate = gateWith(demotion !== undefined ? { demotion } : {});
    await gate.rollout.evaluate();
    return gate.rollout.checkpoint()?.scopeHash;
  };

  it("hashes what the rule is, not how it was written", async () => {
    const none = await hashOf();
    expect(await hashOf({ kind: "window" })).toBe(none);
    const detector = await hashOf({ kind: "detector" });
    expect(
      await hashOf({
        kind: "detector",
        threshold: 1000,
        shifts: [2, 4, 8],
        rule: "shiryaev-roberts",
        overdue: { after: 30, action: "report" },
      }),
    ).toBe(detector);
    const all = [
      none,
      detector,
      await hashOf({ kind: "detector", threshold: 500 }),
      await hashOf({ kind: "detector", rule: "cusum" }),
      await hashOf({ kind: "detector", shifts: [2, 4] }),
      await hashOf({ kind: "detector", overdue: { after: 30, action: "demote" } }),
      await hashOf({ kind: "first-error" }),
      await hashOf({ kind: "first-error", overdue: { after: 5, action: "report" } }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("starts a fresh shadow phase when the rule changes", async () => {
    const ledger = new MemoryLedger();
    const gate = gateWith({ demotion: { kind: "detector" } }, {}, ledger);
    await promote(gate);
    const checkpoint = gate.rollout.checkpoint() as RolloutCheckpoint;
    const same = gateWith({ demotion: { kind: "detector" }, checkpoint }, {}, ledger);
    expect((await same.rollout.evaluate()).mode).toBe("enforce");
    for (const demotion of [
      { kind: "detector", threshold: 500 },
      { kind: "window" },
      { kind: "first-error" },
    ] as const) {
      const changed = gateWith({ demotion, checkpoint }, {}, ledger);
      expect(await changed.rollout.evaluate()).toMatchObject({
        mode: "shadow",
        reason: "holding shadow: evidence configuration changed",
      });
    }
    // Opting an enforcing window-rule gate into a detector is a change too.
    const windowLedger = new MemoryLedger();
    const plain = gateWith({}, {}, windowLedger);
    await promote(plain);
    const opted = gateWith(
      {
        demotion: { kind: "detector" },
        checkpoint: plain.rollout.checkpoint() as RolloutCheckpoint,
      },
      {},
      windowLedger,
    );
    expect((await opted.rollout.evaluate()).reason).toBe(
      "holding shadow: evidence configuration changed",
    );
  });

  it.each<[unknown, string]>([
    [{ kind: "detector", threshold: 1 }, "threshold must be a finite number above 1"],
    [{ kind: "detector", threshold: Number.NaN }, "threshold must be a finite number above 1"],
    [
      { kind: "detector", threshold: Number.POSITIVE_INFINITY },
      "threshold must be a finite number above 1",
    ],
    [{ kind: "detector", shifts: [] }, "shifts must be a non-empty array of numbers"],
    [
      { kind: "detector", shifts: [0.5] },
      "a shift must put the post-change error rate strictly between",
    ],
    [
      { kind: "detector", shifts: [100] },
      "a shift must put the post-change error rate strictly between",
    ],
    [{ kind: "detector", rule: "page" }, 'rule must be "shiryaev-roberts" or "cusum"'],
    [
      { kind: "detector", overdue: { after: 0, action: "report" } },
      "overdue after must be a positive integer",
    ],
    [
      { kind: "first-error", overdue: { after: 1.5, action: "demote" } },
      "overdue after must be a positive integer",
    ],
    [
      { kind: "first-error", overdue: { after: 3, action: "page" } },
      'overdue action must be "report" or "demote"',
    ],
    [{ kind: "first-error", overdue: { after: 3 } }, 'overdue action must be "report" or "demote"'],
    [{ kind: "first-error", overdue: 30 }, "overdue must be { after, action }"],
    [{ kind: "sprt" }, 'unknown kind "sprt"; use "window", "detector" or "first-error"'],
    [{ kind: "window", threshold: 10 }, 'the window rule takes no "threshold" setting'],
    [{ kind: "first-error", shifts: [2] }, 'the first-error rule takes no "shifts" setting'],
    [null, "demotion must be an object with a kind"],
  ])("holds shadow on an invalid setting: %j", async (demotion, why) => {
    const gate = new Engine({ oracle, mode: "enforce" }).gate(
      spec({ demotion: demotion as DemotionSettings }),
    );
    const s = await gate.rollout.evaluate();
    expect(s).toMatchObject({ mode: "shadow", changed: true });
    expect(s.reason).toContain(`holding shadow: invalid demotion: ${why}`);
    expect(gate.rollout.checkpoint()).toBeUndefined();
    expect(await gate.rollout.progress()).toMatchObject({ phase: "none" });
  });
});

describe("progress() reads without changing anything", () => {
  it("leaves the checkpoint, the mode and every status as a run that never called it", async () => {
    const ledger = new MemoryLedger();
    const settings: RolloutSettings = {
      demotion: { kind: "detector", overdue: { after: 2, action: "report" } },
    };
    const reader = gateWith(settings, {}, ledger);
    const quiet = gateWith(settings, {}, ledger);
    const read = async (): Promise<string> => {
      const p = await reader.rollout.progress();
      const text = describeProgress(p);
      expect(text.split(". ").length).toBeLessThanOrEqual(2);
      return text;
    };
    // Both read the same ledger; only `reader` asks, and only `reader` calls progress().
    const both = async (): Promise<RolloutStatus> => {
      await read();
      const a = await reader.rollout.evaluate();
      const b = await quiet.rollout.evaluate();
      expect(a).toEqual(b);
      expect(reader.rollout.checkpoint()).toEqual(quiet.rollout.checkpoint());
      expect(reader.mode).toBe(quiet.mode);
      expect(reader.rollout.history).toEqual(quiet.rollout.history);
      await read();
      return a;
    };

    // Before the first evaluation there is no phase to read, and reading one initializes nothing.
    expect(await reader.rollout.progress()).toEqual({
      promisedAccuracy: 0.98,
      gateId: "demotion-gate",
      phase: "none",
      reason:
        "not evaluated yet: the first evaluate() places the phase boundary, or verifies the checkpoint, so there is no phase to read",
    });
    expect(reader.rollout.checkpoint()).toBeUndefined();
    expect(reader.rollout.history).toHaveLength(0);
    await both();

    // Shadow: the planned sample in progress, exactly acceptanceProgress over the phase's rows.
    await ask(reader, true);
    const unlabelled = await ask(reader);
    await ask(reader, true);
    await both();
    const shadow = await reader.rollout.progress();
    const phaseRows = (await ledger.all()).filter((r) => r.mode === "shadow");
    expect(shadow).toEqual({
      promisedAccuracy: 0.98,
      gateId: "demotion-gate",
      phase: "shadow",
      acceptance: acceptanceProgress(phaseRows, PLAN),
    });
    expect(shadow.phase === "shadow" && shadow.acceptance).toMatchObject({
      acts: 3,
      prefix: { acts: 1, right: 1, wrong: 0 },
      labelled: 2,
    });
    const bound = shadow.phase === "shadow" ? shadow.acceptance.lowerBound : Number.NaN;
    expect(describeProgress(shadow)).toBe(
      `Planned sample: 3 of 6 acts collected, 2 labelled by sources the plan reads (0 wrong); the labelled prefix is 1 act long (0 wrong). Running 10% lower bound on accuracy ${(100 * bound).toFixed(2)}%, valid at every look; it decides nothing, the planned test alone promotes.`,
    );
    await reader.engine.label(unlabelled, { correct: true, truth: true });
    for (let i = 0; i < 3; i++) await ask(reader, true);
    expect((await both()).mode).toBe("enforce");

    // Enforce: the detector's readout, the same one the next status carries.
    await audit(reader, false);
    await audit(reader);
    await audit(reader, true);
    await audit(reader, true);
    const enforce = await reader.rollout.progress();
    const live = await both();
    expect(live.mode).toBe("enforce");
    expect(enforce).toEqual({
      promisedAccuracy: 0.98,
      gateId: "demotion-gate",
      phase: "enforce",
      demotion: live.demotion,
    });
    expect(live.demotion).toMatchObject({ read: 1, wrong: 1, pending: 1, overdue: true });
    expect(describeProgress(enforce)).toMatch(
      /^Shiryaev-Roberts detector: 4 current-phase audited acts, 1 read through the labelled prefix \(1 wrong\); 1 still without a label the plan reads, the first \(.+\) overdue with 2 later audits\. Statistic [\d.]+ against threshold 1000; for a gate that keeps its promised 98\.0%, an alarm within 1 audit has probability at most 0\.10%\.$/,
    );

    // An alarm the next evaluation will act on is read, not acted on.
    for (let i = 0; i < 4; i++) await audit(reader, false);
    const pendingLabel = live.demotion?.firstPending?.id as string;
    await reader.engine.label(pendingLabel, { correct: false, truth: false });
    const alarmed = await reader.rollout.progress();
    expect(alarmed).toMatchObject({ phase: "enforce", demotion: { alarmed: true } });
    expect(reader.mode).toBe("enforce");
    expect(describeProgress(alarmed)).toContain(
      "so the next evaluation returns the gate to shadow",
    );
    expect((await both()).mode).toBe("shadow");
    expect(await reader.rollout.progress()).toMatchObject({
      phase: "shadow",
      acceptance: { acts: 0 },
    });
  });

  it("reads nothing before the first evaluation, even with a checkpoint to restore", async () => {
    const ledger = new MemoryLedger();
    const gate = gateWith({ demotion: { kind: "first-error" } }, {}, ledger);
    await promote(gate);
    const checkpoint = gate.rollout.checkpoint() as RolloutCheckpoint;
    const restored = gateWith({ demotion: { kind: "first-error" }, checkpoint }, {}, ledger);
    expect(await restored.rollout.progress()).toMatchObject({ phase: "none" });
    expect(restored.rollout.checkpoint()).toBeUndefined();
    expect(restored.mode).toBe("shadow");
    expect(await restored.rollout.evaluate()).toMatchObject({ mode: "enforce", changed: true });
    expect(await restored.rollout.progress()).toMatchObject({
      phase: "enforce",
      demotion: { kind: "first-error", audited: 0 },
    });
  });

  it("says when the next evaluation will start a fresh phase instead of reading this one", async () => {
    const policy = { actAbove: 0.8 };
    const gate = gateWith({ demotion: { kind: "detector" } }, { policy });
    await promote(gate);
    policy.actAbove = 0.7;
    expect(await gate.rollout.progress()).toMatchObject({
      phase: "none",
      reason: "the evidence configuration changed; the next evaluate() starts a fresh shadow phase",
    });
    expect(gate.mode).toBe("enforce");
    policy.actAbove = 0.8;
    gate.mode = "shadow";
    expect(await gate.rollout.progress()).toMatchObject({
      phase: "none",
      reason:
        "the mode was changed outside this controller; the next evaluate() starts a fresh shadow phase",
    });
  });

  it("reads a rejected configuration as rejected, and the window rule's figures in enforce", async () => {
    const rejected = gateWith();
    await rejected.rollout.evaluate();
    await ask(rejected, false);
    for (let i = 0; i < 5; i++) await ask(rejected, true);
    expect((await rejected.rollout.evaluate()).reason).toMatch(/^rejected/);
    const p = await rejected.rollout.progress();
    expect(p).toMatchObject({ phase: "rejected" });
    expect(describeProgress(p)).toBe(
      "Holding shadow: this configuration was rejected; change its rubric, policy, model, plan or evidence version to test a new one.",
    );

    const window = gateWith({ minAuditRows: 3 });
    await promote(window);
    await audit(window, true);
    await audit(window, false);
    const w = await window.rollout.progress();
    expect(w).toEqual({
      promisedAccuracy: 0.98,
      gateId: "demotion-gate",
      phase: "enforce",
      demotion: {
        kind: "window",
        audits: { n: 2, acted: 2, accuracy: 0.5 },
        window: 200,
        minAuditRows: 3,
      },
    });
    expect(describeProgress(w)).toBe(
      "Window rule: 2 current-phase audited rows, 2 acts at 50.0% against the promised 98.0%. It judges the last 200 once 3 exist.",
    );
    // The same figures the next status reports.
    expect((await window.rollout.evaluate()).audits).toEqual({ n: 2, acted: 2, accuracy: 0.5 });
  });
});
