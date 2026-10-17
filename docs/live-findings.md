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
  BoolQ, four paraphrases had error correlation 0.77 and pooling them lost 1.3 points. The
  model is near-deterministic (run-to-run mean shift 0.009, zero label flips on 40 repeats),
  so replicas are the same vote three times. Replicated ensembles now default to
  correlation 0.75, and the honest use of ensembles is different oracles or decompositions.
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
is more accurate on that question and its errors are not the same errors.

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
2. Shrink the state. It is the only term that scales; pre-digest in code (band numbers, make
   dates relative, drop fields) and it also raises accuracy on the jagged cases.
3. Treat questions as free. Decompose generously, keep the composite in log-odds, fit the
   bar on the composite.
4. Run 16 to 32 in flight. Throughput is limited by your concurrency, not the service.
5. Never repeat a question to the same model for confidence. Use the probability it already
   gave you, calibrated per question from the ledger.
6. Escalate to a human shortlist before escalating to a bigger model, unless the ledger has
   shown the bigger model is both better and differently wrong.

## Open items

- The second run was stopped during the two-judge cascade; `openai/gpt-6-luna` as a second
  upper tier is still unmeasured.
- Banking77 was 150 items over 63 of the 77 intents; the datasets server throttled some pages.
- Criteria descriptions for Banking77 intents were not tested; the literature says they help.
