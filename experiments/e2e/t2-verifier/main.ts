/**
 * Track T2 of the end-to-end evaluation: the independent verifier and the chain ratchet.
 *
 *   bun experiments/e2e/t2-verifier/main.ts --offline      same wiring, simulated oracle, no spend
 *   bun experiments/e2e/t2-verifier/main.ts                live, Jev 1.14 through OpenRouter
 *   ... --run <dir> --from <phase> [--until <phase>]       resume a run directory
 *
 * Phases, in order: corpus (labels fixed, manifest written), fit (shadow asks on the fit split),
 * label-fit (blind census through the real `ratchet review`), freeze (bars, combiner and
 * correlation fitted on fit rows only, written to the manifest), eval (held-out and challenge,
 * once), label-eval, chain (runChain over fresh held-out tasks), analyze.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poolJudge } from "../../../src/compound/aggregate.ts";
import { fitLogistic, predictLogistic } from "../../../src/compound/learned.ts";
import { Engine } from "../../../src/engine.ts";
import type { Gate } from "../../../src/gate.ts";
import { memberCorrelation } from "../../../src/ledger/calibration.ts";
import { decisionRows, JsonlLedger } from "../../../src/ledger/ledger.ts";
import { mean } from "../../../src/math.ts";
import type { GatePolicy } from "../../../src/policy.ts";
import type { Decision, JudgeVerdict, Oracle } from "../../../src/types.ts";
import {
  blindReview,
  corpusHash,
  DECIDER_SOURCE,
  gitHead,
  guard,
  ROOT,
  runDir,
  sha256,
  writeJson,
} from "../lib.ts";
import { analyze, type Frozen } from "./analysis.ts";
import {
  buildChainTable,
  CHAIN,
  type ChainLog,
  type ChainTable,
  REFUSE_CHAINS,
  runOne,
} from "./chain.ts";
import {
  buildCorpus,
  CORPUS_SEED,
  corpusStats,
  INSTANCES,
  labelFile,
  renderItem,
  spotcheck,
  validateCorpus,
} from "./corpus.ts";
import {
  askMany,
  batterySpec,
  Ctx,
  ENGINE_BUDGET_USD,
  EVIDENCE_VERSION,
  features,
  holisticSpec,
  joinRows,
  log,
  MODEL,
  memberVerdicts,
  pointsOf,
  readLedger,
  TRACK,
} from "./harness.ts";
import { BATTERY, GATES, HOLISTIC } from "./questions.ts";
import { fitActBar } from "./stats.ts";
import { type Item, MEMBERS, type Split, subTruths } from "./types.ts";

const PHASES = [
  "corpus",
  "fit",
  "label-fit",
  "freeze",
  "eval",
  "label-eval",
  "chain",
  "chain-strict",
  "analyze",
] as const;
/**
 * The second chain operating point, declared after the fit freeze and before any held-out or
 * chain verdict was read (declared-strict.json in the run directory records when): the vision's
 * "90% verifier" bar, so the formula is tested where false alarms are frequent as well.
 */
const STRICT_BAR = 0.9;
type Phase = (typeof PHASES)[number];

const TARGET = 0.95;
const MIN_SUPPORT = 20;
/** The shadow policy before anything is fitted. It only shapes the recorded recommendation. */
const SHADOW_POLICY: GatePolicy = { actAbove: 0.9 };
/** For the refuse-semantics variant, fixed before any chain ran. */
const REFUSE_BELOW = 0.2;
const TRACK_DIR = join(ROOT, "experiments", "e2e", TRACK);

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const offline = argv.includes("--offline");
const from = (flag("--from") ?? "corpus") as Phase;
const until = (flag("--until") ?? "analyze") as Phase;
if (!PHASES.includes(from) || !PHASES.includes(until))
  throw new Error(`phases are ${PHASES.join(", ")}`);
const dir = flag("--run") ?? runDir(TRACK, offline ? "offline" : "live");
mkdirSync(join(dir, "ledgers"), { recursive: true });
const runs = (p: Phase): boolean =>
  PHASES.indexOf(p) >= PHASES.indexOf(from) && PHASES.indexOf(p) <= PHASES.indexOf(until);

const ctx = new Ctx(dir, offline);
const items = buildCorpus();
validateCorpus(items);
const hashOf = new Map<string, string>();
const renderHash = (it: Item, raw: boolean): string => {
  const key = `${it.id}|${raw}`;
  let h = hashOf.get(key);
  if (h === undefined) {
    h = renderItem(it, raw ? "raw" : "digested").hash;
    hashOf.set(key, h);
  }
  return h;
};
for (const it of items) {
  ctx.register(renderItem(it).text, { truth: it.truth, sub: it.sub });
  if (it.domain === "convert")
    ctx.register(renderItem(it, "raw").text, { truth: it.truth, sub: it.sub });
}
const tables = new Map<number, ChainTable>(CHAIN.ps.map((p) => [p, buildChainTable(p)]));
for (const table of tables.values()) {
  for (const c of table.flat(2))
    ctx.register(c.text, { truth: c.truth, sub: subTruths(c.variant) });
}
const bySplit = (s: Split): Item[] => items.filter((i) => i.split === s);
const statesOf = (xs: readonly Item[], raw = false) =>
  xs
    .filter((i) => !raw || i.domain === "convert")
    .map((i) => ({ id: i.id, text: renderItem(i, raw ? "raw" : "digested").text }));

const manifestPath = join(dir, "manifest.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
async function spend(where: string): Promise<number | undefined> {
  return offline ? undefined : guard(`${TRACK} ${where}`);
}

/** Label every unreviewed row of a gate through the real review command, in sessions of 1,000. */
async function census(
  ledger: string,
  gateId: string,
): Promise<{ answered: number; missing: number; sessions: number; ms: number }> {
  const path = ctx.ledgerPath(ledger);
  const labels = ctx.labels();
  const started = performance.now();
  let answered = 0;
  let missing = 0;
  let sessions = 0;
  for (;;) {
    const rows = await readLedger(ctx, ledger);
    const pool = decisionRows(rows).filter(
      (r) =>
        r.gateId === gateId &&
        typeof r.state === "string" &&
        !(r.outcome?.source ?? "").startsWith("review:"),
    );
    if (pool.length === 0) break;
    const res = await blindReview(path, gateId, labels, {
      sample: Math.min(1000, pool.length),
      seed: 101 + sessions,
    });
    if (res.exitCode !== 0) throw new Error(`review failed on ${ledger}: ${res.output}`);
    sessions++;
    answered += res.answered;
    missing += res.missing;
    if (res.answered === 0) break;
  }
  const ms = performance.now() - started;
  // Every decision row must now carry the decider's blind label, equal to the corpus truth.
  const rows = decisionRows(await readLedger(ctx, ledger)).filter((r) => r.gateId === gateId);
  const bad = rows.filter(
    (r) =>
      r.outcome?.source !== DECIDER_SOURCE ||
      ctx.truthByText.get(r.state ?? "")?.truth !== r.outcome?.truth,
  );
  if (bad.length > 0)
    throw new Error(`${ledger}: ${bad.length} rows not labelled as the corpus says`);
  log(
    `  census ${ledger}: ${answered} labels in ${sessions} session(s), ${(ms / 1000).toFixed(1)} s`,
  );
  return { answered, missing, sessions, ms };
}

async function phaseCorpus(): Promise<void> {
  const labels = labelFile(items);
  const labelsPath = join(TRACK_DIR, "labels.json");
  const text = `${JSON.stringify(labels, null, 2)}\n`;
  if (existsSync(labelsPath) && readFileSync(labelsPath, "utf8") !== text) {
    if (!argv.includes("--rewrite-labels")) {
      throw new Error(
        "labels.json differs from the generator; labels are never changed after a live run",
      );
    }
  }
  if (!existsSync(labelsPath) || argv.includes("--rewrite-labels")) {
    writeJson(labelsPath, labels);
    writeJson(join(TRACK_DIR, "spotcheck.json"), spotcheck(items));
  }
  const chainLabels = [...tables.values()].flatMap((t) =>
    t.flat(2).map((c) => ({
      id: c.id,
      truth: c.truth,
      variant: c.variant,
      why: c.why,
      stateHash: c.stateHash,
    })),
  );
  writeJson(join(dir, "chain-labels.json"), chainLabels);
  writeJson(join(dir, "corpus.json"), items);
  const stats = corpusStats(items);
  writeJson(manifestPath, {
    track: TRACK,
    createdAt: new Date().toISOString(),
    offline,
    gitHead: gitHead(),
    model: offline ? "sim@t2 (SimOracle accuracy 0.85)" : MODEL,
    corpusSeed: CORPUS_SEED,
    instancesPerFamily: INSTANCES,
    corpusHash: corpusHash(items),
    labelsHash: sha256(readFileSync(labelsPath, "utf8")),
    chainLabelsHash: corpusHash(chainLabels),
    chain: { ...CHAIN, refuseChains: REFUSE_CHAINS, refuseBelow: REFUSE_BELOW },
    stats,
    questions: { holistic: HOLISTIC, battery: BATTERY },
    shadowPolicy: SHADOW_POLICY,
    target: TARGET,
    minSupport: MIN_SUPPORT,
    engineBudgetUsd: ENGINE_BUDGET_USD,
    evidenceVersion: EVIDENCE_VERSION,
  });
  log(
    `corpus: ${stats.n} items (${Object.entries(stats.bySplit)
      .map(([k, v]) => `${k} ${v.n}`)
      .join(", ")}), ${chainLabels.length} chain candidates`,
  );
}

async function phaseFit(): Promise<void> {
  await spend("fit:start");
  const fit = bySplit("fit");
  const hol = ctx.engine("fit-holistic").gate(holisticSpec(GATES.holistic, SHADOW_POLICY));
  const bat = ctx.engine("fit-battery").gate(batterySpec(GATES.battery, SHADOW_POLICY));
  const raw = ctx.engine("fit-raw").gate(holisticSpec(GATES.raw, SHADOW_POLICY));
  const logs = {
    holistic: await askMany(hol, statesOf(fit), "fit holistic"),
    battery: await askMany(bat, statesOf(fit), "fit battery"),
    raw: await askMany(raw, statesOf(fit, true), "fit raw"),
  };
  writeJson(join(dir, "asks-fit.json"), logs);
  await spend("fit:end");
}

async function phaseLabel(split: "fit" | "eval"): Promise<void> {
  const out: Record<string, unknown> = {};
  const list: [string, string][] =
    split === "fit"
      ? [
          ["fit-holistic", GATES.holistic],
          ["fit-battery", GATES.battery],
          ["fit-raw", GATES.raw],
        ]
      : [
          ["heldout-holistic", GATES.holistic],
          ["heldout-battery", GATES.battery],
          ["heldout-battery-corr", GATES.batteryCorr],
          ["heldout-battery-learned", GATES.batteryLearned],
          ["heldout-raw", GATES.raw],
          ["challenge-holistic", GATES.holistic],
          ["challenge-battery", GATES.battery],
          ["challenge-raw", GATES.raw],
        ];
  for (const [ledger, gate] of list) out[ledger] = await census(ledger, gate);
  writeJson(join(dir, `labels-${split}.json`), out);
}

/** Fit on the fit split only: the report's bar, a one-sided act bar, the combiner, rho. */
async function phaseFreeze(): Promise<void> {
  const digested = new Map(
    items.map((it) => [
      renderHash(it, false),
      { id: it.id, cluster: it.instance, truth: it.truth },
    ]),
  );
  const never: Oracle = {
    id: "never",
    decide: async () => {
      throw new Error("the freeze phase reads the ledger only");
    },
  };
  // The product path: the gate's own report on its labelled shadow rows.
  const fitEngine = new Engine({
    oracle: never,
    ledger: new JsonlLedger(ctx.ledgerPath("fit-holistic")),
  });
  const gate = fitEngine.gate(holisticSpec(GATES.holistic, SHADOW_POLICY));
  const report = await gate.report({ targetAccuracy: TARGET, minSupport: MIN_SUPPORT });
  const fitRows = joinRows(await readLedger(ctx, "fit-holistic"), GATES.holistic, digested);
  const fitPts = pointsOf(fitRows.scored);
  const oneSidedBar = fitActBar(fitPts, TARGET, MIN_SUPPORT);
  const productBar = report.fitted?.threshold;
  const chainBar = oneSidedBar ?? productBar ?? 0.9;
  const chainBarSource =
    oneSidedBar !== undefined
      ? "one-sided precision bar on fit"
      : productBar !== undefined
        ? "report().fitted fallback"
        : "default 0.9";

  // The battery, read back from the ledger: member verdicts by request, truth from the label.
  const bRows = await readLedger(ctx, "fit-battery");
  const members = memberVerdicts(bRows, GATES.battery);
  const combined = decisionRows(bRows).filter(
    (r) => r.gateId === GATES.battery && !r.failedOpen && typeof r.outcome?.truth === "boolean",
  );
  const train = combined.flatMap((r) => {
    const vs = members.get(r.requestId);
    return vs
      ? [
          {
            x: features(vs),
            y: r.outcome?.truth === true,
            vs,
            cluster: digested.get(r.stateHash)?.cluster ?? r.requestId,
          },
        ]
      : [];
  });
  const learned = fitLogistic(train.map(({ x, y }) => ({ x, y })));
  // The correlation the docs ask for, measured as the ledger would give it: phi between members'
  // correctness against the inherited (battery) truth, averaged over pairs.
  const cols = MEMBERS.map((_, k) =>
    train.map((t) => (t.vs[k] as JudgeVerdict).pYes >= 0.5 === t.y),
  );
  const phis: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    for (let k = i + 1; k < cols.length; k++) {
      const a = cols[i] as boolean[];
      const b = cols[k] as boolean[];
      let n11 = 0;
      let n10 = 0;
      let n01 = 0;
      let n00 = 0;
      a.forEach((x, j) => {
        const y = b[j] as boolean;
        if (x && y) n11++;
        else if (x) n10++;
        else if (y) n01++;
        else n00++;
      });
      const d = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
      if (d > 0) phis.push((n11 * n00 - n10 * n01) / d);
    }
  }
  const lib = memberCorrelation(bRows);
  const measured = lib.mean ?? mean(phis);
  const correlation = Math.min(1, Math.max(0, measured));
  const pts = (f: (vs: readonly JudgeVerdict[]) => number) =>
    train.map((t) => ({ p: f(t.vs), truth: t.y, cluster: t.cluster }));
  const batteryBars: Record<string, number | undefined> = {
    holistic: oneSidedBar,
    logodds: fitActBar(
      pts((vs) => poolJudge(vs).pYes),
      TARGET,
      MIN_SUPPORT,
    ),
    "logodds-corr": fitActBar(
      pts((vs) => poolJudge(vs, { correlation }).pYes),
      TARGET,
      MIN_SUPPORT,
    ),
    min: fitActBar(
      pts((vs) => poolJudge(vs, { method: "min" }).pYes),
      TARGET,
      MIN_SUPPORT,
    ),
    learned: fitActBar(
      pts((vs) => predictLogistic(learned, features(vs))),
      TARGET,
      MIN_SUPPORT,
    ),
  };
  const frozen: Frozen = {
    target: TARGET,
    ...(productBar !== undefined ? { productBar } : {}),
    ...(report.fittedFrom !== undefined ? { productFittedFrom: report.fittedFrom } : {}),
    productReport: report,
    ...(oneSidedBar !== undefined ? { oneSidedBar } : {}),
    chainBar,
    chainBarSource,
    correlation,
    correlationSource:
      lib.mean !== undefined
        ? "memberCorrelation over the fit battery ledger"
        : `memberCorrelation found no pairs (n=${lib.n}); mean phi of member correctness against the inherited truth over ${phis.length} pairs, computed from member rows by request`,
    learned,
    batteryBars,
  };
  writeJson(join(dir, "frozen.json"), frozen);
  const manifest = readJson<Record<string, unknown>>(manifestPath);
  writeJson(manifestPath, {
    ...manifest,
    frozenAt: new Date().toISOString(),
    frozen: {
      ...frozen,
      policies: {
        holistic: { actAbove: chainBar },
        battery: { actAbove: batteryBars.logodds ?? 0.99 },
        batteryCorr: {
          combine: { method: "logodds", correlation },
          actAbove: batteryBars["logodds-corr"] ?? 0.99,
        },
        batteryLearned: { combine: learned, actAbove: batteryBars.learned ?? 0.99 },
        chain: { actAbove: chainBar },
        chainRefuse: { actAbove: chainBar, refuseBelow: REFUSE_BELOW },
      },
    },
  });
  log(
    `freeze: report bar ${productBar ?? "none"} (${report.fittedFrom ?? "-"}), one-sided bar ${oneSidedBar ?? "none"}, chain bar ${chainBar}, rho ${correlation.toFixed(3)}`,
  );
}

async function phaseEval(): Promise<void> {
  const frozen = readJson<Frozen>(join(dir, "frozen.json"));
  await spend("eval:start");
  const pol = (b: number | undefined): GatePolicy => ({ actAbove: b ?? 0.99 });
  for (const split of ["heldout", "challenge"] as const) {
    const xs = bySplit(split);
    const logs: Record<string, unknown> = {};
    const hol = ctx
      .engine(`${split}-holistic`)
      .gate(holisticSpec(GATES.holistic, pol(frozen.chainBar)));
    logs.holistic = await askMany(hol, statesOf(xs), `${split} holistic`);
    const bat = ctx
      .engine(`${split}-battery`)
      .gate(batterySpec(GATES.battery, pol(frozen.batteryBars.logodds)));
    logs.battery = await askMany(bat, statesOf(xs), `${split} battery`);
    const raw = ctx.engine(`${split}-raw`).gate(holisticSpec(GATES.raw, pol(frozen.chainBar)));
    logs.raw = await askMany(raw, statesOf(xs, true), `${split} raw`);
    if (split === "heldout") {
      const corr = ctx.engine("heldout-battery-corr").gate(
        batterySpec(GATES.batteryCorr, pol(frozen.batteryBars["logodds-corr"]), {
          method: "logodds",
          correlation: frozen.correlation,
        }),
      );
      logs.corr = await askMany(corr, statesOf(xs), "heldout battery rho");
      const learned = ctx
        .engine("heldout-battery-learned")
        .gate(batterySpec(GATES.batteryLearned, pol(frozen.batteryBars.learned), frozen.learned));
      logs.learned = await askMany(learned, statesOf(xs), "heldout battery learned");
    }
    writeJson(join(dir, `asks-${split}.json`), logs);
    await spend(`eval:${split}`);
  }
}

async function mapLimit<T, R>(
  xs: readonly T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= xs.length) return;
        out[i] = await fn(xs[i] as T);
      }
    }),
  );
  return out;
}

async function phaseChain(): Promise<void> {
  const frozen = readJson<Frozen>(join(dir, "frozen.json"));
  await spend("chain:start");
  const policy: GatePolicy = { actAbove: frozen.chainBar };
  const gate: Gate = ctx.engine("chain").gate(holisticSpec(GATES.chain, policy));
  const logs: ChainLog[] = [];
  // One verdict cache per base rate, so a replay sees exactly the verdicts its own run bought.
  const caches = new Map<number, Map<string, Decision>>(CHAIN.ps.map((p) => [p, new Map()]));
  for (const p of CHAIN.ps) {
    const table = tables.get(p) as ChainTable;
    const cache = caches.get(p) as Map<string, Decision>;
    const idx = table.map((_, c) => c);
    const ver = await mapLimit(idx, 8, (c) =>
      runOne(table[c] as never, gate, policy, "verified", cache, p, c),
    );
    const unv = await mapLimit(idx, 8, (c) =>
      runOne(table[c] as never, undefined, policy, "unverified", cache, p, c),
    );
    // The same chains with a larger retry budget: verdicts replayed, later attempts asked.
    const big = await mapLimit(idx, 8, (c) =>
      runOne(table[c] as never, gate, policy, "budget", cache, p, c, CHAIN.budgetAttempts),
    );
    logs.push(...ver, ...unv, ...big);
    log(
      `  chains p=${p}: ${ver.filter((c) => c.ok).length}/${ver.length} ok, ${ver.filter((c) => c.trulyOk).length} truly ok; ` +
        `unverified ${unv.filter((c) => c.trulyOk).length}; budget ${CHAIN.budgetAttempts}: ${big.filter((c) => c.trulyOk).length} truly ok`,
    );
  }
  const p0 = CHAIN.ps[0];
  const table0 = tables.get(p0) as ChainTable;
  const cache0 = caches.get(p0) as Map<string, Decision>;
  const refusePolicy: GatePolicy = { actAbove: frozen.chainBar, refuseBelow: REFUSE_BELOW };
  for (let c = 0; c < REFUSE_CHAINS; c++) {
    logs.push(await runOne(table0[c] as never, gate, refusePolicy, "refuse", cache0, p0, c));
  }
  writeJson(join(dir, "chain-runs.json"), logs);
  await spend("chain:end");
  await census("chain", GATES.chain).then((r) => writeJson(join(dir, "labels-chain.json"), r));
}

/** The same chains at the strict bar: verdicts the chain phase bought are replayed from its ledger. */
async function phaseChainStrict(): Promise<void> {
  await spend("chain-strict:start");
  const policy: GatePolicy = { actAbove: STRICT_BAR };
  const gate: Gate = ctx.engine("chain").gate(holisticSpec(GATES.chain, policy));
  const bought = decisionRows(await readLedger(ctx, "chain")).filter(
    (r) => r.gateId === GATES.chain,
  );
  const logs: ChainLog[] = [];
  for (const p of CHAIN.ps) {
    const table = tables.get(p) as ChainTable;
    const texts = new Set(table.flat(2).map((c) => c.text));
    // Rebuild this base rate's verdict cache from the rows its own runs wrote.
    const cache = new Map<string, Decision>();
    for (const r of bought) {
      const mine = r.tags.some((t) => t.startsWith(`chain:p${p}:`));
      if (r.state === undefined || !texts.has(r.state) || !mine) continue;
      cache.set(r.state, {
        verdict: r.verdict,
        oracle: r.oracle,
        ...(r.model !== undefined ? { model: r.model } : {}),
        latencyMs: r.latencyMs,
        cost: r.cost,
        at: r.at,
      });
    }
    const idx = table.map((_, c) => c);
    const runs = await mapLimit(idx, 8, (c) =>
      runOne(table[c] as never, gate, policy, "strict", cache, p, c),
    );
    logs.push(...runs);
    log(
      `  strict chains p=${p}: ${runs.filter((c) => c.ok).length} ok, ${runs.filter((c) => c.trulyOk).length} truly ok, ${runs.reduce((s, c) => s + c.asked, 0)} new asks`,
    );
  }
  writeJson(join(dir, "chain-runs-strict.json"), logs);
  await spend("chain-strict:end");
  await census("chain", GATES.chain).then((r) =>
    writeJson(join(dir, "labels-chain-strict.json"), r),
  );
}

async function phaseAnalyze(): Promise<void> {
  const frozen = readJson<Frozen>(join(dir, "frozen.json"));
  const chains = [
    ...(existsSync(join(dir, "chain-runs.json"))
      ? readJson<ChainLog[]>(join(dir, "chain-runs.json"))
      : []),
    ...(existsSync(join(dir, "chain-runs-strict.json"))
      ? readJson<ChainLog[]>(join(dir, "chain-runs-strict.json"))
      : []),
  ];
  const res = await analyze(ctx, items, renderHash, frozen, chains);
  // Spend recorded on the ledgers (a battery's members carry its cost).
  const names = [
    "fit-holistic",
    "fit-battery",
    "fit-raw",
    "heldout-holistic",
    "heldout-battery",
    "heldout-battery-corr",
    "heldout-battery-learned",
    "heldout-raw",
    "challenge-holistic",
    "challenge-battery",
    "challenge-raw",
    "chain",
  ];
  const cost: Record<string, { rows: number; requests: number; usd: number }> = {};
  for (const n of names) {
    const rows = await readLedger(ctx, n);
    cost[n] = {
      rows: rows.length,
      requests: new Set(rows.map((r) => r.requestId)).size,
      usd: rows.reduce((s, r) => s + r.cost, 0),
    };
  }
  const total = Object.values(cost).reduce((s, c) => s + c.usd, 0);
  writeJson(join(dir, "results.json"), { ...res.json, cost, totalUsd: total, frozen });
  const head = [
    `# T2 verifier run: ${offline ? "offline (simulated oracle)" : MODEL}`,
    "",
    `Run directory: ${dir}`,
    "",
    `Ledger-recorded spend: $${total.toFixed(4)} over ${Object.values(cost).reduce((s, c) => s + c.requests, 0)} requests.`,
    "",
    `Frozen on the fit split: report bar ${frozen.productBar ?? "none"} (fitted from ${frozen.productFittedFrom ?? "-"}), one-sided bar ${frozen.oneSidedBar ?? "none"}, chain bar ${frozen.chainBar} (${frozen.chainBarSource}), rho ${frozen.correlation.toFixed(3)}.`,
    "",
  ];
  await Bun.write(join(dir, "results.md"), `${head.join("\n")}${res.md}\n`);
  log(`analyze: wrote ${join(dir, "results.md")} (ledger spend $${total.toFixed(4)})`);
}

log(`${TRACK}: ${offline ? "OFFLINE" : "LIVE"} run in ${dir}, phases ${from}..${until}`);
if (runs("corpus")) await phaseCorpus();
if (runs("fit")) await phaseFit();
if (runs("label-fit")) await phaseLabel("fit");
if (runs("freeze")) await phaseFreeze();
if (runs("eval")) await phaseEval();
if (runs("label-eval")) await phaseLabel("eval");
if (runs("chain")) await phaseChain();
if (runs("chain-strict")) await phaseChainStrict();
if (runs("analyze")) await phaseAnalyze();
