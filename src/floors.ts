import { type Action, moreCautious, type Question } from "./types.ts";

/**
 * A hard rule: looks at the state and the question and either imposes a minimum caution
 * or stays silent (undefined). Floors are deterministic and fail closed: a soft oracle can
 * push the final action to be MORE cautious than the floor, never less. This is the
 * `max(floor, judgment)` pattern practitioners converged on (hard checks fail closed, soft
 * judgments fail open), as a first-class object.
 */
export type FloorRule = (state: string, question: Question) => Action | undefined;

/** The floor a set of rules imposes, and why any rule could not be read. */
export interface FloorEvaluation {
  readonly floor: Action;
  /** One line per rule that threw or returned something other than an Action, kept short. */
  readonly errors: readonly string[];
}

/** What a floor rule fails closed to when it throws or answers outside the vocabulary. */
export const FLOOR_FAILS_CLOSED_TO: Action = "review";

const ACTIONS: ReadonlySet<unknown> = new Set<Action>(["act", "review", "refuse"]);

/**
 * Evaluate every rule. A rule that throws, or returns anything but an Action or silence
 * (undefined, and the null or false a `cond && "refuse"` rule yields), cannot be read, and an
 * unreadable hard rule fails closed: it imposes review and its error is kept, so a typo
 * ("deny") or a parser that chokes on a malformed state never lets the oracle's answer
 * through unbounded, and never aborts the ask without a ledger row.
 */
export function evaluateFloors(
  rules: readonly FloorRule[],
  state: string,
  question: Question,
): FloorEvaluation {
  let floor: Action = "act";
  const errors: string[] = [];
  rules.forEach((rule, i) => {
    let a: unknown;
    try {
      a = rule(state, question);
    } catch (error) {
      let message: string;
      try {
        message = error instanceof Error ? error.message : String(error);
      } catch {
        message = "an unprintable error";
      }
      errors.push(`floor ${i + 1} threw: ${message}`.slice(0, 160));
      floor = moreCautious(floor, FLOOR_FAILS_CLOSED_TO);
      return;
    }
    if (a === undefined || a === null || a === false) return;
    if (!ACTIONS.has(a)) {
      const what = typeof a === "string" ? JSON.stringify(a) : `a value of type ${typeof a}`;
      errors.push(`floor ${i + 1} returned ${what}, not an action`.slice(0, 160));
      floor = moreCautious(floor, FLOOR_FAILS_CLOSED_TO);
      return;
    }
    floor = moreCautious(floor, a as Action);
  });
  return { floor, errors };
}

/**
 * The most cautious action any rule demands, or "act" when no rule speaks. A rule that throws
 * or answers outside the vocabulary fails closed to review (`evaluateFloors`, which also says
 * why).
 */
export function floorFor(rules: readonly FloorRule[], state: string, question: Question): Action {
  return evaluateFloors(rules, state, question).floor;
}

/**
 * Test a pattern from its start, whatever its flags. Global and sticky patterns carry
 * `lastIndex` between calls, so `test` would alternate between a match and a miss on the same
 * text; a hard rule (or a scripted verdict) must not depend on earlier evaluations.
 */
export function matches(pattern: RegExp, text: string): boolean {
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

/**
 * Scope a rule to questions whose id matches. The scope is recorded on the rule under
 * `Symbol.for("ratchet.questionScope")`, so a gate can refuse at registration a rule scoped to
 * a battery member, which floors never see (e2e T4-08).
 */
export function forQuestion(id: string | RegExp, rule: FloorRule): FloorRule {
  const match =
    typeof id === "string" ? (q: Question) => q.id === id : (q: Question) => matches(id, q.id);
  const scoped: FloorRule = (state, q) => (match(q) ? rule(state, q) : undefined);
  Object.defineProperty(scoped, Symbol.for("ratchet.questionScope"), { value: id });
  return scoped;
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
  // A bypass that throws grants nothing: the question is asked as if it had not matched.
  const grants = (r: BypassRule): boolean => {
    try {
      return Boolean(r(state, question));
    } catch {
      return false;
    }
  };
  return question.kind === "judge" && rules.some(grants);
}
