/**
 * Deterministic oracles for the T5 repros: no network, no randomness, so each repro's output
 * is the same on every run and shows one behaviour of the engine in isolation.
 */
import { judgeVerdictFrom, pickVerdictFrom } from "../../../../src/questions.ts";
import type { Decision, Oracle, Question } from "../../../../src/types.ts";

/** A judge oracle whose pYes is a function of the question asked (and so of its framing). */
export function fixedJudge(id: string, pYes: (q: Question, state: string) => number): Oracle {
  return {
    id,
    async decide(state, qs): Promise<Decision[]> {
      return qs.map((q) => {
        if (q.kind !== "judge") throw new Error("fixedJudge answers judge questions only");
        return {
          verdict: judgeVerdictFrom(q, pYes(q, state)),
          oracle: id,
          model: id,
          latencyMs: 1,
          cost: 0,
          at: new Date().toISOString(),
        };
      });
    },
  };
}

/** A pick oracle that always puts `p` on one option by name, the rest spread evenly. */
export function fixedPick(id: string, choose: (state: string) => string, p: number): Oracle {
  return {
    id,
    async decide(state, qs): Promise<Decision[]> {
      return qs.map((q) => {
        if (q.kind !== "pick") throw new Error("fixedPick answers pick questions only");
        const c = choose(state);
        const rest = (1 - p) / (q.options.length - 1);
        return {
          verdict: pickVerdictFrom(
            q,
            q.options.map((o) => (o === c ? p : rest)),
          ),
          oracle: id,
          model: id,
          latencyMs: 1,
          cost: 0,
          at: new Date().toISOString(),
        };
      });
    },
  };
}

export const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
