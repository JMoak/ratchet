import type { StateEntry } from "./state.ts";
import { type Action, moreCautious, type Question, type StateLike } from "./types.ts";

/**
 * A hard rule: looks at the state and the question and either imposes a minimum caution
 * or stays silent (undefined). Floors are deterministic and fail closed: a soft oracle can
 * push the final action to be MORE cautious than the floor, never less. This is the
 * `max(floor, judgment)` pattern practitioners converged on (hard checks fail closed, soft
 * judgments fail open), as a first-class object.
 *
 * A plain rule reads the rendered text. One built with `entryFloor` or `floorOn` reads the
 * builder's entries instead; it is still a `FloorRule`, so both kinds share one `floors` array.
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

/** How `FloorInput.get` finds an entry. */
export interface EntryLookup {
  /**
   * Also match an untrusted span of that name. Off by default, so a rule over the command does
   * not fire on tool output that mentions it (e2e T4-14); a floor raises caution, so it may opt
   * in. A bypass is handed no untrusted spans, so for one this changes nothing.
   */
  readonly untrusted?: boolean;
  /** Return undefined, instead of failing closed, when the state has entries but not this one. */
  readonly optional?: boolean;
}

/**
 * What a rule built with `entryFloor` reads: the rendering, the trusted block alone, and the
 * builder's entries with a lookup by path. A plain string, or a StateLike without `fields`, has
 * no entries to read: `get` then throws, and a floor that throws imposes review (e2e T4-13).
 */
export interface FloorInput {
  /** The whole rendering, untrusted spans included: what plain rules and the oracle read. */
  readonly text: string;
  /** The trusted block alone (`StateLike.trustedText`); the whole text for a plain string. */
  readonly trustedText: string;
  /** The entries in insertion order (`State.fields`), or undefined when the state has none. */
  readonly entries: readonly StateEntry[] | undefined;
  /**
   * The entry at a path, section included ("customer.plan"; a pair is "left and right"): a
   * trusted field, digest or pair, or with `untrusted` any entry. Throws when the state has no
   * entries, when two entries share the path, and when none has it unless `optional` is set.
   */
  get(path: string, lookup?: EntryLookup & { readonly optional?: false }): StateEntry;
  get(path: string, lookup: EntryLookup): StateEntry | undefined;
}

/**
 * Where a rule that reads entries keeps its reader. A registered symbol, as `forQuestion` records
 * its scope, so entry rules sit in the same `floors` and `bypass` arrays as plain ones and the
 * evaluators below can hand them the state's entries instead of its text.
 */
const ENTRY_READER: unique symbol = Symbol.for("ratchet.entryReader");

type Reader = (input: FloorInput, question: Question) => unknown;

function readerOf(rule: unknown): Reader | undefined {
  if (typeof rule !== "function") return undefined;
  const read = (rule as unknown as Readonly<Record<symbol, unknown>>)[ENTRY_READER];
  return typeof read === "function" ? (read as Reader) : undefined;
}

function withReader<R extends FloorRule | BypassRule>(rule: R, read: Reader): R {
  Object.defineProperty(rule, ENTRY_READER, { value: read });
  return rule;
}

/** The kinds a rule reads by default: entries the harness vouches for, never a raw `text` wrap. */
const TRUSTED_KINDS: ReadonlySet<unknown> = new Set(["field", "digest", "pair"]);

function isTrustedEntry(e: unknown): e is StateEntry {
  if (typeof e !== "object" || e === null) return false;
  const entry = e as StateEntry;
  return entry.trusted === true && TRUSTED_KINDS.has(entry.kind);
}

function inputOf(
  text: string,
  trustedText: string,
  entries: readonly StateEntry[] | undefined,
): FloorInput {
  function get(path: string, lookup?: EntryLookup & { readonly optional?: false }): StateEntry;
  function get(path: string, lookup: EntryLookup): StateEntry | undefined;
  function get(path: string, lookup: EntryLookup = {}): StateEntry | undefined {
    // `State.from(string)` wraps the whole text as one "text" entry: no structure to read.
    const typed = (entries ?? []).filter((e) => e.kind !== "text");
    if (typed.length === 0)
      throw new Error(
        `state has no entries to read "${path}" from (a plain string, or a StateLike without fields)`,
      );
    const named = typed.filter((e) => e.name === path);
    const found = lookup.untrusted === true ? named : named.filter(isTrustedEntry);
    if (found.length > 1)
      throw new Error(`state entry "${path}" is ambiguous: ${found.length} entries have that path`);
    const [entry] = found;
    if (entry !== undefined) return entry;
    if (lookup.optional === true) return undefined;
    throw new Error(
      named.length > 0
        ? `state entry "${path}" is absent; only an untrusted span has that name (untrusted: true reads it)`
        : `state entry "${path}" is absent`,
    );
  }
  return { text, trustedText, entries, get };
}

/** What every rule reads of a state: a string is all trusted text and has no entries. */
function floorInput(state: string | StateLike): FloorInput {
  if (typeof state === "string") return inputOf(state, state, undefined);
  const trustedText = typeof state.trustedText === "string" ? state.trustedText : state.text;
  return inputOf(state.text, trustedText, Array.isArray(state.fields) ? state.fields : undefined);
}

/**
 * What a bypass that reads entries is handed: the trusted block and the trusted entries only,
 * built without untrusted spans, so nothing it asks for can reach one.
 */
function loweringInput(input: FloorInput): FloorInput {
  return inputOf(input.trustedText, input.trustedText, input.entries?.filter(isTrustedEntry));
}

/** What `floorOn` and `allowOn` hand a predicate: the raw value behind a digest when kept. */
function entryValue(entry: StateEntry): unknown {
  return entry.raw !== undefined ? entry.raw : entry.value;
}

function checkPath(path: unknown, what: string): void {
  if (typeof path !== "string" || path.trim() === "")
    throw new Error(`${what} needs the path of a state entry, such as "amount" or "customer.plan"`);
}

/**
 * Evaluate every rule. A rule that throws, or returns anything but an Action or silence
 * (undefined, and the null or false a `cond && "refuse"` rule yields), cannot be read, and an
 * unreadable hard rule fails closed: it imposes review and its error is kept, so a typo
 * ("deny") or a parser that chokes on a malformed state never lets the oracle's answer
 * through unbounded, and never aborts the ask without a ledger row.
 *
 * `state` is the text or a `StateLike`. A plain rule receives the text exactly as before; an
 * entry rule (`entryFloor`, `floorOn`) receives the entries, and on a state that has none it
 * fails closed the same way, with its reason kept.
 */
export function evaluateFloors(
  rules: readonly FloorRule[],
  state: string | StateLike,
  question: Question,
): FloorEvaluation {
  const input = floorInput(state);
  let floor: Action = "act";
  const errors: string[] = [];
  rules.forEach((rule, i) => {
    let a: unknown;
    try {
      const read = readerOf(rule);
      a = read !== undefined ? read(input, question) : rule(input.text, question);
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
export function floorFor(
  rules: readonly FloorRule[],
  state: string | StateLike,
  question: Question,
): Action {
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
 * a battery member, which floors never see (e2e T4-08). An entry rule stays one when scoped.
 */
export function forQuestion(id: string | RegExp, rule: FloorRule): FloorRule {
  const match =
    typeof id === "string" ? (q: Question) => q.id === id : (q: Question) => matches(id, q.id);
  const scoped: FloorRule = (state, q) => (match(q) ? rule(state, q) : undefined);
  Object.defineProperty(scoped, Symbol.for("ratchet.questionScope"), { value: id });
  const read = readerOf(rule);
  if (read !== undefined) withReader(scoped, (input, q) => (match(q) ? read(input, q) : undefined));
  return scoped;
}

/**
 * A floor that reads the state's entries rather than its rendering: `read` gets a `FloorInput`
 * (the text, the trusted text, the entries and `get` by path) and the question, and answers as
 * any floor does. A floor raises caution, so it may read anything, untrusted spans included.
 * Called as a plain rule on text it has no entries, so a lookup throws and it fails closed.
 */
export function entryFloor(
  read: (input: FloorInput, question: Question) => Action | undefined,
): FloorRule {
  if (typeof read !== "function")
    throw new Error("entryFloor needs a function of (input, question)");
  const rule: FloorRule = (state, q) => read(floorInput(state), q);
  return withReader(rule, read);
}

export interface FloorOnOptions {
  /** What the rule imposes when the predicate holds: review (the default) or refuse. */
  readonly action?: "review" | "refuse";
  /** Read an untrusted span of that name too (`EntryLookup.untrusted`). */
  readonly untrusted?: boolean;
  /**
   * Stay silent when the state has entries but not this one, for a field that is legitimately
   * not always there. Without it an absent entry imposes review: a floor that silently stops
   * firing because its field went missing is the dangerous direction.
   */
  readonly optional?: boolean;
}

/**
 * A floor over one entry's value: the value the caller gave the builder (a field's value, a
 * digest's `raw` value when it kept one and the digest otherwise, a pair's `{ left, right }`, a
 * span's full text), not its rendering. So an amount floor reads 1200 whether the state shows
 * `amount: 1200` or `amount: over $1,000` (e2e T3-10), and a command floor reads the command
 * field, not tool output that mentions the command (T4-14). The entry is a trusted field, digest
 * or pair at `path`, section included; a span of that name only with `untrusted: true`.
 *
 * `predicate` returns true to impose `action` (review by default), false for silence, or an
 * Action to impose that one. It fails closed to review, with its reason on the row, exactly as
 * `evaluateFloors` records any rule that throws (T4-13): when the entry is absent (unless
 * `optional`), when the state has no entries (a plain string), when two entries share the path,
 * when the predicate throws, and when it returns anything else (`"deny"`, `undefined`).
 *
 * ```ts
 * floorOn("amount", (v) => typeof v === "number" && v > 1000, { action: "refuse" });
 * floorOn("command", (v) => /\brm -rf\b/.test(String(v)));
 * ```
 */
export function floorOn(
  path: string,
  predicate: (value: unknown, entry: StateEntry, question: Question) => boolean | Action,
  options: FloorOnOptions = {},
): FloorRule {
  checkPath(path, "floorOn");
  if (typeof predicate !== "function") throw new Error(`floorOn("${path}") needs a predicate`);
  const action = options.action ?? "review";
  // Checked at runtime too: "act" or a typo here would be a floor that never raises caution.
  if (action !== "review" && action !== "refuse")
    throw new Error(
      `floorOn("${path}"): action must be "review" or "refuse", got ${String(action)}`,
    );
  const lookup: EntryLookup = {
    untrusted: options.untrusted === true,
    optional: options.optional === true,
  };
  return entryFloor((input, q) => {
    const entry = input.get(path, lookup);
    if (entry === undefined) return undefined;
    const held: unknown = predicate(entryValue(entry), entry, q);
    if (held === true) return action;
    if (held === false) return undefined;
    if (ACTIONS.has(held)) return held as Action;
    const what = typeof held === "string" ? JSON.stringify(held) : `a value of type ${typeof held}`;
    throw new Error(`floorOn("${path}") predicate returned ${what}, not a boolean or an action`);
  });
}

/**
 * A bypass: a state the application already knows is safe to act on, so the oracle is not
 * asked at all. Claude Code skips its classifier for in-project writes; read-only commands
 * are the usual case. Bypasses never override a floor: a state that matches both a bypass
 * and a refuse floor is refused. They apply to judge questions only.
 *
 * A bypass lowers caution, so text the harness did not vouch for must not grant one: that is
 * invariant 2 (floors only raise caution) applied to bypasses. On a state with untrusted spans a
 * plain bypass is granted only when it matches the trusted block (`trustedText`) AND the whole
 * text. The conjunction removes a grant that only untrusted text earned and can never add one:
 * a pattern anchored at the end may match the trusted block and not the full rendering, and that
 * is not a grant. A plain string, or a state without spans, has one text and nothing changes.
 */
export type BypassRule = (state: string, question: Question) => boolean;

/** Grant when any pattern matches the state: its trusted block and its whole text (`BypassRule`). */
export function allowIf(...patterns: readonly RegExp[]): BypassRule {
  return (state) => patterns.some((p) => matches(p, state));
}

/**
 * A bypass over one trusted entry: the judge question is answered yes without a call when
 * `predicate` returns exactly true for the value of the trusted field, digest or pair at `path`
 * (the value `floorOn` reads). It reads trusted entries only, by construction: entry bypasses are
 * handed the trusted block and trusted entries alone, so no untrusted span can reach one. An
 * absent entry, a state without entries, or a predicate that throws grants nothing.
 */
export function allowOn(
  path: string,
  predicate: (value: unknown, entry: StateEntry, question: Question) => boolean,
): BypassRule {
  checkPath(path, "allowOn");
  if (typeof predicate !== "function") throw new Error(`allowOn("${path}") needs a predicate`);
  const read = (input: FloorInput, q: Question): boolean => {
    let entry: StateEntry | undefined;
    try {
      entry = input.get(path, { optional: true });
    } catch {
      return false;
    }
    return entry !== undefined && predicate(entryValue(entry), entry, q) === true;
  };
  const rule: BypassRule = (state, q) => read(loweringInput(floorInput(state)), q);
  return withReader(rule, read);
}

/**
 * True when some bypass grants the judge question. `state` is the text or a `StateLike`: a plain
 * bypass must match both its trusted text and its whole text (`BypassRule`); an entry bypass
 * (`allowOn`) reads its trusted entries.
 */
export function bypassFor(
  rules: readonly BypassRule[],
  state: string | StateLike,
  question: Question,
): boolean {
  if (question.kind !== "judge" || rules.length === 0) return false;
  const input = floorInput(state);
  const lowering = loweringInput(input);
  // A bypass that throws grants nothing: the question is asked as if it had not matched.
  const grants = (r: BypassRule): boolean => {
    try {
      const read = readerOf(r);
      if (read !== undefined) return read(lowering, question) === true;
      if (!r(input.text, question)) return false;
      return input.trustedText === input.text || Boolean(r(input.trustedText, question));
    } catch {
      return false;
    }
  };
  return rules.some(grants);
}
