import type { Engine } from "../engine.ts";
import type { Gate } from "../gate.ts";
import type { JudgeVerdict } from "../types.ts";
import type { Harness } from "./event.ts";
import { hookLabelSource } from "./gate.ts";
import type { PromptOutcome } from "./resolve.ts";
import { promptState } from "./state.ts";

/** Ledger tag naming the prompt a row came from; it makes ingestion idempotent. */
export const promptTag = (o: PromptOutcome): string => `hook:prompt:${o.prompt.id}`;

export interface IngestResult {
  /** Settled prompts a person answered: the population the gate would replace. */
  readonly population: number;
  readonly asked: number;
  readonly already: number;
  /** Prompts with no answer yet; they are ingested on a later run. */
  readonly open: number;
  /** Prompts the harness's classifier settled; not a person's judgment. */
  readonly classifier: number;
  readonly stoppedAtBudget: boolean;
}

/**
 * Replay settled prompts through the gate in shadow, oldest first, and label each row with
 * the answer read from the journal. Every settled prompt is ingested whatever its label, in
 * time order, so the acceptance sample (the first acts in ledger order) is fixed without
 * anyone choosing rows by their labels. The answer is attached after the gate has ruled; it
 * never enters the state. A failed-open row bought no answer and is asked again next run.
 */
export async function ingestPrompts(
  engine: Engine,
  gate: Gate<JudgeVerdict>,
  harness: Harness,
  outcomes: readonly PromptOutcome[],
): Promise<IngestResult> {
  const seen = new Set(
    (await engine.ledger.all()).flatMap((r) =>
      r.failedOpen || r.questionHash !== gate.questionHash ? [] : r.tags,
    ),
  );
  let open = 0;
  let classifier = 0;
  const population = outcomes
    .filter((o) => {
      if (o.label === "open") open++;
      else if (o.label === "classifier") classifier++;
      return o.label === "allowed" || o.label === "denied";
    })
    .sort(
      (a, b) =>
        Date.parse(a.prompt.at) - Date.parse(b.prompt.at) || a.prompt.id.localeCompare(b.prompt.id),
    );
  let asked = 0;
  let already = 0;
  let stoppedAtBudget = false;
  for (const o of population) {
    const tag = promptTag(o);
    if (seen.has(tag)) {
      already++;
      continue;
    }
    if (engine.overBudget) {
      stoppedAtBudget = true;
      break;
    }
    seen.add(tag);
    const p = o.prompt;
    const result = await gate.ask(promptState(p), {
      baseline: "review",
      tags: [
        tag,
        `session:${harness}:${p.session}`,
        `harness:${harness}`,
        `tool:${p.tool ?? "unknown"}`,
        ...(p.permissionMode === undefined ? [] : [`mode:${p.permissionMode}`]),
      ],
    });
    if (result.decision.detail.budgetExhausted === true) {
      stoppedAtBudget = true;
      break;
    }
    const approved = o.label === "allowed";
    await engine.label(result.recordId, {
      at: o.settledAt ?? p.at,
      correct: result.decision.verdict.pYes >= 0.5 === approved,
      truth: approved,
      source: hookLabelSource(harness),
      ...(approved ? {} : { note: `denied: no run before ${o.by ?? "unknown"}` }),
    });
    asked++;
  }
  return { population: population.length, asked, already, open, classifier, stoppedAtBudget };
}
