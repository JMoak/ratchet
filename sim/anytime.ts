/**
 * Anytime-valid rollout, measured: promotion by a betting e-process against the planned fixed
 * samples, demotion by a Shiryaev-Roberts e-detector against today's window rule, and the wrong
 * acts the shadow, enforce, audit loop lets through. Promotion and outgoing quality are exact
 * (dynamic programming and closed forms); demotion is seeded Monte Carlo over audit outcomes,
 * with the audit draw itself integrated out exactly. Everything runs through `src/anytime.ts`
 * except the window rule, which is reproduced below from `Rollout.watch` for comparison.
 */
import { requiredActs } from "../src/acceptance.ts";
import {
  type DetectorSpec,
  detectorStatistic,
  exactCrossingProbability,
  outgoingQualityLimit,
  startDetector,
  stepDetector,
  worstOutgoingQuality,
} from "../src/anytime.ts";
import { logGamma, type Rand, rng } from "../src/math.ts";
import { heading, note, pct, table } from "./lib.ts";

const PROMISE = 0.98;
const ALPHA = 0.05;
const WORTH_KEEPING = PROMISE + (1 - PROMISE) / 2;
const BETA = 0.1;
const ACCURACIES = [0.98, 0.985, 0.99, 0.995, 0.999] as const;
const CAPS = [313, 600, 1000] as const;

/**
 * A fixed plan of n acts allowing k wrong, stopped at the (k + 1)-th wrong act, which already
 * decides it: the exact chance it passes and the expected acts it reads.
 */
function fixedPlan(n: number, k: number, p: number): { promote: number; meanActs: number } {
  const mass = new Float64Array(k + 1);
  mass[0] = 1;
  let meanActs = 0;
  for (let t = 1; t <= n; t++) {
    meanActs += (mass[k] as number) * (1 - p) * t;
    for (let f = k; f >= 1; f--)
      mass[f] = (mass[f] as number) * p + (mass[f - 1] as number) * (1 - p);
    mass[0] = (mass[0] as number) * p;
  }
  const promote = mass.reduce((a, b) => a + b, 0);
  return { promote, meanActs: meanActs + promote * n };
}

function promotionTable(): void {
  const zero = requiredActs(PROMISE, 1 - ALPHA, 0);
  const two = requiredActs(PROMISE, 1 - ALPHA, 2);
  heading(
    `9. Promotion at a ${pct(PROMISE, 0)} promise: planned fixed samples against an e-process read after every act`,
  );
  note(
    `Exact, no simulation: each act is right with probability p, independently, and a promotion at ${pct(PROMISE, 1)} is a false one (alpha ${ALPHA}). ` +
      `The fixed plans stop at the wrong act that fails them; the e-process (the log-grid mixture, with a reverse test that retires at 1/${BETA} against a ${pct(WORTH_KEEPING, 0)} gate, and curtailment) stops at a promotion, a retirement, or once its cap can no longer be reached.`,
  );
  const rows = ACCURACIES.map((p) => {
    const cells = [fixedPlan(zero, 0, p), fixedPlan(two, 2, p)].flatMap((r) => [
      pct(r.promote, 2),
      r.meanActs.toFixed(0),
    ]);
    for (const cap of CAPS) {
      const r = exactCrossingProbability(p, PROMISE, ALPHA, cap, {
        futility: { worthKeeping: WORTH_KEEPING, beta: BETA },
      });
      cells.push(pct(r.promote, 2), r.meanActs.toFixed(0));
    }
    return [pct(p, 1), ...cells];
  });
  table(
    [
      "true act accuracy",
      `fixed, 0 wrong of ${zero}: promoted`,
      "mean acts",
      `fixed, at most 2 wrong of ${two}: promoted`,
      "mean acts",
      ...CAPS.flatMap((cap) => [
        `e-process, cap ${cap.toLocaleString("en")}: promoted`,
        "mean acts",
      ]),
    ],
    rows,
  );
}

const HEALTHY = 0.99;
const RATES = [0.05, 0.1, 0.2] as const;
const HORIZONS = [1_000, 10_000] as const;
const DROPS = [0.95, 0.9, 0.8] as const;
const RUNS = 10_000;
const WINDOW = 200;
const MIN_AUDITS = 30;
/**
 * Audits simulated per healthy run. 10,000 acts at a rate of 0.2 hold 2,000 audits on average
 * with a standard deviation of 40, so an alarm after audit 2,400 falls inside the horizon with
 * probability below 1e-20; it is counted as none.
 */
const AUDIT_CAP = 2_400;
const SR: DetectorSpec = { promise: PROMISE, threshold: 1_000 };
const SR_LOW = 300;

interface Alarms {
  readonly window: number;
  readonly sr1000: number;
  readonly sr300: number;
}

/**
 * The audit at which each detector first demotes, on one stream of audit outcomes each wrong
 * with probability `errorRate`, or Infinity if none does by `cap`. The window rule is
 * `Rollout.watch` as it stands: the last 200 audited acts, at least 30 of them, and a demotion
 * once their accuracy reads below the promise. The Shiryaev-Roberts statistics do not depend on
 * the threshold, so one detector gives the first audit at A = 300 and the alarm at A = 1000.
 */
function alarmAudits(errorRate: number, cap: number, rand: Rand): Alarms {
  const ring = new Uint8Array(WINDOW);
  let wrongInWindow = 0;
  let window = Number.POSITIVE_INFINITY;
  let sr300 = Number.POSITIVE_INFINITY;
  let sr1000 = Number.POSITIVE_INFINITY;
  let state = startDetector(SR);
  for (let audit = 1; audit <= cap; audit++) {
    const wrong = rand() < errorRate;
    if (window === Number.POSITIVE_INFINITY) {
      const slot = (audit - 1) % WINDOW;
      wrongInWindow += (wrong ? 1 : 0) - (ring[slot] as number);
      ring[slot] = wrong ? 1 : 0;
      const n = Math.min(audit, WINDOW);
      if (n >= MIN_AUDITS && (n - wrongInWindow) / n < PROMISE) window = audit;
    }
    if (sr1000 === Number.POSITIVE_INFINITY) {
      state = stepDetector(SR, state, wrong);
      if (sr300 === Number.POSITIVE_INFINITY && detectorStatistic(state) >= SR_LOW) sr300 = audit;
      if (state.alarmed) sr1000 = audit;
    }
    if (window !== Number.POSITIVE_INFINITY && sr1000 !== Number.POSITIVE_INFINITY) break;
  }
  return { window, sr1000, sr300 };
}

/** P(Binomial(n, r) ≥ k) for every k from 0 to n + 1, from the log probabilities. */
function binomialTails(n: number, r: number): Float64Array {
  const tails = new Float64Array(n + 2);
  const base = logGamma(n + 1);
  for (let k = n; k >= 0; k--) {
    const log =
      base - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(r) + (n - k) * Math.log1p(-r);
    tails[k] = (tails[k + 1] as number) + Math.exp(log);
  }
  return tails;
}

const DETECTORS = [
  ["window rule (last 200, at least 30)", "window"],
  ["Shiryaev-Roberts mixture, A = 1,000", "sr1000"],
  ["Shiryaev-Roberts mixture, A = 300", "sr300"],
] as const;

function demotionTable(): void {
  heading(
    `10. Demotion at a ${pct(PROMISE, 0)} promise: the window rule against a Shiryaev-Roberts e-detector`,
  );
  note(
    `${RUNS.toLocaleString("en")} seeded streams of audit outcomes per accuracy (standard error about half a point at 30%), each act audited independently at the given rate, labels immediate; the detectors bet on error rates of 4%, 8% and 16%. ` +
      "A healthy gate's chance of demotion within a horizon is averaged exactly over how many audits the horizon holds, and wrong acts executed before a demotion after N audits are (1 - p)(1 - r)/r × N on average, since the audit draw is independent of correctness (Wald's identity); the drop happens at the first enforced act.",
  );
  const healthyRand = rng(11_000);
  const healthy = Array.from({ length: RUNS }, () =>
    alarmAudits(1 - HEALTHY, AUDIT_CAP, healthyRand),
  );
  const tails = new Map<string, Float64Array>(
    RATES.flatMap((r) => HORIZONS.map((n) => [`${r}:${n}`, binomialTails(n, r)] as const)),
  );
  const demotedWithin = (key: keyof Alarms, r: number, n: number): number => {
    const tail = tails.get(`${r}:${n}`) as Float64Array;
    const total = healthy.reduce((sum, a) => sum + (a[key] <= n ? (tail[a[key]] as number) : 0), 0);
    return total / RUNS;
  };
  const meanAudits = DROPS.map((p, k) => {
    const rand = rng(11_001 + k);
    const runs = Array.from({ length: RUNS }, () => alarmAudits(1 - p, 1_000_000, rand));
    const mean = (key: keyof Alarms) => runs.reduce((sum, a) => sum + a[key], 0) / RUNS;
    return { p, window: mean("window"), sr1000: mean("sr1000"), sr300: mean("sr300") };
  });
  const rows = DETECTORS.flatMap(([name, key]) =>
    RATES.map((r) => [
      name,
      String(r),
      ...HORIZONS.map((n) => pct(demotedWithin(key, r, n), 1)),
      ...meanAudits.map((m) => ((((1 - m.p) * (1 - r)) / r) * m[key]).toFixed(1)),
    ]),
  );
  table(
    [
      "detector",
      "audit rate",
      `healthy ${pct(HEALTHY, 0)} gate: demoted within 1,000 acts`,
      "within 10,000 acts",
      ...DROPS.map((p, k) =>
        k === 0
          ? `wrong acts executed before demotion, drop to ${pct(p, 0)}`
          : `drop to ${pct(p, 0)}`,
      ),
    ],
    rows,
  );
}

const CLEARANCES = [59, 149, 313] as const;
const AUDIT_FRACTIONS = [0.05, 0.1, 0.2, 0.5] as const;

function outgoingTable(): void {
  heading("11. Outgoing quality of the shadow, enforce, audit loop (Dodge's CSP-1)");
  note(
    "Closed form: shadow until a clearance of consecutive right acts, then enforce with a fraction of acts audited, and back to shadow at the first audited error; outgoing quality is wrong acts executed per act-eligible decision, not the error rate of the acts that run, which stays at p. " +
      "The limit is the worst case over stationary error rates p, assuming correct audit labels known before the next act; the worst case holds against any error sequence that cannot see the audit draw.",
  );
  const rows = CLEARANCES.flatMap((clearance) =>
    AUDIT_FRACTIONS.map((f) => {
      const { limit, at } = outgoingQualityLimit(clearance, f);
      return [
        String(clearance),
        String(f),
        pct(limit, 3),
        pct(at, 2),
        pct(worstOutgoingQuality(clearance, f), 2),
      ];
    }),
  );
  table(["clearance", "audit rate", "outgoing quality limit", "at error rate", "worst case"], rows);
}

export function anytimeTables(): void {
  promotionTable();
  demotionTable();
  outgoingTable();
}
