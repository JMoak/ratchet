/**
 * The arithmetic under a calibration profile (`profile.ts`): per-gate confidence bins at the
 * profile's resolution, and the bar they support for a promise. Internal; the profile module is
 * the public surface.
 *
 * A bin is shown as a `ReliabilityBin` (rows, mean confidence, accuracy) but held as integers:
 * rows, right answers and confidence summed in millionths. Each float it shows is one division
 * of those integers, so it rounds back to them exactly, and two profiles of one resolution add
 * as integers do: in any order, or as one build over every row, with the same bins, bars and
 * hash.
 *
 * A bar is read on the cumulative tail, as `fitThreshold` reads one in its conservative mode:
 * the rows at or above a bin's lower edge, not the bin's own rows. So a borrowed bar and a
 * fitted bar mean the same thing ("at or above this confidence the model kept the promise"),
 * and on confidences that sit on the bins' edges they are the same number.
 */

import { clamp } from "../math.ts";
import { wilsonLower } from "./calibration.ts";
import type { ProfileBar, ProfileBin } from "./profile.ts";

const MICRO = 1e6;
/**
 * A confidence written on an edge (0.29) lands in the bin it names rather than the one below,
 * where `0.29 * 100 = 28.999999999999996` would put it.
 */
const EDGE = 1e-9;

interface Tally {
  n: number;
  right: number;
  micros: number;
}

/** Each gate's bins at one resolution, by gate id; every gate has a tally per bin, empty ones included. */
export interface Tallies {
  readonly resolution: number;
  readonly gates: Map<string, Tally[]>;
}

export const emptyTallies = (resolution: number): Tallies => ({ resolution, gates: new Map() });

/** The bin a confidence in [0, 1] falls in; the top bin holds 1 as well. */
export const binOf = (confidence: number, resolution: number): number =>
  Math.min(resolution - 1, Math.floor(confidence * resolution + EDGE));

function tallyFor(t: Tallies, gate: string, bin: number): Tally {
  let bins = t.gates.get(gate);
  if (!bins) {
    bins = Array.from({ length: t.resolution }, () => ({ n: 0, right: 0, micros: 0 }));
    t.gates.set(gate, bins);
  }
  return bins[bin] as Tally;
}

/** Count one answer of `gate`, its confidence clamped to [0, 1]. */
export function count(t: Tallies, gate: string, confidence: number, right: boolean): void {
  const c = clamp(confidence, 0, 1);
  const tally = tallyFor(t, gate, binOf(c, t.resolution));
  tally.n++;
  if (right) tally.right++;
  tally.micros += Math.round(c * MICRO);
}

/** The tallies behind `bins`, bins of one gate and edge added together. */
export function talliesOf(bins: readonly ProfileBin[], resolution: number): Tallies {
  const t = emptyTallies(resolution);
  for (const b of bins) addTo(t, b, Math.round(b.lo * resolution));
  return t;
}

function addTo(t: Tallies, b: ProfileBin, bin: number): void {
  const tally = tallyFor(t, b.gate, bin);
  tally.n += b.n;
  tally.right += Math.round(b.accuracy * b.n);
  tally.micros += Math.round(b.meanConfidence * (b.n * MICRO));
}

/** Every gate's non-empty bins, by gate id and then confidence. */
export function binsOf(t: Tallies): ProfileBin[] {
  const out: ProfileBin[] = [];
  for (const gate of [...t.gates.keys()].sort()) {
    (t.gates.get(gate) ?? []).forEach((tally, i) => {
      if (tally.n === 0) return;
      out.push({
        gate,
        lo: i / t.resolution,
        hi: (i + 1) / t.resolution,
        n: tally.n,
        meanConfidence: tally.micros / (tally.n * MICRO),
        accuracy: tally.right / tally.n,
      });
    });
  }
  return out;
}

/**
 * `bins` at `resolution` regrouped into `into` wider bins, for reading rather than for bars;
 * unchanged when `resolution` is not a multiple of `into`, since a fine bin would straddle two.
 */
export function coarsen(
  bins: readonly ProfileBin[],
  resolution: number,
  into: number,
): ProfileBin[] {
  if (resolution <= into || resolution % into !== 0) return [...bins];
  const t = emptyTallies(into);
  const per = resolution / into;
  for (const b of bins) addTo(t, b, Math.floor(Math.round(b.lo * resolution) / per));
  return binsOf(t);
}

/** Rows and right answers at or above bin `from`: the tail a bar at its lower edge acts on. */
export function above(tallies: readonly Tally[], from: number): { n: number; right: number } {
  let n = 0;
  let right = 0;
  for (let i = from; i < tallies.length; i++) {
    n += tallies[i]?.n ?? 0;
    right += tallies[i]?.right ?? 0;
  }
  return { n, right };
}

/**
 * One gate's bar: the lowest bin edge whose tail (every row at or above it) holds at least
 * `minSupport` rows and clears `target` at the lower end of a 95% Wilson interval (a one-sided
 * 97.5% bound), the bar `fitThreshold`
 * keeps with `conservative` on. An empty bin's edge is never a bar, since nothing there was seen.
 */
export function gateBar(
  tallies: readonly Tally[],
  target: number,
  minSupport: number,
): { bar: number; support: number } | undefined {
  let best: { bar: number; support: number } | undefined;
  for (let i = tallies.length - 1; i >= 0; i--) {
    if ((tallies[i]?.n ?? 0) === 0) continue;
    const { n, right } = above(tallies, i);
    if (n >= minSupport && wilsonLower(right / n, n) >= target) {
      best = { bar: i / tallies.length, support: n };
    }
  }
  return best;
}

/**
 * The cautious end across gates: the lowest bin edge (of a bin some gate has rows in) at which
 * every gate with at least `minSupport` rows in its tail there clears `target` on that tail,
 * with at least one gate that well supported; undefined when no edge holds. It is the strictest
 * donor's bar, not the average: a profile is lent to a gate none of its donors is, so the bar
 * must hold on every gate it was read from, and a gate whose questions the model is
 * confidently wrong on keeps it up. A gate with fewer rows in the tail was too rarely that sure
 * to say anything there. Searching upward means a gate that misses by a hair at one edge holds
 * the bar to the next edge where it clears, rather than leaving the promise with no bar. Every
 * bar the highest per-gate bar would give, once checked against every gate, holds here too.
 * `support` is the fewest tail rows among the gates that cleared: the thinnest evidence the
 * bar rests on.
 */
export function cautiousBar(
  t: Tallies,
  target: number,
  minSupport: number,
): ProfileBar | undefined {
  const gates = [...t.gates.values()];
  for (let i = 0; i < t.resolution; i++) {
    if (!gates.some((g) => (g[i]?.n ?? 0) > 0)) continue;
    let support: number | undefined;
    let holds = true;
    for (const tallies of gates) {
      const { n, right } = above(tallies, i);
      if (n < minSupport) continue;
      if (wilsonLower(right / n, n) < target) {
        holds = false;
        break;
      }
      support = support === undefined ? n : Math.min(support, n);
    }
    if (holds && support !== undefined) return { target, bar: i / t.resolution, support };
  }
  return undefined;
}
