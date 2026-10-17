/**
 * Shared plumbing for the live experiments: dataset loaders (files under experiments/data are
 * downloaded, untrusted data and are only ever parsed as JSON), a concurrency-limited map,
 * a hard spend budget, and a raw System One caller that exposes token usage.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rng, shuffled } from "../../src/math.ts";
import type { WireRequest, WireResponse } from "../../src/oracles/systemone.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA = join(ROOT, "experiments", "data");
export const OUT = join(ROOT, "experiments", "out");

export const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY is not set (put it in .env)");

export const JEV_MODEL = "typesafe/jev-1.13";
export const STRONG_MODELS = [
  { model: "anthropic/claude-haiku-5.5", price: { input: 0.1, output: 0.5 } },
  { model: "openai/gpt-6-luna", price: { input: 0.1, output: 0.5 } },
] as const;
export const STRONG_MODEL = STRONG_MODELS.map((m) => m.model).join(" and ");

export const progress = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// Budget. Every experiment adds the billed cost of every call; crossing it throws.
// ---------------------------------------------------------------------------

export class Spend {
  total = 0;
  calls = 0;
  constructor(readonly budgetUsd: number) {}
  add(cost: number): void {
    this.total += cost;
    this.calls++;
    if (this.total > this.budgetUsd) {
      throw new Error(`budget exceeded: $${this.total.toFixed(4)} > $${this.budgetUsd}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

interface RowsFile {
  readonly rows?: readonly { readonly row: Record<string, unknown> }[];
  readonly features?: readonly {
    readonly name: string;
    readonly type: { readonly names?: readonly string[] };
  }[];
}

function readRows(prefix: string, offsets: readonly number[]): RowsFile[] {
  const out: RowsFile[] = [];
  for (const off of offsets) {
    const p = join(DATA, `${prefix}_${off}.json`);
    if (!existsSync(p)) continue;
    out.push(JSON.parse(readFileSync(p, "utf8")) as RowsFile);
  }
  return out;
}

export interface BoolqItem {
  readonly id: string;
  readonly question: string;
  readonly passage: string;
  readonly answer: boolean;
}

export function loadBoolq(n: number): BoolqItem[] {
  const items: BoolqItem[] = [];
  for (const f of readRows("google_boolq_validation", [0, 100, 200])) {
    for (const { row } of f.rows ?? []) {
      const q = String(row.question ?? "").trim();
      const question = q.charAt(0).toUpperCase() + q.slice(1);
      items.push({
        id: `boolq-${items.length}`,
        question: question.endsWith("?") ? question : `${question}?`,
        passage: String(row.passage ?? ""),
        answer: Boolean(row.answer),
      });
      if (items.length >= n) return items;
    }
  }
  return items;
}

export interface BankingItem {
  readonly id: string;
  readonly text: string;
  readonly label: string;
}

export const humanize = (label: string): string => label.replace(/_/g, " ");

export function loadBanking77(n: number, seed = 77): { items: BankingItem[]; labels: string[] } {
  // The test split is sorted by label, so items are pooled from every downloaded page and
  // sampled with a seed. Label names come from any file whose features carry them.
  const files = readdirSync(DATA)
    .filter((f) => /banking77_test_\d+\.json$/.test(f))
    .sort();
  let names: readonly string[] | undefined;
  const pool: BankingItem[] = [];
  for (const f of files) {
    const text = readFileSync(join(DATA, f), "utf8");
    if (!text.startsWith("{")) continue; // a throttled download, not JSON
    const d = JSON.parse(text) as RowsFile;
    const feat = d.features?.find((x) => x.name === "label");
    if (feat?.type.names && feat.type.names.length >= 70) names = feat.type.names;
    if (!f.startsWith("mteb_")) continue;
    for (const { row } of d.rows ?? []) {
      const label = typeof row.label_text === "string" ? row.label_text : String(row.label);
      pool.push({ id: `b77-${pool.length}`, text: String(row.text ?? ""), label: humanize(label) });
    }
  }
  if (!names) throw new Error("Banking77 label names not found in experiments/data");
  return { items: shuffled(pool, rng(seed)).slice(0, n), labels: names.map(humanize) };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Raw System One call through OpenRouter, exposing usage. No retries: callers count failures.
// ---------------------------------------------------------------------------

export interface RawResult {
  readonly status: number;
  readonly latencyMs: number;
  readonly body?: WireResponse & {
    readonly usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  };
  readonly error?: string;
}

export async function rawSystemOne(req: WireRequest): Promise<RawResult> {
  const started = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/systemone", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENROUTER_KEY}`,
      "X-Title": "ratchet-experiments",
    },
    body: JSON.stringify(req),
  });
  const latencyMs = performance.now() - started;
  if (!res.ok) return { status: res.status, latencyMs, error: (await res.text()).slice(0, 200) };
  return {
    status: res.status,
    latencyMs,
    body: (await res.json()) as NonNullable<RawResult["body"]>,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function ensureOut(): void {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
}

export function writeJsonl(name: string, rows: readonly unknown[]): string {
  ensureOut();
  const p = join(OUT, name);
  writeFileSync(p, "", "utf8");
  for (const r of rows) appendFileSync(p, `${JSON.stringify(r)}\n`, "utf8");
  return p;
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};
