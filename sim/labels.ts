/**
 * Label noise against the planned acceptance test, exact. The zero-error plan passes only when
 * none of its acts is labelled wrong, so with each act labelled wrong independently with
 * probability q it passes with probability (1 - q)^n, and nothing needs simulating. The rates
 * are those of the foundations review's label-noise section: a reviewer marks a right act wrong
 * with probability e1 and a wrong act right with probability e2; under confirm-wrong (review
 * protocol P1, `src/ledger/labels.ts`) a second blind reviewer reviews every "wrong" and a third
 * breaks a tie, with every reviewer erring independently at the same rates.
 */
import { requiredActs } from "../src/acceptance.ts";
import { heading, note, pct, table } from "./lib.ts";

const PROMISE = 0.98;
const GATES = [1, 0.995, 0.99] as const;
const FALSE_WRONG = [0, 0.005, 0.0125, 0.02] as const;
const MISS = 0.1;

/** The chance the zero-error plan of `n` acts passes when each act reads wrong with chance `q`. */
const passes = (n: number, q: number): number => Math.exp(n * Math.log1p(-q));

/**
 * One gate and one reviewer, read once and under confirm-wrong. A right act ends wrong when the
 * first and second reviewers both say wrong, or they split and the third says wrong:
 * e1·(1 - (1 - e1)²). A wrong act ends right when the first says right, or the first says wrong
 * and the next two say right: e2 + (1 - e2)·e2². A first "wrong" always takes a second review,
 * and a split takes a third.
 */
function protocol(theta: number, e1: number, e2: number, n: number) {
  const eps = 1 - theta;
  const once = eps * (1 - e2) + theta * e1;
  const e1c = e1 * (1 - (1 - e1) ** 2);
  const e2c = e2 + (1 - e2) * e2 ** 2;
  const confirmed = eps * (1 - e2c) + theta * e1c;
  const split = theta * e1 * (1 - e1) + eps * (1 - e2) * e2;
  return {
    once: passes(n, once),
    confirmed: passes(n, confirmed),
    falseWrong: e1c,
    extra: n * (once + split),
  };
}

export function labelTables(): void {
  const n = requiredActs(PROMISE);
  heading(
    `16. Label noise at a ${pct(PROMISE, 0)} promise: one review per act, or every "wrong" confirmed`,
  );
  note(
    `Exact, no simulation. The ${n}-act zero-error plan passes only if no act is labelled wrong. A reviewer marks a right act wrong with probability e1 and a wrong act right with probability ${pct(MISS, 0)}. ` +
      `Under confirm-wrong a second blind reviewer reviews every "wrong" label and a third breaks a tie, so a right act ends wrong with probability e1·(1 − (1 − e1)²), the false-wrong rate below, and a wrong act ends right with probability e2 + (1 − e2)·e2² (${pct(MISS + (1 - MISS) * MISS ** 2, 1)}). Extra reviews are the second and third reviews per ${n} acts.`,
  );
  const rows = GATES.flatMap((theta) =>
    FALSE_WRONG.map((e1) => {
      const p = protocol(theta, e1, MISS, n);
      return [
        pct(theta, 1),
        pct(e1, 2),
        pct(p.once, 1),
        pct(p.confirmed, 1),
        pct(p.falseWrong, 3),
        p.extra.toFixed(1),
      ];
    }),
  );
  table(
    [
      "acts right",
      "reviewer marks a right act wrong",
      `P(pass ${n}), one review`,
      `P(pass ${n}), confirm-wrong`,
      "false-wrong rate, confirm-wrong",
      `extra reviews per ${n} acts`,
    ],
    rows,
  );
  note(
    `Reading it: a reviewer's false "wrong" spends the plan's whole error budget by itself, so a perfect gate passes only ${pct(protocol(1, 0.0125, MISS, n).once, 1)} of the time at 1.25% and ${pct(protocol(1, 0.02, MISS, n).once, 1)} at 2%, while confirming every "wrong" restores most of the plan's power for a few extra reviews per ${n} acts. ` +
      `It assumes reviewers err independently at the same rates: a blind spot they share with each other or with the model (acts that look routine and are not) defeats a second review, and two misses can now overturn a true "wrong", which only seeded known errors can measure.`,
  );
}
