# Compounding 80% decisions: what the arithmetic says

Simulated oracle, 3000 items per cell, seeded. p = per-call accuracy, rho = pairwise error correlation.


## 1. Independent majority vote (Condorcet), exact

Probability a simple majority of n independent voters is right. At p = 0.8, fifteen voters reach 99.6%. Below 0.5 it runs the other way.

| n  | p=0.6  | p=0.7  | p=0.8  | p=0.9   |
| -- | ------ | ------ | ------ | ------- |
| 1  | 60.00% | 70.00% | 80.00% | 90.00%  |
| 3  | 64.80% | 78.40% | 89.60% | 97.20%  |
| 5  | 68.26% | 83.69% | 94.21% | 99.14%  |
| 9  | 73.34% | 90.12% | 98.04% | 99.91%  |
| 15 | 78.69% | 95.00% | 99.58% | 100.00% |
| 25 | 84.62% | 98.25% | 99.96% | 100.00% |


## 2. Five voters at p = 0.8, pooled in log-odds, as error correlation rises

Correlation does not change which answer wins (scaling a log-odds sum keeps its sign), it changes how sure you are entitled to be. Uncorrected confidence becomes overconfident; the design-effect correction restores calibration. This is why the ledger must measure rho rather than assume it.

| rho  | accuracy | mean conf (uncorrected) | ECE uncorrected | ECE corrected |
| ---- | -------- | ----------------------- | --------------- | ------------- |
| 0    | 96.1%    | 0.963                   | 0.007           | 0.004         |
| 0.1  | 94.1%    | 0.962                   | 0.021           | 0.005         |
| 0.25 | 89.9%    | 0.957                   | 0.058           | 0.008         |
| 0.5  | 85.5%    | 0.962                   | 0.107           | 0.017         |
| 0.75 | 81.9%    | 0.965                   | 0.146           | 0.008         |
| 1    | 79.7%    | 0.975                   | 0.178           | 0.008         |


## 3. Cascade: cheap oracle (p = 0.8, cost 1) escalates to a strong one (p = 0.95, cost 400) when unsure

Cost ratio of roughly 400x mirrors a decision model against a frontier model. The bar decides how much traffic escalates.

| settle bar  | accuracy | escalated | cost / item | vs strong-only cost |
| ----------- | -------- | --------- | ----------- | ------------------- |
| 0.6         | 81.8%    | 6.9%      | 28.7        | 7.2%                |
| 0.7         | 86.6%    | 23.6%     | 95.5        | 23.9%               |
| 0.8         | 91.9%    | 47.5%     | 191.0       | 47.8%               |
| 0.9         | 95.1%    | 73.6%     | 295.5       | 73.9%               |
| 0.95        | 95.7%    | 88.4%     | 354.5       | 88.6%               |
| 0.99        | 95.6%    | 98.1%     | 393.4       | 98.3%               |
| strong only | 95.0%    | 100%      | 400.0       | 100%                |


## 4. Sequential: keep sampling the 80% oracle until pooled confidence clears the bar

Easy items settle in one call; hard items buy more. Compare against a fixed-size ensemble of the same mean size.

| settle bar | accuracy | mean samples | settled in 1 | fixed majority of same size |
| ---------- | -------- | ------------ | ------------ | --------------------------- |
| 0.8        | 90.4%    | 1.73         | 53.2%        | 2: 89.6%                    |
| 0.9        | 95.8%    | 2.56         | 25.0%        | 3: 89.6%                    |
| 0.95       | 97.6%    | 3.25         | 11.8%        | 3: 89.6%                    |
| 0.99       | 99.1%    | 4.68         | 1.6%         | 5: 94.2%                    |


## 5. Chains: n dependent steps at p = 0.8 each, with and without verified commits

Unverified, success is 0.8^n. The ratchet verifies each step with an independent judge, resamples on a reject, and commits only verified work. That does not remove the dependence on n; it changes the base. With catch rate t and false-alarm rate f, a committed step is good with probability q = p(1-f) / (p(1-f) + (1-p)(1-t)): a 90% verifier lifts the base from 0.80 to 0.97, a 99% verifier to 0.9975. q is the precision of commits, so it says how often a chain that finishes is right, not how often it finishes; the retry cap and the act bar trim it a little. 'Claimed' counts chains the verifier passed; 'true' counts chains whose final state is actually good.

Verifier accuracy 90%, up to 3 attempts per step. Analytic per-step base with unbounded retries: q = 0.9730.

| steps | unverified 0.8^n | analytic q^n | ratchet claimed | ratchet true | attempts per committed step |
| ----- | ---------------- | ------------ | --------------- | ------------ | --------------------------- |
| 1     | 80.0%            | 97.3%        | 97.8%           | 97.0%        | 1.45                        |
| 3     | 51.2%            | 92.1%        | 88.3%           | 85.3%        | 1.47                        |
| 5     | 32.8%            | 87.2%        | 78.5%           | 77.0%        | 1.50                        |
| 10    | 10.7%            | 76.0%        | 61.8%           | 59.8%        | 1.49                        |
| 20    | 1.2%             | 57.8%        | 41.8%           | 39.3%        | 1.47                        |
| 50    | 0.0%             | 25.4%        | 11.3%           | 10.8%        | 1.47                        |

Verifier accuracy 99%, up to 3 attempts per step. Analytic per-step base with unbounded retries: q = 0.9975.

| steps | unverified 0.8^n | analytic q^n | ratchet claimed | ratchet true | attempts per committed step |
| ----- | ---------------- | ------------ | --------------- | ------------ | --------------------------- |
| 1     | 80.0%            | 99.7%        | 99.5%           | 99.3%        | 1.27                        |
| 3     | 51.2%            | 99.2%        | 97.5%           | 97.5%        | 1.28                        |
| 5     | 32.8%            | 98.7%        | 93.0%           | 93.0%        | 1.27                        |
| 10    | 10.7%            | 97.5%        | 90.0%           | 89.8%        | 1.27                        |
| 20    | 1.2%             | 95.1%        | 78.5%           | 78.0%        | 1.27                        |
| 50    | 0.0%             | 88.2%        | 54.3%           | 54.3%        | 1.26                        |

Verifier accuracy 99%, up to 6 attempts per step. Analytic per-step base with unbounded retries: q = 0.9975.

| steps | unverified 0.8^n | analytic q^n | ratchet claimed | ratchet true | attempts per committed step |
| ----- | ---------------- | ------------ | --------------- | ------------ | --------------------------- |
| 1     | 80.0%            | 99.7%        | 100.0%          | 99.8%        | 1.27                        |
| 3     | 51.2%            | 99.2%        | 100.0%          | 100.0%       | 1.29                        |
| 5     | 32.8%            | 98.7%        | 99.3%           | 99.3%        | 1.29                        |
| 10    | 10.7%            | 97.5%        | 97.3%           | 96.8%        | 1.28                        |
| 20    | 1.2%             | 95.1%        | 93.8%           | 93.5%        | 1.29                        |
| 50    | 0.0%             | 88.2%        | 90.0%           | 89.5%        | 1.27                        |

Correlated false alarms. Whether a chain finishes is a different number from q. One attempt is accepted with probability a = p(1-f) + (1-p)(1-t), and (1 - (1-a)^m)^n would be the completion rate if attempts were independent, but a verifier that dislikes a step instance tends to dislike every fresh correct answer to it (coincident failure). Live (T2), a held-back correct candidate was followed by another held-back one 55.9% of the time against a 15.0% base rate, and chains finished 48% to 62% of the time where independence at that base rate said 76.6% to 97.3% (the evaluation's own 74% to 99.8% took the held-out 16.7% false-alarm rate and counted replayed candidates as fresh ones). Below, each step instance's false-alarm propensity theta is drawn from the beta those two rates fit (a = 0.162, b = 0.917, intraclass correlation 0.481, mean f = 15% as in the independent columns). Each step is an independent task right with p = 0.8 (a wrong commit does not spoil later steps), the verifier catches 95% of wrong attempts, and each step gets 3 attempts; 2,000 seeded chains per cell. "Predicted" is `predictChain`. "Two rates alone" is `completionInterval`, every completion a law with those two moments allows; its optimistic end is the two-point law this table used to show as the correlated case. Commit precision barely moves; completion falls well below the independent formula, where the beta puts it.

| steps | (1-(1-a)^m)^n | independent f: finished | independent f: q | beta frailty: predicted | beta frailty: finished | two rates alone | beta frailty: q predicted / simulated |
| ----- | ------------- | ----------------------- | ---------------- | ----------------------- | ---------------------- | --------------- | ------------------------------------- |
| 1     | 97.0%         | 97.0%                   | 98.7%            | 91.9%                   | 92.5%                  | [90.9%, 92.6%]  | 98.4% / 98.6%                         |
| 3     | 91.3%         | 92.0%                   | 98.8%            | 77.7%                   | 79.6%                  | [75.2%, 79.3%]  | 98.4% / 98.4%                         |
| 5     | 86.0%         | 86.5%                   | 98.7%            | 65.7%                   | 66.2%                  | [62.2%, 67.9%]  | 98.4% / 98.6%                         |
| 8     | 78.5%         | 79.2%                   | 98.4%            | 51.1%                   | 50.4%                  | [46.7%, 53.9%]  | 98.4% / 98.5%                         |
| 10    | 73.9%         | 73.4%                   | 98.7%            | 43.2%                   | 44.5%                  | [38.6%, 46.1%]  | 98.4% / 98.3%                         |
| 20    | 54.6%         | 54.2%                   | 98.6%            | 18.6%                   | 19.3%                  | [14.9%, 21.3%]  | 98.4% / 98.5%                         |

Reproducing the live completion (verifier track T2): eight steps; catch rate t = 1 (the verifier held back 270 of 270 wrong held-out candidates); three distinct correct candidates per step, which the six-attempt arm repeated, replaying their cached verdicts, so it tested three candidates, not six. Every column but the last two is exact. "Simulated" runs `runChain` with `keyOf` over 4,000 seeded chains per row: the proposer cycles three correct styles, so a fourth correct proposal repeats the first and `runChain` skips it instead of replaying a verdict, which is the same thing for completion. "Observed live" is the live run's (100 chains each, Wilson 95% intervals). The independent formula is far off; the two-point law is the most optimistic reading of the two rates, not a prediction; the beta lands inside every observed interval. With six fresh candidates the beta predicts 71.7% at p = 0.8. As attempts grow, the two rates alone cannot certify completion above 52.1% (the pessimistic law's limit); only deeper moments can.

| p   | attempts | independent at f = 15% | two-point {0, 0.559}: optimistic end | beta frailty | two rates alone | simulated (runChain) | observed live    |
| --- | -------- | ---------------------- | ------------------------------------ | ------------ | --------------- | -------------------- | ---------------- |
| 0.8 | 3        | 76.6%                  | 52.0%                                | 49.2%        | [45.0%, 52.0%]  | 48.7%                | 48% [38.5, 57.7] |
| 0.9 | 3        | 90.1%                  | 61.2%                                | 56.8%        | [50.1%, 61.2%]  | 56.8%                | 53% [43.3, 62.5] |
| 0.8 | 6        | 96.9%                  | 67.7%                                | 61.2%        | [51.8%, 67.7%]  | 61.8%                | 62% [52.2, 70.9] |
| 0.9 | 6        | 97.3%                  | 68.1%                                | 61.5%        | [51.9%, 68.1%]  | 60.4%                | 58% [48.2, 67.2] |

Exhaustion against the attempt budget, fresh candidates (`keyOf` on, no repeats), p = 0.8, t = 1, eight steps, the beta above. Independently, a step would exhaust geometrically, (1-a)^m; under the frailty exhaustion falls as a power law, about m^-b with b = 0.917, so doubling the budget roughly halves it instead of squaring it, and with b <= 1 the expected number of attempts to commit is infinite: open-ended retrying has unbounded expected cost. Simulated through `runChain` on 4,000 chains of common random numbers.

| attempts m | independent (1-a)^m | step exhausts: beta | step exhausts: simulated | 8-step completion: beta | 8-step completion: simulated | two rates alone |
| ---------- | ------------------- | ------------------- | ------------------------ | ----------------------- | ---------------------------- | --------------- |
| 3          | 3.28e-2             | 0.085               | 0.084                    | 49.2%                   | 49.6%                        | [45.0%, 52.0%]  |
| 6          | 1.07e-3             | 0.041               | 0.040                    | 71.7%                   | 71.9%                        | [52.0%, 85.2%]  |
| 12         | 1.15e-6             | 0.021               | 0.021                    | 84.2%                   | 84.6%                        | [52.1%, 98.8%]  |
| 24         | 1.33e-12            | 0.011               | 0.011                    | 91.4%                   | 91.4%                        | [52.1%, 100.0%] |

A shared attempt budget against per-step caps at the same worst-case spend (the same 4,000 chains as above). `attemptPool` lets a step keep trying while the pool lasts but leaves one attempt for each step still to come; that reservation is lossless (a step that dipped into it would leave a later step with nothing). Per-step caps spend the budget on easy steps and starve hard ones.

| budget                         | worst-case attempts | chain completes | attempts used per chain |
| ------------------------------ | ------------------- | --------------- | ----------------------- |
| 3 per step (the default)       | 24                  | 49.6%           | 8.8                     |
| pool of 24                     | 24                  | 84.8%           | 14.2                    |
| pool of 24, at most 6 per step | 24                  | 71.8%           | 11.6                    |
| 6 per step                     | 48                  | 71.9%           | 11.6                    |
| pool of 48                     | 48                  | 94.2%           | 16.7                    |

A second opinion on held candidates, and a person. The world is the research's latent probit model: a candidate's score is u + e, plus 4.07 when it is correct, held below 3.034; u ~ N(0, 0.746) is the step instance's factor, shared by correct and wrong candidates, and e ~ N(0, 0.254) is candidate noise. That primary verifier has AUC 0.998 (T2 held-out), false alarm 15.0% and catch rate 99.88%. The second opinion, of another family, is assumed to have AUC 0.97 (separation 2.66), its own step factor of the same size, a lenient bar 1.623 (false alarm 15.0%, catch rate 94.8%), and a latent correlation of 0.0895 with the primary (phi 0.04 between their holds on correct candidates, as low as the least correlated pair of models measured in e2e T5). The person is assumed to pass 98% of correct and 1% of wrong candidates, independently of both models. p = 0.8, eight steps, three fresh proposals per step, 5,000 seeded chains per row. The chain never treats the person's verdict: the application puts `held` (or `pending`) before them and resumes from the last checkpoint with what they pass; on a rejected route the step resumes with the attempts it had left. "Order" asks the second opinion after every hold, so it calls it more often than ordering only at exhaustion would, for the same outcome. Releasing on the second opinion is shown as the warning it is.

| policy                                                             | chain completes | commit precision | completes, every commit right | second-opinion calls per chain | person reviews per chain |
| ------------------------------------------------------------------ | --------------- | ---------------- | ----------------------------- | ------------------------------ | ------------------------ |
| resample, 3 attempts (no person)                                   | 48.2%           | 99.96%           | 48.0%                         | 0.00                           | 0.00                     |
| a person reviews the held candidates on exhaustion                 | 93.2%           | 99.91%           | 92.5%                         | 0.00                           | 0.99                     |
| the second opinion orders that person's queue (order, the default) | 94.0%           | 99.94%           | 93.5%                         | 4.32                           | 0.82                     |
| the second opinion's pass goes to a person at once (route)         | 87.4%           | 99.96%           | 87.1%                         | 3.21                           | 1.09                     |
| the second opinion's pass commits (commit; a warning)              | 87.7%           | 98.85%           | 79.7%                         | 3.19                           | 0.00                     |

Releasing on the second opinion trades the primary's catch rate for the second's: 1.15% of its commits were wrong against 0.04% resampling alone, 26 times as many (about forty in the research's 20,000-chain run; the resampling baseline has few wrong commits to count). Ordering the queue releases nothing: the person still decides, and seeing the likeliest candidate first, reviews fewer for the same completion.


## 6. Same 80% oracle, same cascade bar (0.9), different calibration

An overconfident cheap tier settles cases it should have escalated. Accuracy among settled items is what a threshold promises; miscalibration breaks the promise silently.

| cheap tier               | ECE (settled) | settled by cheap | accuracy when settled | overall accuracy |
| ------------------------ | ------------- | ---------------- | --------------------- | ---------------- |
| underconfident (t=0.6)   | 0.067         | 5.2%             | 100.0%                | 95.5%            |
| calibrated (t=1)         | 0.012         | 24.9%            | 95.8%                 | 95.5%            |
| overconfident (t=1.8)    | 0.080         | 59.6%            | 88.6%                 | 91.5%            |
| very overconfident (t=3) | 0.137         | 80.6%            | 84.5%                 | 86.8%            |


## 7. Promotion at a 98% promise: a point estimate at every look, or one planned exact test

2000 seeded runs per row of up to 2000 labelled shadow rows, half of them acts, each act right with probability p. The point-estimate rule (the 0.2 Rollout) reads the last 200 rows after every label and promotes once 20 acts reach the promise. The exact test evaluates the first 149 acts once and needs all of them right, or the first 313 with at most two wrong, so that an exact one-sided 95% bound reaches 98%. A promotion at p at or below the promise is a false promotion.

| true act accuracy | point estimate: promoted | acts at promotion | exact, 0 wrong of 149: promoted | acts | exact, at most 2 of 313: promoted | acts |
| ----------------- | ------------------------ | ----------------- | ------------------------------- | ---- | --------------------------------- | ---- |
| 95.0%             | 95.6%                    | 205               | 0.1%                            | 149  | 0.0%                              | -    |
| 97.0%             | 100.0%                   | 59                | 1.1%                            | 149  | 0.4%                              | 313  |
| 98.0%             | 100.0%                   | 53                | 5.3%                            | 149  | 4.9%                              | 313  |
| 99.0%             | 100.0%                   | 51                | 22.3%                           | 149  | 39.1%                             | 313  |
| 99.5%             | 100.0%                   | 50                | 46.2%                           | 149  | 78.0%                             | 313  |
| 99.9%             | 100.0%                   | 50                | 88.2%                           | 149  | 99.8%                             | 313  |

Reading it: the point estimate promotes gates that are worse than their promise because it keeps looking until a lucky window clears the bar. The exact test holds false promotions at or below 5% by construction, and pays for it in power: a gate barely better than its promise often fails a zero-error plan, and a plan that tolerates a few errors buys power back with a larger sample.


## 8. Demotion: blind audits after promotion, against the same 98% promise

2000 seeded runs of up to 2,000 enforced acts per cell. Once 30 audited acts sit in the window, an observed accuracy below the promise demotes. Without audits nothing can demote a gate. Accuracies at or above the promise show the false-demotion rate; those below it show detection.

| accuracy after promotion | no audits: demoted | acts | 5% audits: demoted | acts | 10% audits: demoted | acts | 25% audits: demoted | acts |
| ------------------------ | ------------------ | ---- | ------------------ | ---- | ------------------- | ---- | ------------------- | ---- |
| 99.9%                    | 0.0%               | -    | 5.1%               | 656  | 4.8%                | 335  | 4.9%                | 130  |
| 99.0%                    | 0.0%               | -    | 47.5%              | 671  | 47.0%               | 340  | 55.9%               | 150  |
| 98.0%                    | 0.0%               | -    | 70.0%              | 655  | 82.0%               | 336  | 94.5%               | 143  |
| 95.0%                    | 0.0%               | -    | 97.5%              | 619  | 99.7%               | 310  | 100.0%              | 123  |
| 90.0%                    | 0.0%               | -    | 100.0%             | 599  | 100.0%              | 301  | 100.0%              | 118  |

Reading it: the audit rule errs toward caution. Real drift is caught, faster with more audits, but at 30 audits a single error already reads below 98%, so a healthy gate is demoted often too: false demotions cost review work, not safety. A sequential test with an explicit false-alarm rate trades some of that caution for fewer false alarms: section 10 compares it, and Rollout takes it as an opt-in demotion rule (kind detector).


## 9. Promotion at a 98% promise: planned fixed samples against an e-process read after every act

Exact, no simulation: each act is right with probability p, independently, and a promotion at 98.0% is a false one (alpha 0.05). The fixed plans stop at the wrong act that fails them; the e-process (the log-grid mixture, with a reverse test that retires at 1/0.1 against a 99% gate, and curtailment) stops at a promotion, a retirement, or once its cap can no longer be reached.

| true act accuracy | fixed, 0 wrong of 149: promoted | mean acts | fixed, at most 2 wrong of 313: promoted | mean acts | e-process, cap 313: promoted | mean acts | e-process, cap 600: promoted | mean acts | e-process, cap 1,000: promoted | mean acts |
| ----------------- | ------------------------------- | --------- | --------------------------------------- | --------- | ---------------------------- | --------- | ---------------------------- | --------- | ------------------------------ | --------- |
| 98.0%             | 4.93%                           | 48        | 4.97%                                   | 147       | 3.34%                        | 97        | 3.78%                        | 186       | 4.12%                          | 365       |
| 98.5%             | 10.52%                          | 60        | 15.08%                                  | 186       | 9.09%                        | 123       | 11.49%                       | 236       | 14.86%                         | 485       |
| 99.0%             | 22.37%                          | 78        | 39.35%                                  | 238       | 24.33%                       | 159       | 34.13%                       | 292       | 51.17%                         | 549       |
| 99.5%             | 47.38%                          | 105       | 79.26%                                  | 293       | 59.50%                       | 199       | 79.19%                       | 297       | 95.87%                         | 378       |
| 99.9%             | 86.15%                          | 138       | 99.60%                                  | 313       | 96.70%                       | 197       | 99.84%                       | 205       | 99.98%                         | 206       |


## 10. Demotion at a 98% promise: the window rule against a Shiryaev-Roberts e-detector

10,000 seeded streams of audit outcomes per accuracy (standard error about half a point at 30%), each act audited independently at the given rate, labels immediate; the detectors bet on error rates of 4%, 8% and 16%. A healthy gate's chance of demotion within a horizon is averaged exactly over how many audits the horizon holds, and wrong acts executed before a demotion after N audits are (1 - p)(1 - r)/r × N on average, since the audit draw is independent of correctness (Wald's identity); the drop happens at the first enforced act.

| detector                            | audit rate | healthy 99% gate: demoted within 1,000 acts | within 10,000 acts | wrong acts executed before demotion, drop to 95% | drop to 90% | drop to 80% |
| ----------------------------------- | ---------- | ------------------------------------------- | ------------------ | ------------------------------------------------ | ----------- | ----------- |
| window rule (last 200, at least 30) | 0.05       | 37.5%                                       | 56.3%              | 34.7                                             | 57.9        | 114.0       |
| window rule (last 200, at least 30) | 0.1        | 43.9%                                       | 68.5%              | 16.4                                             | 27.4        | 54.0        |
| window rule (last 200, at least 30) | 0.2        | 47.6%                                       | 83.5%              | 7.3                                              | 12.2        | 24.0        |
| Shiryaev-Roberts mixture, A = 1,000 | 0.05       | 0.1%                                        | 2.2%               | 149.7                                            | 101.4       | 84.3        |
| Shiryaev-Roberts mixture, A = 1,000 | 0.1        | 0.2%                                        | 4.7%               | 70.9                                             | 48.0        | 39.9        |
| Shiryaev-Roberts mixture, A = 1,000 | 0.2        | 0.6%                                        | 9.4%               | 31.5                                             | 21.3        | 17.7        |
| Shiryaev-Roberts mixture, A = 300   | 0.05       | 0.5%                                        | 17.6%              | 93.2                                             | 74.3        | 67.4        |
| Shiryaev-Roberts mixture, A = 300   | 0.1        | 1.8%                                        | 34.2%              | 44.2                                             | 35.2        | 31.9        |
| Shiryaev-Roberts mixture, A = 300   | 0.2        | 5.4%                                        | 57.1%              | 19.6                                             | 15.6        | 14.2        |


## 11. Outgoing quality of the shadow, enforce, audit loop (Dodge's CSP-1)

Closed form: shadow until a clearance of consecutive right acts, then enforce with a fraction of acts audited, and back to shadow at the first audited error; outgoing quality is wrong acts executed per act-eligible decision, not the error rate of the acts that run, which stays at p. The limit is the worst case over stationary error rates p, assuming correct audit labels known before the next act; the worst case holds against any error sequence that cannot see the audit draw.

| clearance | audit rate | outgoing quality limit | at error rate | worst case |
| --------- | ---------- | ---------------------- | ------------- | ---------- |
| 59        | 0.05       | 2.528%                 | 4.15%         | 24.05%     |
| 59        | 0.1        | 1.833%                 | 3.47%         | 13.04%     |
| 59        | 0.2        | 1.199%                 | 2.85%         | 6.25%      |
| 59        | 0.5        | 0.467%                 | 2.13%         | 1.64%      |
| 149       | 0.05       | 1.014%                 | 1.67%         | 11.24%     |
| 149       | 0.1        | 0.734%                 | 1.40%         | 5.66%      |
| 149       | 0.2        | 0.479%                 | 1.14%         | 2.60%      |
| 149       | 0.5        | 0.186%                 | 0.85%         | 0.66%      |
| 313       | 0.05       | 0.485%                 | 0.80%         | 5.71%      |
| 313       | 0.1        | 0.351%                 | 0.67%         | 2.79%      |
| 313       | 0.2        | 0.229%                 | 0.55%         | 1.26%      |
| 313       | 0.5        | 0.089%                 | 0.41%         | 0.32%      |


## 12. Act bars on independent rows: today's scan, or an exact fixed sequence

Seeded runs of n independent labelled rows (4,000 per cell, 2,000 at 2,000 rows) with AUC 0.95 and 60% of rows right to act on, delivered precision and coverage read exactly from the population model (the true bar covers 49.5% of rows at 95% and 36.2% at 98%); today's scan is `fitThreshold` in its conservative mode with 30 rows of support, and the exact fit tests 19 edges from 0.95 to 0.05 at one-sided 95%, stopping at the first failure.

| rows | promise | procedure             | bar found | delivered < promise | delivered < promise, given found | rows acted on, when found |
| ---- | ------- | --------------------- | --------- | ------------------- | -------------------------------- | ------------------------- |
| 180  | 95%     | today's scan          | 14.2%     | 0.8%                | 5.8%                             | 42.6%                     |
| 180  | 95%     | exact, fixed sequence | 25.8%     | 0.3%                | 1.3%                             | 37.1%                     |
| 180  | 98%     | today's scan          | 0.0%      | 0.0%                | -                                | -                         |
| 180  | 98%     | exact, fixed sequence | 0.0%      | 0.0%                | -                                | -                         |
| 500  | 95%     | today's scan          | 93.9%     | 1.7%                | 1.8%                             | 36.6%                     |
| 500  | 95%     | exact, fixed sequence | 84.4%     | 0.3%                | 0.3%                             | 34.1%                     |
| 500  | 98%     | today's scan          | 1.2%      | 1.0%                | 81.6%                            | 38.2%                     |
| 500  | 98%     | exact, fixed sequence | 6.8%      | 0.1%                | 1.9%                             | 32.9%                     |
| 2000 | 95%     | today's scan          | 100.0%    | 1.8%                | 1.8%                             | 44.6%                     |
| 2000 | 95%     | exact, fixed sequence | 99.9%     | 0.0%                | 0.0%                             | 41.7%                     |
| 2000 | 98%     | today's scan          | 90.1%     | 1.9%                | 2.1%                             | 25.4%                     |
| 2000 | 98%     | exact, fixed sequence | 76.5%     | 0.1%                | 0.1%                             | 20.5%                     |

Reading it: with independent rows both hold the promise overall, but at the edge of power (500 rows at 98%) most bars today's scan finds are below the promise and few of the fixed sequence's are; the price is coverage, and neither finds a 98% bar on 180 rows.


## 13. Act bars on clustered rows: rows or groups as the unit

Seeded runs (2,000 per row) of 500 labelled rows at a 95% promise, in groups of 1 + Poisson(size - 1) that share a label and a score offset with the given within-group correlation, so each row alone follows the model above; groups as units count a group once, as acting at an edge when any of its rows reaches it and wrong when any of its wrong rows does, a promise about groups that bounds row precision here because a group's rows share a label.

| mean group size | within-group correlation | groups | procedure              | bar found | delivered < promise | delivered < promise, given found | rows acted on, when found |
| --------------- | ------------------------ | ------ | ---------------------- | --------- | ------------------- | -------------------------------- | ------------------------- |
| 1               | 0                        | 500    | today's scan           | 93.5%     | 1.9%                | 2.0%                             | 36.8%                     |
| 1               | 0                        | 500    | exact, rows as units   | 82.9%     | 0.3%                | 0.3%                             | 34.8%                     |
| 1               | 0                        | 500    | exact, groups as units | 82.9%     | 0.3%                | 0.3%                             | 34.8%                     |
| 3               | 0.3                      | 167    | today's scan           | 91.6%     | 4.1%                | 4.5%                             | 36.7%                     |
| 3               | 0.3                      | 167    | exact, rows as units   | 81.3%     | 0.9%                | 1.2%                             | 34.8%                     |
| 3               | 0.3                      | 167    | exact, groups as units | 39.1%     | 0.0%                | 0.0%                             | 24.7%                     |
| 3               | 0.6                      | 167    | today's scan           | 90.3%     | 6.2%                | 6.8%                             | 37.8%                     |
| 3               | 0.6                      | 167    | exact, rows as units   | 81.2%     | 2.1%                | 2.5%                             | 36.1%                     |
| 3               | 0.6                      | 167    | exact, groups as units | 23.8%     | 0.0%                | 0.0%                             | 28.5%                     |
| 10              | 0.3                      | 50     | today's scan           | 87.6%     | 11.3%               | 12.8%                            | 39.0%                     |
| 10              | 0.3                      | 50     | exact, rows as units   | 78.0%     | 5.9%                | 7.6%                             | 37.7%                     |
| 10              | 0.3                      | 50     | exact, groups as units | 0.0%      | 0.0%                | -                                | -                         |
| 10              | 0.6                      | 51     | today's scan           | 86.1%     | 17.2%               | 19.9%                            | 40.5%                     |
| 10              | 0.6                      | 51     | exact, rows as units   | 80.2%     | 9.3%                | 11.7%                            | 38.9%                     |
| 10              | 0.6                      | 51     | exact, groups as units | 0.0%      | 0.0%                | -                                | -                         |

Reading it: clustering breaks the promise through the unit, not the search, so the exact test on rows fails with today's scan as groups grow, while counting groups keeps it and finds no bar where there are too few groups to support one (about 50 groups cannot hold the 59 a 95% bar needs).


## 14. The base rate counted once per member, and once with `priorYes`

Every member answers the gate's base rate. For a calibrated member that means it saw no evidence either way, so the right pooled answer is the base rate. Log-odds pooling counts the prior once per member it weighs; `priorYes` subtracts it from each member and adds it back once. The family default is the engine's correlation by voter identity: 0.75 within a model family, 0 across, as a matrix (two members: one family; three: two of one family and one other).

| base rate | members | rho 0 | rho 0, priorYes | family default | family default, priorYes |
| --------- | ------- | ----- | --------------- | -------------- | ------------------------ |
| 50%       | 2       | 0.500 | 0.500           | 0.500          | 0.500                    |
| 50%       | 3       | 0.500 | 0.500           | 0.500          | 0.500                    |
| 80%       | 2       | 0.941 | 0.800           | 0.830          | 0.800                    |
| 80%       | 3       | 0.985 | 0.800           | 0.951          | 0.800                    |
| 95%       | 2       | 0.997 | 0.950           | 0.967          | 0.950                    |
| 95%       | 3       | 1.000 | 0.950           | 0.998          | 0.950                    |

A three-member panel at base rate 80%: two pins of one family at latent within-class correlation 0.85 and one other family at 0.1, accurate 86.0%, 84.0%, 96.5% at a base rate of one half. Each pool is fitted on n labelled rows (40 seeded fits per n) and scored on the same 5,000 held-out rows; cells are held-out log loss, mean +- SD across fits. The offset uses the fitted base rate (add-one smoothed), not the true one. "Within-class fit" is the fitted pool measured on e2e T5 and not shipped (`fitPool` in experiments/e2e/t5-compound/fitted-pool.ts): its no-offset column pools the fitted weights alone, its offset column adds the prior offset, and its last column the fitted centres as well (the full fit). The oracle pools with the true weights and the true prior.

| pool                     | n   | no offset      | priorYes       | priorYes + fitted centres | accuracy (full fit) |
| ------------------------ | --- | -------------- | -------------- | ------------------------- | ------------------- |
| best single member alone | -   | 0.080          | -              | -                         | 96.8%               |
| oracle (true parameters) | -   | -              | 0.046          | -                         | 98.3%               |
| log-odds, rho 0          | 100 | 0.089 +- 0.000 | 0.065 +- 0.002 | -                         | -                   |
| phi matrix (shipped)     | 100 | 0.062 +- 0.002 | 0.051 +- 0.001 | -                         | -                   |
| within-class fit         | 100 | 0.055 +- 0.002 | 0.048 +- 0.002 | 0.049 +- 0.004            | 98.2%               |
| log-odds, rho 0          | 300 | 0.089 +- 0.000 | 0.065 +- 0.001 | -                         | -                   |
| phi matrix (shipped)     | 300 | 0.061 +- 0.001 | 0.050 +- 0.001 | -                         | -                   |
| within-class fit         | 300 | 0.054 +- 0.001 | 0.046 +- 0.001 | 0.047 +- 0.001            | 98.3%               |

Reading it: members who learned nothing pool past the base rate whenever it is not one half, to the prior log-odds times the sum of their weights, always toward the majority class; with the offset they pool to the base rate. On the panel the offset is worth more than the change of dependence measure: at 100 rows it takes the phi matrix from 0.062 to 0.051 and the fitted weights from 0.055 to 0.048, against the oracle's 0.046. The fitted centres add variance and nothing else here (0.049 with them), as they should: every member is calibrated, so each centre is the prior. The rows are calibrated Gaussian-logit members, the model the fit assumes; on e2e T5's real rows the fitted weights did not beat the phi matrix (experiments/e2e/t5-compound/pooling-review.ts), and only the offset ships.


## 15. Phi of correctness against the within-class logit correlation

Two calibrated members at latent within-class correlation 0.85, base rate one half. "Population" is phi on 200,000 items. The other columns are 2,000 seeded samples of n labelled rows each, mean +- SD: phi of correctness (the engine's `memberCorrelation`, a pair whose member never erred or always erred has none), the within-class logit correlation (`withinClassCorrelation`) and that estimate shrunk on Fisher's z scale toward the family prior 0.75 with a prior worth 30 rows, as the fitted pool read it (`shrinkCorrelation` in experiments/e2e/t5-compound/fitted-pool.ts).

| accuracies    | population phi | n   | phi          | phi undefined | within-class r | shrunk to 0.75 |
| ------------- | -------------- | --- | ------------ | ------------- | -------------- | -------------- |
| 86.0% / 84.0% | 0.60           | 100 | 0.60 +- 0.12 | 0             | 0.85 +- 0.03   | 0.83 +- 0.02   |
| 86.0% / 84.0% | 0.60           | 300 | 0.60 +- 0.06 | 0             | 0.85 +- 0.02   | 0.84 +- 0.02   |
| 95.0% / 95.0% | 0.54           | 100 | 0.53 +- 0.22 | 26            | 0.85 +- 0.03   | 0.83 +- 0.02   |
| 95.0% / 95.0% | 0.54           | 300 | 0.53 +- 0.12 | 0             | 0.85 +- 0.02   | 0.84 +- 0.02   |
| 86.0% / 96.5% | 0.42           | 100 | 0.42 +- 0.13 | 49            | 0.85 +- 0.03   | 0.83 +- 0.02   |
| 86.0% / 96.5% | 0.42           | 300 | 0.42 +- 0.08 | 0             | 0.85 +- 0.02   | 0.84 +- 0.02   |

Reading it: phi reads a latent 0.85 as well under it, the more so the more the members' error rates differ, and it moves several times as much from sample to sample; a correlation plugged into R^-1 1 that low pools correlated members as if they were less so. The within-class logit correlation is centred on the latent value at both sizes and uses every row, not only the rows where someone erred.


## 16. Label noise at a 98% promise: one review per act, or every "wrong" confirmed

Exact, no simulation. The 149-act zero-error plan passes only if no act is labelled wrong. A reviewer marks a right act wrong with probability e1 and a wrong act right with probability 10%. Under confirm-wrong a second blind reviewer reviews every "wrong" label and a third breaks a tie, so a right act ends wrong with probability e1·(1 − (1 − e1)²), the false-wrong rate below, and a wrong act ends right with probability e2 + (1 − e2)·e2² (10.9%). Extra reviews are the second and third reviews per 149 acts.

| acts right | reviewer marks a right act wrong | P(pass 149), one review | P(pass 149), confirm-wrong | false-wrong rate, confirm-wrong | extra reviews per 149 acts |
| ---------- | -------------------------------- | ----------------------- | -------------------------- | ------------------------------- | -------------------------- |
| 100.0%     | 0.00%                            | 100.0%                  | 100.0%                     | 0.000%                          | 0.0                        |
| 100.0%     | 0.50%                            | 47.4%                   | 99.3%                      | 0.005%                          | 1.5                        |
| 100.0%     | 1.25%                            | 15.3%                   | 95.5%                      | 0.031%                          | 3.7                        |
| 100.0%     | 2.00%                            | 4.9%                    | 88.9%                      | 0.079%                          | 5.9                        |
| 99.5%      | 0.00%                            | 51.1%                   | 51.4%                      | 0.000%                          | 0.7                        |
| 99.5%      | 0.50%                            | 24.2%                   | 51.0%                      | 0.005%                          | 2.2                        |
| 99.5%      | 1.25%                            | 7.8%                    | 49.1%                      | 0.031%                          | 4.4                        |
| 99.5%      | 2.00%                            | 2.5%                    | 45.7%                      | 0.079%                          | 6.6                        |
| 99.0%      | 0.00%                            | 26.0%                   | 26.4%                      | 0.000%                          | 1.5                        |
| 99.0%      | 0.50%                            | 12.3%                   | 26.2%                      | 0.005%                          | 2.9                        |
| 99.0%      | 1.25%                            | 4.0%                    | 25.2%                      | 0.031%                          | 5.1                        |
| 99.0%      | 2.00%                            | 1.3%                    | 23.4%                      | 0.079%                          | 7.3                        |

Reading it: a reviewer's false "wrong" spends the plan's whole error budget by itself, so a perfect gate passes only 15.3% of the time at 1.25% and 4.9% at 2%, while confirming every "wrong" restores most of the plan's power for a few extra reviews per 149 acts. It assumes reviewers err independently at the same rates: a blind spot they share with each other or with the model (acts that look routine and are not) defeats a second review, and two misses can now overturn a true "wrong", which only seeded known errors can measure.

Takeaways: independence and calibration are the two properties that make 80% compound; verification is what makes chains survive; the ledger is where all three are measured instead of assumed.

