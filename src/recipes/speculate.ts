import { type Asker, type AskResult, wasAnswered } from "../engine.ts";
import type { PickQuestion, PickVerdict, Question, StateInput } from "../types.ts";
import { type RecipeOptions, recipeAskOptions } from "./screen.ts";

/**
 * Speculative decision-tree flattening.
 *
 * A two-level decision ("which operation?" then "which target for that operation?") normally
 * costs two round trips. Because questions on one state are nearly free, ask the root and
 * every branch's follow-up in one request, then keep only the follow-up that belongs to the
 * branch the root chose. Browser Use's jev-ultrafast cut browser-protocol calls from 1,092 to
 * 101 with this shape. Generic here: any pick root, any question per branch.
 *
 * Asked through an `Asker`, so every answer is ruled and ledgered. Through an engine with a
 * gate registered per question (root and each branch), each row lands in its own gate's
 * slice; through one gate, every row lands in that gate's.
 */
export interface SpeculateOptions<O extends string> extends RecipeOptions {
  readonly root: PickQuestion<O>;
  /** Follow-up question for each branch, asked speculatively. Branches may be omitted. */
  readonly branches: Readonly<Partial<Record<O, Question>>>;
}

export interface Speculated<O extends string> {
  /** The root question's ruled answer. Act on the choice only if its ruling says so. */
  readonly root: AskResult<PickVerdict<O>>;
  /** The branch the root chose; absent when the root failed open or a floor settled it. */
  readonly choice?: O;
  /** The chosen branch's follow-up, if that branch had one. */
  readonly branch?: AskResult;
  /** Every speculative follow-up, keyed by branch, for audit or for cheap re-planning. */
  readonly followUps: Readonly<Partial<Record<O, AskResult>>>;
  readonly requestId: string;
  readonly cost: number;
  readonly latencyMs: number;
}

export async function speculate<O extends string>(
  asker: Asker,
  state: StateInput,
  opts: SpeculateOptions<O>,
): Promise<Speculated<O>> {
  const branchIds = (Object.keys(opts.branches) as O[]).filter((k) => opts.branches[k]);
  const questions: Question[] = [opts.root, ...branchIds.map((k) => opts.branches[k] as Question)];
  const results = await asker.askAll(state, questions, recipeAskOptions("speculate", opts));
  const root = results[0];
  if (root?.decision.verdict.kind !== "pick") {
    throw new Error("speculate: root decision missing or not a pick");
  }
  const followUps: Partial<Record<O, AskResult>> = {};
  branchIds.forEach((k, i) => {
    const r = results[i + 1];
    if (r) followUps[k] = r;
  });
  const choice = wasAnswered(root) ? (root.decision.verdict.choice as O) : undefined;
  const branch = choice !== undefined ? followUps[choice] : undefined;
  return {
    root: root as AskResult<PickVerdict<O>>,
    ...(choice !== undefined ? { choice } : {}),
    ...(branch ? { branch } : {}),
    followUps,
    requestId: root.requestId,
    cost: results.reduce((s, r) => s + r.decision.cost, 0),
    latencyMs: results.reduce((m, r) => Math.max(m, r.decision.latencyMs), 0),
  };
}
