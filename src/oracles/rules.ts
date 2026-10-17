import { judgeVerdictFrom, neutralVerdict } from "../questions.ts";
import type { Decision, Oracle, Question, Verdict } from "../types.ts";
import { nowIso } from "./oracle.ts";

/**
 * A deterministic oracle made of rules. Two jobs: the shedding target when the model is
 * overloaded or down (the stream that survived 400 messages per second shed 12.6% to regex),
 * and the scripted baseline every loop should be measured against, since wherever such a
 * baseline existed it matched or beat the decision model. Questions no rule answers come
 * back neutral and flagged failedOpen, so the policy reviews them.
 */
export type VerdictRule = (state: string, question: Question) => Verdict | undefined;

/** Answer a judge question with a fixed yes-probability when the state matches. */
export function judgeIf(pattern: RegExp, pYes: number): VerdictRule {
  return (state, q) =>
    q.kind === "judge" && pattern.test(state) ? judgeVerdictFrom(q, pYes) : undefined;
}

export class RuleOracle implements Oracle {
  readonly id: string;
  constructor(
    private readonly rules: readonly VerdictRule[],
    id = "rules",
  ) {
    this.id = id;
  }

  async decide(state: string, questions: readonly Question[]): Promise<Decision[]> {
    const at = nowIso();
    return questions.map((q) => {
      for (const rule of this.rules) {
        const v = rule(state, q);
        if (v) return { verdict: v, oracle: this.id, latencyMs: 0, cost: 0, at };
      }
      return {
        verdict: neutralVerdict(q),
        oracle: this.id,
        latencyMs: 0,
        cost: 0,
        at,
        failedOpen: true,
      };
    });
  }
}
