/**
 * Shared plumbing for the T1 runner: the committed corpus, the run directory and its
 * manifest, oracles (live Jev or a seeded simulation over the same labels), and engines.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../../src/engine.ts";
import { JsonlLedger } from "../../../src/ledger/ledger.ts";
import { SimOracle } from "../../../src/oracles/sim.ts";
import type { Oracle } from "../../../src/types.ts";
import { corpusHash, E2E_OUT, jev113, ROOT, writeJson } from "../lib.ts";
import { buildCorpus, type Item } from "./corpus.ts";
import { PLAN, TRACK } from "./gate.ts";

export const TRACK_DIR = join(ROOT, "experiments", "e2e", TRACK);
export const CORPUS_FILE = join(TRACK_DIR, "corpus.json");
export const SPOTCHECK_FILE = join(TRACK_DIR, "spotcheck.json");
/** Real traffic lives only under the gitignored output tree. */
export const REAL_DIR = join(E2E_OUT, TRACK, "real");
export const REAL_CORPUS = join(REAL_DIR, "real-corpus.json");
export const REAL_LABELS = join(REAL_DIR, "real-labels.json");

export interface CorpusFile {
  readonly seed: number;
  readonly generatedFrom: string;
  readonly items: readonly Item[];
}

/** The committed corpus, checked against the generator so a label edit cannot slip in late. */
export function loadCorpus(): Item[] {
  const file = JSON.parse(readFileSync(CORPUS_FILE, "utf8")) as CorpusFile;
  const built = buildCorpus();
  if (corpusHash(built) !== corpusHash(file.items)) {
    throw new Error("corpus.json differs from corpus.ts; regenerate it with `main.ts corpus`");
  }
  return [...file.items];
}

export interface RealItem {
  readonly id: string;
  /** Opaque session key (a hash), for grouping only. */
  readonly session: string;
  readonly tool: string;
  readonly state: string;
}

export interface RealLabel {
  readonly id: string;
  readonly truth: boolean;
  readonly why: string;
  readonly ambiguous?: boolean;
}

export function loadReal(): { items: RealItem[]; labels: Map<string, RealLabel> } | undefined {
  if (!existsSync(REAL_CORPUS) || !existsSync(REAL_LABELS)) return undefined;
  const items = (JSON.parse(readFileSync(REAL_CORPUS, "utf8")) as { items: RealItem[] }).items;
  const labels = new Map(
    (JSON.parse(readFileSync(REAL_LABELS, "utf8")) as { labels: RealLabel[] }).labels.map((l) => [
      l.id,
      l,
    ]),
  );
  for (const it of items) {
    if (!labels.has(it.id)) throw new Error(`real item ${it.id} has no label`);
  }
  return { items, labels };
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

export interface Run {
  readonly dir: string;
  readonly offline: boolean;
  readonly ledger: string;
  readonly rawLedger: string;
  readonly batteryLedger: string;
  readonly realLedger: string;
  readonly mechLedger: string;
  readonly budgetLedger: string;
  readonly manifest: string;
  readonly checkpoint: string;
}

export function runPaths(dir: string, offline: boolean): Run {
  return {
    dir,
    offline,
    ledger: join(dir, "ledger.jsonl"),
    rawLedger: join(dir, "raw-ledger.jsonl"),
    batteryLedger: join(dir, "battery-ledger.jsonl"),
    realLedger: join(dir, "real-ledger.jsonl"),
    mechLedger: join(dir, "mechanics-ledger.jsonl"),
    budgetLedger: join(dir, "budget-ledger.jsonl"),
    manifest: join(dir, "manifest.json"),
    checkpoint: join(dir, "checkpoint.json"),
  };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Merge `patch` into the manifest. Fields already set are never overwritten. */
export function amendManifest(run: Run, patch: Record<string, unknown>): void {
  const current = readJson<Record<string, unknown>>(run.manifest);
  for (const k of Object.keys(patch)) {
    if (k in current) throw new Error(`manifest field ${k} is already fixed`);
  }
  writeJson(run.manifest, { ...current, ...patch });
}

// ---------------------------------------------------------------------------
// Oracles and engines
// ---------------------------------------------------------------------------

/** Truth by exact state text, for the offline simulation only. */
export function truthByState(): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const it of loadCorpus()) m.set(it.state, it.truth);
  const real = loadReal();
  if (real) for (const it of real.items) m.set(it.state, real.labels.get(it.id)?.truth ?? true);
  return m;
}

/**
 * Live: Jev 1.13 through OpenRouter (the product's default model for the hook replay).
 * Offline: a seeded, calibrated SimOracle at 90% over the same labels, so every phase runs the
 * same wiring at no cost. The offline numbers say nothing about Jev.
 */
export function oracleFor(run: Run, seed = PLAN.engineSeed): Oracle {
  if (!run.offline) return jev113();
  const truth = truthByState();
  return new SimOracle(
    { accuracy: 0.9, seed, costPerQuestion: 0.00003, latencyMs: 1, id: "sim-p0.90" },
    (state) => {
      const t = truth.get(state);
      return t === undefined ? undefined : { judge: t };
    },
  );
}

export function engineFor(
  run: Run,
  ledgerPath: string,
  opts: {
    readonly dailyBudgetUsd?: number;
    readonly budgetUsd?: number;
    readonly reserveUsd?: number;
  } = {},
): Engine {
  return new Engine({
    oracle: oracleFor(run),
    ledger: new JsonlLedger(ledgerPath),
    mode: "shadow",
    keepState: true,
    seed: PLAN.engineSeed,
    timeoutMs: 30_000,
    budgetUsd: opts.budgetUsd ?? PLAN.budgetUsd,
    dailyBudgetUsd: opts.dailyBudgetUsd ?? PLAN.dailyBudgetUsd,
    ...(opts.reserveUsd !== undefined ? { reserveUsd: opts.reserveUsd } : {}),
  });
}

export const itemTags = (it: Item): string[] => [
  `group:${it.group}`,
  `item:${it.id}`,
  `split:${it.split}`,
  `family:${it.family}`,
];

/** The tag value with this prefix on a row, if any. */
export const tagValue = (tags: readonly string[], prefix: string): string | undefined =>
  tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

export function labelsByState(items: readonly Item[]): Map<string, boolean> {
  return new Map(items.map((it) => [it.state, it.truth]));
}
