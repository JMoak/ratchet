/**
 * Repro T3: `ratchet review` shows the reviewer the state and asks "Approve? [y]es / [n]o"; it
 * never shows the question being labelled, and records y as truth = true for the gate's judge
 * question whatever that question asks. On a gate whose question is "does this need moderator
 * action?" (act = publish, goIsYes false), a reviewer who approves a harmless post with y has
 * recorded "needs action". The label is inverted and the score of the oracle with it.
 *
 *   bun experiments/e2e/t3-triage/repro/review-polarity.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReviewIo, review } from "../../../../src/cli/main.ts";
import { Engine } from "../../../../src/engine.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../../../../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../../../../src/types.ts";

const oracle: Oracle = {
  id: "fixed",
  async decide(_state, qs) {
    // Confident that the harmless post needs no action.
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, 0.03),
      oracle: "fixed",
      model: "fixed-1",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
};
const path = join(mkdtempSync(join(tmpdir(), "t3-review-")), "mod.jsonl");
const engine = new Engine({ oracle, ledger: new JsonlLedger(path), keepState: true });
const q = judge("Does this post need moderator action?", { id: "needs_action" });
engine.gate({ id: "mod", question: q, policy: { actAbove: 0.9, goIsYes: false } });
await engine.ask("post: Caught three fluke off the jetty this morning.", q, {
  policy: { actAbove: 0.9, goIsYes: false },
});

const shown: string[] = [];
const io: ReviewIo = {
  print: (t) => shown.push(t),
  // A reviewer approving the harmless post.
  ask: async (prompt) => {
    shown.push(`[prompt] ${prompt}`);
    return "y";
  },
};
const res = await review([path, "--gate", "mod", "--sample", "5", "--seed", "1"], io);
const row = (await new JsonlLedger(path).all())[0];
console.log(shown.join(""));
console.log(res.output);
console.log(
  `recorded outcome: truth ${row?.outcome?.truth} (the post "needs action"), correct ${row?.outcome?.correct}`,
);
console.log(
  `question shown to the reviewer: ${shown.some((s) => s.includes("moderator action")) ? "yes" : "no"}`,
);
console.log(`
Expected: the item shows the question it labels (the row's prompt), and the prompt asks for
that question's answer ("Needs moderator action? [y]es / [n]o"), or for a gate whose go side
is "no", asks whether to allow the action and records the truth accordingly.
src/cli/review.ts:98 (prints the state only) and :112 ("Approve?"), :135 (y = truth true).`);
