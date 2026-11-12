/**
 * Track T5 runner: do the compounding strategies compound on new hard data?
 *
 *   bun experiments/e2e/t5-compound/main.ts [--offline]            the evaluation (corpus.json)
 *   bun experiments/e2e/t5-compound/main.ts pilot --corpus=<file>  a difficulty pilot (singles only)
 *   bun experiments/e2e/t5-compound/main.ts --only=seq-bar,...      a subset of strategies
 *   bun experiments/e2e/t5-compound/main.ts --resume=<run dir>      continue a stopped run
 *
 * Every strategy runs through the real engine as a registered gate's strategy, into its own
 * JSONL ledger in a fresh run directory, and every row is labelled afterwards from the corpus
 * labels fixed before the run (source review:blind:decider; one gate also through the real
 * `ratchet review` path). Phase 1 asks the single models; the cascade bars are then fitted on
 * the fit split only and frozen into the manifest before phase 2 asks anything. `--offline`
 * swaps every backend for a SimOracle, exercising the same wiring with no spend.
 *
 * Analysis is separate (analyze.ts) and reads only the ledgers, as a user would.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../../src/engine.ts";
import type { Gate } from "../../../src/gate.ts";
import { hashQuestion, JsonlLedger } from "../../../src/ledger/ledger.ts";
import { SimOracle } from "../../../src/oracles/sim.ts";
import { hashPolicy } from "../../../src/policy.ts";
import type { Question, Verdict } from "../../../src/types.ts";
import {
  blindReview,
  corpusHash,
  type DeciderLabel,
  E2E_OUT,
  gitHead,
  guard,
  HAIKU,
  haiku,
  JEV_113,
  JEV_114,
  jev113,
  jev114,
  LUNA,
  labelAsDecider,
  luna,
  progress,
  runDir,
  writeJson,
} from "../lib.ts";
import type { CorpusFile, CorpusItem } from "./corpus-gen.ts";
import { DOMAINS, type Domain, questionOf, RUBRICS } from "./gates.ts";
import { type Backends, type Frozen, STRATEGIES, type StrategyDef } from "./strategies.ts";

const HERE = new URL("./", import.meta.url);
const TRACK = "t5-compound";
/** Shadow everywhere; the bar only shapes the recorded recommendation. */
const POLICY = { actAbove: 0.95 } as const;
/** This track's own cap, summed from billed ledger costs across its live runs. */
export const TRACK_CAP_USD = 2.5;

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const pilot = args.includes("pilot");
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice(7);
const resume = args.find((a) => a.startsWith("--resume="))?.slice(9);
const corpusArg = args.find((a) => a.startsWith("--corpus="))?.slice(9);
const only = onlyArg ? new Set(onlyArg.split(",")) : undefined;

/**
 * What this track has spent live, summed from the billed cost on every row of every live run's
 * ledgers. The evaluation-wide guard reads the provider's usage, which other tracks share; this
 * is the track's own share of it.
 */
export function trackSpend(): number {
  const root = join(E2E_OUT, TRACK);
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const run of readdirSync(root)) {
    if (run.includes("offline")) continue;
    const dir = join(root, run);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { type?: string; record?: { cost?: number } };
        if (row.type === "decision") total += row.record?.cost ?? 0;
      }
    }
  }
  return total;
}

function checkTrackCap(def: StrategyDef): void {
  const spent = trackSpend();
  progress(`[t5 spend] ${def.name}: track USD ${spent.toFixed(4)} of USD ${TRACK_CAP_USD}`);
  if (spent + def.budgetUsd > TRACK_CAP_USD) {
    throw new Error(
      `track cap: USD ${spent.toFixed(4)} spent, ${def.name} may add USD ${def.budgetUsd}`,
    );
  }
}

function hasRows(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes('"type":"decision"');
}

function loadCorpus(file: string): CorpusFile {
  return JSON.parse(readFileSync(new URL(file, HERE), "utf8")) as CorpusFile;
}

// ---------------------------------------------------------------------------
// Backends: live, or simulated with known accuracy and calibration.
// ---------------------------------------------------------------------------

function simBackends(items: readonly CorpusItem[]): Backends {
  const byState = new Map(items.map((i) => [i.state, i] as const));
  const truthOf = (state: string, q: Question) => {
    const it = byState.get(state);
    if (!it) return undefined;
    if (q.kind === "pick") return { pick: String(it.truth) };
    const negated = q.id.endsWith(".neg");
    return { judge: negated ? it.truth !== true : it.truth === true };
  };
  // Seeds differ per backend, and repeated calls on one item are correlated as a near-
  // deterministic decision model's are; the accuracies are placeholders, not predictions.
  let n = 0;
  const sim = (id: string, accuracy: number, correlation: number, temperature: number) => () =>
    new SimOracle(
      { id, accuracy, correlation, temperature, seed: 11 + n++, latencyMs: 0 },
      truthOf,
    );
  return {
    jev113: sim("jev113@sim", 0.8, 0.9, 1.3),
    jev114: sim("jev114@sim", 0.82, 0.9, 1.2),
    haiku: sim("haiku55@sim", 0.86, 0.95, 1.5),
    luna: sim("luna@sim", 0.84, 0.95, 1.4),
  };
}

const LIVE: Backends = { jev113, jev114, haiku, luna };

// ---------------------------------------------------------------------------
// Running one strategy
// ---------------------------------------------------------------------------

async function mapLimit<T, R>(
  xs: readonly T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= xs.length) return;
      out[i] = await fn(xs[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

interface Asked {
  readonly item: CorpusItem;
  readonly recordId: string;
  readonly verdict: Verdict;
}

async function runStrategy(
  dir: string,
  def: StrategyDef,
  items: readonly CorpusItem[],
  b: Backends,
  frozen: Frozen,
): Promise<void> {
  const ledgerPath = join(dir, `${def.name}.jsonl`);
  const engine = new Engine({
    oracle: b[def.primary](),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    mode: "shadow",
    budgetUsd: def.budgetUsd,
    timeoutMs: 60_000,
    seed: 5,
  });
  const gates = new Map<Domain, Gate>();
  for (const d of DOMAINS) {
    const spec = def.spec?.(d, b, frozen);
    gates.set(
      d,
      engine.gate({
        id: `t5.${d}`,
        question: questionOf(d),
        policy: POLICY,
        ...(spec !== undefined ? { strategy: spec } : {}),
      }) as Gate,
    );
  }
  const started = performance.now();
  const asked = await mapLimit(items, def.concurrency, async (item): Promise<Asked> => {
    const gate = gates.get(item.domain) as Gate;
    const r = await gate.ask(item.state, { tags: [`item:${item.id}`, `split:${item.split}`] });
    return { item, recordId: r.recordId, verdict: r.decision.verdict };
  });
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  // Labels: one gate through the real blind-review path, the rest recorded directly.
  const labelOf = (it: CorpusItem): DeciderLabel => ({
    truth: it.truth,
    why: it.why,
    ...(it.ambiguous ? { ambiguous: true } : {}),
  });
  if (def.name === "single-jev113") {
    const judgeLabels = new Map(
      items.filter((i) => i.domain === "contract").map((i) => [i.state, i.truth === true] as const),
    );
    const res = await blindReview(ledgerPath, "t5.contract", judgeLabels, { sample: 20, seed: 7 });
    progress(`  blind review via ratchet review: ${res.answered} answered, ${res.missing} missing`);
  }
  const labelled = new Set(
    (await engine.ledger.all()).filter((r) => r.outcome !== undefined).map((r) => r.id),
  );
  for (const a of asked) {
    if (labelled.has(a.recordId)) continue;
    await labelAsDecider(engine, a.recordId, a.verdict, labelOf(a.item));
  }
  const rows = await engine.ledger.all();
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const failed = rows.filter((r) => r.failedOpen).length;
  progress(
    `  ${def.name}: ${rows.length} rows in ${secs}s, $${cost.toFixed(4)}, ${failed} failed open`,
  );
}

// ---------------------------------------------------------------------------
// Phase 1 -> frozen bars (fit split only) -> phase 2
// ---------------------------------------------------------------------------

interface SingleRow {
  readonly item: string;
  readonly split: string;
  readonly correct: boolean;
  readonly confidence: number;
}

async function singleRows(dir: string, name: string): Promise<Map<string, SingleRow>> {
  const rows = await new JsonlLedger(join(dir, `${name}.jsonl`)).all();
  const out = new Map<string, SingleRow>();
  for (const r of rows) {
    const item = r.tags.find((t) => t.startsWith("item:"))?.slice(5);
    const split = r.tags.find((t) => t.startsWith("split:"))?.slice(6);
    if (!item || !split || !r.outcome || r.failedOpen) continue;
    out.set(item, { item, split, correct: r.outcome.correct, confidence: r.confidence });
  }
  return out;
}

/**
 * The tier-1 bar that maximises the cascade's accuracy on the fit split, read from the two
 * single-model ledgers (the cascade with bar t answers with tier 1 when its confidence is at
 * least t, else with tier 2). Ties go to the lower bar, which escalates less. This is the bar
 * most favourable to the cascade that the fit split can justify.
 */
function fitCascadeBar(
  t1: Map<string, SingleRow>,
  t2: Map<string, SingleRow>,
): {
  readonly bar: number;
  readonly fitAccuracy: number;
  readonly fitEscalation: number;
  readonly n: number;
} {
  const fit = [...t1.values()].filter((r) => r.split === "fit" && t2.has(r.item));
  const candidates = [...new Set([0.5, ...fit.map((r) => r.confidence), 1.01])].sort(
    (a, b) => a - b,
  );
  let best = { bar: 0.5, fitAccuracy: -1, fitEscalation: 0, n: fit.length };
  for (const bar of candidates) {
    let right = 0;
    let up = 0;
    for (const r of fit) {
      if (r.confidence >= bar) {
        if (r.correct) right++;
      } else {
        up++;
        if (t2.get(r.item)?.correct) right++;
      }
    }
    const acc = right / Math.max(1, fit.length);
    if (acc > best.fitAccuracy + 1e-12) {
      best = { bar, fitAccuracy: acc, fitEscalation: up / Math.max(1, fit.length), n: fit.length };
    }
  }
  return best;
}

async function main(): Promise<void> {
  const corpusFile = corpusArg ?? (pilot ? "pilot-corpus.json" : "corpus.json");
  const corpus = loadCorpus(corpusFile);
  const items = corpus.items;
  const dir =
    resume ?? runDir(TRACK, `${pilot ? "pilot" : "main"}-${offline ? "offline" : "live"}`);
  const b = offline ? simBackends(items) : LIVE;
  const phase1 = STRATEGIES.filter((s) => s.phase === 1);
  const phase2 = STRATEGIES.filter((s) => s.phase === 2);
  const selected = (s: StrategyDef) =>
    (only === undefined || only.has(s.name)) && (!pilot || s.name !== "single-luna");
  const manifest = {
    track: TRACK,
    mode: pilot ? "pilot" : "main",
    offline,
    startedAt: new Date().toISOString(),
    gitHead: gitHead(),
    corpus: {
      file: corpusFile,
      version: corpus.version,
      hash: corpusHash(corpus),
      items: items.length,
      splits: Object.fromEntries(
        ["pilot", "fit", "held"].map((s) => [s, items.filter((i) => i.split === s).length]),
      ),
    },
    models: offline
      ? { jev113: "sim", jev114: "sim", haiku: "sim", luna: "sim" }
      : { jev113: JEV_113, jev114: JEV_114, haiku: HAIKU, luna: LUNA },
    labelSource: "review:blind:decider",
    policy: { ...POLICY, hash: hashPolicy(POLICY) },
    rubrics: Object.fromEntries(
      DOMAINS.map((d) => [
        d,
        {
          id: RUBRICS[d].question.id,
          hash: hashQuestion(RUBRICS[d].question),
          paraphrase: RUBRICS[d].paraphrase,
        },
      ]),
    ),
    strategies: STRATEGIES.filter(selected).map((s) => ({
      name: s.name,
      phase: s.phase,
      describe: s.describe,
      budgetUsd: s.budgetUsd,
    })),
    frozen: undefined as unknown,
  };
  const manifestPath = join(dir, "manifest.json");
  if (resume !== undefined) {
    // A resumed run keeps the manifest it started with, including any frozen bars.
    const prior = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    if (prior.corpus.hash !== manifest.corpus.hash)
      throw new Error("corpus changed since the run began");
    manifest.frozen = prior.frozen;
    manifest.startedAt = prior.startedAt;
  }
  writeJson(manifestPath, manifest);
  progress(`[t5] run dir ${dir}`);
  const done = (def: StrategyDef) => hasRows(join(dir, `${def.name}.jsonl`));

  const live = !offline;
  for (const def of phase1.filter(selected)) {
    if (done(def)) continue;
    if (live) {
      await guard(`t5 ${def.name}`);
      checkTrackCap(def);
    }
    await runStrategy(dir, def, items, b, { cascadeHaikuBar: 1, cascadeLunaBar: 1 });
  }
  if (pilot) {
    progress("[t5] pilot done");
    return;
  }

  // Freeze the cascade bars from the fit split before any phase-2 call.
  const j = await singleRows(dir, "single-jev113");
  const h = await singleRows(dir, "single-haiku");
  const l = await singleRows(dir, "single-luna");
  const haikuFit = fitCascadeBar(j, h);
  const lunaFit = fitCascadeBar(j, l);
  const prior = manifest.frozen as Frozen | undefined;
  const frozen: Frozen = prior ?? { cascadeHaikuBar: haikuFit.bar, cascadeLunaBar: lunaFit.bar };
  if (prior === undefined) {
    manifest.frozen = { at: new Date().toISOString(), ...frozen, haikuFit, lunaFit };
    writeJson(manifestPath, manifest);
  }
  progress(`[t5] frozen: ${JSON.stringify(manifest.frozen)}`);

  for (const def of phase2.filter(selected)) {
    if (done(def)) continue;
    if (live) {
      await guard(`t5 ${def.name}`);
      checkTrackCap(def);
    }
    await runStrategy(dir, def, items, b, frozen);
  }
  progress(`[t5] done: ${dir}`);
}

if (import.meta.main) {
  await main();
}
