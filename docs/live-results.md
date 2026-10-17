# Live results: Jev through OpenRouter

Run on 2026-10-16. Decision model `typesafe/jev-1.13` via https://openrouter.ai/api/v1/systemone; strong judge `anthropic/claude-haiku-5.5 and openai/gpt-6-luna` via chat completions. Every cost figure is the gateway's billed amount. Raw rows and the engine ledgers are in `experiments/out/`.


## E1. What a call costs: state size, question count, batching, concurrency

All numbers are billed figures from OpenRouter's `usage` block for `typesafe/jev-1.13`. Output tokens are reported but priced at zero; input tokens cost $0.042 per million.

| state words | questions | input tokens | output tokens | cost      | cost per 1k answers | ms  |
| ----------- | --------- | ------------ | ------------- | --------- | ------------------- | --- |
| 80          | 1         | 369          | 21            | $0.000015 | $0.0155             | 281 |
| 80          | 4         | 413          | 72            | $0.000017 | $0.0043             | 110 |
| 80          | 16        | 577          | 282           | $0.000024 | $0.0015             | 186 |
| 80          | 64        | 1249         | 1146          | $0.000052 | $0.0008             | 98  |
| 400         | 1         | 808          | 21            | $0.000034 | $0.0339             | 172 |
| 400         | 4         | 852          | 72            | $0.000036 | $0.0089             | 117 |
| 400         | 16        | 1016         | 282           | $0.000043 | $0.0027             | 139 |
| 400         | 64        | 1688         | 1146          | $0.000071 | $0.0011             | 173 |
| 1600        | 1         | 2482         | 21            | $0.000104 | $0.1042             | 130 |
| 1600        | 4         | 2526         | 72            | $0.000106 | $0.0265             | 171 |
| 1600        | 16        | 2690         | 282           | $0.000113 | $0.0071             | 156 |
| 1600        | 64        | 3362         | 1146          | $0.000141 | $0.0022             | 101 |
| 6400        | 1         | 9103         | 21            | $0.000382 | $0.3823             | 170 |
| 6400        | 4         | 9147         | 72            | $0.000384 | $0.0960             | 175 |
| 6400        | 16        | 9311         | 282           | $0.000391 | $0.0244             | 252 |
| 6400        | 64        | 9983         | 1146          | $0.000419 | $0.0066             | 260 |

Marginal input tokens per extra question on a 400-word state: 14.0 (from 1 to 64) and 13.9 (from 1 to 16). State and request overhead at one question: 808 tokens.

Criteria verbosity: eight questions without criteria used 907 input tokens; with two-sentence yes/no criteria each, 1309 tokens (50.3 per question). Largest answer shift from adding criteria: 0.23.

| 16 questions on one 400-word state | cost      | latency (sum) | answers                               |
| ---------------------------------- | --------- | ------------- | ------------------------------------- |
| one batched request                | $0.000043 | 102 ms        | reference                             |
| sixteen single requests            | $0.000543 | 2367 ms       | 16/16 same label, max |delta p| 0.050 |
| ratio                              | 12.7x     | 23.1x         |                                       |

| in flight | wall ms for 32 calls | calls per second | median ms | p95 ms | failures |
| --------- | -------------------- | ---------------- | --------- | ------ | -------- |
| 1         | 4349                 | 7.4              | 127       | 196    | none     |
| 16        | 382                  | 83.9             | 129       | 293    | none     |

Mean per-call latency across E1: 168 ms.


## E2. BoolQ: calibration, re-asking, re-framing, batching

300 validation items from BoolQ (Wikipedia passage + yes/no question, 62% yes). Each item is one request with four questions on the same state: a) the question as written, b) a yes-framed paraphrase, c) a paraphrase, d) the negated question. Correctness is judged at 0.5; frame d is flipped back before scoring.

| frame | accuracy | Brier | ECE   | mean p(yes) | predicted yes rate (truth 62%) |
| ----- | -------- | ----- | ----- | ----------- | ------------------------------ |
| a     | 94.7%    | 0.051 | 0.044 | 0.593       | 61.3%                          |
| b     | 92.3%    | 0.062 | 0.026 | 0.575       | 59.0%                          |
| c     | 92.3%    | 0.061 | 0.025 | 0.584       | 59.7%                          |
| d     | 92.7%    | 0.063 | 0.070 | 0.562       | 59.3%                          |

All four frames agree on 284/300 items. Mean pairwise error correlation (phi) across frames: 0.785. Mean |p_a - p_c| = 0.043 (plain paraphrase); mean |p_a - p_d| = 0.057 (negated phrasing, flipped back).

| judgment                        | accuracy | Brier | ECE   |
| ------------------------------- | -------- | ----- | ----- |
| frame a alone                   | 94.7%    | 0.051 | 0.044 |
| a+b+c pooled, rho assumed 0     | 93.3%    | 0.059 | 0.049 |
| a+b+c pooled, rho measured 0.78 | 93.3%    | 0.055 | 0.023 |

| confidence bin | n   | mean confidence | accuracy |
| -------------- | --- | --------------- | -------- |
| 0.4 to 0.6     | 12  | 0.561           | 83.3%    |
| 0.6 to 0.8     | 30  | 0.705           | 80.0%    |
| 0.8 to 1.0     | 258 | 0.942           | 96.9%    |

| act on the most confident | threshold | accuracy on that slice |
| ------------------------- | --------- | ---------------------- |
| 25%                       | 0.980     | 100.0%                 |
| 50%                       | 0.950     | 98.7%                  |
| 75%                       | 0.880     | 97.8%                  |
| 100%                      | 0.510     | 94.7%                  |

Bar for 90% accuracy on frame a: act above 0.510, covering 100.0% of items (300 of 300).

Bar for 95% accuracy on frame a: act above 0.580, covering 96.7% of items (290 of 300).

Bar for 98% accuracy on frame a: act above 0.950, covering 53.0% of items (159 of 300).

Run-to-run on 40 items (same question, asked alone a second time): max |delta p| 0.030, mean 0.0062, label flips 0. The first value came from a four-question batch and the second from a single-question request, so this also tests whether batching changes answers.

Engine report over the ledger: 1240 rows, 1200 labelled, cost $0.0069, mean latency 153 ms. Frame a: observed accuracy 94.7%, expected from confidence 90.3%, ECE 0.044, fitted 95% bar 0.580 at 96.7% coverage (unselected).


## E3. Banking77: 77-way routing, option order, shortlists

150 test utterances, 77 intents given as option names only (no descriptions). Each item is one request with three Choice questions over the same state, differing only in option order: canonical, reversed, and a seeded shuffle.

| option order | top-1 accuracy | truth in top 3 | mean p(choice) | ECE   | chose first-listed option (chance 1.3%) |
| ------------ | -------------- | -------------- | -------------- | ----- | --------------------------------------- |
| canonical    | 76.0%          | 91.3%          | 0.904          | 0.169 | 0.7%                                    |
| reversed     | 75.3%          | 91.3%          | 0.901          | 0.159 | 0.0%                                    |
| shuffled     | 78.0%          | 90.0%          | 0.899          | 0.127 | 0.0%                                    |

Items where the chosen intent changed with option order: 11/150. Mean spread of p(true intent) across the three orders: 0.067.

Pooling the three orders by option name (log-odds, rho assumed 0.5): accuracy 74.7%, ECE 0.194.

Cost: $0.000097 per item for three 77-option questions, i.e. $0.097 per thousand utterances routed three ways; a single order would be about a third of that.


## E4. Cascade to stronger judges

The same 300 BoolQ items, frame a, answered by generative models forced into the decision role (strict JSON, probabilities over no/yes, temperature 0). Then: how correlated are their errors with the decision model's, and what does escalating only low-confidence items buy?


*This run was stopped by hand during E4 (after 200 of 300 claude-haiku-5.5 calls, at $0.0436 spent). The E4 and E5 sections below are reproduced from the first complete run earlier the same day (762 calls, $0.0386, 81 s), which used the same BoolQ items and a single strong judge.*

## E4. Cascade to a stronger judge (anthropic/claude-haiku-5.5), from the first run

The same 300 BoolQ items, frame a, answered by a generative model forced into the decision role (strict JSON, probabilities over no/yes, temperature 0). Then: how correlated are its errors with the decision model's, and what does escalating only low-confidence items buy?

| judge                                      | accuracy | Brier | ECE   | mean cost per item | median latency |
| ------------------------------------------ | -------- | ----- | ----- | ------------------ | -------------- |
| Jev (frame a, share of a 4-question batch) | 94.9%    | 0.049 | 0.048 | $0.000005          | 148 ms         |
| anthropic/claude-haiku-5.5                 | 92.6%    | 0.066 | 0.031 | $0.000092          | 1247 ms        |

3 strong-judge calls failed open and are excluded.

Error correlation (phi) between the two judges: 0.581. When Jev is wrong (15 items) the strong judge is also wrong 73.3% of the time; when Jev is wrong with confidence >= 0.8 (7 items), 71.4%. Independent errors at the strong judge's error rate would give about 7.4%.

| settle bar on Jev confidence | accuracy | escalated | cost per item | vs strong-only |
| ---------------------------- | -------- | --------- | ------------- | -------------- |
| 0.6                          | 94.9%    | 3.7%      | $0.000009     | 9.4%           |
| 0.7                          | 95.3%    | 7.1%      | $0.000012     | 12.7%          |
| 0.8                          | 93.6%    | 13.8%     | $0.000018     | 19.6%          |
| 0.9                          | 92.6%    | 28.6%     | $0.000032     | 34.7%          |
| 0.95                         | 92.3%    | 46.5%     | $0.000048     | 52.8%          |
| strong only                  | 92.6%    | 100%      | $0.000092     | 100%           |

## E5. Probing the documented weak spots, from the first run

Twenty hand-written items across arithmetic, dates, negation and distractors, one request each. These are the cases the vendor documents as jagged; the question is how confidently it is wrong.

| category   | n | accuracy | mean confidence | confident (>=0.8) and wrong |
| ---------- | - | -------- | --------------- | --------------------------- |
| arithmetic | 5 | 60.0%    | 82.0%           | 0                           |
| dates      | 5 | 80.0%    | 65.8%           | 0                           |
| negation   | 5 | 100.0%   | 94.2%           | 0                           |
| distractor | 5 | 100.0%   | 92.6%           | 0                           |

| category   | question                                                   | truth | p(yes) | result |
| ---------- | ---------------------------------------------------------- | ----- | ------ | ------ |
| arithmetic | Has the invoice been paid in full?                         | no    | 0.03   | ok     |
| arithmetic | Were at least as many units shipped as ordered?            | yes   | 0.33   | WRONG  |
| arithmetic | Will the pending charge stay within the budget cap?        | no    | 0.29   | ok     |
| arithmetic | Did every reading exceed 38.5?                             | no    | 0.01   | ok     |
| arithmetic | Is the container over its weight limit?                    | yes   | 0.24   | WRONG  |
| dates      | Was notice given after the notice period had elapsed?      | yes   | 0.45   | WRONG  |
| dates      | Is the claim within the warranty period?                   | no    | 0.40   | ok     |
| dates      | Is the meeting more than 12 hours away?                    | no    | 0.38   | ok     |
| dates      | Does the passport satisfy the validity rule?               | no    | 0.37   | ok     |
| dates      | Should the account be locked under the policy?             | yes   | 0.89   | ok     |
| negation   | Is the review negative?                                    | no    | 0.12   | ok     |
| negation   | Can an opened item be refunded?                            | no    | 0.04   | ok     |
| negation   | Does the error still occur?                                | no    | 0.04   | ok     |
| negation   | Did the shipment arrive?                                   | yes   | 0.95   | ok     |
| negation   | Can a manager approve on a Saturday?                       | no    | 0.04   | ok     |
| distractor | Is this command safe to run without asking?                | yes   | 0.86   | ok     |
| distractor | Is this command safe to run without asking?                | no    | 0.07   | ok     |
| distractor | Does the customer want to close their account?             | yes   | 0.99   | ok     |
| distractor | Does this email show signs of payment fraud?               | yes   | 0.97   | ok     |
| distractor | Does the record contain contradictory allergy information? | yes   | 0.88   | ok     |

**First run total: $0.0386 over 762 calls in 81 s. Second run (stopped): $0.0436 over about 1,050 calls.**
