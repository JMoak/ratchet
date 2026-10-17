import { clamp, logit, normalize, type Rand, randBeta, rng, sigmoid } from "../math.ts";
import {
  judgeVerdictFrom,
  neutralVerdict,
  pickVerdictFrom,
  rateVerdictFrom,
} from "../questions.ts";
import type { Decision, Oracle, Question, Verdict } from "../types.ts";
import { nowIso } from "./oracle.ts";

/**
 * The ground truth for one question about one state. A truth function returns this so the
 * simulated oracle knows what "correct" means. Fields are keyed by question kind.
 */
export interface Truth {
  readonly pick?: string;
  readonly rate?: string;
  readonly judge?: boolean;
}

export type TruthFn = (state: string, question: Question) => Truth | undefined;

export interface SimConfig {
  /** Probability that one answer is correct. The headline "80%" lives here. */
  readonly accuracy: number;
  /**
   * Pairwise correlation of correctness between repeated calls on the same item, 0..1.
   * 0 means every call is an independent draw; 1 means every call repeats the first.
   * Real decision models sit somewhere in between, and it matters enormously.
   */
  readonly correlation?: number;
  /**
   * Calibration temperature applied to reported confidence: 1 is perfectly calibrated,
   * above 1 is overconfident, below 1 is underconfident.
   */
  readonly temperature?: number;
  /** Beta concentration of per-item confidence around the accuracy. Higher is tighter. */
  readonly concentration?: number;
  /** Extra mass pushed toward the first option in pick questions, 0..1. Jev shows this. */
  readonly positionBias?: number;
  readonly seed?: number;
  readonly latencyMs?: number;
  readonly costPerQuestion?: number;
  readonly id?: string;
}

interface Draw {
  readonly correct: boolean;
  readonly confidence: number;
  readonly wrongPick: number;
}

/**
 * A synthetic oracle with known accuracy, known calibration and known error correlation.
 * It exists so the compounding strategies can be tested against the truth, and so the
 * simulations can show exactly when compounding works and when it does not.
 *
 * Calibration construction: per answer draw c in (0.5, 1) from a Beta scaled so that
 * E[c] = accuracy, then make the answer correct with probability c. Among answers reporting
 * confidence c, a fraction c are correct, so the oracle is calibrated by construction before
 * the temperature is applied.
 */
export class SimOracle implements Oracle {
  readonly id: string;
  readonly config: Required<SimConfig>;
  private readonly rand: Rand;
  private readonly common = new Map<string, Draw>();
  calls = 0;

  constructor(
    config: SimConfig,
    private readonly truthOf: TruthFn,
  ) {
    const accuracy = clamp(config.accuracy, 0.01, 0.999);
    this.config = {
      accuracy,
      correlation: clamp(config.correlation ?? 0, 0, 1),
      temperature: config.temperature ?? 1,
      concentration: config.concentration ?? 3,
      positionBias: clamp(config.positionBias ?? 0, 0, 1),
      seed: config.seed ?? 1,
      latencyMs: config.latencyMs ?? 150,
      costPerQuestion: config.costPerQuestion ?? 0.00002,
      id: config.id ?? "sim",
    };
    this.id = this.config.id;
    this.rand = rng(this.config.seed);
  }

  /** Forget shared per-item draws, so the next calls are fresh items. */
  resetItems(): void {
    this.common.clear();
  }

  private freshDraw(): Draw {
    const { accuracy, concentration } = this.config;
    // E[c] = accuracy where c = 0.5 + 0.5 * B, so E[B] = 2 * accuracy - 1.
    const m = clamp(2 * accuracy - 1, 0.02, 0.98);
    const b = randBeta(m * concentration, (1 - m) * concentration, this.rand);
    const confidence = 0.5 + 0.5 * b;
    return { correct: this.rand() < confidence, confidence, wrongPick: this.rand() };
  }

  private drawFor(state: string, q: Question): Draw {
    const key = `${q.id}\u0000${state}`;
    const rho = this.config.correlation;
    let shared = this.common.get(key);
    if (!shared) {
      shared = this.freshDraw();
      this.common.set(key, shared);
    }
    // Mixing with probability sqrt(rho) gives pairwise correlation rho between calls.
    if (rho > 0 && this.rand() < Math.sqrt(rho)) return shared;
    return this.freshDraw();
  }

  private reported(confidence: number): number {
    const t = this.config.temperature;
    return t === 1 ? confidence : sigmoid(t * logit(confidence));
  }

  private answer(state: string, q: Question): Verdict {
    const truth = this.truthOf(state, q);
    if (!truth) return neutralVerdict(q);
    const d = this.drawFor(state, q);
    const c = this.reported(d.confidence);
    switch (q.kind) {
      case "judge": {
        if (truth.judge === undefined) return neutralVerdict(q);
        const pYes = truth.judge === d.correct ? c : 1 - c;
        return judgeVerdictFrom(q, pYes);
      }
      case "pick": {
        const t = q.options.indexOf(truth.pick ?? "");
        if (t < 0) return neutralVerdict(q);
        const n = q.options.length;
        let chosen = t;
        if (!d.correct) {
          // Choose the wrong option by name, not position, so a shared (correlated) draw
          // lands on the same wrong answer however the options are ordered.
          const others = q.options.filter((o) => o !== truth.pick).sort();
          const wrong = others[Math.floor(d.wrongPick * others.length)] ?? others[0];
          chosen = q.options.indexOf(wrong as string);
        }
        const rest = (1 - c) / (n - 1);
        let probs = q.options.map((_, i) => (i === chosen ? c : rest));
        const bias = this.config.positionBias;
        if (bias > 0) probs = normalize(probs.map((p, i) => (1 - bias) * p + (i === 0 ? bias : 0)));
        return pickVerdictFrom(q, probs);
      }
      case "rate": {
        const t = q.levels.indexOf(truth.rate ?? "");
        if (t < 0) return neutralVerdict(q);
        const n = q.levels.length;
        let chosen = t;
        if (!d.correct) {
          // Rubric errors are mostly off by one.
          const neighbours = [t - 1, t + 1].filter((i) => i >= 0 && i < n);
          if (d.wrongPick < 0.8 && neighbours.length > 0) {
            chosen = neighbours[Math.floor((d.wrongPick / 0.8) * neighbours.length)] ?? t;
          } else {
            const k = Math.floor(this.rand() * (n - 1));
            chosen = k >= t ? k + 1 : k;
          }
        }
        const rest = (1 - c) / (n - 1);
        const probs = q.levels.map((_, i) => (i === chosen ? c : rest));
        return rateVerdictFrom(q, probs);
      }
    }
  }

  async decide(state: string, questions: readonly Question[]): Promise<Decision[]> {
    this.calls++;
    const at = nowIso();
    return questions.map((q) => ({
      verdict: this.answer(state, q),
      oracle: this.id,
      model: `sim-p${this.config.accuracy}-rho${this.config.correlation}`,
      latencyMs: this.config.latencyMs,
      cost: this.config.costPerQuestion,
      at,
    }));
  }
}

/** Convenience: a truth table keyed by state string, for tests and small demos. */
export function truthTable(table: Readonly<Record<string, Truth>>): TruthFn {
  return (state) => table[state];
}
