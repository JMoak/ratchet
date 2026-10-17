import { type Asker, type AskOptions, type AskResult, wasAnswered } from "../engine.ts";
import { hashState } from "../ledger/ledger.ts";
import type { GatePolicy } from "../policy.ts";
import { judge, pick } from "../questions.ts";
import type {
  Action,
  JudgeVerdict,
  PickQuestion,
  PickVerdict,
  Question,
  StateInput,
  StateLike,
} from "../types.ts";

/**
 * Batteries over collections, run through an `Asker` (an engine or a gate) so every answer is
 * ledgered, budgeted, floored and auditable. Four shapes that cover most bulk work:
 *
 * - relevance(): one judge per item, all on one shared context, in requests of up to
 *   `perRequest` items. This is context compaction: the model sees the task and a one-line
 *   summary of each item, never the item bodies, and says which are still needed.
 * - screenMany(): the same questions over many documents, one request per document, with
 *   bounded concurrency under the engine's spend cap. Map in the model, reduce in code.
 * - locate() builds "which chunk answers this?" as a pick over chunk ids; locateWith() asks
 *   it. This is the cheap first tier of tiered reading: find the chunk with a decision
 *   model, read it with an expensive one.
 *
 * Every row a recipe writes carries the tag `recipe:<name>`, and rows from one underlying
 * request share a request id.
 */

/** What every recipe needs from its caller: how to rule, and what the application does anyway. */
export interface RecipeOptions {
  /**
   * How each answer is ruled, one policy for all questions or one per question. Required: a
   * recipe cannot know what a wrong act costs in the caller's world.
   */
  readonly policy: GatePolicy | ((q: Question) => GatePolicy);
  /** In shadow mode, what the application is doing anyway. Default review. */
  readonly baseline?: Action;
  readonly tags?: readonly string[];
}

export const recipeTag = (recipe: string): string => `recipe:${recipe}`;

/** Per-question ask options for one recipe call, tagged with the recipe's name. */
export function recipeAskOptions(recipe: string, opts: RecipeOptions): (q: Question) => AskOptions {
  const tags = [...(opts.tags ?? []), recipeTag(recipe)];
  const policy = opts.policy;
  return (q) => ({
    policy: typeof policy === "function" ? policy(q) : policy,
    ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
    tags,
  });
}

const exhaustedByBudget = (r: AskResult): boolean => r.decision.detail.budgetExhausted === true;

/**
 * Append trusted text (an item listing the harness wrote) to a built state. The whole
 * rendering is re-hashed; the trusted hash folds the addition into the base's trusted hash.
 */
function appendTrusted(base: StateLike, suffix: string): StateLike {
  const text = `${base.text}${suffix}`;
  return {
    text,
    hash: hashState(text),
    trustedHash: hashState(`${base.trustedHash}${suffix}`),
    untrusted: base.untrusted,
  };
}

export interface Item {
  readonly id: string;
  readonly summary: string;
}

export interface RelevanceOptions extends RecipeOptions {
  /** Default: "Is item `<id>` still needed to continue the task?" */
  readonly prompt?: (item: Item) => string;
  /** Items per request. Default 64. */
  readonly perRequest?: number;
}

export interface Relevance {
  /** Probability each item is still needed; 0.5 where the answer failed open. */
  readonly scores: ReadonlyMap<string, number>;
  /** Every ruled, ledgered answer, in item order. */
  readonly results: readonly AskResult[];
  /** One per request, in order. */
  readonly requestIds: readonly string[];
  readonly cost: number;
  readonly requests: number;
}

export async function relevance(
  asker: Asker,
  context: StateInput,
  items: readonly Item[],
  opts: RelevanceOptions,
): Promise<Relevance> {
  const per = Math.max(1, opts.perRequest ?? 64);
  const prompt =
    opts.prompt ?? ((it: Item) => `Is item \`${it.id}\` still needed to continue the task?`);
  const askOpts = recipeAskOptions("relevance", opts);
  const scores = new Map<string, number>();
  const results: AskResult[] = [];
  const requestIds: string[] = [];
  let cost = 0;
  let requests = 0;
  for (let i = 0; i < items.length; i += per) {
    const slice = items.slice(i, i + per);
    const listing = `\n\nItems:\n${slice.map((it) => `- ${it.id}: ${it.summary}`).join("\n")}`;
    const state =
      typeof context === "string" ? `${context}${listing}` : appendTrusted(context, listing);
    const qs = slice.map((it) => judge(prompt(it), { id: it.id }));
    const rs = await asker.askAll(state, qs, askOpts);
    requests++;
    if (rs[0]) requestIds.push(rs[0].requestId);
    rs.forEach((r, j) => {
      const it = slice[j];
      if (!it) return;
      results.push(r);
      cost += r.decision.cost;
      scores.set(it.id, r.decision.failedOpen ? 0.5 : (r.decision.verdict as JudgeVerdict).pYes);
    });
  }
  return { scores, results, requestIds, cost, requests };
}

/** Split a relevance result into keep and drop lists at a bar. */
export function prune(
  rel: Relevance,
  keepAbove: number,
): { readonly keep: string[]; readonly drop: string[] } {
  const keep: string[] = [];
  const drop: string[] = [];
  for (const [id, p] of rel.scores) (p >= keepAbove ? keep : drop).push(id);
  return { keep, drop };
}

export interface Doc {
  readonly id: string;
  /** The document as plain text or as a built state. */
  readonly text: StateInput;
}

export interface ScreenOptions extends RecipeOptions {
  /** Requests in flight at once. Default 8. */
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, cost: number) => void;
}

export interface Screened {
  /** Ruled answers per screened document, in question order. */
  readonly byDoc: ReadonlyMap<string, readonly AskResult[]>;
  /**
   * Documents asked after the engine's spend cap was reached. Their asks failed open into
   * the policy's fail-open action and are in the ledger, but no answer was bought.
   */
  readonly skipped: readonly string[];
  readonly cost: number;
  /** Requests that reached the oracle. */
  readonly requests: number;
}

export async function screenMany(
  asker: Asker,
  docs: readonly Doc[],
  questions: readonly Question[],
  opts: ScreenOptions,
): Promise<Screened> {
  const askOpts = recipeAskOptions("screen", opts);
  const byDoc = new Map<string, readonly AskResult[]>();
  const skipped: string[] = [];
  let cost = 0;
  let requests = 0;
  let done = 0;
  let next = 0;
  const limit = Math.max(1, opts.concurrency ?? 8);
  const workers = Array.from({ length: Math.min(limit, docs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= docs.length) return;
      const doc = docs[i] as Doc;
      const rs = await asker.askAll(doc.text, questions, askOpts);
      for (const r of rs) cost += r.decision.cost;
      if (rs.some(exhaustedByBudget)) skipped.push(doc.id);
      else {
        requests++;
        byDoc.set(doc.id, rs);
      }
      opts.onProgress?.(++done, docs.length, cost);
    }
  });
  await Promise.all(workers);
  return { byDoc, skipped, cost, requests };
}

export interface Chunk {
  readonly id: string;
  readonly text: string;
}

/** Build the state and the pick question for "which chunk answers this?". */
export function locate(
  chunks: readonly Chunk[],
  question: string,
  extra: { readonly id?: string; readonly none?: boolean } = {},
): { state: string; question: PickQuestion<string> } {
  const ids = chunks.map((c) => c.id);
  const options = extra.none ? [...ids, "none"] : ids;
  const state = chunks.map((c) => `[${c.id}]\n${c.text}`).join("\n\n");
  const criteria: Record<string, string> = {};
  if (extra.none) criteria.none = "No chunk contains what is needed to answer the question";
  return {
    state,
    question: pick(`Which chunk answers this question: ${question}`, options, {
      ...(extra.id ? { id: extra.id } : {}),
      criteria,
    }),
  };
}

export interface LocateOptions extends RecipeOptions {
  /** Offer a "none" option, so absence can be detected rather than forced onto a chunk. */
  readonly none?: boolean;
  /** Question id; rows are recorded under it (and under its gate, if one owns it). */
  readonly id?: string;
}

export interface Located {
  readonly result: AskResult<PickVerdict<string>>;
  /** The chunk the pick chose; absent when it chose "none" or no answer was bought. */
  readonly chunk?: string;
  readonly question: PickQuestion<string>;
}

/** Ask which chunk answers a question, through the engine. */
export async function locateWith(
  asker: Asker,
  chunks: readonly Chunk[],
  question: string,
  opts: LocateOptions,
): Promise<Located> {
  const built = locate(chunks, question, {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.none ? { none: true } : {}),
  });
  const [r] = await asker.askAll(built.state, [built.question], recipeAskOptions("locate", opts));
  if (r?.decision.verdict.kind !== "pick") throw new Error("locateWith: no pick answer");
  const choice = r.decision.verdict.choice;
  const chunk = wasAnswered(r) && !(opts.none && choice === "none") ? choice : undefined;
  return {
    result: r as AskResult<PickVerdict<string>>,
    question: built.question,
    ...(chunk !== undefined ? { chunk } : {}),
  };
}
