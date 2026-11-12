/**
 * V1 round 2 repro: `checkStrategy` runs only at gate registration. A strategy passed per ask
 * (`engine.ask` / `askAll` take `AskOptions.strategy`) is not checked, so a sequential plan with
 * `maxSamples: Infinity` buys answers until something else stops it; `budgetUsd` is checked
 * per request, not per sample, so one ask spends far past the cap.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/r2-ask-strategy-unbounded.ts
 *
 * The oracle throws after 500 calls so the repro terminates. Exits 1 while one ask makes more
 * than 100 calls. Fix: call `checkStrategy(opts.strategy, ...)` for every lane in `runLanes`
 * (or in `decide`), and have `sequential()` itself refuse a non-integer `maxSamples`.
 */
import { Engine } from "../../../../../src/engine.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import { judged, scripted } from "../lib.ts";

const q = judge("Is it safe?", { id: "q" });
let calls = 0;
const unsure = scripted("unsure", (qs) => {
  calls++;
  if (calls > 500) throw new Error("repro stop");
  return qs.map((x) => judged(x, 0.6, { cost: 0.001, model: "unsure" }));
});
const engine = new Engine({ oracle: unsure, ledger: new MemoryLedger(), budgetUsd: 0.01 });
const r = await engine.ask("s", q, {
  policy: { actAbove: 0.9 },
  strategy: {
    sequential: {
      members: [{ oracle: unsure }],
      settleAbove: 0.99,
      maxSamples: Number.POSITIVE_INFINITY,
    },
  },
});
console.log(
  `one ask: ${calls} oracle calls, engine.spent $${engine.spent.toFixed(3)} against budgetUsd $0.01; action ${r.action}`,
);
process.exitCode = calls > 100 ? 1 : 0;
