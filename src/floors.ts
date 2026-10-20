import { type Action, moreCautious, type Question } from "./types.ts";

/**
 * A hard rule: looks at the state and the question and either imposes a minimum caution
 * or stays silent (undefined). Floors are deterministic and fail closed: a soft oracle can
 * push the final action to be MORE cautious than the floor, never less. This is the
 * `max(floor, judgment)` pattern practitioners converged on (hard checks fail closed, soft
 * judgments fail open), as a first-class object.
 */
export type FloorRule = (state: string, question: Question) => Action | undefined;

/** The most cautious action any rule demands, or "act" when no rule speaks. */
export function floorFor(rules: readonly FloorRule[], state: string, question: Question): Action {
  let floor: Action = "act";
  for (const rule of rules) {
    const a = rule(state, question);
    if (a) floor = moreCautious(floor, a);
  }
  return floor;
}

/** Global and sticky patterns must not make a hard rule depend on earlier evaluations. */
function matches(pattern: RegExp, text: string): boolean {
  const lastIndex = pattern.lastIndex;
  try {
    pattern.lastIndex = 0;
    return pattern.test(text);
  } finally {
    pattern.lastIndex = lastIndex;
  }
}

/** Refuse whenever the state matches any pattern. */
export function refuseIf(...patterns: readonly RegExp[]): FloorRule {
  return (state) => (patterns.some((p) => matches(p, state)) ? "refuse" : undefined);
}

/** Require review whenever the state matches any pattern. */
export function reviewIf(...patterns: readonly RegExp[]): FloorRule {
  return (state) => (patterns.some((p) => matches(p, state)) ? "review" : undefined);
}

/** Require review unless the state matches at least one allowed pattern. */
export function reviewUnless(...allowed: readonly RegExp[]): FloorRule {
  return (state) => (allowed.some((p) => matches(p, state)) ? undefined : "review");
}

/**
 * One-way doors are never automated. Any per-decision chance of an irreversible loss
 * compounds to near-certainty over enough decisions, however confident the oracle is, so
 * the most the engine may do with an irreversible action is recommend it for review.
 */
export function oneWayDoor(
  isIrreversible: (state: string, question: Question) => boolean,
): FloorRule {
  return (state, q) => (isIrreversible(state, q) ? "review" : undefined);
}

/** Scope a rule to questions whose id matches. */
export function forQuestion(id: string | RegExp, rule: FloorRule): FloorRule {
  const match =
    typeof id === "string" ? (q: Question) => q.id === id : (q: Question) => matches(id, q.id);
  return (state, q) => (match(q) ? rule(state, q) : undefined);
}

/**
 * A bypass: a state the application already knows is safe to act on, so the oracle is not
 * asked at all. Claude Code skips its classifier for in-project writes; read-only commands
 * are the usual case. Bypasses never override a floor: a state that matches both a bypass
 * and a refuse floor is refused. They apply to judge questions only.
 */
export type BypassRule = (state: string, question: Question) => boolean;

export function allowIf(...patterns: readonly RegExp[]): BypassRule {
  return (state) => patterns.some((p) => matches(p, state));
}

export function bypassFor(
  rules: readonly BypassRule[],
  state: string,
  question: Question,
): boolean {
  return question.kind === "judge" && rules.some((r) => r(state, question));
}
