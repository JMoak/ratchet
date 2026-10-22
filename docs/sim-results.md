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

Unverified, success is 0.8^n. The ratchet verifies each step with an independent judge, resamples on a reject, and commits only verified work. That does not remove the dependence on n; it changes the base. With catch rate t and false-alarm rate f, a committed step is good with probability q = p(1-f) / (p(1-f) + (1-p)(1-t)): a 90% verifier lifts the base from 0.80 to 0.97, a 99% verifier to 0.9975. The retry cap and the act bar trim that a little. 'Claimed' counts chains the verifier passed; 'true' counts chains whose final state is actually good.

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

Reading it: the audit rule errs toward caution. Real drift is caught, faster with more audits, but at 30 audits a single error already reads below 98%, so a healthy gate is demoted often too: false demotions cost review work, not safety. A sequential test with an explicit false-alarm rate would trade some of that caution for fewer false alarms; it is not built.

Takeaways: independence and calibration are the two properties that make 80% compound; verification is what makes chains survive; the ledger is where all three are measured instead of assumed.

