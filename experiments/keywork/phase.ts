import { KEYWORK_FIT_FROM, KEYWORK_FREEZE, type KeyworkFreeze } from "./gate.ts";
import type { AnswerWindow } from "./ingest.ts";

/**
 * The three phases of the experiment, told apart by the instant the person answered. The smoke
 * set (answers before the fit phase began) proves the loop; fit rows fit the bar; evidence
 * validates the frozen bar. Each phase keeps its own ledger and a run ingests only its own
 * phase's answers, so no row is both fitted on and validated on, and no row seen before the
 * plan was fixed can enter the plan.
 */
export type Phase = "smoke" | "fit" | "evidence";

export interface PhaseSpec {
  readonly phase: Phase;
  readonly window: AnswerWindow;
  /** The phase's ledger, relative to the repository root. Phases never share one. */
  readonly ledger: string;
}

/** The instants that bound the phases; the defaults are the experiment's constants. */
export interface PhaseBounds {
  readonly fitFrom?: string;
  readonly freeze?: KeyworkFreeze | undefined;
}

export const PHASE_LEDGERS: Readonly<Record<Phase, string>> = {
  smoke: "experiments/out/keywork/smoke.jsonl",
  fit: "experiments/out/keywork/fit.jsonl",
  evidence: "experiments/out/keywork/evidence.jsonl",
};

/** A plain run fits until the freeze is set and collects evidence after it. */
export function currentPhase(bounds: PhaseBounds = {}): "fit" | "evidence" {
  return freezeOf(bounds) === undefined ? "fit" : "evidence";
}

export function phaseSpec(phase: Phase, bounds: PhaseBounds = {}): PhaseSpec {
  const fitFrom = bounds.fitFrom ?? KEYWORK_FIT_FROM;
  const freeze = freezeOf(bounds);
  const ledger = PHASE_LEDGERS[phase];
  switch (phase) {
    case "smoke":
      return { phase, window: { before: fitFrom }, ledger };
    case "fit":
      return {
        phase,
        window: { since: fitFrom, ...(freeze !== undefined ? { before: freeze.at } : {}) },
        ledger,
      };
    case "evidence":
      if (freeze === undefined) {
        throw new Error("evidence begins at the freeze, and the fit phase is not frozen yet");
      }
      return { phase, window: { since: freeze.at }, ledger };
  }
}

function freezeOf(bounds: PhaseBounds): KeyworkFreeze | undefined {
  return "freeze" in bounds ? bounds.freeze : KEYWORK_FREEZE;
}
