import type { JudgeQuestion, PickQuestion, Question, RateQuestion, Verdict } from "./types.ts";

export const LIMITS = {
  /** Jev accepts up to 255 options per Choice; we enforce the same ceiling by default. */
  maxOptions: 255,
  minRubricLevels: 2,
  maxRubricLevels: 10,
} as const;

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${(++counter).toString(36)}`;

/** Build a pick question. Options must be distinct, non-empty strings. */
export function pick<const O extends string>(
  prompt: string,
  options: readonly O[],
  extra: { id?: string; criteria?: Partial<Record<O, string>> } = {},
): PickQuestion<O> {
  if (options.length < 2) throw new Error("pick needs at least two options");
  if (options.length > LIMITS.maxOptions) {
    throw new Error(`pick allows at most ${LIMITS.maxOptions} options`);
  }
  if (new Set(options).size !== options.length) throw new Error("pick options must be distinct");
  if (options.some((o) => o.trim() === "")) throw new Error("pick options must be non-empty");
  return {
    kind: "pick",
    id: extra.id ?? nextId("pick"),
    prompt,
    options,
    ...(extra.criteria ? { criteria: extra.criteria } : {}),
  };
}

/** Build a rate question over an ordered rubric (lowest level first). */
export function rate(
  prompt: string,
  levels: readonly string[],
  extra: { id?: string } = {},
): RateQuestion {
  if (levels.length < LIMITS.minRubricLevels || levels.length > LIMITS.maxRubricLevels) {
    throw new Error(`rate needs ${LIMITS.minRubricLevels} to ${LIMITS.maxRubricLevels} levels`);
  }
  if (new Set(levels).size !== levels.length) throw new Error("rate levels must be distinct");
  return { kind: "rate", id: extra.id ?? nextId("rate"), prompt, levels };
}

/** Build a yes / no question. Phrase it so that "yes" is the thing you want a probability for. */
export function judge(
  prompt: string,
  extra: { id?: string; criteria?: { yes?: string; no?: string } } = {},
): JudgeQuestion {
  if (!prompt.trim()) throw new Error("judge needs a prompt");
  return {
    kind: "judge",
    id: extra.id ?? nextId("judge"),
    prompt,
    ...(extra.criteria ? { criteria: extra.criteria } : {}),
  };
}

/**
 * A value as text for an error message, without ever throwing: `String()` throws on an object
 * with no prototype or a hostile `toString`, and an error message about garbage must not
 * become a second failure. Strings are quoted; anything unprintable is named by its type.
 */
export function show(x: unknown): string {
  try {
    if (typeof x === "string") return JSON.stringify(x.length > 60 ? `${x.slice(0, 60)}...` : x);
    if (typeof x === "object" && x !== null) return Array.isArray(x) ? "an array" : "an object";
    return String(x);
  } catch {
    return `a value of type ${typeof x}`;
  }
}

/** A probability: a real number, not NaN, not a string, not null, within [0, 1]. */
export const isProbability = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * How far a stated figure may sit from the one its distribution implies (rounding in a vendor's
 * numbers), and how far a distribution may sum from 1.
 */
const TOLERANCE = 1e-3;

const near = (a: number, b: number, tol = TOLERANCE): boolean => Math.abs(a - b) <= tol;

/** Every entry within TOLERANCE of 1 / n: the uniform distribution a neutral verdict carries. */
const uniform = (ps: readonly number[]): boolean => ps.every((p) => near(p, 1 / ps.length));

/**
 * Sanity-check a verdict against its question; adapters call this on everything they parse,
 * and `failOpen` calls it on every answer an oracle returns. It is strict because whatever it
 * lets through is ruled on: a NaN, a string, an out-of-range number or a confidence the
 * distribution does not support must never become permission to act.
 *
 * - judge: `pYes` is a probability and `confidence` is max(pYes, 1 - pYes).
 * - pick: `choice` is an option, the distribution names only options, its entries are
 *   probabilities summing to 1, and `confidence` is the mass on `choice`.
 * - rate: one probability per level summing to 1, `level` is on the rubric, `confidence` is the
 *   mass on `level`, and `score` is the probability-weighted position.
 *
 * The one exception is the neutral verdict (`neutralVerdict`): uniform, or pYes 0.5, with
 * confidence 0 by convention, since it says nothing. Figures may differ from what the
 * distribution implies by rounding (1e-3).
 */
export function validateVerdict(q: Question, v: Verdict): void {
  if (typeof v !== "object" || v === null) throw new Error("verdict is missing");
  if (v.kind !== q.kind) {
    throw new Error(`verdict kind ${show(v.kind)} does not match question kind ${q.kind}`);
  }
  if (v.questionId !== q.id) {
    throw new Error(`verdict for ${show(v.questionId)} does not match question ${q.id}`);
  }
  if (!isProbability(v.confidence)) {
    throw new Error(`confidence ${show(v.confidence)} is not a probability`);
  }
  switch (v.kind) {
    case "pick": {
      const qq = q as PickQuestion;
      if (typeof v.choice !== "string" || !qq.options.includes(v.choice)) {
        throw new Error(`choice ${show(v.choice)} is not an option`);
      }
      const probabilities: unknown = v.probabilities;
      if (typeof probabilities !== "object" || probabilities === null) {
        throw new Error("pick probabilities are missing");
      }
      const named = probabilities as Readonly<Record<string, unknown>>;
      for (const key of Object.keys(named)) {
        if (!qq.options.includes(key)) throw new Error(`probability for ${key}, not an option`);
      }
      const ps = qq.options.map((o) => (Object.hasOwn(named, o) ? named[o] : 0));
      if (!ps.every(isProbability)) throw new Error("pick probabilities are not all probabilities");
      const sum = ps.reduce((s, p) => s + p, 0);
      if (!near(sum, 1)) throw new Error(`pick probabilities sum to ${sum}`);
      const mass = ps[qq.options.indexOf(v.choice)] as number;
      if (!near(v.confidence, mass) && !(v.confidence === 0 && uniform(ps))) {
        throw new Error(`pick confidence ${v.confidence} is not the mass ${mass} on its choice`);
      }
      break;
    }
    case "rate": {
      const qq = q as RateQuestion;
      const raw: unknown = v.probabilities;
      if (!Array.isArray(raw) || raw.length !== qq.levels.length) {
        throw new Error("rate probabilities length mismatch");
      }
      if (!raw.every(isProbability))
        throw new Error("rate probabilities are not all probabilities");
      const ps = raw as readonly number[];
      if (
        !near(
          ps.reduce((a, b) => a + b, 0),
          1,
        )
      ) {
        throw new Error("rate probabilities do not sum to 1");
      }
      if (typeof v.level !== "string" || !qq.levels.includes(v.level)) {
        throw new Error(`level ${show(v.level)} is not on the rubric`);
      }
      const mass = ps[qq.levels.indexOf(v.level)] as number;
      if (!near(v.confidence, mass) && !(v.confidence === 0 && uniform(ps))) {
        throw new Error(`rate confidence ${v.confidence} is not the mass ${mass} on its level`);
      }
      const expected = ps.reduce((s, p, i) => s + i * p, 0);
      if (
        typeof v.score !== "number" ||
        !Number.isFinite(v.score) ||
        !near(v.score, expected, TOLERANCE * (qq.levels.length - 1))
      ) {
        throw new Error(`rate score ${show(v.score)} is not the expected position ${expected}`);
      }
      break;
    }
    case "judge": {
      if (!isProbability(v.pYes)) throw new Error(`pYes ${show(v.pYes)} out of range`);
      const lean = Math.max(v.pYes, 1 - v.pYes);
      if (!near(v.confidence, lean) && !(v.confidence === 0 && v.pYes === 0.5)) {
        throw new Error(`judge confidence ${v.confidence} is not max(pYes, 1 - pYes) = ${lean}`);
      }
      break;
    }
    default:
      throw new Error(`unknown verdict kind ${show((v as { kind?: unknown }).kind)}`);
  }
}

/** A verdict that says nothing: uniform / 0.5 with zero confidence. Used when an oracle fails open. */
export function neutralVerdict(q: Question): Verdict {
  switch (q.kind) {
    case "pick": {
      const p = 1 / q.options.length;
      const probabilities = Object.fromEntries(q.options.map((o) => [o, p])) as Record<
        string,
        number
      >;
      return {
        kind: "pick",
        questionId: q.id,
        choice: q.options[0] as string,
        probabilities,
        confidence: 0,
      };
    }
    case "rate": {
      const n = q.levels.length;
      return {
        kind: "rate",
        questionId: q.id,
        score: (n - 1) / 2,
        level: q.levels[0] as string,
        probabilities: q.levels.map(() => 1 / n),
        confidence: 0,
      };
    }
    case "judge":
      return { kind: "judge", questionId: q.id, pYes: 0.5, confidence: 0 };
  }
}

/** Build a pick verdict from a probability vector aligned with the question's options. */
export function pickVerdictFrom<O extends string>(
  q: PickQuestion<O>,
  probs: readonly number[],
): import("./types.ts").PickVerdict<O> {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if ((probs[i] ?? 0) > (probs[best] ?? 0)) best = i;
  const probabilities = Object.fromEntries(q.options.map((o, i) => [o, probs[i] ?? 0])) as Record<
    O,
    number
  >;
  return {
    kind: "pick",
    questionId: q.id,
    choice: q.options[best] as O,
    probabilities,
    confidence: probs[best] ?? 0,
  };
}

/** Build a rate verdict from a probability vector aligned with the rubric. */
export function rateVerdictFrom(
  q: RateQuestion,
  probs: readonly number[],
): import("./types.ts").RateVerdict {
  let best = 0;
  let score = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i] ?? 0;
    score += i * p;
    if (p > (probs[best] ?? 0)) best = i;
  }
  return {
    kind: "rate",
    questionId: q.id,
    score,
    level: q.levels[best] as string,
    probabilities: probs.slice(),
    confidence: probs[best] ?? 0,
  };
}

/**
 * Options ranked by probability with cumulative mass: the shortlist a reviewer sees when the
 * top answer is not sure enough to act on. On 77-way routing the truth sat in the top three
 * 91% of the time while the top one was right 77% of the time.
 */
export function shortlist<O extends string>(
  v: import("./types.ts").PickVerdict<O>,
  k = 3,
): { option: O; p: number; cumulative: number }[] {
  const ranked = (Object.entries(v.probabilities) as [O, number][]).sort((a, b) => b[1] - a[1]);
  let cumulative = 0;
  return ranked.slice(0, k).map(([option, p]) => {
    cumulative += p;
    return { option, p, cumulative };
  });
}

/**
 * Build a judge verdict from p(yes), clamped to [0, 1]. A NaN stays NaN, so `validateVerdict`
 * rejects it and `rule()` reads it as failed open. Clamping is for rounding spill; adapters
 * reject an out-of-range probability before they get here, since clamping 1.7 to 1 would repair
 * garbage into certainty.
 */
export function judgeVerdictFrom(
  q: JudgeQuestion,
  pYes: number,
): import("./types.ts").JudgeVerdict {
  const p = Math.min(1, Math.max(0, pYes));
  return { kind: "judge", questionId: q.id, pYes: p, confidence: Math.max(p, 1 - p) };
}
