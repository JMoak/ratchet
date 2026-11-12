/**
 * Repro (T2-07): `runChain` bounds attempts with `Math.max(1, step.maxAttempts ?? 3)`, which
 * passes non-finite values through. `maxAttempts: Infinity` retries a step whose verifier never
 * acts without end; `maxAttempts: NaN` makes zero attempts and reports the step "exhausted"
 * with an empty attempt list. Both are caller errors the runner could refuse.
 *
 *   bun experiments/e2e/t2-verifier/repro/chain-attempt-bounds.ts
 */
import { runChain } from "../../../../src/compound/chain.ts";
import type { Decision } from "../../../../src/types.ts";

const unsure: Decision = {
  verdict: { kind: "judge", questionId: "ok", pYes: 0.5, confidence: 0.5 },
  oracle: "unsure",
  latencyMs: 0,
  cost: 0,
  at: "2026-11-12T00:00:00.000Z",
};
const CAP = 10_000;

for (const maxAttempts of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
  let proposals = 0;
  try {
    const res = await runChain(
      0,
      [
        {
          name: "s1",
          maxAttempts,
          propose: async (s) => {
            proposals++;
            if (proposals > CAP) throw new Error(`still retrying after ${CAP} proposals`);
            return s + 1;
          },
          verify: async () => unsure,
        },
      ],
      { actAbove: 0.9 },
    );
    console.log(
      `maxAttempts ${maxAttempts}: ${proposals} proposals, stopReason ${res.stopReason}, attempts recorded ${res.trace[0]?.attempts.length}`,
    );
  } catch (e) {
    console.log(`maxAttempts ${maxAttempts}: ${(e as Error).message}`);
  }
}
