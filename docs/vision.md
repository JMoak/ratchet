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
  this geometric decay in the wild. A verifier fixes what gets committed, not how often the
  chain finishes: in the end-to-end evaluation every committed step was correct (1,132 of
  1,132), but chains finished 48% to 62% of the time where the independent-retry arithmetic
  predicted 74% to 99.8%, because a verifier that wrongly rejects one correct answer to a step
  tends to reject the next one too (revised 2026-11-12, e2e T2).
- **Correlation caps everything.** Calling the same model five times is not five voters. With
  pairwise error correlation rho, the effective crowd is n / (1 + (n - 1) rho); at rho = 0.5,
  five calls are worth 1.7. Published LLM-judge panels of nine frontier models deliver about
  two independent votes' worth. Measured live on Jev, re-asking buys nothing: three replicas of
  jev-1.13 erred together (phi 0.85 to 0.91) and gained 0.8 points, not significantly; three
  framings of the question gained nothing; and a second Jev pin is not a second opinion
  (jev-1.14's errors correlate with jev-1.13's at phi 0.785). What added evidence was a model of
  a different family: a cascade from jev-1.13 to haiku-5.5, whose errors barely overlapped
  Jev's (phi 0.04), took held-out accuracy from 85.8% to 98.5%, more cheaply than haiku alone
  (revised 2026-11-12, e2e T5). The same pair correlated at 0.58 on BoolQ, so the correlation
  belongs to the question as much as to the models, and has to be measured per question.
- **Calibration is the load-bearing wall.** A threshold on a confidence number is a promise
  about accuracy. An overconfident oracle breaks the promise silently: same accuracy, same
  bar, 84% precision where 96% was promised (table 6 in the simulation results).
- **Ruin does not average out.** Any nonzero per-decision chance of an irreversible loss
  becomes certainty over enough decisions. One-way doors are never automated.

So the honest version of the thesis, and the sentence this project is built around:

> A calibrated cheap decider does not make 80%-good decisions. It sorts decisions into the
> ones it can make at 98% and the ones it should hand off. The sort, the hand-off, and the
> loop that keeps the sort honest are the product.

The end-to-end evaluation of 2026-11-12 ([docs/e2e/](e2e/findings.md); its corpora were authored,
except 200 real tool calls from one operator in T1) tested this sentence on the flagship case: the sort did not
transfer as fitted, and the loop caught it. On coding-agent tool calls, a bar fitted at 98% on
one set of template groups delivered 91.2% on held-out groups of the same families, and the
planned acceptance test refused to promote it: 5 wrong of 59 planned acts, an exact lower bound
of 83.0% against a 95% promise. The sort was in Jev's probabilities (post hoc, a higher bar was
right on 79 of 80 held-out acts), but a fit on 180 items put the bar in the wrong place, and a
98% promise needs 149 clean planned acts before it can be tested at all. Refusing that gate is
the system working, not failing (e2e T1). Where the sort did hold on held-out data: a verifier
committed 135
outputs and all were correct (T2); a refund and expense desk decided 206 of 219 requests on
digested facts with no error (T3); and a cascade from Jev to a model of another family met a 98%
precision target at 95.8% coverage (T5).

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
says otherwise. The soft layer failing never grants permission. The red team held the engine to
this: thrown errors, timeouts and short or long batches reviewed on every path, but malformed
answers from an adapter (probabilities out of range, null, or of the wrong kind) acted in 128 of
1,908 fault cells, a gap in validation, not in the principle (e2e T4-01). `failOpen` now checks
every answer in a batch and fails the whole batch open on one it cannot trust.

**Measure independence; do not assume it.** The pooling math takes a correlation parameter.
The ledger can estimate it from paired correctness. Default to the measured value, and when
there is none, default to pessimism. Pooling three framings of one model as independent votes
made it confidently wrong (ECE 0.099, against 0.042 at the measured correlation), and one
average correlation cannot describe a mixed panel: two near-duplicates and one independent
model need a weight per pair (e2e T5).

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
study, attacks flipped 12 of 12 decisions whose margin was 0.1 or less and 1 of 468 others. The
band must also cover the pinned model's own run-to-run spread, which is measured, not assumed,
and differs by pin. Over 414 repeated pairs jev-1.13 moved a median 0.01 and at most 0.11 (e2e
T1); on jev-1.14, 11.4% of 924 repeated requests moved more than 0.12 and 5.5% flipped their
lean (e2e T2). Revised 2026-11-12: this paragraph used to call Jev near-deterministic.

**Decompose for the right shape, and fit the bar on the composite.** Pooling sub-questions
softly beats thresholding each at 0.5 and AND-ing them, which lost on 9 of 10 published
benchmarks and lost again on ranking in e2e T2 (AUC 0.107 below a log-odds pool). But log-odds
is the right soft pool only when every member is evidence for the same proposition, such as
several signals of one answer. It is wrong for other shapes. On T2's verification corpus eight
all-of conditions pooled in log-odds lost to one holistic question (AUC 0.992 against 0.998, ECE
0.198 against 0.082) and saturated at 0 and 1; on T3 the default log-odds pool inverted an
any-of moderation battery, which at its bar would have published 51 of the 56 posts that needed
action. An any-of battery takes the `any` combiner, an all-of battery `all` or a combiner learned
from labels, and one well-written question is often as good as the battery (revised 2026-11-12,
e2e T2, T3).

**Numbers and dates are computed in code, never by the model.** This is the most-confirmed
result in the project. Four tracks of the end-to-end evaluation measured it live on new corpora:
refund and expense approvals went from 66.7% right on raw dates and amounts to 99.1% on the same
facts stated as comparisons (71 items right only when digested, none the other way; T3); a
two-condition policy check from 83.3% to 100% on jev-1.13 (p = 0.008) and 89.6% to 100% on
jev-1.14 (T4; p = 0.0625, not significant at n = 48); a verifier's catches of numeric errors from 11 of 15 to 15 of 15 (T2); and rule
items with raw numbers sat at 78.7% to 84.2% against 100% on digested ones (T5, not paired).
Digest the comparison, not just the value: rendering dates as "1 month ago" made 27% of a refund
desk's auto-approvals wrong at a 30-day window (T3).

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
in code, and never let a soft judgment be the sole barrier on a security boundary. These
figures are still the literature's: the end-to-end evaluation planned its own injection study
and did not run it (e2e T4).

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
