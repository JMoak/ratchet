/**
 * The ratchet against reality. Multi-step tasks whose steps are held-out verification tasks
 * (fresh instances, never in the corpus), proposed by the scripted proposer at base accuracy
 * p and verified by the frozen verifier gate through `runChain`.
 *
 * Every candidate any attempt could propose is generated and labelled before the first call,
 * so the labels are fixed whatever the verifier does. The two base rates share random numbers
 * (an attempt correct at p = 0.8 is correct at p = 0.9), which makes their difference sharper.
 * Attempts within a step never repeat a candidate: correct attempts cycle through the three
 * correct styles and wrong ones through distinct error types, as `Step` asks ("a fresh
 * proposal, not a retry of the same bytes").
 */
import { type ChainResult, runChain, type Step } from "../../../src/compound/chain.ts";
import type { Gate } from "../../../src/gate.ts";
import { rng, shuffled } from "../../../src/math.ts";
import type { GatePolicy } from "../../../src/policy.ts";
import type { Decision } from "../../../src/types.ts";
import { FAMILIES, renderTask, seedOf } from "./corpus.ts";
import { HOLISTIC } from "./questions.ts";
import { CORRECT_STYLES, type ErrorType, type Family, type Variant } from "./types.ts";

export const CHAIN = {
  chains: 100,
  steps: 8,
  maxAttempts: 3,
  /** Candidates generated per step: enough for the larger retry budget. */
  tableAttempts: 6,
  budgetAttempts: 6,
  ps: [0.8, 0.9] as const,
};
export const REFUSE_CHAINS = 30;

export interface ChainCandidate {
  readonly id: string;
  readonly p: number;
  readonly chain: number;
  readonly step: number;
  readonly attempt: number;
  readonly family: string;
  readonly instance: string;
  readonly variant: Variant;
  readonly truth: boolean;
  readonly why: string;
  readonly text: string;
  readonly stateHash: string;
}

const HELD: readonly Family[] = FAMILIES.filter((f) => f.split === "heldout");

/** table[c][s][a] for one base rate p. */
export type ChainTable = ChainCandidate[][][];

export function buildChainTable(p: number, nChains = CHAIN.chains): ChainTable {
  const table: ChainTable = [];
  for (let c = 0; c < nChains; c++) {
    const steps: ChainCandidate[][] = [];
    for (let s = 0; s < CHAIN.steps; s++) {
      const f = HELD[(c + s) % HELD.length] as Family;
      const inst = f.make(rng(seedOf("chain-instance", c, s)));
      const pr = rng(seedOf("chain-perm", c, s));
      const styles = shuffled(CORRECT_STYLES, pr);
      const types = shuffled(inst.supports ?? f.errors, pr) as ErrorType[];
      let nRight = 0;
      let nWrong = 0;
      const attempts: ChainCandidate[] = [];
      for (let a = 0; a < CHAIN.tableAttempts; a++) {
        const u = rng(seedOf("chain-u", c, s, a))();
        const correct = u < p;
        const variant: Variant = correct
          ? (styles[nRight++ % styles.length] as Variant)
          : (types[nWrong++ % types.length] as Variant);
        const cand = inst.render(variant, rng(seedOf("chain-render", c, s, a, variant)));
        const state = renderTask(inst.task, cand.text);
        attempts.push({
          id: `chain.p${p}.${c}.${s}.${a + 1}`,
          p,
          chain: c,
          step: s,
          attempt: a + 1,
          family: f.id,
          instance: `chain.${c}.${s}`,
          variant,
          truth: correct,
          why: cand.why,
          text: state.text,
          stateHash: state.hash,
        });
      }
      steps.push(attempts);
    }
    table.push(steps);
  }
  return table;
}

interface S {
  readonly outputs: readonly string[];
  readonly good: boolean;
}

export interface AttemptLog {
  readonly id: string;
  readonly truth: boolean;
  readonly action: string;
  readonly go: number;
}

export interface ChainLog {
  readonly p: number;
  readonly chain: number;
  readonly mode: "verified" | "unverified" | "refuse" | "budget" | "strict";
  readonly maxAttempts: number;
  /** Gate asks this run bought (replays reuse the verified run's verdicts). */
  readonly asked: number;
  readonly ok: boolean;
  /** ok and every committed candidate truly correct. */
  readonly trulyOk: boolean;
  readonly stopReason?: string;
  readonly stoppedAt?: string;
  readonly steps: readonly {
    readonly committed: boolean;
    readonly attempts: readonly AttemptLog[];
  }[];
  /** Broken stop/commit semantics, if any. Expected empty. */
  readonly violations: readonly string[];
  readonly cost: number;
}

const PASS: Decision = {
  verdict: { kind: "judge", questionId: HOLISTIC.id, pYes: 1, confidence: 1 },
  oracle: "none",
  latencyMs: 0,
  cost: 0,
  at: "1970-01-01T00:00:00.000Z",
};

/** Check that the result is what the ratchet promises, from the trace and the candidates alone. */
function violationsOf(res: ChainResult<S>, table: ChainCandidate[][], max: number): string[] {
  const v: string[] = [];
  const committedIds: string[] = [];
  res.trace.forEach((t, s) => {
    if (t.attempts.length > max) v.push(`step ${s + 1}: ${t.attempts.length} attempts > ${max}`);
    const acts = t.attempts.filter((a) => a.ruling.action === "act");
    if (t.committed) {
      if (acts.length !== 1) v.push(`step ${s + 1}: committed with ${acts.length} act rulings`);
      const last = t.attempts.at(-1);
      if (last?.ruling.action !== "act") v.push(`step ${s + 1}: committed but last ruling not act`);
      const won = table[s]?.[(last?.attempt ?? 1) - 1];
      if (won) committedIds.push(won.id);
    } else if (acts.length > 0) v.push(`step ${s + 1}: an act ruling was not committed`);
    if (!t.committed && s !== res.trace.length - 1)
      v.push(`step ${s + 1}: chain continued past a failed step`);
  });
  if (res.checkpoints.length !== committedIds.length + 1)
    v.push("checkpoints do not match commits");
  if (res.state.outputs.join() !== committedIds.join())
    v.push("final state holds an unverified proposal");
  if (res.ok !== (res.trace.length === table.length && res.trace.every((t) => t.committed))) {
    v.push("ok disagrees with the trace");
  }
  if (
    res.stopReason === "refused" &&
    res.trace.at(-1)?.attempts.at(-1)?.ruling.action !== "refuse"
  ) {
    v.push("refused without a refuse ruling");
  }
  return v;
}

/**
 * Run one chain. "verified" asks the gate on every attempt (tagged with chain, step and attempt
 * so the ledger can be read back) and records each verdict in `cache`, which is per base rate.
 * "refuse" and "budget" replay those exact verdicts under another policy or retry budget and
 * ask only for attempts the verified run never reached. "unverified" commits every first
 * proposal.
 */
export async function runOne(
  table: ChainCandidate[][],
  gate: Gate | undefined,
  policy: GatePolicy,
  mode: ChainLog["mode"],
  cache: Map<string, Decision>,
  p: number,
  chain: number,
  maxAttempts: number = CHAIN.maxAttempts,
): Promise<ChainLog> {
  let asked = 0;
  const steps: Step<S>[] = table.map((cands, s) => ({
    name: `step-${s + 1}`,
    maxAttempts,
    propose: async (st, attempt) => {
      const c = cands[attempt - 1] as ChainCandidate;
      return { outputs: [...st.outputs, c.id], good: st.good && c.truth };
    },
    verify: async (_before, _after, attempt) => {
      const c = cands[attempt - 1] as ChainCandidate;
      if (mode === "unverified" || gate === undefined) return PASS;
      const hit = cache.get(c.text);
      if (hit && mode !== "verified") return hit;
      asked++;
      const r = await gate.ask(c.text, {
        baseline: "review",
        tags: [`chain:p${p}:${chain}`, `step:${s + 1}`, `attempt:${attempt}`, `run:${mode}`],
      });
      cache.set(c.text, r.decision);
      return r.decision;
    },
  }));
  const res = await runChain<S>({ outputs: [], good: true }, steps, policy);
  const logSteps = res.trace.map((t, s) => ({
    committed: t.committed,
    attempts: t.attempts.map((a) => {
      const c = table[s]?.[a.attempt - 1] as ChainCandidate;
      return { id: c.id, truth: c.truth, action: a.ruling.action, go: a.ruling.go };
    }),
  }));
  return {
    p,
    chain,
    mode,
    maxAttempts,
    asked,
    ok: res.ok,
    trulyOk: res.ok && res.state.good,
    ...(res.stopReason !== undefined ? { stopReason: res.stopReason } : {}),
    ...(res.stoppedAt !== undefined ? { stoppedAt: res.stoppedAt } : {}),
    steps: logSteps,
    violations: violationsOf(res, table, maxAttempts),
    cost: res.cost,
  };
}

/** The formula from the vision, and what bounded retries add to it. */
export function predict(p: number, t: number, f: number, m: number, n: number) {
  const a = p * (1 - f) + (1 - p) * (1 - t);
  const q = (p * (1 - f)) / a;
  const stepCommit = 1 - (1 - a) ** m;
  return {
    accept: a,
    q,
    stepCommit,
    claimed: stepCommit ** n,
    trueSuccess: (q * stepCommit) ** n,
    trueGivenClaimed: q ** n,
    unverified: p ** n,
  };
}
