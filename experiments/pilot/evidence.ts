import { rng } from "../../src/math.ts";

export interface FixedPolicyEvidence {
  acts: number;
  wrongActs: number;
  accuracy: number | null;
  lowerBound: number | null;
  targetAccuracy: number;
  confidence: number;
  status: "supported" | "insufficient-evidence" | "below-target";
}

export interface ValidationOptions {
  targetAccuracy: number;
  confidence?: number;
}

function checkConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be finite and strictly between 0 and 1");
  }
}

function checkCounts(correct: number, total: number): void {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(correct) ||
    total < 0 ||
    correct < 0 ||
    correct > total
  ) {
    throw new RangeError(
      "correct and total must be non-negative safe integers with correct <= total",
    );
  }
}

/**
 * Log P(X >= k), X ~ Binomial(n, p). Summing in log space avoids overflow in choose(n, k)
 * and underflow in the tail. This local routine keeps the pilot independent of the
 * approximate pooling math; exact-binomial inversion needs accurate extreme tails.
 */
function logBinomialTail(n: number, k: number, p: number): number {
  if (k === 0 || p === 1) return 0;
  if (p === 0 || k > n) return Number.NEGATIVE_INFINITY;
  let logChoose = 0;
  const terms = Math.min(k, n - k);
  for (let i = 1; i <= terms; i++) logChoose += Math.log((n - terms + i) / i);
  const logOdds = Math.log(p) - Math.log1p(-p);
  let term = logChoose + k * Math.log(p) + (n - k) * Math.log1p(-p);
  let sum = term;
  for (let i = k; i < n; i++) {
    term += Math.log((n - i) / (i + 1)) + logOdds;
    const largest = Math.max(sum, term);
    sum = largest + Math.log1p(Math.exp(Math.min(sum, term) - largest));
  }
  return Math.min(0, sum);
}

/**
 * One-sided Clopper-Pearson lower accuracy bound. Zero observations mean unknown.
 * Its coverage assumes independent, identically distributed Bernoulli outcomes and
 * one predetermined evaluation; repeated looks require a different procedure.
 */
export function exactBinomialLowerBound(
  correct: number,
  total: number,
  confidence = 0.95,
): number | null {
  checkCounts(correct, total);
  checkConfidence(confidence);
  if (total === 0) return null;
  if (correct === 0) return 0;
  const logAlpha = Math.log1p(-confidence);
  if (correct === total) return Math.exp(logAlpha / total);
  let low = 0;
  // At low confidence the lower bound can exceed the observed proportion.
  let high = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const mid = (low + high) / 2;
    if (mid === low || mid === high) break;
    if (logBinomialTail(total, correct, mid) < logAlpha) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Assess a frozen policy on independent representative would-act outcomes. Fit the
 * rubric, model, combiner and threshold before collecting this validation sample.
 * The caller supplies action correctness, never correctness of an opposite prediction.
 * Related sessions and retries are not independent observations.
 *
 * "Supported" is conditional on those assumptions and one planned look; this helper
 * cannot verify their provenance and never changes a gate. "Below-target" describes
 * the observed point estimate, not proof that population accuracy is below the target.
 */
export function validateFixedPolicy(
  actedCorrectness: readonly boolean[],
  { targetAccuracy, confidence = 0.95 }: ValidationOptions,
): FixedPolicyEvidence {
  if (!Number.isFinite(targetAccuracy) || targetAccuracy <= 0 || targetAccuracy > 1) {
    throw new RangeError("targetAccuracy must be finite, greater than 0 and at most 1");
  }
  checkConfidence(confidence);
  let correct = 0;
  for (const outcome of actedCorrectness) {
    if (typeof outcome !== "boolean")
      throw new TypeError("acted correctness must contain booleans");
    if (outcome) correct++;
  }
  const acts = actedCorrectness.length;
  const accuracy = acts === 0 ? null : correct / acts;
  const lowerBound = exactBinomialLowerBound(correct, acts, confidence);
  const status =
    lowerBound !== null && lowerBound >= targetAccuracy
      ? "supported"
      : accuracy !== null && accuracy < targetAccuracy
        ? "below-target"
        : "insufficient-evidence";
  return {
    acts,
    wrongActs: acts - correct,
    accuracy,
    lowerBound,
    targetAccuracy,
    confidence,
    status,
  };
}

export type EvidenceMethodId =
  | "point20"
  | "point200"
  | "exact200"
  | "repeatedExact200"
  | "exact2000"
  | "repeatedExact2000";

export interface EvidenceMethod {
  id: EvidenceMethodId;
  label: string;
  rule: "point-estimate" | "exact-lower-bound";
  maxLabels: number;
  /** Predetermined sample counts at which to check; repeated checks are uncorrected. */
  looks: readonly number[];
}

export interface EvidenceExperiment {
  seed: number;
  trials: number;
  targetAccuracy: number;
  confidence: number;
  methods: EvidenceMethod[];
  rows: {
    trueAccuracy: number;
    results: {
      methodId: EvidenceMethodId;
      acceptances: number;
      acceptanceRate: number;
      meanLabelsEvaluated: number;
    }[];
  }[];
}

function methods(): EvidenceMethod[] {
  const everyTwenty = (max: number) => Array.from({ length: max / 20 }, (_, i) => (i + 1) * 20);
  return [
    {
      id: "point20",
      label: "Point estimate at 20",
      rule: "point-estimate",
      maxLabels: 20,
      looks: [20],
    },
    {
      id: "point200",
      label: "Point estimate at 200",
      rule: "point-estimate",
      maxLabels: 200,
      looks: [200],
    },
    {
      id: "exact200",
      label: "Exact bound at 200",
      rule: "exact-lower-bound",
      maxLabels: 200,
      looks: [200],
    },
    {
      id: "repeatedExact200",
      label: "Uncorrected exact bound every 20, through 200",
      rule: "exact-lower-bound",
      maxLabels: 200,
      looks: everyTwenty(200),
    },
    {
      id: "exact2000",
      label: "Exact bound at 2,000",
      rule: "exact-lower-bound",
      maxLabels: 2000,
      looks: [2000],
    },
    {
      id: "repeatedExact2000",
      label: "Uncorrected exact bound every 20, through 2,000",
      rule: "exact-lower-bound",
      maxLabels: 2000,
      looks: everyTwenty(2000),
    },
  ];
}

/** Cache inversion at the target, so simulations never bisect a bound for each trial. */
function acceptanceCutoffs(
  maxLabels: number,
  targetAccuracy: number,
  confidence: number,
): number[] {
  const cutoffs = [Number.POSITIVE_INFINITY];
  const logAlpha = Math.log1p(-confidence);
  let required = 1;
  for (let n = 1; n <= maxLabels; n++) {
    while (required <= n && logBinomialTail(n, required, targetAccuracy) > logAlpha) required++;
    cutoffs.push(required);
  }
  return cutoffs;
}

/**
 * Synthetic IID trials of a fixed would-act population, not a model evaluation.
 * Each method sees prefixes of the SAME 2,000 outcomes per trial. The point estimate
 * and exact bound at 200 share a label budget; so do the single and repeated looks
 * at 2,000. Repeating a check does not create any new independent labels.
 *
 * The repeated-look methods deliberately violate fixed-time inference assumptions.
 * At the target, acceptance is a boundary rejection rate, not a false promotion of
 * a below-target policy. Below the target, acceptance is a false promotion.
 */
export function runEvidenceExperiment({
  seed = 20261020,
  trials = 3000,
}: {
  seed?: number;
  trials?: number;
} = {}): EvidenceExperiment {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("seed must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 100_000) {
    throw new RangeError("trials must be an integer from 1 to 100,000");
  }
  const targetAccuracy = 0.98;
  const confidence = 0.95;
  const maxLabels = 2000;
  const configurations = methods();
  const cutoffs = acceptanceCutoffs(maxLabels, targetAccuracy, confidence);
  const rand = rng(seed);
  const rows = [0.9, 0.95, 0.97, 0.98, 0.99, 0.995].map((trueAccuracy) => {
    const totals = configurations.map(() => ({ accepted: 0, labels: 0 }));
    const correctThrough = new Uint32Array(maxLabels + 1);
    for (let trial = 0; trial < trials; trial++) {
      let correct = 0;
      for (let n = 1; n <= maxLabels; n++) {
        if (rand() < trueAccuracy) correct++;
        correctThrough[n] = correct;
      }
      for (let index = 0; index < configurations.length; index++) {
        const method = configurations[index];
        const total = totals[index];
        if (!method || !total) throw new Error("missing evidence method");
        let labels = method.maxLabels;
        for (const n of method.looks) {
          const observed = correctThrough[n] ?? 0;
          const passes =
            method.rule === "point-estimate"
              ? observed / n >= targetAccuracy
              : observed >= (cutoffs[n] ?? Number.POSITIVE_INFINITY);
          if (passes) {
            total.accepted++;
            labels = n;
            break;
          }
        }
        total.labels += labels;
      }
    }
    return {
      trueAccuracy,
      results: configurations.map((method, index) => {
        const total = totals[index];
        if (!total) throw new Error("missing evidence total");
        return {
          methodId: method.id,
          acceptances: total.accepted,
          acceptanceRate: total.accepted / trials,
          meanLabelsEvaluated: total.labels / trials,
        };
      }),
    };
  });
  return { seed, trials, targetAccuracy, confidence, methods: configurations, rows };
}
