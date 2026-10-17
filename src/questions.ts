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

/** Sanity-check a verdict against its question; adapters call this on everything they parse. */
export function validateVerdict(q: Question, v: Verdict): void {
  if (v.kind !== q.kind) {
    throw new Error(`verdict kind ${v.kind} does not match question kind ${q.kind}`);
  }
  if (v.questionId !== q.id) {
    throw new Error(`verdict for ${v.questionId} does not match question ${q.id}`);
  }
  const near1 = (s: number) => Math.abs(s - 1) < 1e-3;
  switch (v.kind) {
    case "pick": {
      const qq = q as PickQuestion;
      if (!qq.options.includes(v.choice)) throw new Error(`choice ${v.choice} is not an option`);
      const sum = qq.options.reduce((s, o) => s + (v.probabilities[o] ?? 0), 0);
      if (!near1(sum)) throw new Error(`pick probabilities sum to ${sum}`);
      break;
    }
    case "rate": {
      const qq = q as RateQuestion;
      if (v.probabilities.length !== qq.levels.length) {
        throw new Error("rate probabilities length mismatch");
      }
      if (!near1(v.probabilities.reduce((a, b) => a + b, 0))) {
        throw new Error("rate probabilities do not sum to 1");
      }
      if (!qq.levels.includes(v.level)) throw new Error(`level ${v.level} is not on the rubric`);
      break;
    }
    case "judge":
      if (v.pYes < 0 || v.pYes > 1) throw new Error("pYes out of range");
      break;
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

export function judgeVerdictFrom(
  q: JudgeQuestion,
  pYes: number,
): import("./types.ts").JudgeVerdict {
  const p = Math.min(1, Math.max(0, pYes));
  return { kind: "judge", questionId: q.id, pYes: p, confidence: Math.max(p, 1 - p) };
}
