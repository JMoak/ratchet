/**
 * V4: fresh live validation of the tool gate and the moderation battery, with policies frozen
 * from wave-1 fit data only (`freeze.ts`), on corpora whose labels were fixed before any call
 * (`build.ts`).
 *
 *   bun experiments/e2e/verify/v4-fresh/main.ts [--offline]
 *
 * One process, in this order: check the corpora against their generators; compute the frozen
 * policies from wave-1 ledgers; write `manifest.json` (corpus hashes, frozen policies and their
 * hashes, acceptance plan, git HEAD) before the first call; then
 *
 * A. the tool gate: register the frozen gate (`keepState`, shadow, JSONL ledger, T1's floors)
 *    with a 95% rollout, initialise the rollout before any fresh row, ask every fresh call
 *    sequentially in a seeded order, label every row through `ratchet review` (`blindReview`),
 *    evaluate the rollout once, restore it in a fresh engine; then the same calls through the
 *    same rubric with no floors (what Jev alone does on what the floors settle);
 * B. the moderation battery: one live pass through a gate combining T3's four members with
 *    `any` at its frozen bar, labelled through `ratchet review` and then with each member's own
 *    truth (`memberTruths`).
 *
 * Every live phase calls `guard()` (the evaluation's ceiling) and this study's own cap on its
 * recorded spend. `analyze.ts` then reads only the ledgers, corpora and manifest; the other
 * combiners are re-pooled offline from the same member answers, which is legitimate because
 * every bar was frozen first. `--offline` runs the same wiring on seeded simulated oracles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredActs, resolvePlan } from "../../../../src/acceptance.ts";
import { Engine } from "../../../../src/engine.ts";
import { forQuestion, refuseIf } from "../../../../src/floors.ts";
import type { Gate, GateSpec } from "../../../../src/gate.ts";
import { hashQuestion, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { rng, shuffled } from "../../../../src/math.ts";
import type { GatePolicy } from "../../../../src/policy.ts";
import type { RolloutCheckpoint, RolloutStatus } from "../../../../src/rollout.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../../../../src/types.ts";
import {
  blindReview,
  corpusHash,
  DECIDER_SOURCE,
  gitHead,
  guard,
  JEV_113,
  progress,
  providerUsage,
  sha256,
  writeJson,
} from "../../lib.ts";
import { FLOORS, TOOL_QUESTION } from "../../t1-toolgate/gate.ts";
import { PROHIBITED_SCAN } from "../../t3-triage/corpus/moderation.ts";
import { analyze } from "./analyze.ts";
import { MOD_CORPUS_FILE, TOOL_CORPUS_FILE, V4_OUT } from "./build.ts";
import {
  itemTags,
  loadMod,
  loadTool,
  MOD_GATE,
  MOD_VERSION,
  modOracle,
  type Paths,
  paths,
  RAW_GATE,
  RAW_VERSION,
  readJson,
  SETTINGS,
  TOOL_GATE,
  TOOL_VERSION,
  toolOracle,
} from "./common.ts";
import { freezeModeration, freezeTool, type ModFreeze, type ToolFreeze } from "./freeze.ts";
import type { Item } from "./tool-corpus.ts";

const offline = process.argv.includes("--offline");

function runDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(V4_OUT, `${stamp}-${offline ? "offline" : "live"}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const fileSha = (path: string): string => sha256(readFileSync(path, "utf8"));

// ---------------------------------------------------------------------------
// Spend: the evaluation's ceiling, and this study's cap on what its own ledgers record
// ---------------------------------------------------------------------------

async function recordedSpend(p: Paths): Promise<number> {
  let s = 0;
  for (const f of [p.toolLedger, p.rawLedger, p.modLedger]) {
    if (existsSync(f)) s += (await new JsonlLedger(f).all()).reduce((a, r) => a + r.cost, 0);
  }
  return s;
}

async function spend(p: Paths, where: string): Promise<void> {
  const recorded = await recordedSpend(p);
  progress(`[spend] v4 ${where}: $${recorded.toFixed(5)} recorded of $${SETTINGS.studyCapUsd}`);
  if (recorded > SETTINGS.studyCapUsd) throw new Error(`v4 study cap reached at ${where}`);
  if (!offline) await guard(`v4-fresh ${where}`);
}

// ---------------------------------------------------------------------------
// Plan: freeze and write the manifest before any call
// ---------------------------------------------------------------------------

interface Frozen {
  readonly tool: ToolFreeze;
  readonly mod: ModFreeze;
  readonly toolPolicy: GatePolicy;
  readonly modPolicy: GatePolicy;
}

async function plan(p: Paths): Promise<Frozen> {
  const tool = loadTool();
  const mod = loadMod();
  const ft = await freezeTool();
  const fm = await freezeModeration();
  const live = ft.live === "primary" ? ft.primary : ft.secondary;
  if (live.policy === undefined) throw new Error("no frozen tool policy to register");
  const toolPolicy = live.policy;
  const modPolicy = fm.live.policy;
  const acceptance = {
    ...resolvePlan({
      target: SETTINGS.promise,
      confidence: SETTINGS.confidence,
      maxErrors: SETTINGS.maxErrors,
      group: SETTINGS.group,
    }),
    sampleSize: requiredActs(SETTINGS.promise, SETTINGS.confidence, SETTINGS.maxErrors),
  };
  const usageAtStart = offline ? null : await providerUsage();
  writeJson(p.manifest, {
    study: "V4 fresh validation (wave 3)",
    createdAt: new Date().toISOString(),
    offline,
    gitHead: gitHead(),
    corpora: {
      tool: {
        file: "experiments/e2e/verify/v4-fresh/tool-corpus.json",
        hash: corpusHash(tool),
        fileSha256: fileSha(TOOL_CORPUS_FILE),
        items: tool.length,
        approve: tool.filter((i) => i.truth).length,
        groups: new Set(tool.map((i) => i.group)).size,
        ambiguous: tool.filter((i) => i.ambiguous).length,
      },
      moderation: {
        file: "experiments/e2e/verify/v4-fresh/moderation-corpus.json",
        hash: corpusHash(mod.items),
        fileSha256: fileSha(MOD_CORPUS_FILE),
        posts: mod.items.length,
        floored: mod.items.filter((i) => i.floored).length,
        needsAction: mod.items.filter((i) => !i.floored && i.truth).length,
        ambiguous: mod.items.filter((i) => i.ambiguous).length,
      },
    },
    oracle: offline
      ? { kind: "SimOracle", accuracy: 0.9, seed: SETTINGS.engineSeed }
      : { kind: "jevViaOpenRouter", requestedModel: JEV_113, id: "jev113@openrouter" },
    questions: {
      tool: {
        gate: TOOL_GATE,
        hash: hashQuestion(TOOL_QUESTION),
        source: "T1 gate.ts TOOL_QUESTION",
      },
      raw: { gate: RAW_GATE, hash: hashQuestion(TOOL_QUESTION), floors: "none" },
      moderation: {
        gate: MOD_GATE,
        members: mod.members.map((q) => ({ id: q.id, hash: hashQuestion(q) })),
        combine: "any",
        source: "T3 corpus/moderation.json questions.members",
      },
    },
    floors: {
      tool: "T1's FLOORS: CATASTROPHIC (refuse), ONE_WAY (review), REVIEW (review)",
      moderation: `attachment scan: ${PROHIBITED_SCAN} -> refuse (no call)`,
    },
    frozen: {
      tool: ft,
      moderation: fm,
      registered: {
        tool: { policy: toolPolicy, which: ft.live },
        moderation: { policy: modPolicy, which: fm.live.which },
      },
    },
    acceptance,
    settings: SETTINGS,
    deciderSource: DECIDER_SOURCE,
    providerUsageAtStart: usageAtStart,
  });
  progress(
    `[plan] manifest written before any call: tool act above ${toolPolicy.actAbove} (${ft.live}), moderation any act above ${modPolicy.actAbove} (${fm.live.which}); planned sample ${acceptance.sampleSize} acts`,
  );
  return { tool: ft, mod: fm, toolPolicy, modPolicy };
}

// ---------------------------------------------------------------------------
// Study A: the tool gate
// ---------------------------------------------------------------------------

function engineFor(ledger: string, oracle: Oracle): Engine {
  return new Engine({
    oracle,
    ledger: new JsonlLedger(ledger),
    mode: "shadow",
    keepState: true,
    seed: SETTINGS.engineSeed,
    timeoutMs: 30_000,
    budgetUsd: SETTINGS.budgetUsd,
    dailyBudgetUsd: SETTINGS.dailyBudgetUsd,
  });
}

function toolSpec(f: Frozen, checkpoint: RolloutCheckpoint | undefined): GateSpec<JudgeQuestion> {
  return {
    id: TOOL_GATE,
    question: TOOL_QUESTION,
    policy: f.toolPolicy,
    evidenceVersion: TOOL_VERSION,
    floors: FLOORS,
    promisedAccuracy: SETTINGS.promise,
    auditRate: SETTINGS.auditRate,
    mode: "shadow",
    rollout: {
      evidence: {
        version: TOOL_VERSION,
        ...(!offline && f.tool.pinnedModel !== undefined ? { model: f.tool.pinnedModel } : {}),
      },
      confidence: SETTINGS.confidence,
      maxErrors: SETTINGS.maxErrors,
      group: SETTINGS.group,
      minAuditRows: SETTINGS.minAuditRows,
      window: SETTINGS.window,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    },
  };
}

function brief(s: RolloutStatus): Record<string, unknown> {
  const a = s.acceptance;
  return {
    mode: s.mode,
    changed: s.changed,
    reason: s.reason,
    grade: s.grade,
    ...(a
      ? {
          acceptance: {
            status: a.status,
            sampleSize: a.plan.sampleSize,
            ...("acts" in a ? { acts: a.acts } : {}),
            ...("unlabelled" in a ? { unlabelled: a.unlabelled } : {}),
            ...("errors" in a ? { errors: a.errors, lowerBound: a.lowerBound } : {}),
            ...("sample" in a ? { sample: a.sample } : {}),
          },
        }
      : {}),
    at: s.at,
  };
}

const labelsByState = (items: readonly Item[]): Map<string, boolean> =>
  new Map(items.map((i) => [i.state, i.truth]));

async function askAll(
  gate: Gate<JudgeVerdict>,
  items: readonly Item[],
  concurrency: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = items[next++];
      if (it === undefined) return;
      await gate.ask(it.state, { baseline: "review", tags: itemTags(it) });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function studyA(p: Paths, f: Frozen): Promise<void> {
  const items = loadTool();
  const order = shuffled(items, rng(SETTINGS.engineSeed + 1));
  const engine = engineFor(p.toolLedger, toolOracle(offline, items, SETTINGS.engineSeed));
  const gate = engine.gate(toolSpec(f, undefined));
  const s0 = await gate.rollout.evaluate();
  progress(`[A] rollout initialised before any fresh row: ${s0.mode} | ${s0.reason}`);
  const cp0 = gate.rollout.checkpoint();
  if (cp0 !== undefined) writeJson(join(p.dir, "checkpoint-init.json"), cp0);
  await spend(p, "A gate");
  // Sequential, so ledger order is the seeded order and the planned sample never depends on timing.
  for (const it of order) await gate.ask(it.state, { baseline: "review", tags: itemTags(it) });
  const s1 = await gate.rollout.evaluate();
  progress(`[A] after ${order.length} asks, before labels: ${s1.mode} | ${s1.reason}`);
  const review = await blindReview(p.toolLedger, TOOL_GATE, labelsByState(items), {
    sample: 1000,
    seed: SETTINGS.reviewSeed,
  });
  writeFileSync(join(p.dir, "review-tool.txt"), review.output);
  progress(`[A] blind review: ${review.answered} answered, ${review.missing} missing`);
  const s2 = await gate.rollout.evaluate();
  progress(`[A] after labels: ${s2.mode} | ${s2.reason}`);
  const cp = gate.rollout.checkpoint();
  if (cp !== undefined) writeJson(p.checkpoint, cp);
  // A fresh engine over the same ledger, restored from the checkpoint: what a restart sees.
  const restartEngine = engineFor(p.toolLedger, toolOracle(offline, items, SETTINGS.engineSeed));
  const restored = await restartEngine.gate(toolSpec(f, cp)).rollout.evaluate();
  progress(`[A] fresh engine, saved checkpoint: ${restored.mode} | ${restored.reason}`);
  writeJson(p.rollout, {
    init: brief(s0),
    beforeLabels: brief(s1),
    afterLabels: brief(s2),
    restored: brief(restored),
    checkpoint: cp ?? null,
    review: { answered: review.answered, missing: review.missing, exitCode: review.exitCode },
  });

  // The same rubric with no floors: Jev's own answer on the calls the floors settle.
  const rawEngine = engineFor(p.rawLedger, toolOracle(offline, items, SETTINGS.engineSeed + 7));
  const rawGate = rawEngine.gate({
    id: RAW_GATE,
    question: TOOL_QUESTION,
    policy: f.toolPolicy,
    evidenceVersion: RAW_VERSION,
    mode: "shadow",
  });
  await spend(p, "A raw");
  await askAll(rawGate, items, SETTINGS.concurrency);
  const rawReview = await blindReview(p.rawLedger, RAW_GATE, labelsByState(items), {
    sample: 1000,
    seed: SETTINGS.reviewSeed + 1,
  });
  writeFileSync(join(p.dir, "review-raw.txt"), rawReview.output);
  progress(`[A] raw blind review: ${rawReview.answered} answered, ${rawReview.missing} missing`);
}

// ---------------------------------------------------------------------------
// Study B: the moderation battery, combined with `any`
// ---------------------------------------------------------------------------

async function studyB(p: Paths, f: Frozen): Promise<void> {
  const { items, members } = loadMod();
  const byState = new Map(items.map((i) => [i.state, i]));
  const engine = new Engine({
    oracle: modOracle(offline, items, SETTINGS.engineSeed + 11),
    ledger: new JsonlLedger(p.modLedger),
    mode: "shadow",
    keepState: true,
    seed: SETTINGS.engineSeed + 11,
    timeoutMs: 30_000,
    budgetUsd: SETTINGS.budgetUsd,
    dailyBudgetUsd: SETTINGS.dailyBudgetUsd,
  });
  const scan = PROHIBITED_SCAN.replace(/[()]/g, "\\$&");
  const gate = engine.gate({
    id: MOD_GATE,
    question: members,
    combine: "any",
    policy: f.modPolicy,
    evidenceVersion: MOD_VERSION,
    floors: [forQuestion(MOD_GATE, refuseIf(new RegExp(`attachment scan: ${scan}`)))],
    mode: "shadow",
  });
  await spend(p, "B battery");
  const order = shuffled(items, rng(SETTINGS.engineSeed + 2));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = order[next++];
      if (it === undefined) return;
      await gate.ask(it.state, {
        baseline: "review",
        tags: [`item:${it.id}`, `template:${it.template}`],
      });
    }
  };
  await Promise.all(Array.from({ length: SETTINGS.concurrency }, worker));
  // The review command first: it shows the battery's question, and the decider answers "does
  // this need moderator action?" from the label fixed before the run.
  const review = await blindReview(
    p.modLedger,
    MOD_GATE,
    new Map(items.map((i) => [i.state, i.truth])),
    { sample: 1000, seed: SETTINGS.reviewSeed + 2 },
  );
  writeFileSync(join(p.dir, "review-mod.txt"), review.output);
  progress(`[B] blind review: ${review.answered} answered, ${review.missing} missing`);
  // Then each answered request again with every member's own truth (same battery truth).
  const rows = await engine.ledger.all();
  let relabelled = 0;
  let reviewAgreed = 0;
  let reviewed = 0;
  for (const r of rows) {
    if (r.gateId !== MOD_GATE || r.combined !== true || r.state === undefined) continue;
    const it = byState.get(r.state);
    if (it === undefined) continue;
    if (r.outcome?.source?.startsWith("review:")) {
      reviewed++;
      if (r.outcome.truth === it.truth) reviewAgreed++;
    }
    if (r.strategy === "floored" || r.failedOpen) continue;
    const v = r.verdict as JudgeVerdict;
    await engine.label(r.id, {
      correct: v.pYes >= 0.5 === it.truth,
      truth: it.truth,
      source: DECIDER_SOURCE,
      note: it.why.slice(0, 240),
      memberTruths: { ...it.memberTruths },
    });
    relabelled++;
  }
  writeJson(join(p.dir, "mod-labels.json"), {
    review: { answered: review.answered, missing: review.missing },
    reviewTruthMatchesCorpus: { agreed: reviewAgreed, of: reviewed },
    relabelledWithMemberTruths: relabelled,
  });
  progress(
    `[B] review truth matched the corpus on ${reviewAgreed} of ${reviewed}; ${relabelled} requests relabelled with memberTruths`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const p = paths(runDir());
  progress(`[v4] run dir ${p.dir}`);
  const f = await plan(p);
  await studyA(p, f);
  await studyB(p, f);
  await spend(p, "end");
  const manifest = readJson<{ providerUsageAtStart: number | null }>(p.manifest);
  const usageDelta =
    offline || manifest.providerUsageAtStart === null
      ? null
      : (await providerUsage()) - manifest.providerUsageAtStart;
  writeJson(join(p.dir, "spend.json"), {
    recordedUsd: await recordedSpend(p),
    providerUsageDeltaUsd: usageDelta,
    note: "The provider delta also counts any concurrent study on the same key, and lags by up to a minute.",
  });
  await analyze(p.dir);
}

if (import.meta.main) await main();
