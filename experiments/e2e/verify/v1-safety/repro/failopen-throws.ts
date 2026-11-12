/**
 * V1 repro (T4-01 residual, low): `failOpen` can still throw, so the ask throws with no ledger
 * row and its (possibly billed) cost is never recorded:
 *
 *   - the inner call rejects with a value String() cannot print (Object.create(null)), or an
 *     Error whose `message` getter throws: `failed()` formats it outside any try;
 *   - an answer's `cost` getter throws: `checkDecisions` throws (caught), then `spentOn` reads
 *     the same getter inside the catch block.
 *
 * And it validates a snapshot it does not keep: `checkDecisions` returns the adapter's own
 * objects, so a `pYes` getter that reads 0.2 while validated and 0.99 afterwards is ruled act.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/failopen-throws.ts
 *
 * Exits 1 while any reproduces. Fix: format errors with the guarded formatter floors.ts uses;
 * wrap `spentOn` in try/catch (undefined on any throw); have `checkDecisions` return plain
 * copies built from the values it validated (verdict fields read once, then frozen).
 */
import { failOpen } from "../../../../../src/oracles/oracle.ts";
import { rule } from "../../../../../src/policy.ts";
import { judge } from "../../../../../src/questions.ts";
import type { Decision } from "../../../../../src/types.ts";
import { judged, scripted } from "../lib.ts";

const q = judge("Is it safe?", { id: "q" });
let reproduced = 0;
const tryIt = async (name: string, inner: ReturnType<typeof scripted>) => {
  try {
    const [d] = await failOpen(inner).decide("s", [q]);
    console.log(`${name}: failed open (${d?.error})`);
  } catch {
    reproduced++;
    console.log(`${name}: failOpen THREW`);
  }
};
await tryIt(
  "rejects with Object.create(null)",
  scripted("x", () => {
    throw Object.create(null);
  }),
);
await tryIt(
  "cost getter throws",
  scripted("x", (qs) =>
    qs.map((x) =>
      Object.defineProperty({ ...judged(x, 0.95) }, "cost", {
        get() {
          throw new Error("cost");
        },
      }),
    ),
  ),
);
let reads = 0;
const shifty = {
  kind: "judge",
  questionId: q.id,
  confidence: 0.8,
  get pYes() {
    return ++reads <= 4 ? 0.2 : 0.99;
  },
};
const [d] = await failOpen(
  scripted("x", () => [
    { verdict: shifty, oracle: "x", latencyMs: 1, cost: 0, at: "2026-11-12T12:00:00.000Z" },
  ]),
).decide("s", [q]);
const ruling = rule(d as Decision, { actAbove: 0.9 });
console.log(`pYes getter 0.2 then 0.99: validated, then ruled ${ruling.action}`);
if (ruling.action === "act") reproduced++;
process.exitCode = reproduced > 0 ? 1 : 0;
