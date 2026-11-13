# Label efficiency and label noise: a valid measured statement from fewer human labels

*Research note, 2026-11-12. Foundations review: how far a strong second judge, sampling design, sequential tests and a review protocol can cut the human labels behind a measured grade, what reviewer error does to the acceptance test, what agreement between judges can bound without labels, and what a logged label propensity unlocks. Docs only; URLs are in the sources at the end. Citations carry [verified] (abstract or text fetched in this session) or [memory].*

People's time is the binding constraint. One pilot produced 9 person answers in two days; another turned 41,628 hook events into 4 answered prompts. Model calls are cheap. So the question is how few human labels can still support the one statement that promotes a gate: an exact one-sided 95% lower bound of at least 0.98 on act precision (`src/acceptance.ts`, 149 clean acts, or 313 with at most two wrong).

The answer has five parts:

- **The judge cannot lower the floor.** No method that stays valid whatever the second judge is like can make that statement from fewer than 138 human labels at 80% power, or 149 at full power, even for a perfect gate (section 1).
- **The judge buys power, not validity, and little of it.** Near 99% precision it saves 9% to 38% of the labels needed for 80% power, through an exact two-phase stratified test (section 3). Prediction-powered intervals are unsafe at these error rates (section 2).
- **The judge is worth much more as a gate member.** Acting only where it agrees raises the chance that a 149-act plan passes from 22% to between 44% and 99% (section 4).
- **A sequential plan removes the one-shot failure.** An anytime-valid e-process ends the "one unlucky sample freezes the configuration" problem without losing exactness (section 5).
- **Reviewer error is the same size as the error budget.** A protocol of adjudication plus seeded known errors is needed before 149 clean labels mean 98% (section 7).

## Setting and notation

- An *act* is a decision row the policy would have acted on and an oracle answered.
- Act precision is θ and the act error rate is ε = 1 − θ.
- The promise is T = 0.98, so the null boundary is ε₀ = 0.02. Every bound is one-sided at α = 0.05 unless stated.
- A strong judge from another model family gives a verdict on every act: s = 1 means "acting was right", s = 0 means it flags the act.
- A person's label is y, with the same coding.
- The four cells of (s, y) are p11, p10 (the judge passed a wrong act: a miss), p01 (the judge flagged a right act: a false alarm) and p00 (the judge flagged a wrong act: a catch).
- The judge's *agreement* is p11 + p00, its *recall on errors* is p00 / (p00 + p10), and its *flagged share* is w_B = p01 + p00, with w_A = 1 − w_B.

The simulations use two judge models:

- **Symmetric.** The judge flips the human label with probability 1 − agreement, independently of the truth, so its recall on errors equals its agreement. This is optimistic.
- **Recall 0.5.** The judge catches half the gate's errors, and false alarms make up the rest of the disagreement: f = (1 − agreement − ε·0.5)/θ. This is a shared blind spot of the kind measured between a Jev pin and a model with correlated errors, and it is pessimistic.

## 1. The label floor

**Theorem.** Consider any procedure with the following properties:

- It reads the judge's verdicts on any number of acts.
- It chooses at most n acts to label. The choice may be adaptive: it may depend on the verdicts, on earlier labels and on an independent random seed.
- It accepts or rejects.
- It is valid for every joint law of (verdict, truth) under which act precision is at most 0.98, meaning P(accept) ≤ α there.

Then, for every law Q under which every act is right, Q(accept) ≤ α / 0.98^n.

**Proof.**

1. Fix Q: some law of the judge's verdicts, with every truth equal to "right".
2. Build P: the verdicts have the same law as under Q, and each truth is independent of the verdicts and of every other truth, wrong with probability 0.02. Act precision under P is 0.98, so P is in the null and P(accept) ≤ α.
3. Fix the verdicts and the seed. The *all-right path* is the sequence of label reads the procedure makes when every label it reads says "right". It is determined by the verdicts and the seed, and it reads k ≤ n distinct acts.
4. Let A be the event that every label read is "right". Under P, given the verdicts and the seed, A has probability 0.98^k ≥ 0.98^n, because each read act is independently right with probability 0.98.
5. On A, the procedure follows the all-right path and makes the same decision it makes under Q with the same verdicts and seed. The verdicts and the seed have the same law under P and Q.
6. Therefore P(accept) ≥ P(accept and A) ≥ 0.98^n · Q(accept).
7. Combining with step 2: Q(accept) ≤ α / 0.98^n. ∎

**Consequences.**

- A power of β against a perfect gate needs 0.98^n ≤ α/β:
  - β = 0.8 gives n ≥ ln(0.0625)/ln(0.98) = 137.24, so 138 labels.
  - β = 1 gives n ≥ 148.28, so 149 labels.
  - At a 95% promise the same floors are 55 and 59; at 99%, 276 and 299.
- The floor holds for prediction-powered inference, PPI++, stratified PPI, active inference, active testing, importance-weighted audits and e-values alike.
- It holds for any judge: the procedure must be valid when the judge is uninformative, so its power against good gates is capped by the same inequality.
- For a gate that is not perfect, power is lower still.
- A procedure that stops at a random time is covered with n taken as its maximum number of labels.

The only escape is a procedure whose validity rests on an assumption about the judge, such as a bound on its miss rate brought in from other data. That is not this gate's evidence, so in the project's vocabulary it is *borrowed*.

The result matches the published limit. Dorner, Nastl and Hardt show that when the judge is no more accurate than the model it evaluates, no debiasing method can cut the ground-truth labels needed by more than half (ICLR 2025) [verified].

The practical reading: no measurement trick removes the need for about 149 human labels per 98% claim. Labels can be made cheaper per act, the gate can be made better so that a plan passes more often, or a weaker grade can be accepted.

## 2. Prediction-powered inference in the rare-error regime

**Estimators.** In each estimator below, the human labels are a uniform random sample of n acts out of N judge-labelled acts.

- **PPI** (Angelopoulos, Bates, Fannjiang, Jordan, Zrnic) [verified]:
  - Point estimate: θ̂_PP = s̄_N − (1/n)·Σ(s_i − y_i).
  - Interval: θ̂_PP ± z·√(σ̂²_s/N + σ̂²_{s−y}/n).
  - The intervals rest on the central limit theorem (CLT).
- **PPI++** (Angelopoulos, Duchi, Zrnic) [verified]:
  - Point estimate: θ̂_λ = ȳ_n + λ̂·(s̄_N − s̄_n).
  - Weight: λ̂ = Ĉov(y, s) / ((1 + n/N)·V̂ar(s)) [memory for the exact (1 + n/N) factor].
  - Variance: V̂ar(y − λ̂s)/n + λ̂²·V̂ar(s)/N.
  - Asymptotically it is never worse than the human labels alone.
- **Active inference** (Zrnic and Candès) [verified]:
  - Each act is labelled with probability π_i, with ξ_i ~ Bernoulli(π_i), and θ̂ = (1/N)·Σ[s_i + (y_i − s_i)·ξ_i/π_i].
  - This is the augmented inverse-propensity-weighted (AIPW) form.
  - π is proportional to an uncertainty score and mixed with uniform sampling: π^(τ) = (1 − τ)·π + τ·n_b/N.
  - Validity comes from the CLT (the martingale CLT when sequential), with non-asymptotic analogues in an appendix.
- **Stratified PPI** (Fisch et al.) [verified]: applies PPI within strata with weights w_k and a tuned λ_k per stratum. Its oracle allocation is n_k ∝ w_k·√Var(y − λ_k·s | k). Its limitations section states that the guarantees are asymptotic.
- **Cross-prediction-powered inference** [memory]: trains the predictor on folds of the labelled data.
- **Confidence-driven inference** [verified]: applies active inference to LLM annotations and reports more than 25% fewer human labels on three tasks.
- **Prediction-powered e-values** [verified]: give anytime-valid prediction-powered procedures.

**Validity conditions** for the CLT intervals above:

- The labelled rows are a probability sample, with known inclusion probabilities, from the same population as the judge-labelled rows.
- The judge's outputs are fixed before any label is read, and not fitted on the labelled rows unless cross-fitted.
- n and N are large enough for the normal approximation.

Nothing is assumed about the judge's accuracy. That is their strength.

**Gain at the promise.** With N much larger than n:

- PPI++ multiplies the effective number of human labels by 1/(1 − ρ²), where ρ is the correlation between the judge's verdict and the human label.
- PPI with λ = 1 multiplies it by Var(y)/Var(y − s).

Near 99% precision the label variance θ(1 − θ) is tiny, so a judge that disagrees often adds far more variance than it removes.

| precision | judge agreement | ρ² | PPI++ multiplier | PPI (λ = 1) multiplier |
| --- | --- | --- | --- | --- |
| 0.80 | 0.90 | 0.532 | 2.14 | 1.66 |
| 0.80 | 0.95 | 0.732 | 3.73 | 3.26 |
| 0.80 | 0.99 | 0.939 | 16.52 | 16.06 |
| 0.85 | 0.90 | 0.476 | 1.91 | 1.34 |
| 0.85 | 0.95 | 0.685 | 3.17 | 2.61 |
| 0.85 | 0.99 | 0.925 | 13.37 | 12.81 |
| 0.90 | 0.90 | 0.390 | 1.64 | 0.96 |
| 0.90 | 0.95 | 0.605 | 2.53 | 1.86 |
| 0.90 | 0.99 | 0.897 | 9.73 | 9.06 |
| 0.95 | 0.90 | 0.252 | 1.34 | 0.52 |
| 0.95 | 0.95 | 0.448 | 1.81 | 0.99 |
| 0.95 | 0.99 | 0.822 | 5.61 | 4.79 |
| 0.98 | 0.90 | 0.122 | 1.14 | 0.22 |
| 0.98 | 0.95 | 0.251 | 1.33 | 0.41 |
| 0.98 | 0.99 | 0.655 | 2.90 | 1.98 |
| 0.99 | 0.90 | 0.066 | 1.07 | 0.11 |
| 0.99 | 0.95 | 0.144 | 1.17 | 0.21 |
| 0.99 | 0.99 | 0.490 | 1.96 | 1.00 |
| 0.995 | 0.90 | 0.034 | 1.04 | 0.06 |
| 0.995 | 0.95 | 0.078 | 1.08 | 0.10 |
| 0.995 | 0.99 | 0.326 | 1.48 | 0.50 |

*Reproduce: closed form under the symmetric judge model. With e = 1 − agreement, the cells are p00 = ε(1 − e), p10 = εe, p01 = θe and p11 = θ(1 − e). Then ρ = (p11·p00 − p10·p01)/√(P(s=1)·P(s=0)·θ·ε), Var(y) = θε, and Var(y − s) = p10 + p01 − (p10 − p01)². Deterministic.*

Where PPI helps and where it does not:

- At precision 0.99, a 90%-agreement judge under plain PPI is worth nine times fewer labels than people alone (multiplier 0.11). PPI++ protects against that but gains at most 7% to 96%.
- In the bar-fitting region (0.8 to 0.9) the same judges multiply effective labels 1.6 to 16 times. The judge belongs there, in the estimated grade, not at the promise.

**Collapse of the intervals.** Each CLT interval estimates its variance from the labelled sample. At 1% errors, small samples often hold no disagreement and no error, so the estimated variance is zero and the interval shrinks to a point.

The chance that a labelled sample holds no judge–human disagreement is:

| judge agreement | n = 50 | n = 149 | n = 313 |
| --- | --- | --- | --- |
| 0.95 | 0.077 | 0.000 | 0.000 |
| 0.98 | 0.364 | 0.049 | 0.002 |
| 0.99 | 0.605 | 0.224 | 0.043 |

A correct procedure accepts a gate whose true precision is exactly 0.98 no more than 5% of the time. Here are the false-acceptance rates; "exact stratified" is the section 3 test:

| judge agreement | judge model | n | PPI (CLT) | PPI++ (CLT) | Wald | exact stratified |
| --- | --- | --- | --- | --- | --- | --- |
| 0.95 | symmetric | 50 | 0.012 | 0.355 | 0.355 | 0 (no outcome can pass) |
| 0.95 | symmetric | 149 | 0.026 | 0.153 | 0.194 | 0 (no outcome can pass) |
| 0.95 | symmetric | 313 | 0.032 | 0.101 | 0.128 | 0.0478 |
| 0.99 | symmetric | 50 | 0.002 | 0.366 | 0.366 | 0 (no outcome can pass) |
| 0.99 | symmetric | 149 | 0.009 | 0.112 | 0.199 | 0 (no outcome can pass) |
| 0.99 | symmetric | 313 | 0.018 | 0.076 | 0.125 | 0.0267 |
| 0.95 | recall 0.5 | 50 | 0.019 | 0.367 | 0.367 | 0 (no outcome can pass) |
| 0.95 | recall 0.5 | 149 | 0.032 | 0.183 | 0.198 | 0.0498 |
| 0.95 | recall 0.5 | 313 | 0.037 | 0.113 | 0.124 | 0.0499 |
| 0.99 | recall 0.5 | 50 | 0.607 | 0.607 | 0.369 | 0 (no outcome can pass) |
| 0.99 | recall 0.5 | 149 | 0.222 | 0.296 | 0.200 | 0.0498 |
| 0.99 | recall 0.5 | 313 | 0.154 | 0.172 | 0.130 | 0.0499 |

*Reproduce:*
- *CLT columns: Monte Carlo with 20,000 runs per cell, N = 5,000 judge-labelled acts, labelled cells drawn as a multinomial of the four (s, y) cells, mulberry32 PRNG.*
- *Seeds continue the counter of the n80 table below (base 20261112, plus one per call).*
- *One-sided 95% lower bound: z = 1.6449.*
- *Exact-stratified column: no randomness. The allocation was planned on the 0.99 scenario and rebuilt with the strata weights of the 0.98 scenario. Its exact size is the maximum, over a 4,000-point grid of the null boundary, of the probability of the acceptance region. "0" means that design has no acceptable outcome at that n.*

Reading the table:

- PPI with λ = 1 fails when the judge misses errors: 0.607 at n = 50. A judge that is biased toward "right" makes the uncorrected judge mean pass whenever no disagreement is sampled.
- PPI++ and Wald fail everywhere at these sizes.
- In the n80 table below, PPI++ "reaches 80% power" with 10 labels in every scenario. That is the collapse at work, not a finding.

**Conclusion.** The CLT members of the PPI family never feed a measured grade. They may feed an estimated grade only under the preconditions in section 10.1.

## 3. Exact use of the judge: two-phase stratification

This is two-phase sampling for stratification [memory: Neyman 1938] applied with the strong judge as the fallible classifier. It is the exact, finite-sample relative of Tenenbein's double sampling for misclassified binomial data [memory; title, journal and DOI confirmed in a search listing, publisher page returned 403].

**Design.**

1. **Phase 1.** The judge labels every act in the phase. Stratum A is the acts it passed (s = 1), stratum B the acts it flagged (s = 0). The weights w_A = N_A/N and w_B = N_B/N are known, and the strata are recorded before any human label is read.
2. **Phase 2.** People label n_A acts drawn uniformly from A and n_B drawn uniformly from B, with n_A and n_B fixed in advance (see the allocation rule).

Let x_A and x_B be the wrong acts found in each stratum. The error rate is ε = w_A·p_A + w_B·p_B.

**Test statistic.** T = w_A·x_A/n_A + w_B·x_B/n_B, the stratified estimate of ε.

**Acceptance rule.**
- Accept the gate if and only if S(t_obs; ε₀) ≤ α, where S(t; ε₀) = max over (p_A, p_B) on the boundary w_A·p_A + w_B·p_B = ε₀ of P_{p_A,p_B}(T ≤ t).
- With independent binomials, P(T ≤ t) = Σ_{x_A} Bin(x_A; n_A, p_A)·F_B(⌊(t − w_A·x_A/n_A)·n_B/w_B⌋; n_B, p_B), where F_B is the binomial distribution function and terms with a negative argument are dropped.
- P(T ≤ t) decreases in each of p_A and p_B, because binomials are stochastically ordered. So the supremum over the composite null {w_A·p_A + w_B·p_B ≥ ε₀} is attained on its boundary.
- Parameterise the boundary by p_A ∈ [max(0, (ε₀ − w_B)/w_A), min(1, ε₀/w_A)], with p_B = (ε₀ − w_A·p_A)/w_B.
- In practice, precompute the acceptance region as {T ≤ t*}. Here t* is the largest candidate value of T (all values of T for x_A up to 60 and x_B up to n_B) whose size S(t*; ε₀) is at most α. Binary-search the sorted candidates, which works because S grows with t. Evaluate S on a coarse boundary grid during the search, then verify the chosen t* on a fine grid (1,500 points over an interval no longer than 0.022) and step down if the verification fails.
- A cautious implementation may require S ≤ 0.049, to cover grid error.
- This is a Buehler-type exact bound for a weighted sum of binomials [memory: Buehler 1957].

**Lower bound on precision.**
- Let U = inf{ε₀ : S(t_obs; ε₀) ≤ α}. Report 1 − U.
- S(t; ε₀) falls as ε₀ rises, because the boundary moves to larger error rates, so U is found by bisection.
- The test at ε₀ = 0.02 is the special case.

**Allocation rule.**
- Before any label is read, choose n_B to maximise the exact power P_{p̂_A,p̂_B}(T ≤ t*) at anticipated stratum error rates. Those come from shadow estimates or the judge's own rates, and the guess affects only power, never validity.
- Search n_B over round(n·f) for f ∈ {0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.13, 0.16, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6}, plus the proportional allocation round(n·w_B) ± 2, 2× and 3×.
- With proportional allocation T is the pooled error count over n, and the test reduces to today's Clopper-Pearson test, because (1 − p_A)^{n_A}·(1 − p_B)^{n_B} under a fixed mean is largest at equal p (Jensen). So the stratified family never loses more than rounding against the classical plan.

**Why the allocation must be fixed first.** If n_A, n_B or the strata were chosen after some labels were read, the design would depend on outcomes. The acceptance region's size would then no longer be its computed value, which is the same optional-design problem the planned sample avoids.

**Streaming variant.** When acts arrive over time, use Poisson sampling. Each act is selected with probability π_A or π_B by its stratum, drawn from a logged seed at decision time. Condition on the realised n_A and n_B. Within each stratum the selected acts are still independent draws, because selection never depends on a label, so the same exact test applies conditionally.

**Superpopulation caveat.** The test treats w_A and w_B as known. That is exact for a claim about this phase's acts. For a claim about future traffic, w_B is an estimate and an underestimate makes the bound optimistic when p_B > p_A.
- Example: 99 flags in 5,000 acts (0.0198) has a one-sided 99.5% upper bound of 0.0255.
- Spend α_w = 0.005 on that bound, run the test at α = 0.045, and take the maximum in S over w_B in its interval as well.
- I have not simulated this variant.

**Result.** Human labels for 80% power, the probability of passing at the two plan sizes in use, and the composite gate of section 4. N = 5,000.

Classical exact reference:

| true precision | labels for 80% power (errors allowed) | pass prob. at 149 (0 errors) | at 236 (≤ 1) | at 313 (≤ 2) | at 386 (≤ 3) |
| --- | --- | --- | --- | --- | --- |
| 0.99 | 969 (≤ 12) | 0.224 | 0.316 | 0.393 | 0.460 |
| 0.995 | 386 (≤ 3) | 0.474 | 0.670 | 0.793 | 0.870 |

With the judge:

| true prec. | judge agrees | judge model | recall on errors | flagged share w_B | PPI n80 (CLT, invalid) | PPI++ n80 (CLT, invalid) | exact stratified n80 [n_A + n_B] | stratified pass prob. at 149 | stratified pass prob. at 313 | composite precision (coverage) | composite pass prob. at 149 / composite n80 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.99 | 0.90 | symmetric | 0.90 | 0.1080 | > 2500 | 10 | 814 [651 + 163] | 0.214 | 0.382 | 0.9989 (89.2%) | 0.846 / 149 |
| 0.99 | 0.95 | symmetric | 0.95 | 0.0590 | > 2500 | 10 | 719 [676 + 43] | 0.191 | 0.355 | 0.9995 (94.1%) | 0.924 / 149 |
| 0.99 | 0.98 | symmetric | 0.98 | 0.0296 | 1800 | 10 | 645 [588 + 57] | 0.130 | 0.368 | 0.9998 (97.0%) | 0.970 / 149 |
| 0.99 | 0.99 | symmetric | 0.99 | 0.0198 | 670 | 10 | 630 [594 + 36] | 0.123 | 0.336 | 0.9999 (98.0%) | 0.985 / 149 |
| 0.99 | 0.90 | recall 0.5 | 0.50 | 0.1000 | > 2500 | 10 | 884 [769 + 115] | 0.220 | 0.394 | 0.9944 (90.0%) | 0.436 / 386 |
| 0.99 | 0.95 | recall 0.5 | 0.50 | 0.0500 | > 2500 | 10 | 838 [754 + 84] | 0.205 | 0.381 | 0.9947 (95.0%) | 0.456 / 386 |
| 0.99 | 0.98 | recall 0.5 | 0.50 | 0.0200 | 1650 | 10 | 811 [779 + 32] | 0.200 | 0.332 | 0.9949 (98.0%) | 0.467 / 386 |
| 0.99 | 0.99 | recall 0.5 | 0.50 | 0.0100 | 10 | 10 | 783 [775 + 8] | 0.119 | 0.378 | 0.9949 (99.0%) | 0.470 / 386 |
| 0.995 | 0.90 | symmetric | 0.90 | 0.1040 | > 2500 | 10 | 271 [228 + 43] | 0.478 | 0.810 | 0.9994 (89.6%) | 0.920 / 149 |
| 0.995 | 0.95 | symmetric | 0.95 | 0.0545 | 1800 | 10 | 249 [233 + 16] | 0.464 | 0.869 | 0.9997 (94.5%) | 0.961 / 149 |
| 0.995 | 0.98 | symmetric | 0.98 | 0.0248 | 540 | 10 | 238 [231 + 7] | 0.408 | 0.932 | 0.9999 (97.5%) | 0.985 / 149 |
| 0.995 | 0.99 | symmetric | 0.99 | 0.0149 | 145 | 10 | 238 [234 + 4] | 0.443 | 0.984 | 0.9999 (98.5%) | 0.992 / 149 |
| 0.995 | 0.90 | recall 0.5 | 0.50 | 0.1000 | > 2500 | 10 | 322 [241 + 81] | 0.471 | 0.795 | 0.9972 (90.0%) | 0.661 / 236 |
| 0.995 | 0.95 | recall 0.5 | 0.50 | 0.0500 | 1750 | 10 | 326 [306 + 20] | 0.458 | 0.790 | 0.9974 (95.0%) | 0.675 / 236 |
| 0.995 | 0.98 | recall 0.5 | 0.50 | 0.0200 | 540 | 10 | 276 [259 + 17] | 0.461 | 0.824 | 0.9974 (98.0%) | 0.683 / 236 |
| 0.995 | 0.99 | recall 0.5 | 0.50 | 0.0100 | 10 | 10 | 265 [259 + 6] | 0.388 | 0.826 | 0.9975 (99.0%) | 0.686 / 236 |

*Reproduce:*
- *Classical: for each n, c(n) is the largest c whose Clopper-Pearson lower bound on (n − c)/n is at least 0.98. Power is P(Bin(n, ε) ≤ c(n)), and n80 is the smallest n with power at least 0.8. Exact.*
- *Exact stratified: exact power. n80 by bisection on [60, 2400], stopped at width 4, so each n80 is within 4 labels. The search grid uses 120 boundary points and verification uses 1,500.*
- *PPI and PPI++ n80: Monte Carlo. Scan n = 10 to 195 in steps of 5, 200 to 990 in steps of 10, and 1,000 to 2,500 in steps of 50, with 1,000 runs at seed s + n. Confirm the first n that reaches 0.8 with 8,000 runs at seed s + 7n. Here s starts at 20261112 and increases by one per call, looping over precision, then judge model, then agreement, with PPI before PPI++.*
- *Composite: classical exact at precision 1 − p10/(p11 + p10).*

Reading:
- Stratification saves 9% to 35% of the labels for 80% power at precision 0.99 (630 to 884 against 969), and 16% to 38% at 0.995 (238 to 326 against 386).
- At n = 149 it is no better than the classical plan (within 0.004), as section 1 predicts.
- At 313 labels and precision 0.995 it raises the pass probability from 0.79 to 0.93 or 0.98 with judges that catch 98% to 99% of errors.
- The gain is small because the test must stay valid when the residual error sits in the under-sampled stratum. Bounding the error rate among acts the judge passed still costs about 3/δ labels for a budget δ.

## 4. The judge as a gate member

If the strong judge labels every act anyway, the better use is to let the gate act only where the judge also passes the act: the T5 cascade, which met 98% where nothing else did. The composite gate's precision is 1 − p10/(p11 + p10) and its coverage is w_A of the original acts.

Its acceptance plan is today's classical plan, run on the composite's acts. From the table:

- At precision 0.99, a 149-act zero-error plan passes 85% to 99% of the time with judges that catch 90% to 99% of errors, at a coverage cost of 2% to 11% of acts sent to review. Without the judge it passes 22% of the time.
- With a recall-0.5 judge it passes 44% to 47% of the time, and 66% to 69% at precision 0.995.

What it changes:

- It changes the gate, not the measurement. It is a new configuration, so the evidence version must move.
- The floor of 149 labels still holds.
- Stratification is then pointless: no flagged act is ever acted on.
- The gain depends entirely on the judge's recall on *this gate's* errors, which must be measured, never assumed (see open questions).

## 5. Anytime-valid acceptance: the mixture e-process

Today's planned sample is evaluated once, and a failure is final for the configuration. At a true precision of 0.99, a 149-act plan fails 78% of the time. A sequential plan replaces "pass or be rejected" with "pass when the evidence suffices", and stays exact.

**Construction.** Test H0: ε ≥ ε₀ = 0.02 on the labelled acts in planned order. For a labelled act with x = 1 when wrong:

- Likelihood-ratio factor against an alternative ε₁ < ε₀: f(x; ε₁) = (ε₁/ε₀)^x·((1 − ε₁)/(1 − ε₀))^{1−x}.
- Mixture e-process: E_t = ∫ Π_{i ≤ t} f(x_i; ε₁) dπ(ε₁), with π uniform on (0, ε₀). In practice, use a 200-point midpoint grid.
- Accept the gate at the first t with E_t ≥ 1/α = 20.

**Validity.**
- Under any ε ≥ ε₀, E[f(x; ε₁)] = ε·ε₁/ε₀ + (1 − ε)·(1 − ε₁)/(1 − ε₀). This equals 1 at ε = ε₀ and decreases in ε when ε₁ < ε₀, so each factor has mean at most 1.
- So E_t is a nonnegative supermartingale under every null law.
- By Ville's inequality, P(sup_t E_t ≥ 20) ≤ 0.05. Acceptance is therefore valid at any stopping time: continuous monitoring, early stops, label gaps [memory: Ville 1939; the betting framework of Waudby-Smith and Ramdas generalises it, verified].
- A fixed alternative (ε₁ = 0.01 or 0.005) is the same construction with a point mass. It is Wald's sequential probability ratio test without the rejection boundary [memory].

**Confidence sequence for the bound.** For each ε₀ on a grid, run the e-process with its alternatives uniform on (0, ε₀). The upper bound on the error rate at time t is the largest ε₀ that no e-process has yet rejected. Report 1 − that value.

**Ordering rule.** Process acts in ledger order and update only on the longest prefix of the planned acts that is fully labelled (a sealed prefix). Labels may arrive out of order, for example because an adjudicated "wrong" takes longer. Updating in arrival order would make the processing order depend on outcomes.

Retries count once and group caps apply, as in today's plan.

**Cost.**
- With zero errors, acceptance needs 224 clean labels under the mixture, 296 with ε₁ = 0.01, and 198 with ε₁ = 0.005, against 149 for the fixed plan.
- Each wrong label costs 68 (ε₁ = 0.01) or 91 (ε₁ = 0.005) further clean labels.

| e-process | true precision | P(accept by 313 labels) | by 969 | by 100,000 | median labels to accept |
| --- | --- | --- | --- | --- | --- |
| fixed ε₁ = 0.01 | 0.99 | 0.051 | 0.639 | 1.000 | 780 |
| fixed ε₁ = 0.01 | 0.995 | 0.223 | 0.987 | 1.000 | 434 |
| fixed ε₁ = 0.01 | 0.98 (null) | 0.003 | 0.031 | 0.048 | never |
| fixed ε₁ = 0.01 | 0.975 (null) | 0.000 | 0.005 | 0.005 | never |
| fixed ε₁ = 0.005 | 0.99 | 0.242 | 0.566 | 1.000 | 751 |
| fixed ε₁ = 0.005 | 0.995 | 0.600 | 0.973 | 1.000 | 290 |
| fixed ε₁ = 0.005 | 0.98 (null) | 0.030 | 0.049 | 0.050 | never |
| fixed ε₁ = 0.005 | 0.975 (null) | 0.010 | 0.013 | 0.013 | never |
| mixture | 0.99 | 0.105 | 0.517 | 1.000 | 935 |
| mixture | 0.995 | 0.316 | 0.968 | 1.000 | 340 |
| mixture | 0.98 (null) | 0.010 | 0.026 | 0.045 | never |
| mixture | 0.975 (null) | 0.003 | 0.004 | 0.005 | never |

*Reproduce: 10,000 runs per row. Seed 424242 + round(10⁴·θ) + the length of the method's name ("fixed 0.01", "fixed 0.005", "mixture"), mulberry32. Cap 100,000 labels. Each run accepts at the first t ≥ t\*(k), where t\*(k) is the fewest labels with k wrong at which E_t ≥ 20 (E_t rises with t for fixed k). An earlier run with 2,000 runs, seed 7 + round(1000·θ) + name length and cap 20,000 gave the same medians.*

**Comparison with the planned test.**
- At 0.99 the e-process needs a median of 750 to 935 labels; the planned test needs 969 for 80% power and allows 12 errors.
- At 0.995 the e-process needs a median of 290 to 434; the planned test needs 386.
- False acceptance over 100,000 labels is 0.045 to 0.050, at Ville's bound as theory says.
- What it buys: no final rejection on a single unlucky sample, a gate that promotes as soon as the evidence suffices, and the same construction serving the sequential demotion test already on the roadmap. In that test the null is ε ≤ 0.02 and the alternative above it, read from the audits.
- Prediction-powered e-values [verified] could in principle add the judge. By section 1 they cannot go below the floor, and I did not simulate them.

## 6. Active testing and importance-sampled audits

**Literature.**
- Sawade, Landwehr, Bickel and Scheffer derive the instance-sampling distribution that minimises the error of an active risk estimate, with confidence intervals (ICML 2010) [verified].
- Kossen, Farquhar, Gal and Rainforth select test points to label and remove the resulting bias while reducing variance (ICML 2021) [verified].
- Farquhar, Gal and Rainforth give unbiased corrective weights (PURE and LURE) for actively selected data (ICLR 2021) [verified; the estimator names from memory].
- Zrnic and Candès's rule labels with probability proportional to √E[(y − f)² | x], the expected error magnitude, mixed with uniform sampling so π is never near zero [verified].

All of these weight a labelled row by the inverse of its selection probability, so all of them need that probability.

**What error-weighted sampling buys for estimation.** With the judge's verdict as the predicted error, Neyman allocation n_k ∝ w_k·√(p_k(1 − p_k)) gives the following (deterministic, closed form):

| true prec. | judge agrees | recall | flagged w_B | error among flagged p_B | error among passed p_A | Neyman share to flagged | variance vs uniform | inclusion-prob. ratio flagged : passed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.99 | 0.90 | 0.90 | 0.1080 | 8.3% | 0.112% | 50.0% | 0.360 | 8.3 |
| 0.99 | 0.95 | 0.95 | 0.0590 | 16.1% | 0.053% | 50.0% | 0.190 | 15.9 |
| 0.99 | 0.98 | 0.98 | 0.0296 | 33.1% | 0.021% | 50.0% | 0.078 | 32.8 |
| 0.99 | 0.99 | 0.99 | 0.0198 | 50.0% | 0.010% | 50.0% | 0.040 | 49.5 |
| 0.99 | 0.99 | 0.50 | 0.0100 | 50.0% | 0.505% | 6.7% | 0.571 | 7.1 |
| 0.995 | 0.90 | 0.90 | 0.1040 | 4.3% | 0.056% | 50.0% | 0.360 | 8.6 |
| 0.995 | 0.95 | 0.95 | 0.0545 | 8.7% | 0.026% | 50.0% | 0.190 | 17.3 |
| 0.995 | 0.98 | 0.98 | 0.0248 | 19.8% | 0.010% | 50.0% | 0.078 | 39.3 |
| 0.995 | 0.99 | 0.99 | 0.0149 | 33.2% | 0.005% | 50.0% | 0.040 | 66.1 |
| 0.995 | 0.99 | 0.50 | 0.0100 | 25.0% | 0.253% | 8.0% | 0.586 | 8.6 |

Under symmetric noise the Neyman share is exactly 50%, because w_A·σ_A = w_B·σ_B there.

For *estimating* precision (an estimated grade), error-weighted sampling cuts variance to 0.04 to 0.36 of uniform with a good judge, or about 0.58 with a recall-0.5 judge. Flagged acts get 7 to 66 times the inclusion probability of passed acts.

**What it buys for testing.** Only the gains of section 3. The exact test must guard the case where the residual error sits among the acts the judge passed, which are sampled at the lowest probability. One error found there moves that stratum's bound sharply:

| n_A | exact upper bound on p_A at 0 errors | at 1 error | at 2 errors |
| --- | --- | --- | --- |
| 150 | 1.98% | 3.12% | 4.14% |
| 300 | 0.99% | 1.57% | 2.08% |
| 600 | 0.50% | 0.79% | 1.05% |

With a continuous π, such as one proportional to the judge's probability that the act is wrong, the importance weight 1/π of a rare error found at small π dominates any estimate. Exact or betting bounds on importance-weighted means scale with 1/π_min.

**What must be logged.**

- Per row, at decision time, before any label: the inclusion probability π_i, the stratum, the design's identity (rates, strata rule, seed), and whether the draw selected the row.
- These are needed on *unlabelled* rows too. The Horvitz-Thompson estimate's denominator is the whole population, and a selected row whose label never arrives is non-response, not "not selected".
- A propensity reconstructed afterwards from configuration is fragile once `auditRate` changes over time.
- Enforce a floor on π (defensive mixing with uniform sampling).

## 7. Label noise in the acceptance test

**Model.**
- A reviewer marks a right act wrong with probability e1 (false alarm) and a wrong act right with probability e2 (miss).
- The probability that an act is *labelled* wrong is q_w = ε·(1 − e2) + θ·e1.
- The acceptance test sees only the labels, so it bounds q_w, not ε.

**What a zero-error pass certifies.**
- Zero wrong of 149 gives the exact bound q_w ≤ U = 1 − 0.05^{1/149} = 1.990%.
- Since θ·e1 ≥ 0, q_w ≥ ε·(1 − e2), so ε ≤ U/(1 − e2): the certified precision is 1 − U/(1 − e2).
- If e1 were known exactly, the sharper Rogan-Gladen form applies: θ = (q_r − e2)/(1 − e1 − e2), with q_r = 1 − q_w the labelled-right rate [memory: Rogan and Gladen 1978]. But e1 is never known exactly, and ignoring it is conservative.
- When e2 is only bounded, e2 ≤ e2⁺ at confidence 1 − α_s, the union bound gives ε ≤ U_{α_p}/(1 − e2⁺) at confidence 1 − α_p − α_s.
- Exact intervals that carry the uncertainty in sensitivity and specificity exist for prevalence (Reiczigel, Földi and Ózsvári 2010) [verified]. Here 1 − e2 plays the role of sensitivity and 1 − e1 of specificity.

**Why e1 at or above the error budget makes the promise unverifiable.**
- For a perfect gate, q_w = e1. If e1 ≥ 0.02, the label stream of a perfect gate has the same law as, or a worse law than, a gate of precision 1 − e1 ≤ 0.98 reviewed without error. That gate is in the null.
- Any test valid on these labels therefore passes a perfect gate with probability at most α, at every n.
- Below the budget the cost is steep. The labelled acts needed for 80% power on a *perfect* gate, choosing the errors allowed per n, are:

| reviewer e1 | labels for 80% power on a perfect gate |
| --- | --- |
| 0.005 | 386 |
| 0.010 | 969 |
| 0.0125 | 1,799 |
| 0.015 | 4,320 |
| 0.019 | more than 40,000 |

Each e1 behaves exactly like a gate whose error rate equals e1 under perfect labels: 386 and 969 are the classical n80 at precision 0.995 and 0.99.

**The end-to-end relabel.** 153 of 157 label slots agreed, so d = 4/157 = 2.55%, with an exact two-sided 95% interval of 0.70% to 6.39%.
- For two independent labellers with error rates e_L and e_R on a binary label, P(disagree) = e_L + e_R − 2·e_L·e_R.
- With equal rates e, 2e(1 − e) = d, so e = (1 − √(1 − 2d))/2 = 1.29% per reviewer. The upper end of the interval gives 3.31%.
- If the relabeller were perfect, the original labels erred on 2.55%.
- Disagreement only bounds the *sum* of the two error rates from below. Errors both labellers share are invisible, exactly as for two judges (section 8).
- All four disagreements were on items flagged ambiguous, in urgency and moderation corpora rather than tool acts.

So per-reviewer error is plausibly 1% to 3%: the same size as the 2% budget.

**Certificate and pass probability of the 149-act zero-error plan under noise.** Pass probability is (1 − q_w)^149.

| e1 | e2 | certified precision on a pass (e2 known, e1 ignored) | P(pass), true 0.99 | P(pass), true 0.995 | P(pass), perfect gate |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0.9801 | 0.224 | 0.474 | 1.000 |
| 0 | 0.1 | 0.9779 | 0.260 | 0.511 | 1.000 |
| 0 | 0.25 | 0.9735 | 0.326 | 0.571 | 1.000 |
| 0 | 0.5 | 0.9602 | 0.474 | 0.689 | 1.000 |
| 0.005 | 0 | 0.9801 | 0.106 | 0.225 | 0.474 |
| 0.005 | 0.1 | 0.9779 | 0.123 | 0.242 | 0.474 |
| 0.005 | 0.25 | 0.9735 | 0.155 | 0.271 | 0.474 |
| 0.005 | 0.5 | 0.9602 | 0.225 | 0.327 | 0.474 |
| 0.0125 | 0 | 0.9801 | 0.034 | 0.073 | 0.153 |
| 0.0125 | 0.1 | 0.9779 | 0.040 | 0.078 | 0.153 |
| 0.0125 | 0.25 | 0.9735 | 0.050 | 0.088 | 0.153 |
| 0.0125 | 0.5 | 0.9602 | 0.073 | 0.106 | 0.153 |
| 0.02 | 0 | 0.9801 | 0.011 | 0.023 | 0.049 |
| 0.02 | 0.1 | 0.9779 | 0.013 | 0.025 | 0.049 |
| 0.02 | 0.25 | 0.9735 | 0.016 | 0.028 | 0.049 |
| 0.02 | 0.5 | 0.9602 | 0.024 | 0.034 | 0.049 |
| 0.025 | 0 | 0.9801 | 0.005 | 0.011 | 0.023 |
| 0.025 | 0.1 | 0.9779 | 0.006 | 0.012 | 0.023 |
| 0.025 | 0.25 | 0.9735 | 0.008 | 0.013 | 0.023 |
| 0.025 | 0.5 | 0.9602 | 0.011 | 0.016 | 0.023 |

*Reproduce: exact arithmetic, deterministic.*

The two noise rates act in opposite directions:
- Misses (e2) inflate the certificate silently: a pass is easier and means less.
- False alarms (e1) destroy power: at the relabel-implied 1.25%, a 0.99 gate passes 3.4% of the time instead of 22.4%.
- Misses are the validity problem; false alarms are the throughput problem.

**Corrections from the literature, and why they do not fit here.**
- Latent class models identify both raters' error rates without a gold standard only under conditional independence. Hui and Walter's two-test, two-population design is the classic case [memory; their 1980 paper is listed in search results]; Dawid and Skene generalise it to many raters [memory].
- At 1% errors there are too few positives to fit them.
- Conditional independence is exactly what fails: the acts that fool a model ("routine-looking, not routine", e2e T1) are the ones that fool a quick reviewer.
- Double review with adjudication and seeded known errors are the practical tools.

**Review protocols.** Reviewers are assumed independent with equal (e1, e2). The strong judge's false-alarm rate is 0.02 on right acts, and precision is 0.99.

- **P0, single blind review.**
- **P1, adjudicate every "wrong" label.** A second blind reviewer, not told the first verdict, reviews it. A third breaks a tie, and the majority stands.
  - Effective e1′ = e1·(1 − (1 − e1)²) ≈ 2e1².
  - Effective e2′ = e2 + (1 − e2)·e2².
  - Expected extra reviews per labelled act: q_w·(1 + P(second says right | first says wrong)).
- **P2, P1 plus a recheck of judge-flagged "right" labels.** Every "right" label on an act the strong judge flagged gets two more blind reviews, and becomes "wrong" only if both say wrong.
  - Effective e2″ = e2·((1 − r_J) + r_J·(1 − (1 − e2)²)) + (1 − e2)·e2², with r_J the judge's recall on errors.
  - Effective e1″ = e1′ + (1 − e1)·f_J·e1².
  - Extra reviews: P1's, plus 2·(θ·(1 − e1)·f_J + ε·e2·r_J) per act.

| reviewer e1 | reviewer e2 | judge recall | protocol | effective e1 | effective e2 | extra reviews per 149 labels | P(pass 149), true 0.99 | certified precision on a pass (effective e2 known) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.0125 | 0.10 | n/a | P0 | 1.25e-2 | 0.1000 | 0.0 | 0.040 | 0.9779 |
| 0.0125 | 0.10 | n/a | P1 | 3.11e-4 | 0.1090 | 5.1 | 0.252 | 0.9777 |
| 0.0125 | 0.10 | 0.9 | P2 | 3.14e-4 | 0.0361 | 11.2 | 0.225 | 0.9793 |
| 0.0125 | 0.10 | 0.5 | P2 | 3.14e-4 | 0.0685 | 11.1 | 0.237 | 0.9786 |
| 0.0125 | 0.25 | n/a | P0 | 1.25e-2 | 0.2500 | 0.0 | 0.050 | 0.9735 |
| 0.0125 | 0.25 | n/a | P1 | 3.11e-4 | 0.2969 | 5.1 | 0.334 | 0.9717 |
| 0.0125 | 0.25 | 0.9 | P2 | 3.14e-4 | 0.1703 | 11.6 | 0.276 | 0.9760 |
| 0.0125 | 0.25 | 0.5 | P2 | 3.14e-4 | 0.2266 | 11.3 | 0.300 | 0.9743 |
| 0.005 | 0.10 | n/a | P0 | 5.00e-3 | 0.1000 | 0.0 | 0.123 | 0.9779 |
| 0.005 | 0.10 | n/a | P1 | 4.99e-5 | 0.1090 | 2.9 | 0.262 | 0.9777 |
| 0.005 | 0.10 | 0.9 | P2 | 5.04e-5 | 0.0361 | 9.1 | 0.234 | 0.9793 |
| 0.005 | 0.10 | 0.5 | P2 | 5.04e-5 | 0.0685 | 9.0 | 0.246 | 0.9786 |

*Reproduce: exact arithmetic, deterministic.*

What each protocol does:

- P1 is a throughput fix. It restores the pass probability from 0.040 to 0.252 for about 5 extra reviews per 149 labels. Its validity cost is the small rise in e2 (two misses can overturn a true "wrong"), which seeds measure.
- P2 moves labels only toward "wrong", so it cannot inflate a pass. It cuts misses to 3.6% (recall-0.9 judge) or 6.9% (recall-0.5 judge) for about 6 more reviews per 149.

**Seeded known errors bound the misses.**
- Interleave m planted known-wrong acts into the blind queue, indistinguishable from real ones and passed through the full protocol, including the strong judge for P2.
- If k are missed, e2⁺ is the exact upper bound for k of m at α_s.
- A zero-error plan that keeps 98% at 95% overall then needs n = ⌈ln α_p / ln(1 − 0.02·(1 − e2⁺))⌉, with α_p + α_s = 0.05.
- With errors allowed c, choose n so that the exact upper bound on c wrong of n at α_p is at most 0.02·(1 − e2⁺).

| seeds m | seeds missed | α split (plan / seeds) | miss-rate bound e2⁺ | zero-error acts needed | vs 149 |
| --- | --- | --- | --- | --- | --- |
| 30 | 0 | 0.04 / 0.01 | 14.2% | 187 | +38 |
| 30 | 1 | 0.04 / 0.01 | 20.2% | 200 | +51 |
| 59 | 0 | 0.04 / 0.01 | 7.5% | 173 | +24 |
| 59 | 1 | 0.04 / 0.01 | 10.7% | 179 | +30 |
| 100 | 0 | 0.04 / 0.01 | 4.5% | 167 | +18 |
| 100 | 1 | 0.04 / 0.01 | 6.5% | 171 | +22 |
| 200 | 0 | 0.04 / 0.01 | 2.3% | 164 | +15 |
| 200 | 1 | 0.04 / 0.01 | 3.3% | 165 | +16 |
| 300 | 0 | 0.04 / 0.01 | 1.5% | 162 | +13 |
| 300 | 1 | 0.04 / 0.01 | 2.2% | 163 | +14 |
| 30 | 0 | 0.025 / 0.025 | 11.6% | 207 | +58 |
| 30 | 1 | 0.025 / 0.025 | 17.2% | 221 | +72 |
| 59 | 0 | 0.025 / 0.025 | 6.1% | 195 | +46 |
| 59 | 1 | 0.025 / 0.025 | 9.1% | 202 | +53 |
| 100 | 0 | 0.025 / 0.025 | 3.6% | 190 | +41 |
| 100 | 1 | 0.025 / 0.025 | 5.4% | 194 | +45 |
| 200 | 0 | 0.025 / 0.025 | 1.8% | 187 | +38 |
| 200 | 1 | 0.025 / 0.025 | 2.8% | 188 | +39 |
| 300 | 0 | 0.025 / 0.025 | 1.2% | 185 | +36 |
| 300 | 1 | 0.025 / 0.025 | 1.8% | 187 | +38 |

*Reproduce: exact arithmetic, deterministic.*

Seeds measure the misses only on errors like themselves. Draw them from this gate's real historical errors, for example the nine held-out wrong acts of e2e T1, replayed or lightly mutated, not from invented ones. A seed set that is easier than real errors understates e2.

## 8. Label-free accuracy from several judges

**Literature.**
- Dawid and Skene estimate each rater's confusion matrix by expectation maximisation (EM) under conditional independence [memory].
- Platanios, Blum and Mitchell compute error rates exactly from the agreement rates of several classifiers when their errors are independent, and estimate dependencies under relaxed assumptions (UAI 2014) [verified].
- Parisi, Strino, Nadler and Kluger show that under conditional independence the off-diagonal covariance of the predictions is rank one. Its leading eigenvector ranks the classifiers (the spectral meta-learner, PNAS 2014) [verified].
- Jaffe, Fetaya, Nadler, Jiang and Kluger model dependent classifiers (AISTATS 2016) [verified].
- Ratner et al.'s data programming learns label-function accuracies with a generative model [memory].
- Fu et al. give closed-form, triplet-based parameter recovery (ICML 2020) [verified; the triplet formula below is from memory].
- Identifiability of such latent class models in general needs three conditionally independent views [memory: Allman, Matias and Rhodes 2009, via Kruskal's theorem].

**LLM-judge evidence from 2025 to 2026.**
- Errors of many LLMs are substantially correlated: on one leaderboard, models agree on 60% of the items where both err (Kim et al., ICML 2025) [verified].
- An independence latent class model's 95% intervals for judge false-acceptance rates never covered the human-label value in 42 of 42 cells, and underestimated total error in every cell. A beta-binomial model restored coverage to 0.90 (Zhang and Martinez, NeurIPS 2026 workshop poster) [verified].
- Judge true and false positive rates estimated on a small human set give a finite-sample Type-I-controlled test (Feng et al., ICLR 2026) [verified].
- Selective judging that keeps human agreement above a stated level escalates the rest (Jung, Brahman and Choi; ICLR 2025 per the proceedings listing) [verified].

**What three binary judges reveal.** Only the agreement pattern of each item is observable without labels. Write each item's correctness pattern as (c₁c₂c₃) with 1 = wrong. A pattern and its complement give the same agreement, so the observables are four masses:

- A = m(000) + m(111), all agree.
- O₁ = m(100) + m(011), O₂ = m(010) + m(101) and O₃ = m(001) + m(110), each judge the odd one out.
- The pairwise disagreements D₁₂ = O₁ + O₂, D₁₃ = O₁ + O₃ and D₂₃ = O₂ + O₃ determine the three O's, so pairwise rates carry all the agreement information.

The unknowns are how each mass splits: x₀ = m(111) ∈ [0, A], x₁ = m(011) ∈ [0, O₁], x₂ = m(101) ∈ [0, O₂] and x₃ = m(110) ∈ [0, O₃]. In terms of these:

- e₁ = (O₁ − x₁) + x₂ + x₃ + x₀, e₂ = (O₂ − x₂) + x₁ + x₃ + x₀, and e₃ = (O₃ − x₃) + x₁ + x₂ + x₀.
- Both-wrong masses: b₁₂ = x₃ + x₀, b₁₃ = x₂ + x₀, b₂₃ = x₁ + x₀.
- Majority-vote error = x₀ + x₁ + x₂ + x₃.
- The error of a gate that acts only on unanimous answers = x₀/A.
- Error correlation: φ_ij = (b_ij − e_i·e_j)/√(e_i(1 − e_i)·e_j(1 − e_j)).

**Under conditional independence**, 1 − 2D_ij = a_i·a_j with a_i = 1 − 2e_i. So a₁ = √((1 − 2D₁₂)(1 − 2D₁₃)/(1 − 2D₂₃)), and cyclically for the others: the triplet method.

Positive error correlation adds 4·φ_ij·σ_i·σ_j to the right-hand side. Correlated judges therefore look more accurate, and the method assigns their shared errors to the odd one out.

**Without assumptions, agreement gives only lower bounds:**
- P(at least one of i and j is wrong) ≥ D_ij.
- e_i + e_j ≥ D_ij.
- The sum of all errors is at least O₁ + O₂ + O₃.

Any single judge's error, the majority's error and the unanimous gate's error can each be anything from 0 upward. Upper bounds need an assumption about joint errors.

**The project's two-judge case** (jev-1.13 and haiku-5.5 disagree on 13.8%; the pooled gate is wrong on 3.5%; T5 published table).

- No assumptions:
  - At least one judge is wrong on at least 13.8% of items, and the worse judge errs on at least 6.9%.
  - The both-wrong mass w can be anywhere in [0, 43.1%] even if both judges beat chance, since e_A + e_B = D + 2w ≤ 1.
  - So there is no upper bound on any gate's error.
- With the gate's *labelled* 3.5% error: a pooled gate is wrong on every item both judges get wrong, so w ≤ 3.5%. Then "at least one wrong" lies in [13.8%, 17.3%] (true 15.0%), and e_A + e_B lies in [13.8%, 20.8%] (true 16.2%).
- Label-free with an assumed cap on the error correlation (both judges better than chance): maximise w = (e_A + e_B − D)/2 subject to w ≤ min(e_A, e_B) and φ(w, e_A, e_B) ≤ cap.

| cap on error φ | max both-wrong w | bound on a gate acting only when both agree (w / (1 − D)) | worst-case (e_A, e_B) |
| --- | --- | --- | --- |
| 0 | 0.55% | 0.64% | (6.8%, 8.2%) |
| 0.04 | 0.88% | 1.02% | (6.7%, 8.9%) |
| 0.1 | 1.45% | 1.68% | (7.5%, 9.2%) |
| 0.136 | 1.85% | 2.15% | (8.5%, 9.0%) |
| 0.2 | 2.63% | 3.05% | (9.0%, 10.1%) |
| 0.3 | 4.18% | 4.84% | (10.6%, 11.6%) |
| 0.58 | 13.80% | 16.01% | (20.2%, 21.2%) |
| 0.785 | 43.05% | 49.94% | (50.0%, 50.0%) |

*Reproduce: a deterministic grid over e_A, e_B ∈ (0, 0.5] in steps of 0.0005.*

On the T5 table's rows the realised φ was 0.136 (e_A 13.1%, e_B 3.1%, both wrong 1.2%). The single-ledger held-out figure for the same pair was 0.04, and the fit split gave −0.04 to −0.08.

**Three judges on the T5 rows.** The rows are the judge items of the T5 live `diverse3` ledger's held-out split: jev-1.13 (1), jev-1.14 (2) and haiku-5.5 (3). That is n = 208 of 260 held-out rows; the other 52 are pick items with string truths. On these rows the 1–3 disagreement is 12.5% and the pooled verdict is wrong on 3.4%, slightly different from the published table, which counts every row.

- Observable without labels: all agree on 177; judge 1 is the odd one out on 3, judge 2 on 5, judge 3 on 23. Pairwise disagreement is 3.8% (1–2), 12.5% (1–3) and 13.5% (2–3).
- Truth from labels: errors 11.5%, 12.5% and 3.8%; 3 items with all three wrong; the majority wrong on 10.1%; a unanimous-only gate wrong on 3 of 177 acts (1.7%); the pooled verdict wrong on 3.4%.
- The triplet method gives errors of 1.3%, 2.6% and 11.5%: it hands the two Jev pins' shared errors to haiku.

Identification regions. The sample proportions are treated as exact and every split consistent with the stated assumptions is enumerated in counts. Only agreement patterns are used, which gives a valid but possibly loose outer region.

| assumptions | jev-1.13 error | jev-1.14 error | haiku error | majority-vote error | unanimous-only gate error (true 1.7%) |
| --- | --- | --- | --- | --- | --- |
| none | 0 to 100% | 0 to 100% | 0 to 100% | 0 to 100% | 0 to 100% |
| each judge better than chance | 0 to 50.0% | 0 to 50.0% | 0 to 50.0% | 0 to 51.4% | 0 to 50.8% |
| + cross-family φ ≤ 0.3 (Jev pair free) | 0 to 13.9% | 0 to 14.9% | 0 to 13.9% | 0 to 14.9% | 0 to 4.0% |
| + cross-family φ ≤ 0.2 | 0 to 13.0% | 1.0% to 13.9% | 0 to 13.0% | 0 to 13.9% | 0 to 2.3% |
| + cross-family φ ≤ 0.1 | 0.5% to 12.5% | 1.9% to 13.5% | 0 to 12.0% | 0 to 11.5% | 0 to **1.1% (excludes the truth)** |
| + cross-family φ ≤ 0 | 1.4% to 12.5% | 2.4% to 13.5% | 0 to 11.1% | 0 to 11.1% | 0 (below one item) |
| all three pairs φ ≤ 0 | 1.4% | 2.4% | 11.1% | 0 | 0 |

*Reproduce: deterministic enumeration over x₀ = 0 to 177, x₁ = 0 to 3, x₂ = 0 to 5 and x₃ = 0 to 23 (counts out of 208). The data source is the gitignored ledger `experiments/out/e2e/t5-compound/2026-11-12T10-35-57-202Z-main-live/diverse3.jsonl`, rows tagged `split:held` with a boolean truth and all three members answering. A member's leading answer is pYes ≥ 0.5; the pooled answer is the row's verdict pYes ≥ 0.5.*

Comparing with the same rows and judges 1 and 3 alone, the bound on a gate acting only when both agree is 3.8%, 2.2%, 1.1% and below one item at caps of 0.3, 0.2, 0.1 and 0. The third judge adds little once the cap does the work.

The realised error φ on these rows was 0.163 (1–3), 0.151 (2–3) and 0.819 (1–2). A cap of 0.1, which the single-ledger figure of 0.04 would have suggested, produced a false bound of 1.1% against a true 1.7%. The measured correlation for the same model pair ranged from −0.08 to 0.16 across row sets of one experiment, and was 0.58 on BoolQ.

A correlation cap is an assumption to state, not a measurement to borrow.

## 9. Selective labels and propensities

**What is selective here.**
- Lakkaraju et al. named the selective labels problem: an outcome is observed only when the action is taken (KDD 2017) [memory; cited in the project's consequence_labels.md].
- Ratchet's trusted labels are different. They are a person's judgment of whether acting was right, and they exist for any row a person looks at, whatever the gate did.
- So the classic problem applies only to consequence labels, which the existing note already keeps out of every fit.

For blind and census labels, two things remain:
- *Which rows a person looks at.* This is a design variable. Once its probability is logged, weighting makes estimates unbiased.
- *What the person saw.* A moment label, given after seeing the model's lean, is a measurement problem that no weighting repairs.

**Off-policy evaluation.**
- Dudík, Langford and Li's doubly robust estimator combines a reward model with the logging policy's propensities, and stays accurate if either is good (ICML 2011) [verified].
- Kilbertus et al. argue that under selective labels one should learn stochastic decision policies rather than predict-then-threshold (AISTATS 2020) [verified].
- Wei shows the optimal policy in the homogeneous case is a threshold that tightens as labels accrue (ICML 2021) [verified].
- Coston, Rambachan and Chouldechova assume selection and outcome are unconfounded given the observed features (ICML 2021 per the proceedings listing) [verified].

In ratchet the exploration that these papers ask for already exists: the blind audit above the bar, and the review band below it. Both have known probabilities if they are logged.

**Estimators, given a logged π_i for every row and a trusted label on the selected ones.**

Let L_i indicate that row i was selected and received a trusted label, U_b the rows with act probability go_i ≥ b, and N_b = |U_b|.

- Horvitz-Thompson precision at bar b: θ̂_HT(b) = (1/N_b)·Σ_{i ∈ U_b} L_i·y_i/π_i.
- Hájek precision at bar b: θ̂_H(b) = Σ_{i ∈ U_b} L_i·y_i/π_i ÷ Σ_{i ∈ U_b} L_i/π_i.
- AIPW precision at bar b: θ̂_DR(b) = (1/N_b)·Σ_{i ∈ U_b} [m_i + L_i·(y_i − m_i)/π_i].
  - m_i is a prediction of y fixed before the labels, such as the strong judge's probability that acting is right, or its verdict.
  - If m is fitted on the same labels it must be cross-fitted.
  - The variance estimate is the sample variance of the bracketed terms divided by N_b.
- Calibration bins and bar fits work the same way: weight each labelled row by 1/π_i. This would justify a third `fittedFrom` value, "weighted", for fits that use enforce rows.

**Conditions.**
- Positivity: π_i > 0 for every row in U_b.
- π fixed before the label exists and independent of it given the logged variables.
- The trust class of the label known in advance.
- With these, the estimators are unbiased for this traffic.

**Lowering a bar from b to b′ < b with enforce data.**
- In enforce, acts above b are audited at rate r, so π = r.
- Rows in the band [b′, b) go to a person, so π = 1.
- If the review hides the model's lean, the band's labels are a blind census, and an exact bound follows:

precision(b′) ≥ [N_hi·(1 − UB_audit) + R_band] / (N_hi + N_band)

where:
- N_hi is the number of acts above b in the window.
- UB_audit is the exact one-sided upper bound on the error rate among those acts, from x wrong of m audited.
- N_band is the number of band rows.
- R_band is the number of band rows whose blind label says acting would have been right. A band row without a label counts as wrong.

The bound is exact for the window's rows. Conditional on m, the audited acts are a simple random sample of the acts above b, and the band is a census with no sampling error. It is measured-eligible only if the evaluation point (the window) is fixed before its labels are read.

| enforce acts above b | audit rate | audits | audit errors | band rows | band right | certified precision at b′ | at b alone |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3,000 | 0.05 | 150 | 0 | 400 | 396 | 98.14% | 98.02% |
| 3,000 | 0.05 | 150 | 0 | 400 | 392 | 98.02% | 98.02% |
| 3,000 | 0.05 | 150 | 1 | 400 | 396 | 97.13% | 96.88% |
| 6,000 | 0.05 | 300 | 1 | 800 | 792 | 98.50% | 98.43% |
| 1,500 | 0.10 | 150 | 0 | 300 | 297 | 98.19% | 98.02% |

*Reproduce: exact arithmetic, deterministic.*

An enforcing gate needs 149 clean audits before its audits alone hold a 98% statement: 7,450 enforce acts at r = 0.02, 2,980 at 0.05, 1,490 at 0.1 and 745 at 0.2.

**What remains impossible.**

- **Moment labels.** No weight repairs anchoring.
  - Blinding fixes it: hide the lean in enforce review prompts.
  - Otherwise double-sample. Take a random subset of moment-labelled rows, logged with π, re-review them blind, and estimate the moment labels' error as a fallible device: Tenenbein's design again, with the blind label as the true device. That supports an estimated grade, not a fitted bar.
- **Consequence labels.** These exist only for acts that ran.
- **Positivity failures.**
  - With r = 0, nothing above the bar is ever labelled.
  - The hook's census labels cover only the calls the harness chose to ask about, so π = 0 for auto-approved call types. A bar fitted on asked calls says nothing about the rest. The planned opt-in run sampling (e2e T1-03) should be a Bernoulli draw with its rate logged.
- **Future traffic.** Propensities give unbiasedness for the traffic seen, not for future traffic.
- **Steering.** If the gate's own decisions change the states that come next, invariant 8's concern, no estimator on past rows describes the new regime.

## 10. Recommended design

### 10.1 Grade per method

| method | grade it deserves | why |
| --- | --- | --- |
| planned Clopper-Pearson sample (today) | measured | exact, planned, labels fixed before reading |
| sequential plan: mixture e-process (section 5) | measured (new plan kind) | exact at any stopping time by Ville's inequality; plan fixed before labels; no final rejection on one unlucky sample |
| two-phase stratified exact test (section 3) | measured (new plan kind) | design-based and exact whatever the judge is like; requires strata, allocation and π recorded before any label |
| bar-lowering bound from audits plus a blind band census (section 9) | measured if the window is planned and the band blind; otherwise estimated | exact for the window; read repeatedly it is optional stopping |
| Wilson on labelled unselected rows (today) | estimated | nominal coverage, read repeatedly |
| PPI++, stratified PPI, AIPW or active inference with CLT intervals | estimated at most, under the preconditions below | asymptotic; the variance estimate collapses at rare errors (false acceptance up to 0.61) |
| inverse-propensity-weighted fits and calibration on enforce rows | estimated (`fittedFrom: "weighted"`) | unbiased given logged π and positivity; repeated looks |
| moment labels corrected by a blind double sample | estimated | a measurement-error correction resting on the double sample's randomness |
| two-judge disagreement rate (today) | borrowed | an unconditional lower bound on "at least one of the two judges is wrong" |
| agreement bounds under a stated φ cap | borrowed, "assumed" variant, shadow only, cap printed | rests on an unmeasured cap; a cap of 0.1 already failed on T5 rows |
| a bound from the judge's recall measured elsewhere: ε ≤ w_B·p_B/(1 − m⁺) | borrowed | m⁺ is not this gate's evidence. Example: 29 of 29 historical errors flagged gives m⁺ = 9.81%, and a flagged-and-wrong share of 1% then gives ε ≤ 1.11% |
| triplet, Dawid-Skene or spectral point estimates | none (diagnostic only) | identification needs conditional independence, which fails here (jev-1.13 estimated at 1.3%, true 11.5%) |
| consequence labels | none (as today) | selective in the strict sense |

The two hard lines of `docs/design/evidence-grades.md` are unchanged: only measured promotes, and no number appears without its grade.

The measured variant of the grade union needs a plan-kind field ("fixed", "sequential" or "stratified"), so that a status names which exact test stands behind it.

**Preconditions for a CLT-based estimated grade.**
- The labelled rows are a probability sample with logged π, and π is floored: τ-mixing with uniform sampling at τ ≥ 0.1.
- The judge's outputs were recorded before the labels.
- λ, or the outcome model m, is cross-fitted.
- The sample holds at least 10 labelled disagreements and at least 10 labelled errors; otherwise fall back to Wilson on the human labels alone.
- The figure is used for bar fitting and calibration in the region where errors are common (precision below about 0.95), where table 2 shows real gains.
- It never reads as a lower bound at the promise.

### 10.2 Ledger fields

All fields are optional and additive. They do not touch `hashPolicy` or plan hashes.

`DecisionRecord.labelPlan?: { propensity: number; route: string; stratum?: string; design: string; selected?: boolean }` is written when the decision row is written, before any label exists:

- **`propensity`**: the probability that this row receives a label from `route`, under the design in force at decision time.
  - Enforce act: the effective `auditRate`, on every enforce act whether or not the audit draw selected it. Today only the `audit` tag survives the draw (`src/engine.ts` lines 1230 to 1239).
  - Enforce review-band row, not floored: 1, with `route` the blind review source when the prompt hides the lean. When the prompt shows the lean, the route is the moment source and the row carries no trusted propensity.
  - Enforce refuse row: 0 unless a refusal review design exists.
  - Floored or bypassed rows: no `labelPlan`, because they are not acts.
  - Shadow row on a census route: 1 when the harness or application asks the person about this call, 0 when it does not. The hook records whether the harness asked.
  - Shadow row under opt-in run sampling: the sampling rate.
  - Stratified two-phase design: π_A or π_B by the stratum. It is written when the judge's verdict is recorded, which must precede any human label.
- **`route`**: the label source the propensity refers to, such as `review:blind` or `claude-code:person`. It names the trust class in advance.
- **`stratum`**: for example `judge:pass`, `judge:flag`, `band` or `act`.
- **`design`**: the hash of the design: rates, strata rule, seed and phase boundary.
- **`selected`**: the result of the Bernoulli draw. A selected row without a label is non-response: it holds an exact evaluation or counts as wrong, never vanishes.

**Later samples.** A sample drawn after the fact, such as `ratchet review`'s seeded uniform sample, cannot be written at decision time. Write a sample manifest line to the ledger *before any label in the sample is read*: `{ type: "labelSample", design, seed, at, rule, eligible: N, k }`. Every eligible row then has π = k/N.

A review of all denials (`--denied`) is a design with π = 1 on rows whose inferred label is a denial. Its selection depends on a recorded variable, so it stays unbiased for the denial stratum. The approved stratum still needs the uniform sample.

**Review history.** Keep every review as its own outcome record: `{ reviewer, source, correct, truth, at, blindTo: ["lean", ...] }`, plus the adjudicated final label.

**Seeds.** Planted known-wrong acts are tagged `seed:planted`. Every estimate, fit and plan excludes them; only the miss-rate bound reads them.

### 10.3 Review protocol

1. **First review blind.** Neither the model's answer, its confidence nor the strong judge's verdict is shown. In enforce, the review prompt must hide the lean, or the band's labels are moment labels.
2. **Adjudicate every "wrong" label (P1).** A second blind reviewer reviews it, not told the first verdict. If the two disagree, a third blind reviewer decides by majority.
3. **Recheck judge-flagged "right" labels (P2).** Every "right" label on an act the strong judge flagged gets two more blind reviews. It becomes "wrong" only if both say wrong; otherwise it stays "right".
4. **Seed known errors.** Interleave m real historical errors (59 is a good default) per plan. Pass them through the whole protocol, including the strong judge. Compute e2⁺ at α_s = 0.01 and size the plan at α_p = 0.04 from section 7's formula: 173 zero-error acts if all 59 are caught.
   - Until seeds exist, a measured grade must print "labels assumed correct" among its assumptions, as `docs/rollout.md` already lists.
5. **Ambiguity rule, pre-registered.** An act a reviewer marks ambiguous counts as wrong for acceptance. A plan may instead exclude ambiguous acts by a criterion fixed in the plan's identity before any label, never by a decision made after seeing how they fall.

### 10.4 What not to build

- A PPI, PPI++ or active-inference lower bound at the promise.
- Any label-free point estimate of a judge's accuracy as a grade.
- A propensity reconstructed after the fact from configuration.

## 11. Pitfalls and assumptions

Every exact guarantee in this note rests on four assumptions:

- **Random selection with a probability fixed before the label.** This means uniform or stratified selection, with the strata recorded first.
- **Independent acts.** Keep the group cap. A stratified or Horvitz-Thompson design over sessions needs cluster sampling: whole sessions, analysed by session.
- **Correct labels, or a stated miss-rate bound e2⁺.** Misses inflate a pass silently; false alarms only cost power.
- **Stationarity between the evidence and the traffic** the promise is about.

Further pitfalls:

- CLT intervals (PPI, PPI++, stratified PPI, active inference, Wald) shrink to a point when no disagreement or error is sampled. At 1% errors that is the common case at n of 50 to 150.
- PPI with λ = 1 can need nine times more labels than people alone near the promise.
- Variance-optimal sampling puts its lowest probability where the judge is confident, which is where an error hurts the bound most. Floor π.
- Strata weights describe this phase's acts. A claim about future traffic needs the w_B allowance of section 3.
- The judge's recall on *this gate's* errors is unknown until measured. A shared blind spot (recall 0.5) halves the composite gate's benefit.
- Seeds bound misses only on errors like themselves.
- Reviewers share blind spots with the model ("routine-looking, not routine"). That breaks both the independence the adjudication arithmetic assumes and the conditional independence latent class models need.
- A correlation cap is an assumption. One model pair's measured φ ranged from −0.08 to 0.16 within one experiment and was 0.58 on another task.
- Estimated grades are read repeatedly. Only the e-process may be monitored continuously and still mean what it says.
- The stratified test's size is verified on a grid of the null boundary. Implementations should verify on a fine grid or keep a small margin (S ≤ 0.049).
- Sample proportions in section 8 are treated as exact. With n = 208, the identification regions carry sampling error that is not shown.

## 12. Open questions and confidence

| recommendation or result | confidence | what would change it |
| --- | --- | --- |
| The label floor (section 1) | high: a proof | nothing within assumption-free methods |
| CLT methods never measured; PPI only for fitting | high: exact multipliers and seeded false-acceptance rates | none expected |
| Label-noise arithmetic and the protocol's effect | high for the arithmetic; medium for the inputs | reviewer e1 and e2 measured on tool acts, not across corpora; reviewer independence on hard items |
| Two-phase stratified test as a measured plan kind | medium-high | sizes verified exactly at most 0.0499. I did not optimise the ordering of outcomes (a likelihood-ratio ordering may be tighter), and the superpopulation w_B variant is not simulated. Gains are modest (9% to 38%), so it is optional |
| Composite gate as the main lever | medium | the judge's real recall on this gate's errors, which no ledger has measured; the coverage cost per gate |
| Mixture e-process as a sequential measured plan | medium | it is a policy change to "a failure is final"; the choice of mixture (fixed alternatives gain on clean streams and lose on errors) |
| `labelPlan` propensity fields | high value for low cost | whether weighted fits (`fittedFrom: "weighted"`) are wanted; that is a separate decision |
| Agreement bounds under a φ cap, borrowed and shadow only | medium | a defensible way to measure the cap per question without labels, which I do not believe exists |
| Bar-lowering bound | medium-high | requires enforce review prompts that hide the lean; whether the hook's harness permits that |

Other open questions:

- Whether prediction-powered e-values beat the mixture e-process at 98% to 99.5%. They cannot beat the floor; I did not simulate them.
- How the review band's moment-to-blind conversion interacts with the e2e T1 observation that wrong acts cluster in a narrow confidence band.
- The plan size under cluster sampling by session for the stratified design.

## Sources

- Allman, E. S., Matias, C. and Rhodes, J. A. (2009). Identifiability of parameters in latent structure models with many observed variables. *Annals of Statistics* 37(6A), 3099-3132. https://doi.org/10.1214/09-AOS689 [memory]
- Angelopoulos, A. N., Bates, S., Fannjiang, C., Jordan, M. I. and Zrnic, T. (2023). Prediction-powered inference. *Science*. https://arxiv.org/abs/2301.09633 [verified]
- Angelopoulos, A. N., Duchi, J. C. and Zrnic, T. (2023). PPI++: Efficient prediction-powered inference. https://arxiv.org/abs/2311.01453 [verified]
- Buehler, R. J. (1957). Confidence intervals for the product of two binomial parameters. *JASA* 52, 482-493. [memory]
- Coston, A., Rambachan, A. and Chouldechova, A. (2021). Characterizing fairness over the set of good models under selective labels. ICML 2021. https://arxiv.org/abs/2101.00352 [verified]
- Csillag, D., Struchiner, C. J. and Goedert, G. T. (2025). Prediction-powered e-values. ICML 2025. https://arxiv.org/abs/2502.04294 [verified]
- Dawid, A. P. and Skene, A. M. (1979). Maximum likelihood estimation of observer error-rates using the EM algorithm. *Applied Statistics* 28(1), 20-28. https://www.jstor.org/stable/2346806 [memory]
- Dorner, F. E., Nastl, V. Y. and Hardt, M. (2025). Limits to scalable evaluation at the frontier: LLM as judge won't beat twice the data. ICLR 2025. https://arxiv.org/abs/2410.13341 [verified]
- Dudík, M., Langford, J. and Li, L. (2011). Doubly robust policy evaluation and learning. ICML 2011. https://arxiv.org/abs/1103.4601 [verified]
- Farquhar, S., Gal, Y. and Rainforth, T. (2021). On statistical bias in active learning: how and when to fix it. ICLR 2021. https://arxiv.org/abs/2101.11665 [verified]
- Feng, C., Shen, M., Balashankar, A., Gerner-Beuerle, C. and Rodrigues, M. R. D. (2026). Noisy but valid: robust statistical evaluation of LLMs with imperfect judges. ICLR 2026. https://arxiv.org/abs/2601.20913 [verified]
- Fisch, A., Maynez, J., Hofer, R. A., Dhingra, B., Globerson, A. and Cohen, W. W. (2024). Stratified prediction-powered inference for hybrid language model evaluation. NeurIPS 2024. https://arxiv.org/abs/2406.04291 [verified]
- Fu, D. Y., Chen, M. F., Sala, F., Hooper, S. M., Fatahalian, K. and Ré, C. (2020). Fast and three-rious: speeding up weak supervision with triplet methods. ICML 2020. https://arxiv.org/abs/2002.11955 [verified]
- Gligorić, K., Zrnic, T., Lee, C., Candès, E. J. and Jurafsky, D. (2025). Can unconfident LLM annotations be used for confident conclusions? NAACL 2025. https://arxiv.org/abs/2408.15204 [verified]
- Hui, S. L. and Walter, S. D. (1980). Estimating the error rates of diagnostic tests. *Biometrics* 36(1), 167-171. https://jhanley.biostat.mcgill.ca/bios601/CandH-ch0102/HuiWalter1980.pdf [memory]
- Jaffe, A., Fetaya, E., Nadler, B., Jiang, T. and Kluger, Y. (2016). Unsupervised ensemble learning with dependent classifiers. AISTATS 2016, PMLR 51, 351-360. https://proceedings.mlr.press/v51/jaffe16.html [verified]
- Jung, J., Brahman, F. and Choi, Y. (2025). Trust or escalate: LLM judges with provable guarantees for human agreement. ICLR 2025. https://arxiv.org/abs/2407.18370 [verified]
- Kilbertus, N., Gomez Rodriguez, M., Schölkopf, B., Muandet, K. and Valera, I. (2020). Fair decisions despite imperfect predictions. AISTATS 2020, PMLR 108, 277-287. https://proceedings.mlr.press/v108/kilbertus20a.html [verified]
- Kim, E., Garg, A., Peng, K. and Garg, N. (2025). Correlated errors in large language models. ICML 2025. https://arxiv.org/abs/2506.07962 [verified]
- Kossen, J., Farquhar, S., Gal, Y. and Rainforth, T. (2021). Active testing: sample-efficient model evaluation. ICML 2021, PMLR 139, 5753-5763. https://arxiv.org/abs/2103.05331 [verified]
- Lakkaraju, H., Kleinberg, J., Leskovec, J., Ludwig, J. and Mullainathan, S. (2017). The selective labels problem. KDD 2017, 275-284. https://doi.org/10.1145/3097983.3098066 [memory]
- Neyman, J. (1938). Contribution to the theory of sampling human populations. *JASA* 33, 101-116. [memory]
- Parisi, F., Strino, F., Nadler, B. and Kluger, Y. (2014). Ranking and combining multiple predictors without labeled data. *PNAS* 111(4), 1253-1258. https://arxiv.org/abs/1303.3257 [verified]
- Platanios, E. A., Blum, A. and Mitchell, T. (2014). Estimating accuracy from unlabeled data. UAI 2014, PMLR R12, 226-235. https://proceedings.mlr.press/r12/university14g.html [verified]
- Ratner, A., De Sa, C., Wu, S., Selsam, D. and Ré, C. (2016). Data programming: creating large training sets, quickly. NeurIPS 2016. https://arxiv.org/abs/1605.07723 [memory]
- Reiczigel, J., Földi, J. and Ózsvári, L. (2010). Exact confidence limits for prevalence of a disease with an imperfect diagnostic test. *Epidemiology and Infection* 138(11), 1674-1678. https://doi.org/10.1017/S0950268810000385 [verified]
- Rogan, W. J. and Gladen, B. (1978). Estimating prevalence from the results of a screening test. *American Journal of Epidemiology* 107(1), 71-76. [memory]
- Sawade, C., Landwehr, N., Bickel, S. and Scheffer, T. (2010). Active risk estimation. ICML 2010, 951-958. https://mlanthology.org/icml/2010/sawade2010icml-active [verified]
- Tenenbein, A. (1970). A double sampling scheme for estimating from binomial data with misclassifications. *JASA* 65(331), 1350-1361. https://doi.org/10.1080/01621459.1970.10481170 [memory; bibliographic details confirmed in a search listing]
- Ville, J. (1939). *Étude critique de la notion de collectif*. Gauthier-Villars. [memory]
- Waudby-Smith, I. and Ramdas, A. (2024). Estimating means of bounded random variables by betting. *JRSS Series B*, doi 10.1093/jrsssb/qkad009. https://arxiv.org/abs/2010.09686 [verified; journal details from a search listing]
- Wei, D. (2021). Decision-making under selective labels: optimal finite-domain policies and beyond. ICML 2021, PMLR 139, 11035-11046. https://proceedings.mlr.press/v139/wei21a.html [verified]
- Zhang, Y. and Martinez, I. (2026). Estimating LLM judge error rates and outcome prevalence with limited or no gold labels. NeurIPS 2026 workshop "Can We Trust the Judge?". https://neurips.cc/virtual/2026/161252 [verified]
- Zrnic, T. and Candès, E. J. (2024). Active statistical inference. ICML 2024, PMLR 235, 62993-63010. https://arxiv.org/abs/2403.03208 [verified]
- Zrnic, T. and Candès, E. J. (2024). Cross-prediction-powered inference. *PNAS* 121(15), e2322083121. https://arxiv.org/abs/2309.16598 [memory]

Every number in this note was computed by seeded or deterministic scripts in a session scratch folder that is not part of the repository; any table that backs shipped code is to be reproduced under `sim/` first.
