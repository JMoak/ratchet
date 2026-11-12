/**
 * V1 round 2 repro: counting settleLead votes by `modelFamily` can make the engine less
 * cautious. Merging two voters on the minority answer removes a vote from the runner-up, so a
 * lead-by-2 settles earlier and the run acts before the member that would have said no.
 *
 * Six members, settleLead 2, settleAbove 0.999: yes 0.8 from three families, no 0.3 from two
 * minority members, then a confident no (0.001). With the minority as gpt-4o + gpt-5 (one
 * family, "gpt") the run settles after 5 samples and acts at 0.922; with gpt-4o + command-r it
 * reaches the sixth member and reviews at 0.012.
 *
 *   bun experiments/e2e/verify/v1-safety/repro/r2-minority-merge.ts
 *
 * Exits 1 while the merged run acts and the unmerged one does not. Fix: count the lead
 * asymmetrically, so merging can only delay a stop: the leading answer's votes by family,
 * the runner-up's by distinct model (or the larger of the merged and unmerged counts).
 */
import type { Member } from "../../../../../src/compound/ensemble.ts";
import { Engine } from "../../../../../src/engine.ts";
import { MemoryLedger } from "../../../../../src/ledger/ledger.ts";
import { judge } from "../../../../../src/questions.ts";
import { fixed } from "../lib.ts";

const q = judge("Is it safe?", { id: "q" });
const run = async (minority: [string, string]) => {
  const members: Member[] = [
    { oracle: fixed("claude", 0.8, "claude-3-opus") },
    { oracle: fixed("n1", 0.3, minority[0]) },
    { oracle: fixed("gemini", 0.8, "gemini-2.5-pro") },
    { oracle: fixed("n2", 0.3, minority[1]) },
    { oracle: fixed("llama", 0.8, "llama-3.1-70b") },
    { oracle: fixed("n3", 0.001, "mistral-large-2") },
  ];
  const engine = new Engine({
    oracle: fixed("x", 0.5),
    ledger: new MemoryLedger(),
    mode: "enforce",
  });
  const gate = engine.gate({
    id: "s",
    question: q,
    policy: { actAbove: 0.9 },
    mode: "enforce",
    strategy: {
      sequential: { members, settleAbove: 0.999, settleLead: 2, maxSamples: 6, correlation: 0 },
    },
  });
  const r = await gate.ask("s");
  return { action: r.action, samples: r.decision.detail.samples };
};
const merged = await run(["gpt-4o", "gpt-5"]);
const apart = await run(["gpt-4o", "command-r"]);
console.log(
  `minority gpt-4o + gpt-5 (one family): ${merged.action} after ${merged.samples} samples`,
);
console.log(`minority gpt-4o + command-r: ${apart.action} after ${apart.samples} samples`);
process.exitCode = merged.action === "act" && apart.action !== "act" ? 1 : 0;
