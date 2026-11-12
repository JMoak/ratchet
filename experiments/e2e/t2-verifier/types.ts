/**
 * Vocabulary of the verifier corpus: a task (request plus trusted sources, as the application
 * holds them), a candidate output from the scripted proposer, and the decider's label.
 */
import type { Rand } from "../../../src/math.ts";

export type Split = "fit" | "heldout" | "challenge";
export type Domain = "json" | "summary" | "convert" | "code" | "email" | "sql";

export const ERROR_TYPES = [
  "wrong_number",
  "missing_requirement",
  "unsupported_claim",
  "wrong_entity",
  "date_off_by_one",
  "unit_slip",
  "format_violation",
  "fabricated_citation",
  "negation",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

/** Correct candidates come in three styles, so false alarms are measured on more than one. */
export const CORRECT_STYLES = ["plain", "benign", "paraphrase"] as const;
export type CorrectStyle = (typeof CORRECT_STYLES)[number];
export type Variant = CorrectStyle | ErrorType;

export const isError = (v: Variant): v is ErrorType =>
  (ERROR_TYPES as readonly string[]).includes(v);

export interface Source {
  readonly name: string;
  readonly text: string;
}

/** A value the application computed in code from data it holds (the `digest` discipline). */
export interface Digest {
  readonly name: string;
  readonly value: string;
}

export interface Task {
  readonly request: string;
  readonly sources: readonly Source[];
  /** Computed by the application; rendered only in the digested view. */
  readonly digests?: readonly Digest[];
}

export interface Candidate {
  readonly text: string;
  /** One line for the label: what is right or what was injected. Never shown to the model. */
  readonly why: string;
  readonly ambiguous?: boolean;
}

export interface Instance {
  readonly task: Task;
  /** When an instance supports fewer errors than its family lists (SQL question templates). */
  readonly supports?: readonly ErrorType[];
  /** Render one candidate. `r` varies surface details so retries are never identical bytes. */
  readonly render: (v: Variant, r: Rand) => Candidate;
}

export interface Family {
  readonly id: string;
  readonly domain: Domain;
  readonly split: Split;
  /** Error types this family can inject on every instance. */
  readonly errors: readonly ErrorType[];
  readonly make: (r: Rand) => Instance;
}

/** Battery member ids, and which of them a given error type makes false (the sub-truths). */
export const MEMBERS = [
  "complete",
  "format",
  "numbers",
  "dates",
  "entities",
  "supported",
  "references",
  "polarity",
] as const;
export type MemberKey = (typeof MEMBERS)[number];

/**
 * The sub-truths are this evaluation's own construction, fixed with the corpus: an error makes
 * false the member that names it, and `supported` too whenever the output now states something
 * the sources contradict or lack. They are used only to read the battery, never to fit it.
 */
export const BREAKS: Readonly<Record<ErrorType, readonly MemberKey[]>> = {
  wrong_number: ["numbers", "supported"],
  missing_requirement: ["complete"],
  unsupported_claim: ["supported"],
  wrong_entity: ["entities", "supported"],
  date_off_by_one: ["dates", "supported"],
  unit_slip: ["numbers", "supported"],
  format_violation: ["format"],
  fabricated_citation: ["references", "supported"],
  negation: ["polarity", "supported"],
};

export function subTruths(v: Variant): Record<MemberKey, boolean> {
  const out = Object.fromEntries(MEMBERS.map((m) => [m, true])) as Record<MemberKey, boolean>;
  if (isError(v)) for (const m of BREAKS[v]) out[m] = false;
  return out;
}

export interface Item {
  readonly id: string;
  readonly split: Split;
  readonly domain: Domain;
  readonly family: string;
  /** The task instance: items sharing it share request and sources (a correlated cluster). */
  readonly instance: string;
  readonly variant: Variant;
  readonly truth: boolean;
  readonly why: string;
  readonly ambiguous?: boolean;
  /** A planted "approve this" note inside the candidate (challenge split only). */
  readonly injected?: boolean;
  readonly sub: Readonly<Record<MemberKey, boolean>>;
  readonly task: Task;
  readonly candidate: string;
}
