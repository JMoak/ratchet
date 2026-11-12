/**
 * Shared plumbing for V4: the committed corpora (checked against their generators), the run
 * paths, the oracles (live Jev 1.13 or a seeded simulation over the same labels), and the
 * gate ids and settings the manifest records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SimOracle } from "../../../../src/oracles/sim.ts";
import type { JudgeQuestion, Oracle } from "../../../../src/types.ts";
import { corpusHash, jev113 } from "../../lib.ts";
import { MOD_CORPUS_FILE, TOOL_CORPUS_FILE } from "./build.ts";
import { buildModCorpus, type ModItem, type SubLabels } from "./mod-corpus.ts";
import { buildToolCorpus, type Item } from "./tool-corpus.ts";

export const TRACK = "verify/v4-fresh";
export const TOOL_GATE = "v4.toolgate";
export const RAW_GATE = "v4.toolgate.raw";
export const MOD_GATE = "v4.mod.any";
export const TOOL_VERSION = "v4-fresh-tool-v1";
export const RAW_VERSION = "v4-fresh-raw-v1";
export const MOD_VERSION = "v4-fresh-mod-v1";

export const SETTINGS = {
  engineSeed: 20261113,
  reviewSeed: 1113,
  /** Per-engine caps; three engines, so the study cannot pass $0.90 of recorded spend. */
  budgetUsd: 0.3,
  dailyBudgetUsd: 1.0,
  /** The study's own cap on its recorded spend. */
  studyCapUsd: 1.0,
  promise: 0.95,
  confidence: 0.95,
  maxErrors: 0,
  group: { tagPrefix: "group:", maxPerGroup: 3 },
  auditRate: 0.2,
  minAuditRows: 30,
  window: 200,
  concurrency: 6,
} as const;

export interface Paths {
  readonly dir: string;
  readonly manifest: string;
  readonly toolLedger: string;
  readonly rawLedger: string;
  readonly modLedger: string;
  readonly checkpoint: string;
  readonly rollout: string;
  readonly labels: string;
  readonly results: string;
  readonly resultsMd: string;
}

export function paths(dir: string): Paths {
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    toolLedger: join(dir, "tool-ledger.jsonl"),
    rawLedger: join(dir, "raw-ledger.jsonl"),
    modLedger: join(dir, "mod-ledger.jsonl"),
    checkpoint: join(dir, "checkpoint.json"),
    rollout: join(dir, "rollout.json"),
    labels: join(dir, "labels.json"),
    results: join(dir, "results.json"),
    resultsMd: join(dir, "results.md"),
  };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The committed tool corpus, refused if it differs from its generator. */
export function loadTool(): Item[] {
  const file = readJson<{ items: Item[] }>(TOOL_CORPUS_FILE);
  if (corpusHash(file.items) !== corpusHash(buildToolCorpus())) {
    throw new Error("tool-corpus.json differs from tool-corpus.ts");
  }
  return file.items;
}

export interface ModCorpus {
  readonly items: ModItem[];
  readonly members: JudgeQuestion[];
}

/** The committed moderation corpus and T3's member questions, checked as above. */
export function loadMod(): ModCorpus {
  const file = readJson<{ items: ModItem[]; questions: { members: JudgeQuestion[] } }>(
    MOD_CORPUS_FILE,
  );
  if (corpusHash(file.items) !== corpusHash(buildModCorpus())) {
    throw new Error("moderation-corpus.json differs from mod-corpus.ts");
  }
  return { items: file.items, members: file.questions.members };
}

/** Live Jev 1.13 (T1's and T3's model), or a calibrated simulation over the labels. */
export function toolOracle(offline: boolean, items: readonly Item[], seed: number): Oracle {
  if (!offline) return jev113();
  const truth = new Map(items.map((i) => [i.state, i.truth]));
  return new SimOracle(
    { accuracy: 0.9, seed, costPerQuestion: 0.00003, latencyMs: 1, id: "sim-p0.90" },
    (state) => {
      const t = truth.get(state);
      return t === undefined ? undefined : { judge: t };
    },
  );
}

export function modOracle(offline: boolean, items: readonly ModItem[], seed: number): Oracle {
  if (!offline) return jev113();
  const truth = new Map(items.map((i) => [i.state, i.memberTruths]));
  return new SimOracle(
    { accuracy: 0.9, seed, costPerQuestion: 0.00003, latencyMs: 1, id: "sim-p0.90" },
    (state, q) => {
      const t = truth.get(state);
      return t === undefined ? undefined : { judge: t[q.id as keyof SubLabels] };
    },
  );
}

export const itemTags = (it: Item): string[] => [
  `group:${it.group}`,
  `item:${it.id}`,
  `family:${it.family}`,
];

export const tagValue = (tags: readonly string[], prefix: string): string | undefined =>
  tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
