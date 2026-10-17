import { type GatePolicy, type Ruling, rule } from "../policy.ts";
import type { Action, Decision } from "../types.ts";

/**
 * One step of a multi-step task. `propose` produces a candidate next state; `verify` judges
 * whether the candidate achieved the step (a judge verdict where yes means success).
 * Attempts must be independent: a fresh proposal, not a retry of the same bytes.
 */
export interface Step<S> {
  readonly name: string;
  readonly propose: (state: S, attempt: number) => Promise<S>;
  readonly verify: (before: S, after: S, attempt: number) => Promise<Decision>;
  /** Default 3. */
  readonly maxAttempts?: number;
}

export interface Attempt {
  readonly attempt: number;
  readonly decision: Decision;
  readonly ruling: Ruling;
}

export interface StepTrace {
  readonly name: string;
  readonly attempts: readonly Attempt[];
  readonly committed: boolean;
}

export interface ChainResult<S> {
  readonly ok: boolean;
  /** The last committed state. Never an unverified proposal. */
  readonly state: S;
  readonly checkpoints: readonly S[];
  readonly trace: readonly StepTrace[];
  readonly cost: number;
  readonly stoppedAt?: string;
  readonly stopReason?: "refused" | "exhausted";
}

export interface ChainOptions {
  /** Hard floor applied to every verification ruling, e.g. from floors.ts. */
  readonly floor?: Action;
  readonly onStep?: (trace: StepTrace, state: unknown) => void;
}

/**
 * The ratchet. A chain of n steps that are each right 80% of the time succeeds 0.8^n of the
 * time if nothing checks the work: ten steps, one success in nine. Verifying each step and
 * only committing verified progress turns the chain into a sequence of independent retries,
 * so end-to-end reliability is set by the verifier and the retry budget, not by n.
 */
export async function runChain<S>(
  initial: S,
  steps: readonly Step<S>[],
  policy: GatePolicy,
  opts: ChainOptions = {},
): Promise<ChainResult<S>> {
  let state = initial;
  const checkpoints: S[] = [initial];
  const trace: StepTrace[] = [];
  let cost = 0;
  for (const step of steps) {
    const max = Math.max(1, step.maxAttempts ?? 3);
    const attempts: Attempt[] = [];
    let committed = false;
    let refused = false;
    for (let attempt = 1; attempt <= max; attempt++) {
      const after = await step.propose(state, attempt);
      const decision = await step.verify(state, after, attempt);
      cost += decision.cost;
      const ruling = rule(decision, policy, opts.floor);
      attempts.push({ attempt, decision, ruling });
      if (ruling.action === "act") {
        state = after;
        checkpoints.push(after);
        committed = true;
        break;
      }
      if (ruling.action === "refuse") {
        refused = true;
        break;
      }
    }
    const t: StepTrace = { name: step.name, attempts, committed };
    trace.push(t);
    opts.onStep?.(t, state);
    if (!committed) {
      return {
        ok: false,
        state,
        checkpoints,
        trace,
        cost,
        stoppedAt: step.name,
        stopReason: refused ? "refused" : "exhausted",
      };
    }
  }
  return { ok: true, state, checkpoints, trace, cost };
}
