/**
 * Repro T3: two digest helpers lose or garble exactly the facts a policy turns on.
 *
 * 1. `compare` prints the raw floating-point difference, so ordinary cents come out as
 *    "4.200000000000003 USD". 89 of 219 digested approval states in this track carry one.
 * 2. `relativeTime` rounds to the nearest whole unit, so a 60-day window cannot be read from
 *    it (59 and 61 days are both "2 months ago"), nor a 30-day one (25 and 29 days are both
 *    "4 weeks ago"; 31 and 44 both "1 month ago"), nor a 90-day count (85 days is "3 months ago").
 *
 *   bun experiments/e2e/t3-triage/repro/digest-precision.ts
 */
import { compare, relativeTime } from "../../../../src/recipes/digest.ts";

console.log(compare(70.8, 75, { actual: "cost per attendee", limit: "meal limit", unit: "USD" }));
console.log(
  compare(129.99, 119.99, { actual: "refund requested", limit: "price paid", unit: "USD" }),
);
console.log(compare(7.08, 6, { actual: "flight time", limit: "threshold", unit: "hours" }));

const request = Date.parse("2026-10-20T00:00:00Z");
const ago = (days: number) => relativeTime(request - days * 86_400_000, request);
for (const [window, days] of [
  [30, [25, 29, 30, 31, 44]],
  [60, [45, 59, 60, 61, 74]],
  [90, [76, 85, 89, 91, 104]],
] as const) {
  console.log(`window ${window} days: ${days.map((d) => `${d} -> "${ago(d)}"`).join(", ")}`);
}
console.log(`
Expected: a digest a policy can be read from: "by 4.2 USD"; a relative date that keeps the side
of a policy window ("59 days ago" vs "61 days ago"), or documentation that relativeTime is for
recency, not for windows, and that windows take daysBetween + compare.`);
