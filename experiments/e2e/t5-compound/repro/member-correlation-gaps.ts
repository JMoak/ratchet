/**
 * Repro T5: two ways `memberCorrelation` hands pooling the wrong rho.
 *
 * 1. A pair with no variance in one member's correctness (it was never wrong, or always
 *    wrong, on the rows read) has an undefined phi. `errorCorrelation` returns 0 for it, and
 *    `memberCorrelation` averages that 0 into `mean`: "independent", the most optimistic
 *    value, on exactly the slice where nothing was learned. The doc comment promises that a
 *    missing pair is absent "rather than 0, which would read as independence", but a
 *    degenerate pair is reported as 0.
 * 2. Pick (and rate) questions are skipped entirely: rows whose truth is an option name are
 *    dropped, and pick members are never scored. A replicated pick ensemble measures nothing,
 *    so a user following "measure rho from the ledger" has no number to feed back.
 *
 *   bun experiments/e2e/t5-compound/repro/member-correlation-gaps.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { memberCorrelation } from "../../../../src/ledger/calibration.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { judge, pick } from "../../../../src/questions.ts";
import { fixedJudge, fixedPick, say } from "./fixtures.ts";

// --- 1. Degenerate pair: two identical replicas that are right on every labelled row ------
{
  const ledger = new MemoryLedger();
  const oracle = fixedJudge("replica", () => 0.8);
  const engine = new Engine({ oracle, ledger, mode: "shadow" });
  const gate = engine.gate({
    id: "easy.gate",
    question: judge("Is it safe?", { id: "easy" }),
    policy: { actAbove: 0.9 },
    strategy: { ensemble: { k: 3 } },
  });
  for (let i = 0; i < 40; i++) {
    const r = await gate.ask(`state ${i}`);
    // Every item is truly yes, and every replica said yes: no replica was ever wrong.
    await engine.label(r.recordId, { correct: true, truth: true, source: "review:blind:x" });
  }
  const mc = memberCorrelation(await ledger.all());
  say(`replicas identical on every row (agreement 1.0): ${JSON.stringify(mc)}`);
  say(
    mc.mean === 0
      ? "REPRODUCED (1): three identical replicas read as independent (mean phi 0); pooled at rho 0 they would count as three votes."
      : "(1) not reproduced",
  );
}

// --- 2. Pick rows are skipped ---------------------------------------------------------------
{
  const ledger = new MemoryLedger();
  // Wrong on a third of the items, identically for every replica: the errors are perfectly
  // correlated, which is the number a user needs before pooling.
  const oracle = fixedPick("picker", (s) => (Number(s.split(" ")[1]) % 3 === 0 ? "b" : "a"), 0.7);
  const engine = new Engine({ oracle, ledger, mode: "shadow" });
  const gate = engine.gate({
    id: "route.gate",
    question: pick("Which queue?", ["a", "b", "c"], { id: "route" }),
    policy: { actAbove: 0.9 },
    strategy: { ensemble: { k: 3 } },
  });
  for (let i = 0; i < 30; i++) {
    const r = await gate.ask(`state ${i}`);
    const choice = r.decision.verdict.kind === "pick" ? r.decision.verdict.choice : "";
    await engine.label(r.recordId, {
      correct: choice === "a",
      truth: "a",
      source: "review:blind:x",
    });
  }
  const rows = await ledger.all();
  const mc = memberCorrelation(rows);
  say(`pick ensemble, 30 labelled rows with members: ${JSON.stringify(mc)}`);
  say(
    mc.n === 0 && mc.pairs.length === 0
      ? "REPRODUCED (2): memberCorrelation reads no pick rows at all (n 0, no pairs); the pick gate's rho cannot be measured."
      : "(2) not reproduced",
  );
}
