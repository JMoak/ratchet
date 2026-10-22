import type { Engine } from "../../src/engine.ts";
import type { Gate } from "../../src/gate.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import { KEYWORK_LABEL_SOURCE } from "./gate.ts";
import { type AnsweredBy, decisionKey, type ToolDecision } from "./record.ts";
import { toolCallState } from "./state.ts";

/** Ledger tag naming the keywork call a row came from; it makes ingestion idempotent. */
export const callTag = (d: ToolDecision): string => `keywork:call:${decisionKey(d)}`;

export interface IngestResult {
  /** Decisions a person answered: the population the gate would replace. */
  readonly population: number;
  /** Rows asked of the gate in this run. */
  readonly asked: number;
  /** Person-answered decisions already in the ledger from an earlier run. */
  readonly already: number;
  /** Decisions outside the population, by who answered them. */
  readonly skipped: Readonly<Record<Exclude<AnsweredBy, "person">, number>>;
  /** True when the budget ran out and the rest were left for a later run. */
  readonly stoppedAtBudget: boolean;
}

/**
 * Replay a person's answered asks through the gate in shadow, oldest first, and label each row
 * with the answer the person gave. Only fresh answers are evidence: a call a standing grant
 * covered, a rule decided or no one could answer says nothing about the person's judgment of
 * that call, and an older journal that cannot tell an answer from a grant is left out.
 *
 * Every person-answered decision is ingested regardless of its answer, in time order, so the
 * acceptance sample (the first acts in ledger order) is fixed without anyone choosing rows by
 * their labels. The answer is attached after the gate has ruled; it never enters the state.
 */
export async function ingestDecisions(
  engine: Engine,
  gate: Gate<JudgeVerdict>,
  decisions: readonly ToolDecision[],
): Promise<IngestResult> {
  const skipped = { headless: 0, grant: 0, rule: 0, unknown: 0 };
  // A failed-open row bought no answer, so its call is asked again on a later run.
  const seen = new Set((await engine.ledger.all()).flatMap((r) => (r.failedOpen ? [] : r.tags)));
  const population = decisions
    .filter((d) => {
      if (d.answer.by === "person") return true;
      skipped[d.answer.by]++;
      return false;
    })
    .sort(
      (a, b) =>
        Date.parse(a.answer.at) - Date.parse(b.answer.at) || a.callId.localeCompare(b.callId),
    );
  let asked = 0;
  let already = 0;
  let stoppedAtBudget = false;
  for (const d of population) {
    const tag = callTag(d);
    if (seen.has(tag)) {
      already++;
      continue;
    }
    if (engine.overBudget) {
      stoppedAtBudget = true;
      break;
    }
    seen.add(tag);
    const result = await gate.ask(toolCallState(d), {
      baseline: "review",
      tags: [tag, `session:${d.rootSession}`, `keywork:tool:${d.tool}`],
    });
    // A cap refused the request (this run's or the day's); its failed-open row is asked again later.
    if (result.decision.detail.budgetExhausted === true) {
      stoppedAtBudget = true;
      break;
    }
    const approved = d.answer.verdict === "granted";
    await engine.label(result.recordId, {
      at: d.answer.at,
      correct: result.decision.verdict.pYes >= 0.5 === approved,
      truth: approved,
      source: KEYWORK_LABEL_SOURCE,
    });
    asked++;
  }
  return { population: population.length, asked, already, skipped, stoppedAtBudget };
}
