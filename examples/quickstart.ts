/**
 * Quick start: triage one support message with a real decision model, through the engine.
 *
 * Needs OPENROUTER_API_KEY (Jev via OpenRouter) or TYPESAFE_API_KEY in .env. One request,
 * four questions, a few hundredths of a cent. Run with `bun run quickstart`.
 */
import { Engine, jev, jevViaOpenRouter, judge, pick, rate } from "../src/index.ts";

const oracle = process.env.TYPESAFE_API_KEY ? jev() : jevViaOpenRouter();
const engine = new Engine({ oracle, mode: "shadow" });

const message = [
  "Subject: payouts failing AGAIN",
  "",
  "Hi, this is the third day in a row my payouts have failed. I have rent due Friday and",
  "nobody has replied to my two previous tickets (#4821, #4833). I need someone to actually",
  "fix this today or I am moving my store elsewhere.",
].join("\n");

const state = `Customer message:\n${message}\n\nAccount: Pro plan, 14 months, no prior refunds.`;

const questions = [
  pick("Which team should handle this?", ["billing", "technical", "sales", "other"], {
    id: "department",
    criteria: {
      billing: "Payments, payouts, invoicing, refunds",
      technical: "Bugs, outages, integrations",
      sales: "Pricing, upgrades, new accounts",
      other: "Anything that fits none of the above",
    },
  }),
  rate("How frustrated is the customer?", ["calm", "annoyed", "frustrated", "furious"], {
    id: "frustration",
  }),
  judge("Does this need a human reply today?", {
    id: "urgent",
    criteria: { yes: "An explicit deadline or a risk of losing the customer", no: "Routine" },
  }),
  judge("Is the customer threatening to leave?", { id: "churn_risk" }),
] as const;

// Every question that shares the state goes in one call. Policies are per question: auto-route
// on a confident department, but a human-today decision needs 0.9 before we would trust it.
const results = await engine.askAll(state, questions, (q) => ({
  policy: q.id === "urgent" ? { actAbove: 0.9 } : { actAbove: 0.7 },
  baseline: "review",
}));

console.log(`oracle ${oracle.id}, model ${results[0]?.decision.model ?? "?"}\n`);
for (const r of results) {
  const v = r.decision.verdict;
  let answer: string;
  switch (v.kind) {
    case "pick": {
      const dist = Object.entries(v.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([k, p]) => `${k} ${p.toFixed(2)}`)
        .join(", ");
      answer = `${v.choice}  [${dist}]`;
      break;
    }
    case "rate":
      answer = `${v.level} (score ${v.score.toFixed(2)} of ${v.probabilities.length - 1})  [${v.probabilities.map((p) => p.toFixed(2)).join(", ")}]`;
      break;
    case "judge":
      answer = `p(yes) = ${v.pYes.toFixed(2)}`;
      break;
  }
  console.log(`${v.questionId.padEnd(12)} ${answer}`);
  console.log(`${"".padEnd(12)} -> ${r.ruling.soft.padEnd(6)} ${r.ruling.reason}`);
}

const cost = results.reduce((s, r) => s + r.decision.cost, 0);
const latency = Math.max(...results.map((r) => r.decision.latencyMs));
console.log(
  `\n${results.length} answers, one request (${results[0]?.requestId}): $${cost.toFixed(6)}, ${latency.toFixed(0)} ms`,
);
// No gate is registered here, so each row is recorded under an anonymous "adhoc:<id>" gate.
// Register one with `engine.gate({ id, question, policy })` to give a question its own slice
// of the ledger, report and rollout.
console.log(`Gates: ${results.map((r) => r.gateId).join(", ")}`);
console.log("Mode was shadow: every row is in the ledger, nothing was acted on.");
