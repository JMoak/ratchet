/**
 * The lifecycle, one phase per process: each phase builds a fresh Engine over the same
 * JsonlLedger and restores the rollout from the checkpoint the previous phase saved, so
 * restart is exercised by construction, not simulated.
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredActs, resolvePlan } from "../../../src/acceptance.ts";
import type { Engine } from "../../../src/engine.ts";
import type { Gate, GateSpec } from "../../../src/gate.ts";
import { hookFloors, hookGateSpec, hookQuestion } from "../../../src/hook/gate.ts";
import { type DecisionRecord, hashQuestion, JsonlLedger } from "../../../src/ledger/ledger.ts";
import { rng, shuffled } from "../../../src/math.ts";
import { hashPolicy } from "../../../src/policy.ts";
import type { RolloutCheckpoint, RolloutStatus } from "../../../src/rollout.ts";
import type { JudgeQuestion, JudgeVerdict } from "../../../src/types.ts";
import {
  blindReview,
  corpusHash,
  DECIDER_SOURCE,
  gitHead,
  guard,
  HAIKU,
  JEV_113,
  labelAsDecider,
  progress,
  writeJson,
} from "../lib.ts";
import {
  amendManifest,
  CORPUS_FILE,
  engineFor,
  itemTags,
  labelsByState,
  loadCorpus,
  loadReal,
  REAL_CORPUS,
  REAL_LABELS,
  type Run,
  readJson,
  tagValue,
} from "./common.ts";
import type { Item } from "./corpus.ts";
import {
  ACCEPTANCE,
  AT_98,
  BATTERY,
  BATTERY_GATE_ID,
  FIT_POLICY,
  FLOORS,
  type FrozenPolicy,
  freezePolicy,
  GATE_ID,
  PLAN,
  RAW_GATE_ID,
  REAL_GATE_ID,
  SAMPLE_SIZE,
  TOOL_QUESTION,
  TRACK,
} from "./gate.ts";

const ordered = (items: readonly Item[], salt: number): Item[] =>
  shuffled(items, rng(PLAN.engineSeed + salt));

/** This track's cap, on the spend its own ledgers record. */
const TRACK_CAP_USD = 1.25;

async function spend(run: Run, where: string): Promise<void> {
  if (run.offline) return;
  await guard(`${TRACK} ${where}`);
  let recorded = 0;
  for (const p of [
    run.ledger,
    run.rawLedger,
    run.batteryLedger,
    run.realLedger,
    run.mechLedger,
    run.budgetLedger,
  ]) {
    if (existsSync(p)) recorded += (await new JsonlLedger(p).all()).reduce((s, r) => s + r.cost, 0);
  }
  progress(
    `[spend] ${TRACK} ${where}: $${recorded.toFixed(5)} recorded by this run of $${TRACK_CAP_USD}`,
  );
  if (recorded > TRACK_CAP_USD) throw new Error(`track cap reached at ${where}`);
}

// ---------------------------------------------------------------------------
// plan: the manifest, before any live call
// ---------------------------------------------------------------------------

export function plan(run: Run): void {
  const items = loadCorpus();
  const real = loadReal();
  writeJson(run.manifest, {
    track: TRACK,
    createdAt: new Date().toISOString(),
    offline: run.offline,
    gitHead: gitHead(),
    corpus: {
      file: CORPUS_FILE.replace(/\\/g, "/").split("/experiments/")[1],
      hash: corpusHash(items),
      items: items.length,
    },
    real: real
      ? {
          corpusFile: REAL_CORPUS,
          labelsFile: REAL_LABELS,
          hash: corpusHash({ items: real.items, labels: [...real.labels.values()] }),
          items: real.items.length,
        }
      : null,
    oracle: run.offline
      ? { kind: "SimOracle", accuracy: 0.9, seed: PLAN.engineSeed }
      : {
          kind: "jevViaOpenRouter",
          requestedModel: JEV_113,
          id: "jev113@openrouter",
          unusedTiers: [HAIKU],
        },
    questions: {
      gate: { id: GATE_ID, hash: hashQuestion(TOOL_QUESTION), question: TOOL_QUESTION },
      battery: { id: BATTERY_GATE_ID, members: BATTERY, combine: "logodds, correlation 0" },
      hook: { id: "agent.tool.claude-code", hash: hashQuestion(hookQuestion) },
    },
    floors: {
      gate: "CATASTROPHIC (refuse), ONE_WAY (review), REVIEW (review); see gate.ts",
      real: "the gate's floors plus the product's hookFloors",
    },
    plan: PLAN,
    acceptance: { ...resolvePlan(ACCEPTANCE), sampleSize: SAMPLE_SIZE },
    at98: AT_98,
    deciderSource: DECIDER_SOURCE,
  });
  progress(`[plan] manifest written to ${run.manifest}`);
}

// ---------------------------------------------------------------------------
// fit: shadow on the fit split, blind census, report, freeze
// ---------------------------------------------------------------------------

function fitGate(engine: Engine): Gate<JudgeVerdict> {
  return engine.gate({
    id: GATE_ID,
    question: TOOL_QUESTION,
    policy: FIT_POLICY,
    evidenceVersion: PLAN.fitVersion,
    floors: FLOORS,
    promisedAccuracy: PLAN.promise,
    mode: "shadow",
  });
}

export async function fit(run: Run): Promise<void> {
  const items = loadCorpus().filter((it) => it.split === "fit");
  const engine = engineFor(run, run.ledger);
  const gate = fitGate(engine);
  await spend(run, "fit");
  progress(`[fit] asking ${items.length} fit items in shadow`);
  // Labels go through the real review command, matched by the exact state text it prints.
  await askTagged(gate, ordered(items, 1));
  const review = await blindReview(run.ledger, GATE_ID, labelsByState(items), {
    sample: 1000,
    seed: PLAN.reviewSeed,
  });
  progress(`[fit] blind review: ${review.answered} answered, ${review.missing} missing`);
  writeFileSync(join(run.dir, "review-fit.txt"), review.output);
  const rows = (await engine.ledger.all()).filter((r) => r.gateId === GATE_ID);
  const frozen = freezePolicy(rows);
  const models = [...new Set(rows.flatMap((r) => (r.model ? [r.model] : [])))];
  const reportAt = async (target: number) =>
    gate.report({ targetAccuracy: target, minSupport: PLAN.fitMinSupport });
  const r98 = await reportAt(0.98);
  const r95 = await reportAt(0.95);
  const fitRecord = {
    frozen,
    recordedModels: models,
    pinnedModel: models.length === 1 ? models[0] : undefined,
    productReport: {
      at98: {
        fitted: r98.fitted ?? null,
        fittedFrom: r98.fittedFrom ?? null,
        grade: r98.grade.kind,
      },
      at95: {
        fitted: r95.fitted ?? null,
        fittedFrom: r95.fittedFrom ?? null,
        grade: r95.grade.kind,
      },
      labelled: r98.labelled,
      unselected: r98.unselected,
      accuracy: r98.accuracy ?? null,
      ece: r98.ece ?? null,
    },
    review: { answered: review.answered, missing: review.missing },
    frozenAt: new Date().toISOString(),
  };
  writeJson(join(run.dir, "frozen.json"), fitRecord);
  amendManifest(run, { frozen: fitRecord });
  progress(
    `[fit] frozen: ${frozen.rule}; actAbove ${frozen.policy.actAbove}; model ${fitRecord.pinnedModel ?? models.join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// The frozen gate, as every later phase registers it
// ---------------------------------------------------------------------------

interface FrozenRecord {
  readonly frozen: FrozenPolicy;
  readonly pinnedModel?: string;
}

export function frozenRecord(run: Run): FrozenRecord {
  return readJson<FrozenRecord>(join(run.dir, "frozen.json"));
}

function frozenSpec(
  run: Run,
  checkpoint: RolloutCheckpoint | undefined,
  extra: Partial<GateSpec<JudgeQuestion>> = {},
): GateSpec<JudgeQuestion> {
  const f = frozenRecord(run);
  return {
    id: GATE_ID,
    question: TOOL_QUESTION,
    policy: f.frozen.policy,
    evidenceVersion: PLAN.frozenVersion,
    floors: FLOORS,
    promisedAccuracy: PLAN.promise,
    auditRate: PLAN.auditRate,
    mode: "shadow",
    rollout: {
      evidence: {
        version: PLAN.frozenVersion,
        ...(f.pinnedModel !== undefined ? { model: f.pinnedModel } : {}),
      },
      confidence: PLAN.confidence,
      maxErrors: PLAN.maxErrors,
      group: PLAN.group,
      minAuditRows: PLAN.minAuditRows,
      window: PLAN.window,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    },
    ...extra,
  };
}

function saveCheckpoint(
  run: Run,
  gate: Gate,
  file = run.checkpoint,
): RolloutCheckpoint | undefined {
  const cp = gate.rollout.checkpoint();
  if (cp !== undefined) writeJson(file, cp);
  return cp;
}

const statusLine = (s: RolloutStatus): string => `${s.mode} | ${s.reason}`;

/** Status without the bulky sample ids, for the run record. */
function brief(s: RolloutStatus): Record<string, unknown> {
  const acceptance = s.acceptance;
  return {
    mode: s.mode,
    changed: s.changed,
    reason: s.reason,
    grade: s.grade,
    ...(acceptance
      ? {
          acceptance: {
            status: acceptance.status,
            sampleSize: acceptance.plan.sampleSize,
            ...("acts" in acceptance ? { acts: acceptance.acts } : {}),
            ...("unlabelled" in acceptance ? { unlabelled: acceptance.unlabelled } : {}),
            ...("errors" in acceptance
              ? { errors: acceptance.errors, lowerBound: acceptance.lowerBound }
              : {}),
            ...("sample" in acceptance ? { sample: acceptance.sample } : {}),
          },
        }
      : {}),
    ...(s.audits ? { audits: s.audits } : {}),
    at: s.at,
  };
}

// ---------------------------------------------------------------------------
// evidence: initialise the rollout, then shadow on the evidence split, then evaluate once
// ---------------------------------------------------------------------------

export async function evidence(run: Run): Promise<void> {
  const items = loadCorpus().filter((it) => it.split === "evidence");
  const engine = engineFor(run, run.ledger);
  const gate = engine.gate(frozenSpec(run, undefined));
  const s0 = await gate.rollout.evaluate();
  progress(`[evidence] init: ${statusLine(s0)}`);
  saveCheckpoint(run, gate);
  await spend(run, "evidence");
  // Sequential, so ledger order is the pre-registered shuffled order and the planned sample
  // (the first acts in ledger order) never depends on response timing.
  for (const it of ordered(items, 2)) {
    await gate.ask(it.state, { baseline: "review", tags: itemTags(it) });
  }
  const s1 = await gate.rollout.evaluate();
  progress(`[evidence] before labels: ${statusLine(s1)}`);
  const review = await blindReview(run.ledger, GATE_ID, labelsByState(items), {
    sample: 1000,
    seed: PLAN.reviewSeed + 1,
  });
  writeFileSync(join(run.dir, "review-evidence.txt"), review.output);
  progress(`[evidence] blind review: ${review.answered} answered, ${review.missing} missing`);
  const s2 = await gate.rollout.evaluate();
  progress(`[evidence] after labels: ${statusLine(s2)}`);
  const cp = saveCheckpoint(run, gate);
  writeJson(join(run.dir, "rollout-evidence.json"), {
    init: brief(s0),
    beforeLabels: brief(s1),
    afterLabels: brief(s2),
    checkpoint: cp ?? null,
    review: { answered: review.answered, missing: review.missing },
  });
}

// ---------------------------------------------------------------------------
// enforce: restore in a fresh process, enforce with blind audits, watch for demotion
// ---------------------------------------------------------------------------

interface Timeline {
  readonly step: number;
  readonly slice: string;
  readonly item: string;
  readonly mode: string;
  readonly soft: string;
  readonly action: string;
  readonly audited: boolean;
  readonly truth: boolean;
}

async function enforceRun(
  run: Run,
  engine: Engine,
  gate: Gate<JudgeVerdict>,
  label: string,
): Promise<void> {
  const corpus = loadCorpus();
  // The fit split runs again after validation for audit power alone: at an audit rate of 0.2
  // the offline wiring run reached only 29 audits over validation, challenge and drift, one
  // short of the 30 demotion needs, so without it demotion could not fire whatever the drift.
  // Fixed before any live call; its acts are traffic to watch, not held-out evidence.
  const slices: [string, Item[]][] = [
    [
      "validation",
      ordered(
        corpus.filter((it) => it.split === "evidence"),
        3,
      ),
    ],
    [
      "fit-replay",
      ordered(
        corpus.filter((it) => it.split === "fit"),
        7,
      ),
    ],
    [
      "challenge",
      ordered(
        corpus.filter((it) => it.split === "challenge"),
        4,
      ),
    ],
    [
      "drift",
      ordered(
        corpus.filter((it) => it.split === "drift"),
        5,
      ),
    ],
  ];
  const statuses: Record<string, unknown>[] = [];
  const timeline: Timeline[] = [];
  let step = 0;
  let pendingAudits: { recordId: string; item: Item; verdict: JudgeVerdict }[] = [];
  const evaluate = async (slice: string): Promise<void> => {
    for (const a of pendingAudits) {
      await labelAsDecider(engine, a.recordId, a.verdict, { truth: a.item.truth, why: a.item.why });
    }
    pendingAudits = [];
    const s = await gate.rollout.evaluate();
    if (s.changed || statuses.length === 0 || step % 50 === 0) {
      progress(`[${label}] step ${step} (${slice}): ${statusLine(s)}`);
    }
    statuses.push({ step, slice, ...brief(s) });
  };
  await spend(run, label);
  for (const [slice, items] of slices) {
    for (const it of items) {
      const r = await gate.ask(it.state, {
        baseline: "review",
        tags: [...itemTags(it), `phase:${label}`],
      });
      step++;
      if (r.audited)
        pendingAudits.push({ recordId: r.recordId, item: it, verdict: r.decision.verdict });
      timeline.push({
        step,
        slice,
        item: it.id,
        mode: r.mode,
        soft: r.ruling.action,
        action: r.action,
        audited: r.audited,
        truth: it.truth,
      });
      if (step % PLAN.evaluateEvery === 0) await evaluate(slice);
    }
    await evaluate(`${slice} end`);
  }
  writeJson(join(run.dir, `${label}.json`), { statuses, timeline });
}

export async function enforce(run: Run): Promise<void> {
  if (!existsSync(run.checkpoint)) throw new Error("no checkpoint; run evidence first");
  const checkpoint = readJson<RolloutCheckpoint>(run.checkpoint);
  const engine = engineFor(run, run.ledger);
  const gate = engine.gate(frozenSpec(run, checkpoint));
  const restored = await gate.rollout.evaluate();
  progress(`[enforce] restored in a fresh process: ${statusLine(restored)}`);
  writeJson(join(run.dir, "restore.json"), { checkpoint, restored: brief(restored) });
  if (restored.mode !== "enforce") {
    progress("[enforce] the gate holds shadow, so the enforce phase does not run; see mechanics");
    return;
  }
  await enforceRun(run, engine, gate, "enforce");
  saveCheckpoint(run, gate, join(run.dir, "checkpoint-after-enforce.json"));
}

/**
 * Only when the primary configuration did not promote: the same frozen policy and floors under
 * an openly weak plan (one-sided 50% confidence, 14 acts), on its own ledger, to exercise the
 * enforce, audit and demotion path. This is a mechanics check and says nothing about whether
 * the gate earned a 95% promise.
 */
export async function mechanics(run: Run): Promise<void> {
  const ev = readJson<{ afterLabels: { mode: string } }>(join(run.dir, "rollout-evidence.json"));
  if (ev.afterLabels.mode === "enforce") {
    progress("[mechanics] the primary configuration promoted; nothing to do");
    return;
  }
  const corpus = loadCorpus();
  const engine = engineFor(run, run.mechLedger);
  const base = frozenSpec(run, undefined);
  const gate = engine.gate({
    ...base,
    id: `${GATE_ID}.mech`,
    evidenceVersion: "t1-toolgate-mech-v1",
    rollout: {
      ...(base.rollout ?? {}),
      evidence: { ...(base.rollout?.evidence ?? { version: "" }), version: "t1-toolgate-mech-v1" },
      confidence: 0.5,
      maxErrors: 0,
    },
  });
  const planned = requiredActs(PLAN.promise, 0.5, 0);
  const s0 = await gate.rollout.evaluate();
  progress(`[mechanics] init (${planned}-act plan): ${statusLine(s0)}`);
  await spend(run, "mechanics");
  const items = ordered(
    corpus.filter((it) => it.split === "evidence"),
    6,
  );
  for (const it of items) {
    await gate.ask(it.state, {
      baseline: "review",
      tags: [...itemTags(it), "phase:mech-evidence"],
    });
  }
  const review = await blindReview(run.mechLedger, gate.id, labelsByState(items), {
    sample: 1000,
    seed: PLAN.reviewSeed + 2,
  });
  const s1 = await gate.rollout.evaluate();
  progress(`[mechanics] after labels: ${statusLine(s1)}`);
  writeJson(join(run.dir, "mechanics-evidence.json"), {
    plannedActs: planned,
    init: brief(s0),
    afterLabels: brief(s1),
    review: { answered: review.answered, missing: review.missing },
  });
  if (s1.mode !== "enforce") return;
  await enforceRun(run, engine, gate, "mechanics-enforce");
}

// ---------------------------------------------------------------------------
// restore-check: what a fresh controller does with good, tampered and stale checkpoints
// ---------------------------------------------------------------------------

export async function restoreCheck(run: Run, which: "evidence" | "enforce"): Promise<void> {
  const cpFile =
    which === "evidence" ? run.checkpoint : join(run.dir, "checkpoint-after-enforce.json");
  if (!existsSync(cpFile)) {
    progress(`[restore-check] no ${which} checkpoint`);
    return;
  }
  const good = readJson<Extract<RolloutCheckpoint, { format: 2 }>>(cpFile);
  const copy = join(run.dir, `restore-${which}-ledger.jsonl`);
  copyFileSync(run.ledger, copy);
  const probe = async (
    name: string,
    cp: unknown,
    extra: Partial<GateSpec<JudgeQuestion>> = {},
  ): Promise<Record<string, unknown>> => {
    const engine = engineFor(run, copy);
    const spec = frozenSpec(run, cp as RolloutCheckpoint | undefined, extra);
    const gate = engine.gate(spec);
    const s = await gate.rollout.evaluate();
    return { name, mode: s.mode, reason: s.reason, grade: s.grade.kind };
  };
  const f = frozenRecord(run);
  const out = [
    await probe("valid checkpoint", good),
    await probe("no checkpoint", undefined),
    await probe("tampered scope hash", { ...good, scopeHash: "0".repeat(16) }),
    await probe("missing anchor", { ...good, afterId: "00000000-0000-0000-0000-000000000000" }),
    await probe("malformed", { ...good, extra: true }),
    await probe("policy edited by 0.01", good, {
      policy: { ...f.frozen.policy, actAbove: Math.max(0, f.frozen.policy.actAbove - 0.01) },
    }),
    await probe("format 1 of the same", {
      format: 1,
      scopeHash: good.scopeHash,
      mode: good.mode,
      afterId: good.afterId,
    }),
  ];
  writeJson(join(run.dir, `restore-check-${which}.json`), out);
  for (const o of out) progress(`[restore-check ${which}] ${o.name}: ${o.mode} | ${o.reason}`);
}

// ---------------------------------------------------------------------------
// raw and battery: every split, no floors, for discrimination and the battery comparison
// ---------------------------------------------------------------------------

export async function raw(run: Run): Promise<void> {
  const items = loadCorpus();
  const engine = engineFor(run, run.rawLedger);
  const gate = engine.gate({
    id: RAW_GATE_ID,
    question: TOOL_QUESTION,
    policy: FIT_POLICY,
    evidenceVersion: "t1-toolgate-raw-v1",
    mode: "shadow",
  });
  await spend(run, "raw");
  progress(`[raw] asking ${items.length} items with no floors`);
  await askTagged(gate, items);
  const review = await blindReview(run.rawLedger, RAW_GATE_ID, labelsByState(items), {
    sample: 1000,
    seed: PLAN.reviewSeed + 3,
  });
  progress(`[raw] blind review: ${review.answered} answered, ${review.missing} missing`);
}

export async function battery(run: Run): Promise<void> {
  const items = loadCorpus();
  const engine = engineFor(run, run.batteryLedger);
  const gate = engine.gate({
    id: BATTERY_GATE_ID,
    question: BATTERY,
    policy: FIT_POLICY,
    evidenceVersion: "t1-toolgate-battery-v1",
    mode: "shadow",
  });
  await spend(run, "battery");
  progress(`[battery] asking ${items.length} items, 3 members each`);
  await askTagged(gate, items);
  const review = await blindReview(run.batteryLedger, BATTERY_GATE_ID, labelsByState(items), {
    sample: 1000,
    seed: PLAN.reviewSeed + 4,
  });
  progress(`[battery] blind review: ${review.answered} answered, ${review.missing} missing`);
}

async function askTagged(gate: Gate<JudgeVerdict>, items: readonly Item[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = items[next++];
      if (it === undefined) return;
      await gate.ask(it.state, { baseline: "review", tags: itemTags(it) });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ---------------------------------------------------------------------------
// real: the frozen gate and the product's own hook gate on real, scrubbed traffic
// ---------------------------------------------------------------------------

export async function real(run: Run): Promise<void> {
  const data = loadReal();
  if (data === undefined) {
    progress("[real] no real-traffic corpus and labels; skipped");
    return;
  }
  const f = frozenRecord(run);
  const engine = engineFor(run, run.realLedger);
  const frozenGate = engine.gate({
    id: REAL_GATE_ID,
    question: TOOL_QUESTION,
    policy: f.frozen.policy,
    evidenceVersion: PLAN.frozenVersion,
    floors: [...FLOORS, ...hookFloors],
    mode: "shadow",
  });
  const hookGate = engine.gate(hookGateSpec("claude-code"));
  await spend(run, "real");
  progress(`[real] asking ${data.items.length} real calls through two gates`);
  for (const gate of [frozenGate, hookGate] as const) {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const it = data.items[next++];
        if (it === undefined) return;
        await gate.ask(it.state, {
          baseline: "review",
          tags: [`item:${it.id}`, `session:${it.session}`, `tool:${it.tool}`],
        });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  const byState = new Map(
    data.items.map((it) => [it.state, data.labels.get(it.id)?.truth ?? true]),
  );
  for (const id of [REAL_GATE_ID, hookGate.id]) {
    const review = await blindReview(run.realLedger, id, byState, {
      sample: 1000,
      seed: PLAN.reviewSeed + 5,
    });
    progress(`[real] ${id} blind review: ${review.answered} answered, ${review.missing} missing`);
  }
  amendManifest(run, {
    realGates: {
      frozen: { id: REAL_GATE_ID, policyHash: hashPolicy(f.frozen.policy) },
      hook: { id: hookGate.id, policyHash: hashPolicy(hookGate.spec.policy) },
    },
  });
}

// ---------------------------------------------------------------------------
// budget: the per-UTC-day cap read from the ledger, across a restart
// ---------------------------------------------------------------------------

export async function budget(run: Run): Promise<void> {
  const items = loadCorpus().slice(0, 12);
  const cap = run.offline ? 0.0001 : 0.00012;
  const rows: Record<string, unknown>[] = [];
  const askAll = async (engine: Engine, label: string, which: readonly Item[]) => {
    const gate = engine.gate({
      id: "t1.toolgate.budget",
      question: TOOL_QUESTION,
      policy: FIT_POLICY,
      evidenceVersion: "t1-budget",
      mode: "shadow",
    });
    for (const it of which) {
      const r = await gate.ask(it.state, { baseline: "review", tags: itemTags(it) });
      const d = r.decision;
      rows.push({
        engine: label,
        item: it.id,
        failedOpen: d.failedOpen === true,
        budget: d.detail.budget ?? null,
        budgetExhausted: d.detail.budgetExhausted === true,
        soft: r.ruling.action,
        action: r.action,
        cost: d.cost,
        spentToday: (await engine.spentToday())?.spentUsd ?? null,
      });
    }
  };
  await spend(run, "budget");
  const first = engineFor(run, run.budgetLedger, { dailyBudgetUsd: cap, reserveUsd: 0.00003 });
  await askAll(first, "first", items.slice(0, 8));
  // A new engine on the same ledger is what a restarted process builds.
  const second = engineFor(run, run.budgetLedger, { dailyBudgetUsd: cap, reserveUsd: 0.00003 });
  await askAll(second, "after restart", items.slice(8, 11));
  // The instance cap, which a restart does reset: two asks under a cap below one request.
  const third = engineFor(run, join(run.dir, "budget-instance-ledger.jsonl"), {
    budgetUsd: 0.00001,
    dailyBudgetUsd: 1,
  });
  await askAll(third, "instance cap", items.slice(0, 2));
  const all = await new JsonlLedger(run.budgetLedger).all();
  writeJson(join(run.dir, "budget.json"), {
    capUsd: cap,
    rows,
    recordedSpend: all.reduce((s, r) => s + r.cost, 0),
  });
  for (const r of rows) progress(`[budget] ${JSON.stringify(r)}`);
}

export type { DecisionRecord };
export { tagValue };
