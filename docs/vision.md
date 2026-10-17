# Vision: a ratchet for judgment

*Working name `ratchet`; the repo and name are provisional. Companion documents:
[architecture.md](architecture.md), [sim-results.md](sim-results.md), and the research under
`../research_notes/` and `../reports/`.*

## The claim, stated carefully

The intuition that started this: a decision model that is right about 80% of the time, costs
a fraction of a cent, and answers in a tenth of a second ought to be *compoundable*. Many
cheap, decent decisions should add up to something excellent.

The research says the intuition is right, but only inside a regime, and the arithmetic
inverts outside it:

- **Aggregating compounds accuracy.** A majority of 5 independent 80% votes is right 94% of
  the time; 15 votes, 99.6%; a sequential test that stops when the pooled evidence clears a
  bar hits 99% in under five calls on average.
- **Chaining compounds error.** Ten dependent 80% steps with nothing checking the work succeed
  10.7% of the time. Fifty steps, never. Every agent-reliability study of 2025 and 2026 finds
  this geometric decay in the wild.
- **Correlation caps everything.** Calling the same model five times is not five voters. With
  pairwise error correlation rho, the effective crowd is n / (1 + (n - 1) rho); at rho = 0.5,
  five calls are worth 1.7. Published LLM-judge panels of nine frontier models deliver about
  two independent votes' worth. Jev itself is near-deterministic (run-to-run probability
  spread around 0.01), so re-asking it the same question buys nothing beyond cancelling
  option-order bias; only different framings, decompositions or models add evidence.
- **Calibration is the load-bearing wall.** A threshold on a confidence number is a promise
  about accuracy. An overconfident oracle breaks the promise silently: same accuracy, same
  bar, 84% precision where 96% was promised (table 6 in the simulation results).
- **Ruin does not average out.** Any nonzero per-decision chance of an irreversible loss
  becomes certainty over enough decisions. One-way doors are never automated.

So the honest version of the thesis, and the sentence this project is built around:

> A calibrated cheap decider does not make 80%-good decisions. It sorts decisions into the
> ones it can make at 98% and the ones it should hand off. The sort, the hand-off, and the
> loop that keeps the sort honest are the product.

## What the engine is

A small library that takes any "decision model" (TypeSafe's Jev, Cloudflare's Clef, Amazon's
Strands Decider, OpenAI's Decisions API, a local clone, or a generative model forced into the
role) and wraps it in the five things the vendors all leave to "your code":

1. **Composition** of probabilistic judgments: ensembles with explicit independence
   manufacturing and correlation correction, sequential sampling that stops when the evidence
   is strong enough, cascades that escalate only the unsure cases, and a verify-then-commit
   runner that turns a fragile chain of steps into a ratchet.
2. **Policy** that turns a probability into act / review / refuse using the costs of being
   wrong, bounded below by hard floors that no model can lower.
3. **A ledger** that records every decision with its confidence, cost, latency, the policy's
   recommendation, what the application actually did, and later, what was true.
4. **Learning** that only ever reads the ledger: calibration (ECE, Brier, reliability bins),
   expected-versus-observed accuracy, error correlation between members, and threshold fitting
   on the slice of history the oracle's own confidence did not select.
5. **Rollout discipline**: shadow, label, fit, enforce, audit. The engine starts by changing
   nothing. It earns the right to act from its own record.

Everything is typed. Three question shapes (pick, rate, judge) cover what every decision model
on the market answers. The oracle interface is one method.

## Principles the research forced on us

**The model proposes; code decides.** Von Neumann showed in 1956 that you cannot build a
reliable organ from unreliable parts if the error-correcting element is itself one of the
unreliable parts (the threshold is one in six). The aggregator, the policy, and the floors are
deterministic code. The oracle is never asked whether the oracle should be trusted.

**Floors are enforced, not requested.** Telling a model "ask before irreversible actions"
skipped the check in 38 to 48% of episodes in a 2026 benchmark; environment-enforced gates cut
harm to 2.5%. Our floors are regular expressions and predicates over the state, evaluated by
the harness. A judgment can raise caution above a floor, never lower it.

**Fail open means review, not act.** When the oracle times out or returns garbage, its
judgment contributes nothing, and the policy's answer to nothing is "review" unless the caller
says otherwise. The soft layer failing never grants permission.

**Measure independence; do not assume it.** The pooling math takes a correlation parameter.
The ledger can estimate it from paired correctness. Default to the measured value, and when
there is none, default to pessimism.

**The 80/20 human split is a trap unless you design around it.** If reviewers only ever see
the cases the model found hard, they deskill, defer to the displayed confidence, and absorb
the blame when it goes wrong. Bainbridge named this in 1983 and it has been replicated since.
The engine's answer is the blind audit: a random, confidence-independent slice of confident
acts is diverted to review anyway. It keeps reviewers calibrated, and it is the only labelled
data that is not biased by the oracle's own selection, so it is the only data thresholds are
fitted on. Fitting thresholds on the engine's own confidence-selected outcomes is how runaway
feedback loops start.

**Thresholds come from costs, and the review band comes from the margin.** The bar for acting
is costWrongAct / (costWrongAct + costWrongHold). A wrong allow that is 50 times costlier than
a wrong ask means acting only above 0.98. The number is derived, logged, and re-fitted; it is
never a vibe. Around it sits a review band at least a tenth wide: in the decision-hijacking
study, attacks flipped 12 of 12 decisions whose margin was 0.1 or less and 1 of 468 others.
Combine decomposed sub-questions in log-odds and fit the bar on the composite; thresholding
each sub-question at 0.5 and AND-ing them lost on 9 of 10 benchmarks.

**Shadow mode must measure usefulness, not just accuracy.** The one published week-long shadow
run of a Jev-based skill router in a coding agent produced 539 suggestions of which about 5%
were used, and the plugin was removed. Accuracy on a fixed set is cheap to measure; whether
the decision changed downstream behaviour for the better is the question the ledger has to be
able to answer, so outcomes should record what happened next, not only whether the verdict
matched a label.

**Untrusted text is evidence, not instruction, and the model will not remember that.**
Injection studies in September and October 2026 flipped 59% to 73% of correct decisions in
Jev-class models with natural-looking context. Typed input markers did nothing. Digest
numbers, dates and untrusted content in code before the oracle sees them, keep the hard floors
in code, and never let a soft judgment be the sole barrier on a security boundary.

## Where it pays off first

The agent-reliability evidence ranks the decision points inside an agent loop by how much a
sub-second calibrated judgment helps:

1. Pre-execution gate on mutating or irreversible tool calls.
2. Independent verifier over candidate outputs and step results (the ratchet).
3. Continue / retry / stop / escalate loop control.
4. Per-item context keep-or-drop (compaction without summarisation).
5. Per-step model and effort routing.
6. Skill and tool selection, including abstention.
7. Speculative fan-out of next actions with a fast picker.
8. Screening tool outputs and inter-agent messages.

The first example in this repo (`examples/tool-gate.ts`) is number one, emitting Claude Code
`PreToolUse` hook decisions. The chain runner is number two.

Beyond agents, the same engine fits anywhere many small typed decisions are made against a
cost of being wrong: triage, routing, screening, moderation queues, data cleaning, approval
workflows. The questions change; the discipline does not.

## What would make this world class

- It never asks a user to trust a model's confidence. It shows them the ledger.
- Switching decision backends is one adapter, and the calibration report tells you which one
  is actually better *for your questions*.
- The default path is safe: shadow mode, review on failure, floors on, audits on.
- The compounding strategies are not folklore. Each is a few hundred lines with the math in
  the comments and a simulation that shows exactly where it breaks.
- A newcomer can read `vision.md`, run `bun run sim`, run `bun run demo`, and understand both
  why the thesis is true and why it is dangerous within half an hour.
