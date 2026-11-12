# Live findings: what Jev does under load, and how to buy it in bulk

Two runs on 2026-10-16 against `typesafe/jev-1.13` through OpenRouter, with
`anthropic/claude-haiku-5.5` as a comparison judge: about 1,800 calls in total for under
$0.09. Tables are in [live-results.md](live-results.md); raw rows and the engine ledgers are
under `experiments/out/`. The harness is `bun run live` (budget-capped at $0.50).

## The one result that changes the design

The same model is **underconfident on one task and overconfident on another**.

| task | accuracy | mean stated confidence | ECE | posture |
| --- | --- | --- | --- | --- |
| BoolQ yes/no (300 items) | 95.0% | 0.90 | 0.05 | underconfident |
| Banking77 77-way routing (150 items) | 76 to 78% | 0.90 | 0.13 to 0.17 | overconfident |

On BoolQ, items the model rated between 0.4 and 0.6 were right 92% of the time. On Banking77
a stated 0.90 delivered 0.77. A single global threshold is therefore wrong in both directions
at once. Thresholds must be fitted per question from labelled outcomes, which is exactly what
`Engine.report()` does, and the sign of the gap (expected accuracy from confidence versus
observed accuracy) belongs in every report because it says whether a bar can be lowered.

Banking77 is the "80% regime" this project started from, and it behaves as the research said
it would:

- **Top-3 covers 91%.** A 77-way pick that is right 77% of the time at rank 1 puts the truth
  in its top three 91% of the time. The shortlist-plus-human pattern is the real product on
  this kind of question; `shortlist()` now exists for it.
- **Re-asking does not help.** Three option orders of the same question flipped the answer
  on 11 of 150 items and moved the true option's probability by 0.07 on average; pooling the
  three by name scored 74.7%, below any single order, and came out more overconfident. On
  BoolQ, four paraphrases had error correlation 0.77 and pooling them lost 1.3 points. On
  BoolQ the model was near-deterministic (run-to-run mean shift 0.009, zero label flips on 40
  repeats), so replicas are the same vote three times. Replicated ensembles now default to
  correlation 0.75, and the honest use of ensembles is different oracles or decompositions.
  (Revised 2026-11-12: "near-deterministic" held for those BoolQ repeats, not in general. On
  items near 0.5 replicas do flip, and jev-1.14 drifts far more than jev-1.13; see the
  end-to-end section below.)
- **Correlation correction works on real data.** The design-effect shrink did not change which
  answer won (it never can) but took the pooled ECE on BoolQ from 0.052 to 0.024.
- **No first-option bias was visible at the label level** on hosted jev-1.13 (0 to 0.7% of
  picks were the first listed option, chance 1.3%), but probabilities do drift with order.

## Cascades: measure the upper tier before paying for it

Claude Haiku 5.5, forced into the decision role with strict JSON, scored 92.6% on the same
BoolQ items against Jev's 94.9%, at 18x the cost and 8x the latency. Its errors were strongly
correlated with Jev's (phi 0.58): when Jev was wrong, Haiku was also wrong 73% of the time
where independent errors would give 7%. No settle bar beat Jev alone by more than 0.4 points.
This replicates the published finding that cascades gain little because fallbacks fail where
the first stage fails. A cascade is only worth building when the ledger shows the upper tier
is more accurate on that question and its errors are not the same errors. Measure that on a
sample where the upper tier answers every item, not from the cascade's own rows, which pair the
tiers only on the escalated items (revised 2026-11-12, e2e T5). The same Haiku that copied
Jev's errors here was wrong in different places on the end-to-end rule-application corpus
(phi 0.04), and the cascade there gained 12.7 points; see below.

## Weak spots, measured

Twenty hand-written probes: arithmetic 3 of 5, dates 4 of 5, negation 5 of 5, injected
"pre-approved" or "deny this" notes 5 of 5 correct. The arithmetic misses (3 cartons of 6
against 17 ordered; 14 pallets of 1,600 kg against a 22,000 kg limit) were answered at 0.24
to 0.33, not confidently; dates sat at 0.66 mean confidence. The model is unsure where it is
weak, which is the best one can ask of it, and the fix is the obvious one: compute numbers and
dates in code and hand the model the comparison, never the arithmetic.

## Bulk economics: what a call actually costs

Measured from the gateway's billed `usage` on jev-1.13:

- **Only input tokens cost anything**, at $0.042 per million. 1,146 output tokens were billed
  at zero.
- **Every request carries about 250 tokens of fixed overhead.** An 80-word state with one
  question billed 369 input tokens.
- **A question costs about 14 tokens** without criteria and about 50 with two-sentence yes/no
  criteria. Sixty-four questions on a 400-word state cost $0.000071 in total.
- **Latency is flat.** 120 to 300 ms whether the state is 80 or 6,400 words and whether the
  request holds 1 or 64 questions. Sixteen in flight gave 65 calls per second with no
  throttling; that is roughly 230,000 calls per hour on one key.
- **Batching is the whole game.** Sixteen questions in one request versus sixteen requests:
  12.7x cheaper, 22.7x faster. Answers were not bit-identical (15 of 16 same label, largest
  probability shift 0.10), so the ledger records how many questions shared a request
  (`vendor.batch`) and a bar fitted on batched answers should be applied to batched answers.
- **Criteria move answers more than they cost.** Adding criteria shifted one answer by 0.27 for
  50 tokens per question. Spend tokens on criteria, not on repeats.

Cost model per request, in dollars: `(250 + state_tokens + 14 * questions) * 0.042 / 1e6`.

| workload | per 1,000 items | per 1,000,000 items |
| --- | --- | --- |
| 300-token state, 1 question | $0.024 | $24 |
| 300-token state, 10 questions | $0.029 | $29 |
| 300-token state, 60 questions | $0.058 | $58 |
| 77-way routing, option names only, 1 order | $0.032 | $32 |
| 2,500-token document, 20 questions | $0.127 | $127 |

The playbook for bulk work:

1. One request per state; put every question about that state in it. There is no
   many-states-per-request call, so item count sets the request count.
2. Shrink the state. It is the only term that scales; pre-digest in code (band numbers, state
   comparisons, drop fields) and it also raises accuracy on the jagged cases. A date against
   a window is a compared day count (`compare(daysBetween(...), window)`), not a relative
   phrase: `relativeTime` read 31 to 44 days as "1 month ago" (fixed: it now floors, in days
   below 120 days), and at a 30-day window that made 27% of a refund desk's auto-approvals
   wrong (revised 2026-11-12, e2e T3).
3. Treat questions as free, and decompose for the battery's shape. Log-odds is the composite
   for members that are evidence for one answer; an any-of battery takes `any`, an all-of
   battery `all` or a learned combiner, and one well-written question is often as good as
   any battery. Fit the bar on the composite (revised 2026-11-12, e2e T2, T3).
4. Run 16 to 32 in flight. Throughput is limited by your concurrency, not the service.
5. Never repeat a question to the same model for confidence. Use the probability it already
   gave you, calibrated per question from the ledger.
6. Escalate to a human shortlist before escalating to a bigger model, unless the ledger has
   shown the bigger model is both better and differently wrong.

## End-to-end evaluation, 2026-11-12: what it changed about Jev

Five tracks ran the real engine live against `typesafe/jev-1.13-20260917` and
`typesafe/jev-1.14-20261014`, with `anthropic/claude-haiku-5.5` and `openai/gpt-6-luna` as upper
tiers, on new corpora authored for the evaluation (labels fixed before the first call), for
under $0.90 recorded in all. The reports are in [e2e/](e2e/findings.md); the numbers below are
the ones that bear on Jev itself.

**Run-to-run spread depends on the pin, and on how close the items sit to 0.5.**

| pin | what was repeated | spread | answer changed |
| --- | --- | --- | --- |
| jev-1.13 | 414 identical (state, question) pairs across T1's ledgers | median 0.01, 90th percentile 0.04, 99th 0.08, max 0.11; identical 118 times | 8 pairs crossed the frozen 0.62 bar |
| jev-1.13 | three replicas on 260 rule items (T5) | mean max-minus-min 0.035; identical probability on 25.4% | 5.0% of rows |
| jev-1.14 | 924 verifier requests asked twice (T2) | median 0.02; 11.4% moved more than 0.12, 46 more than 0.2, max 0.51 | 5.5% |
| jev-1.14 | an 8-member battery asked twice (T2) | median 0.010, 99th percentile 0.13 to 0.14, max 0.34 | 2.6% to 2.9% of member answers |

The flips are noise, not information: three replicas gained 0.8 points (4 fixed, 2 broken,
p = 0.69). Size a review band from the pinned model's measured spread; a 0.05 half-width is
narrower than jev-1.14's.

**jev-1.14 is not a second opinion for jev-1.13.** On T5's 260 held-out items their errors
correlate at phi 0.785: 33 of jev-1.13's 37 errors are jev-1.14 errors, jev-1.14 is 2.7 points
worse (4 fixed, 11 broken, p = 0.12) and 65.4% on the multihop domain, and pooling the two
gained nothing (5 fixed, 5 broken). In T5's first pilot they returned the same probability on 109
of 250 items, and in T4's arithmetic run all five of jev-1.14's raw errors were also jev-1.13
errors. Two pins of one family disagree rarely (5.4%) while each is wrong 13% to 15% of the time,
so their disagreement says little about either.

**A model of a different family is what adds evidence.** On the same 260 items haiku-5.5's
errors barely overlapped jev-1.13's (phi 0.04; when Jev was wrong, haiku was wrong 5.4% of the
time). A cascade from jev-1.13 to haiku, with the escalation bar (0.91) fitted on a fit split,
was right on 98.5% held out against 85.8% for Jev alone (34 fixed, 1 broken), cheaper than haiku
alone ($0.000106 against $0.000153 a decision) and faster at the median (619 ms against 1,183
ms), and it was the only strategy to meet a 98% precision target (95.8% coverage at 98.8%). It
works because Jev's confidence sorts (1 wrong in the 130 held-out items it stated at 0.91 or
more) and the upper tier is wrong elsewhere. That corpus upweighted what Jev gets wrong (raw
arithmetic, counting with open results, rule exceptions over relational text) and what haiku
gets right; on BoolQ the same pair correlated at 0.58 and no cascade helped. What transfers is
the measurement, not the result. Its lead over haiku alone (+1.9 points, p = 0.13) is not
established at this size.

**Digesting numbers and dates in code, confirmed four more times.**

| track | task | raw | digested | paired |
| --- | --- | --- | --- | --- |
| T3 | 219 refund and expense requests against a written policy | 66.7% (dates 30.8%) | 99.1% (dates 100%) | 71 right only digested, 0 the other way |
| T4 | 48 two-condition requests, jev-1.13 | 83.3% | 100% | 8 vs 0, p = 0.0078 |
| T4 | the same, jev-1.14 | 89.6% | 100% | 5 vs 0, p = 0.0625 |
| T2 | conversion outputs to verify, numeric errors caught | 11 of 15 | 15 of 15 | same candidates |
| T5 | rule items with numbers | 78.7% to 84.2% raw (n 104) | 100% (n 20) | different items |

The raw errors are near thresholds: in T4, 11 of 13 were day counts within two days of a policy
window. A relative date is not a digest: rendering dates with `relativeTime`, as it rounded
before the fix above, gave 70.8% in T3, and 10 of its 37 auto-approvals were wrong.

**Calibration posture moves with the rendering, not just the question.** On the same T3
requests Jev was overconfident on raw facts (66.7% right at 75.0% stated) and underconfident on
digested ones (99.1% at 94.8%). It was underconfident as a tool gate (T1, ECE 0.129) and as a
verifier (T2: candidates scored 0.2 to 0.5 passed 23 of 27 times). On T1's 473 tool calls it
never stated a pYes above 0.95, and at most 0.94 on 200 real ones, so a placeholder bar at 0.95
acts on nothing. Fit bars per question and per rendering.

**It is mostly unsure where it is weak, not always.** Most errors sit mid-range (T5: 36 of 37 at
0.42 to 0.88; T4: every raw error at 0.41 to 0.78), but confident misses exist: T1's nine wrong
held-out acts sat at pYes 0.62 to 0.89 ("routine-looking, not routine" commands), and T2's
verifier passed SQL filters that drop the last day of a period at 0.72 to 0.91.

## Open items

- Done 2026-11-12 (e2e T5): `openai/gpt-6-luna` as a second upper tier. It was 97.7% right on
  T5's held-out items, but its confidences sat near 1 (mean 0.989), so a bar on them has almost
  nothing to sort; a cascade to it matched luna alone.
- Banking77 was 150 items over 63 of the 77 intents; the datasets server throttled some pages.
- Criteria descriptions for Banking77 intents were not tested; the literature says they help.
