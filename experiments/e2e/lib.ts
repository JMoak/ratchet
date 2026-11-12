/**
 * Shared plumbing for the end-to-end evaluation (`experiments/e2e/`): the live oracles with
 * distinct ids (so ensemble members keep distinct keys in the ledger), a spend guard that reads
 * the provider's billed usage (so concurrent tracks share one ceiling no restart can reset),
 * run directories, the decider's labels, and a scripted blind review that goes through the real
 * `ratchet review` code path.
 *
 * The decider is the person whose judgment the engine learns from. Here that is the evaluation's
 * author, acting under `DECIDER.md`; every label is fixed in a corpus file before the first live
 * call, so no label can be steered by the model's answer.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ReviewIo, review } from "../../src/cli/main.ts";
import type { Engine } from "../../src/engine.ts";
import { LlmJsonOracle } from "../../src/oracles/llm-json.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import type { Oracle, Verdict } from "../../src/types.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const E2E_OUT = join(ROOT, "experiments", "out", "e2e");

export const progress = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// Run directories and manifests
// ---------------------------------------------------------------------------

/** A fresh directory under experiments/out/e2e/<track>/; runs are never appended to old ones. */
export function runDir(track: string, label = "live"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(E2E_OUT, track, `${stamp}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of a corpus as data, so a manifest proves which labels were fixed before the run. */
export function corpusHash(corpus: unknown): string {
  return sha256(JSON.stringify(corpus));
}

export function gitHead(): string {
  try {
    const head = readFileSync(join(ROOT, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const loose = join(ROOT, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = readFileSync(join(ROOT, ".git", "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line?.split(" ")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Oracles. Pinned model ids; distinct oracle ids so pooled members never share a key.
// ---------------------------------------------------------------------------

export const JEV_113 = "typesafe/jev-1.13";
export const JEV_114 = "typesafe/jev-1.14";
export const HAIKU = "anthropic/claude-haiku-5.5";
export const LUNA = "openai/gpt-6-luna";

function openRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set (put it in .env)");
  return key;
}

export function jev113(): Oracle {
  return jevViaOpenRouter({ model: JEV_113, id: "jev113@openrouter", maxRetries: 3 });
}

export function jev114(): Oracle {
  return jevViaOpenRouter({ model: JEV_114, id: "jev114@openrouter", maxRetries: 3 });
}

/** A generative model forced into the decision role: the stronger, costlier tier. */
export function haiku(): Oracle {
  return new LlmJsonOracle({
    apiKey: openRouterKey(),
    model: HAIKU,
    id: "haiku55@openrouter",
    pricePerMillion: { input: 0.1, output: 0.5 },
  });
}

export function luna(): Oracle {
  return new LlmJsonOracle({
    apiKey: openRouterKey(),
    model: LUNA,
    id: "luna@openrouter",
    pricePerMillion: { input: 0.1, output: 0.5 },
  });
}

// ---------------------------------------------------------------------------
// Spend guard. The ceiling covers the whole evaluation, every track and wave together, and is
// measured from the provider's billed usage rather than any one process's tally.
// ---------------------------------------------------------------------------

interface BudgetFile {
  readonly baselineUsd: number;
  readonly ceilingUsd: number;
  readonly setAt: string;
}

const BUDGET_FILE = join(E2E_OUT, "budget.json");

export function budget(): BudgetFile {
  if (!existsSync(BUDGET_FILE)) {
    throw new Error(`no spend baseline at ${BUDGET_FILE}; the coordinator writes it once`);
  }
  return JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as BudgetFile;
}

/** Billed usage on the OpenRouter key, in USD. Lags real spend by up to a minute or so. */
export async function providerUsage(): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${openRouterKey()}` },
  });
  if (!res.ok) throw new Error(`usage check failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { usage?: unknown } };
  const usage = body.data?.usage;
  if (typeof usage !== "number") throw new Error("usage check returned no usage figure");
  return usage;
}

/** Spend since the evaluation's baseline. Throws past the ceiling: call before every live phase. */
export async function guard(where: string): Promise<number> {
  const b = budget();
  const spent = (await providerUsage()) - b.baselineUsd;
  progress(`[spend] ${where}: $${spent.toFixed(4)} of $${b.ceilingUsd} evaluation ceiling`);
  if (spent > b.ceilingUsd) {
    throw new Error(`evaluation ceiling reached at ${where}: $${spent.toFixed(4)}`);
  }
  return spent;
}

// ---------------------------------------------------------------------------
// The decider's labels
// ---------------------------------------------------------------------------

export const DECIDER = "decider";
/** Labels fixed before the model answered: the blind class, the only one a bar is fitted on. */
export const DECIDER_SOURCE = `review:blind:${DECIDER}`;

export interface DeciderLabel {
  /** Boolean for a judge question; the option or level name for pick and rate. */
  readonly truth: boolean | string;
  /** One line: why the decider answered this way. Never shown to the model. */
  readonly why: string;
  /** The decider could argue either side; reported separately, never silently dropped. */
  readonly ambiguous?: boolean;
}

/** Whether a verdict's leading answer matches the truth, by the convention `ratchet review` uses. */
export function leadMatches(v: Verdict, truth: boolean | string): boolean {
  switch (v.kind) {
    case "judge":
      return v.pYes >= 0.5 === truth;
    case "pick":
      return v.choice === truth;
    case "rate":
      return v.level === truth;
  }
}

/** Record the decider's label on a row (a battery's combined row labels its members too). */
export function labelAsDecider(
  engine: Engine,
  recordId: string,
  verdict: Verdict,
  label: DeciderLabel,
  source: string = DECIDER_SOURCE,
): Promise<boolean> {
  return engine.label(recordId, {
    correct: leadMatches(verdict, label.truth),
    truth: label.truth,
    source,
    note: label.why.slice(0, 240),
  });
}

export interface BlindReviewResult {
  readonly output: string;
  readonly exitCode: number;
  readonly answered: number;
  /** States the review showed that the decider had no fixed label for (skipped, not guessed). */
  readonly missing: number;
}

/**
 * Run the real `ratchet review` over a ledger, answering as the decider. Each answer is looked
 * up by the exact state text the review printed, from labels fixed before the run, so the
 * answer cannot depend on the model's verdict. A state without a label is skipped.
 */
export async function blindReview(
  ledgerPath: string,
  gateId: string,
  labelsByState: ReadonlyMap<string, boolean>,
  opts: { readonly sample?: number; readonly seed?: number; readonly denied?: boolean } = {},
): Promise<BlindReviewResult> {
  let current: string | undefined;
  let answered = 0;
  let missing = 0;
  const io: ReviewIo = {
    print(text) {
      const m = /^\n--- \d+ of \d+ ---\n([\s\S]*)\n$/.exec(text);
      if (m) current = m[1];
    },
    async ask() {
      const truth = current === undefined ? undefined : labelsByState.get(current);
      current = undefined;
      if (truth === undefined) {
        missing++;
        return "s";
      }
      answered++;
      return truth ? "y" : "n";
    },
  };
  const argv = [ledgerPath, "--gate", gateId, "--reviewer", DECIDER];
  if (opts.denied) argv.push("--denied");
  else argv.push("--sample", String(opts.sample ?? 20), "--seed", String(opts.seed ?? 1));
  const res = await review(argv, io);
  return { output: res.output, exitCode: res.exitCode, answered, missing };
}
