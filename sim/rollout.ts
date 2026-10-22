/**
 * Rollout under simulation: how often each promotion rule lets a gate act when it should not,
 * how long a good gate waits, and how fast blind audits catch drift. Acts are independent
 * Bernoulli trials with a known accuracy, so every rate here can be checked against the truth.
 * The exact test runs through `evaluateAcceptance` itself; the earlier rule is reproduced below
 * as it stood in the 0.2 tree, for comparison only.
 */
import { evaluateAcceptance, resolvePlan } from "../src/acceptance.ts";
import type { DecisionRecord } from "../src/ledger/ledger.ts";
import { type Rand, rng } from "../src/math.ts";
import { heading, note, pct, table } from "./lib.ts";

const PROMISE = 0.98;
const TRIALS = 2_000;
const HORIZON_ROWS = 2_000;
const ACT_SHARE = 0.5;
const ACCURACIES = [0.95, 0.97, 0.98, 0.99, 0.995, 0.999] as const;

const template: DecisionRecord = {
  id: "",
  at: "",
  gateId: "sim",
  requestId: "",
  questionId: "q",
  kind: "judge",
  prompt: "ok?",
  questionHash: "0000000000000000",
  stateHash: "",
  trustedHash: "",
  untrusted: [],
  oracle: "sim",
  strategy: "single",
  verdict: { kind: "judge", questionId: "q", pYes: 0.99, confidence: 0.99 },
  go: 0.99,
  confidence: 0.99,
  agreement: 1,
  soft: "act",
  action: "review",
  mode: "shadow",
  cost: 0,
  latencyMs: 0,
  failedOpen: false,
  tags: [],
};

/** One labelled shadow row: an act with probability ACT_SHARE, right with probability p. */
interface SimRow {
  readonly act: boolean;
  readonly right: boolean;
}

function stream(p: number, rand: Rand): SimRow[] {
  return Array.from({ length: HORIZON_ROWS }, () => ({
    act: rand() < ACT_SHARE,
    right: rand() < p,
  }));
}

/**
 * The 0.2 rule: after every label, read the last 200 shadow rows; promote once there are 100 of
 * them, 20 are acts, and the acts' observed accuracy reaches the promise. Returns the number of
 * acts seen when it promoted, or undefined.
 */
function pointEstimatePromotion(rows: readonly SimRow[]): number | undefined {
  let acts = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.act) acts++;
    const window = rows.slice(Math.max(0, i - 199), i + 1);
    const acted = window.filter((r) => r.act);
    if (window.length < 100 || acted.length < 20) continue;
    if (acted.filter((r) => r.right).length / acted.length >= PROMISE) return acts;
  }
  return undefined;
}

/** The planned exact test, through the engine's own acceptance code. */
function exactPromotion(rows: readonly SimRow[], maxErrors: number): number | undefined {
  const plan = resolvePlan({ target: PROMISE, maxErrors });
  const records = rows
    .filter((r) => r.act)
    .slice(0, plan.sampleSize)
    .map((r, i) => ({
      ...template,
      id: `r${i}`,
      stateHash: `s${i}`,
      outcome: { at: "", correct: r.right, truth: r.right },
    }));
  return evaluateAcceptance(records, plan).status === "accepted" ? plan.sampleSize : undefined;
}

function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function promotionCell(results: readonly (number | undefined)[]): string[] {
  const promoted = results.filter((x): x is number => x !== undefined);
  const m = median(promoted);
  return [pct(promoted.length / results.length), m === undefined ? "-" : String(m)];
}

/**
 * The demotion rule both promotion rules share: once 30 audited acts sit in the last 200 audits,
 * an observed accuracy below the promise demotes. Returns the acts taken until demotion.
 */
function actsToDemotion(
  p: number,
  auditRate: number,
  rand: Rand,
  horizon = 2_000,
): number | undefined {
  if (auditRate === 0) return undefined;
  const audits: boolean[] = [];
  for (let act = 1; act <= horizon; act++) {
    const right = rand() < p;
    if (rand() >= auditRate) continue;
    audits.push(right);
    const window = audits.slice(-200);
    if (window.length >= 30 && window.filter(Boolean).length / window.length < PROMISE) return act;
  }
  return undefined;
}

export function rolloutTables(): void {
  heading(
    `7. Promotion at a ${pct(PROMISE, 0)} promise: a point estimate at every look, or one planned exact test`,
  );
  const zero = resolvePlan({ target: PROMISE });
  const two = resolvePlan({ target: PROMISE, maxErrors: 2 });
  note(
    `${TRIALS} seeded runs per row of up to ${HORIZON_ROWS} labelled shadow rows, half of them acts, each act right with probability p. ` +
      `The point-estimate rule (the 0.2 Rollout) reads the last 200 rows after every label and promotes once 20 acts reach the promise. ` +
      `The exact test evaluates the first ${zero.sampleSize} acts once and needs all of them right, or the first ${two.sampleSize} with at most two wrong, ` +
      `so that an exact one-sided 95% bound reaches ${pct(PROMISE, 0)}. A promotion at p at or below the promise is a false promotion.`,
  );
  const rows = ACCURACIES.map((p, k) => {
    const rand = rng(7_000 + k);
    const point: (number | undefined)[] = [];
    const exact0: (number | undefined)[] = [];
    const exact2: (number | undefined)[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const s = stream(p, rand);
      point.push(pointEstimatePromotion(s));
      exact0.push(exactPromotion(s, 0));
      exact2.push(exactPromotion(s, 2));
    }
    return [pct(p, 1), ...promotionCell(point), ...promotionCell(exact0), ...promotionCell(exact2)];
  });
  table(
    [
      "true act accuracy",
      "point estimate: promoted",
      "acts at promotion",
      `exact, 0 wrong of ${zero.sampleSize}: promoted`,
      "acts",
      `exact, at most 2 of ${two.sampleSize}: promoted`,
      "acts",
    ],
    rows,
  );
  note(
    "Reading it: the point estimate promotes gates that are worse than their promise because it keeps looking until a lucky window clears the bar. The exact test holds false promotions at or below 5% by construction, and pays for it in power: a gate barely better than its promise often fails a zero-error plan, and a plan that tolerates a few errors buys power back with a larger sample.",
  );

  heading(`8. Demotion: blind audits after promotion, against the same ${pct(PROMISE, 0)} promise`);
  note(
    `${TRIALS} seeded runs of up to 2,000 enforced acts per cell. Once 30 audited acts sit in the window, an observed accuracy below the promise demotes. Without audits nothing can demote a gate. Accuracies at or above the promise show the false-demotion rate; those below it show detection.`,
  );
  const demotion = [0.999, 0.99, 0.98, 0.95, 0.9].map((p, k) => [
    pct(p, 1),
    ...[0, 0.05, 0.1, 0.25].flatMap((rate, j) => {
      const rand = rng(9_000 + 10 * k + j);
      const results = Array.from({ length: TRIALS }, () => actsToDemotion(p, rate, rand));
      return promotionCell(results);
    }),
  ]);
  table(
    [
      "accuracy after promotion",
      "no audits: demoted",
      "acts",
      "5% audits: demoted",
      "acts",
      "10% audits: demoted",
      "acts",
      "25% audits: demoted",
      "acts",
    ],
    demotion,
  );
  note(
    "Reading it: the audit rule errs toward caution. Real drift is caught, faster with more audits, but at 30 audits a single error already reads below 98%, so a healthy gate is demoted often too: false demotions cost review work, not safety. A sequential test with an explicit false-alarm rate would trade some of that caution for fewer false alarms; it is not built.",
  );
}
