import type { Engine } from "../../src/engine.ts";
import type { Gate } from "../../src/gate.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import { KEYWORK_LABEL_SOURCE } from "./gate.ts";
import { type AnsweredBy, decisionKey, type ToolDecision } from "./record.ts";
import { toolCallState } from "./state.ts";

/** Ledger tag naming the keywork call a row came from; it makes ingestion idempotent. */
export const callTag = (d: ToolDecision): string => `keywork:call:${decisionKey(d)}`;

/** Which answers a run ingests, by the instant the person answered: a half-open interval. */
export interface AnswerWindow {
  /** Only answers at or after this instant (ISO 8601). */
  readonly since?: string;
  /** Only answers before this instant (ISO 8601). */
  readonly before?: string;
}

export function withinWindow(d: ToolDecision, window: AnswerWindow): boolean {
  const at = Date.parse(d.answer.at);
  return (
    (window.since === undefined || at >= Date.parse(window.since)) &&
    (window.before === undefined || at < Date.parse(window.before))
  );
}

export interface IngestResult {
  /** Decisions a person answered inside the window: the population the gate would replace. */
  readonly population: number;
  /** Rows asked of the gate in this run. */
  readonly asked: number;
  /** Person-answered decisions already in the ledger from an earlier run. */
  readonly already: number;
  /** Decisions outside the population, by who answered them. */
  readonly skipped: Readonly<Record<Exclude<AnsweredBy, "person">, number>>;
  /** Person-answered decisions outside the window: another phase's answers. */
  readonly outsideWindow: number;
  /** Denials that judged the moment ("not-now"), not the call; they leave the population. */
  readonly steering: number;
  /** True when the budget ran out and the rest were left for a later run. */
  readonly stoppedAtBudget: boolean;
}

/**
 * Replay a person's answered asks through the gate in shadow, oldest first, and label each row
 * with the answer the person gave. Only fresh answers are evidence: a call a standing grant
 * covered, a rule decided or no one could answer says nothing about the person's judgment of
 * that call, and an older journal that cannot tell an answer from a grant is left out. A denial
 * the person marked "not-now" judged the moment (stop, not that, later) rather than the call,
 * so it leaves the population; it is the person's reason, not the gate's verdict, that excludes
 * it, which keeps the sample unbiased. A denial without a reason counts against the call, and
 * the blind review of every denial corrects it when that was wrong.
 *
 * Every remaining decision inside the window is ingested regardless of its answer, in time
 * order, so the acceptance sample (the first acts in ledger order) is fixed without anyone
 * choosing rows by their labels. The window keeps the phases apart. The answer is attached
 * after the gate has ruled; it never enters the state.
 */
export async function ingestDecisions(
  engine: Engine,
  gate: Gate<JudgeVerdict>,
  decisions: readonly ToolDecision[],
  window: AnswerWindow = {},
): Promise<IngestResult> {
  const skipped = { headless: 0, grant: 0, rule: 0, unknown: 0 };
  let outsideWindow = 0;
  let steering = 0;
  // Rows of this question only: a reworded rubric is a new question, and its calls are asked
  // again. A failed-open row bought no answer, so its call is asked again too.
  const seen = new Set(
    (await engine.ledger.all()).flatMap((r) =>
      r.failedOpen || r.questionHash !== gate.questionHash ? [] : r.tags,
    ),
  );
  const population = decisions
    .filter((d) => {
      if (d.answer.by !== "person") {
        skipped[d.answer.by]++;
        return false;
      }
      if (!withinWindow(d, window)) {
        outsideWindow++;
        return false;
      }
      if (d.answer.verdict === "denied" && d.answer.reason === "not-now") {
        steering++;
        return false;
      }
      return true;
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
  return {
    population: population.length,
    asked,
    already,
    skipped,
    outsideWindow,
    steering,
    stoppedAtBudget,
  };
}
