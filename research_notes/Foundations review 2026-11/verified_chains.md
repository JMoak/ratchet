# Verified chains under correlated verifier error: frailty, remedies, and what the ledger must record

*Research note, 2026-11-12. Foundations review: the theory of verify-then-commit chains (`runChain`) when the verifier's false alarms are correlated across retries, fitted to the e2e T2 live run; extends Key Question 7 of `math_of_compounding_decisions.md`. Docs only; URLs are in the sources at the end. Tags: [verified] means the abstract or text was fetched in this session; [memory] means from memory, with "citation confirmed by search" where a search confirmed the reference exists.*

`runChain` proposes a step, verifies it with an independent judge, commits only on an `act` ruling, and resamples otherwise, up to `maxAttempts`. Live in T2, all 1,132 committed steps were right. But chains finished 48% to 62% of the time, where independent-retry arithmetic said 74% to 99.8%.

The gap has a standard explanation. N-version software calls it coincident failure: some step instances are hard for this verifier, and every fresh correct answer to such a step is likely to be held back again. A beta frailty on each step's false-alarm propensity, fitted to two numbers from the run, reproduces every completion figure T2 reported. A probit version of the same model predicts the strict bar out of sample.

The consequences for design are concrete:

- Exhaustion falls as a power law in the attempt budget, not geometrically, so more retries are a weak lever.
- The two measured numbers cannot bound completion from below once attempts grow.
- Late commits are less precise when the catch rate is below one.
- The remedy that pays best is a human tier at exhaustion, with a second model of a different family ordering what the human sees. Letting a second opinion release a held candidate trades the primary's catch rate for the second model's, and costs a factor of about 40 in wrong commits.

The ledger has to record step instances, distinct candidates and tiers before any of this can be measured rather than computed.

## 1. What T2 measured, recovered from the run data

The run directory is `experiments/out/e2e/t2-verifier/2026-11-12T10-32-34-553Z-live`. It is gitignored and untrusted, and was parsed as JSON only. Four of its files were read:

- `chain-runs.json`, `chain-runs-strict.json`: per-chain logs, one entry per attempt with id, truth, action and go;
- `chain-labels.json`: per-candidate variant and state hash;
- `asks-heldout.json`: per-candidate p(pass) on the held-out split.

The chain design is in `experiments/e2e/t2-verifier/chain.ts`:

- 100 chains of 8 steps per base rate p in {0.8, 0.9}.
- Step s of chain c is a fresh instance of held-out family `(c + s) mod 6`.
- Each attempt is correct with probability p, independently.
- Correct attempts cycle through three styles (plain, benign, paraphrase); wrong attempts cycle through distinct error types.
- The two base rates share instances and random numbers. An attempt correct at 0.8 is correct at 0.9, so counts pooled over p are not independent.

### The two numbers

The estimator is the one in `posthoc.ts`. For each step of each `verified` chain (bar 0.48, 3 attempts):

1. List the attempts whose candidate is correct, in order.
2. A step with at least one correct candidate counts toward the base. Its first correct candidate is "held" when its action is not `act`.
3. Among steps whose first correct candidate was held and that reached a second correct candidate, count how often the second was held too.

Pooled over both base rates:

- first correct candidate held: **184 of 1,227 (15.0%)**;
- second held, given the first was: **95 of 170 (55.9%)**.

By run, with Wilson 95% intervals:

| arm | p | chains finished | steps run | steps exhausted | first correct held | held again | held a third time, given two |
| --- | --- | --- | --- | --- | --- | --- | --- |
| verified, 3 attempts, bar 0.48 | 0.8 | 48/100 | 590 | 52 (8.8%) | 86/586 = 14.7% | 41/76 = 53.9% [42.8, 64.7] | 16/19 = 84.2% |
| verified | 0.9 | 53/100 | 641 | 47 (7.3%) | 98/641 = 15.3% | 54/94 = 57.4% [47.4, 67.0] | 25/36 = 69.4% |
| budget, 6 attempts (replayed) | 0.8 | 62/100 | 650 | 38 (5.8%) | 93/650 = 14.3% | 47/93 = 50.5% [40.6, 60.5] | 38/47 = 80.9% |
| budget | 0.9 | 58/100 | 653 | 42 (6.4%) | 100/653 = 15.3% | 56/100 = 56.0% [46.2, 65.3] | 42/56 = 75.0% |
| strict, bar 0.9, 3 attempts | 0.8 | 0/100 | 239 | 100 (41.8%) | 129/238 = 54.2% | 93/117 = 79.5% [71.3, 85.8] | 42/48 = 87.5% |
| strict | 0.9 | 0/100 | 254 | 100 (39.4%) | 139/254 = 54.7% | 108/136 = 79.4% [71.9, 85.4] | 65/76 = 85.5% |

The budget arm replays the verified arm's verdicts for every candidate it shares, so its rows overlap the verified rows.

### Unselected evidence from the held-out split

The held-out split is clean evidence because every candidate was asked, whatever happened to its neighbours: 54 instances, each with three correct candidates (162 in all) and five wrong ones (270).

**At bar 0.48:**

- f = 27/162 (16.7%).
- Instances with 0, 1, 2 or 3 of their three correct candidates held: 42, 4, 1, 7.
- Over all ordered pairs of correct candidates within an instance, P(held | another of the same instance held) = 44/54 = 81.5%. The within-instance correlation (ICC) is 0.778.
- Beta-binomial maximum likelihood: a = 0.050, b = 0.239 (ICC 0.776, mean 0.172).
- By family, held over correct, with the 0/1/2/3 histogram:

| family | held / correct | instances with 0/1/2/3 held |
| --- | --- | --- |
| shipping JSON | 3/27 | 6/3/0/0 |
| incident summary | 0/27 | 9/0/0/0 |
| dimensions | 0/27 | 9/0/0/0 |
| code expiry | 0/27 | 9/0/0/0 |
| warranty email | 24/27 | 0/1/1/7 |
| SQL HR | 0/27 | 9/0/0/0 |

The frailty here is concentrated in one family.

**At bar 0.9:**

- f = 74/162 (45.7%), histogram 18/13/8/15.
- P(held | another held) = 106/148 = 71.6%, ICC 0.478.
- Maximum likelihood a = 0.506, b = 0.591.
- Warranty: 27/27 held.

**On the score scale.** A one-way ANOVA of logit p(pass) over correct candidates (logit clamped at 0.005 and 0.995) gives:

- between-instance variance 1.355;
- within-instance variance 0.612;
- ICC 0.689.

Chain steps are fresh instances of the same families. Their ICC (about 0.5, below) is lower than held-out's 0.78 at bar 0.48, which is consistent with the T2 report's remark that per-instance variation sits between the pooled and per-family views.

### The six-attempt arm replayed cached verdicts

The six-attempt ("budget") arm did not get six distinct candidates per step:

- In `chain.ts` the k-th correct attempt uses style `k mod 3`.
- `runOne` in any mode other than `verified` returns the cached decision for a candidate text it has already seen.
- 76 steps reached a fourth correct candidate (34 at p = 0.8, 42 at p = 0.9).
- In all 165 pairs (70 + 95) of the k-th and (k+3)-th correct candidates of a step, the variant, the state hash and the score were identical.
- The arm bought only 146 and 53 new gate asks.

So the arm tested at most three distinct correct candidates per step. The T2 report's "predicted 98.9% and 99.8% with six attempts" is independence over six fresh draws. With three distinct correct styles, independence would have said 96.9% and 97.3%. The frailty model says 61.2% and 61.5% against 62% and 58% observed. With six fresh candidates the same model predicts 71.7%.

The six-attempt shortfall is therefore mostly frailty, with about 10 points from byte repetition. The T2 limits section names the repetition; the predicted column should be restated with it.

### Third-moment evidence against the two-point model

Section 5 of `sim/main.ts` models correlated false alarms as a two-point law: `hardShare = f / again = 0.268` of step instances have false-alarm rate 0.56, the rest have 0. That law matches both numbers (E[theta] = 0.15, E[theta^2] = 0.0838), and it implies P(held a third time | held twice) = 0.56.

Observed, with one-sided binomial tails P(X >= k):

| arm | observed | under the two-point law (0.559) | under the fitted beta (0.702) |
| --- | --- | --- | --- |
| verified, p = 0.8 | 16/19 | 0.0095 | 0.138 |
| verified, p = 0.9 | 25/36 | 0.069 | 0.621 |
| budget, p = 0.8 | 38/47 | 3.0e-4 | 0.072 |

The latent probit model below gives 71.4%. The two-point law is rejected. The data sit at or a little above the beta, which says the tail near theta = 1 (steps the verifier essentially never passes) is at least as heavy as the beta's. Section 3 also shows the two-point law is the most optimistic law consistent with the two numbers.

## 2. The model

### Beta frailty: the Eckhardt-Lee intensity for one verifier

Assumptions:

- Each step instance i carries theta_i, the probability that this verifier holds back a correct candidate for that step, with theta_i ~ Beta(a, b) across instances.
- Given theta_i, holds of distinct correct candidates are independent.
- Wrong candidates are caught with probability t.
- The proposer is right with probability p on every attempt, independently.

Then:

```
E[theta^k]          = prod_{j=0..k-1} (a + j) / (a + b + j)
mean f = mu         = a / (a + b)
P(held again | held) = E[theta^2] / E[theta] = (a + 1) / (a + b + 1) = mu + rho (1 - mu)
ICC rho             = 1 / (a + b + 1)
Var(theta)          = rho mu (1 - mu)
```

Fitted to 15.0% and 55.9%:

- rho = (0.559 - 0.150) / 0.850 = 0.481;
- a = mu (1/rho - 1) = 0.162;
- b = (1 - mu)(1/rho - 1) = 0.917;
- Var(theta) = 0.061, SD 0.248.

Both shape parameters are below 1, so the density is U-shaped: most steps near theta = 0, a minority near 1.

The censored likelihood of section 3, fitted per run on chain steps, agrees:

| run | a | b | ICC [profile 95%] |
| --- | --- | --- | --- |
| p = 0.8 | 0.146 | 0.853 | 0.500 [0.384, 0.614] |
| p = 0.9 | 0.159 | 0.882 | 0.490 [0.388, 0.589] |
| budget p = 0.8, first three distinct correct | 0.149 | 0.899 | 0.488 [0.392, 0.582] |

### Latent probit: one parameter for every bar

A correct candidate j of step i is held when `u_i + e_ij < z`, where:

- u_i ~ N(0, r) is the step factor;
- e_ij ~ N(0, 1 - r) is candidate noise;
- z = PhiInv(f).

Then P(held again | held) = Phi2(z, z; r) / f, with Phi2 the bivariate normal CDF.

Fitted at f = 0.15 and 55.9%, r = 0.746 (probit scale). Moving the bar changes only z, so the model predicts other bars from r alone:

- at the strict bar's chain base rate f = 0.545, it predicts held-again 78.9% (observed 79.5% and 79.4%);
- at the held-out f = 0.457, it predicts 74.8% (held-out pairs: 71.6%).

This is the random-effects probit that Qu, Tan and Kutner (1996) used for conditional dependence between diagnostic tests.

For the remedies and the frontier, I extended it to a binormal ROC with the same step factor on both classes:

- candidate score s = c·d + u_i + e_ij, with c = 1 for a correct candidate and 0 for a wrong one;
- d = sqrt(2) PhiInv(AUC);
- the candidate is held when s < b.

Marginally f = Phi(b - d) and t = Phi(b). Per step, f(u) = Phi((b - d - u)/sqrt(1 - r)) and t(u) = Phi((b - u)/sqrt(1 - r)). This is a "strict step, lenient step" factor: a strict step holds back more correct work and also catches more errors.

For T2's verifier (AUC 0.998): d = 4.070, the bar giving f = 0.15 is b = 3.034, and t = 0.9988. This is consistent with the 270 of 270 held-out errors caught.

### What the literature already says

**N-version software built this model.**
- Eckhardt and Lee defined an "intensity of coincident errors" over the input space: the probability that a randomly developed version fails on input x [verified]. The step-level theta(x) above is that intensity for one verifier over step instances. Coincident holds then satisfy E[theta^2] = mu^2 + Var(theta) > mu^2.
- Knight and Leveson's 27 independently written versions, run on one million tests, failed together far more often than independence predicts [memory; citation confirmed by search].
- Nicola and Goyal modelled the intensity with a beta density, giving the beta-binomial, and found community error recovery effective only when versions are lightly correlated [memory; citation confirmed by search].
- Tomek, Muppala and Trivedi model correlation between successive acceptance tests in recovery blocks with the Eckhardt-Lee intensity, and compare against Nicola and Goyal's beta-binomial [verified]. That is `runChain`'s situation exactly.
- Randell's recovery block runs design-diverse alternates against one acceptance test. Avizienis's N-version programming votes across independently generated versions. The consensus recovery block of Scott, Gault and McAllister votes first and falls back to the acceptance test, and is shown more reliable under stated conditions [all memory; citations confirmed by search].
- `runChain` is a recovery block whose alternates are resamples of one generator and whose acceptance test is fixed: the worst case for coincident acceptance-test failures.

**Diversity can beat independence, but only if measured.**
- Littlewood and Miller show that forced diversity (versions built by different methodologies) can make coincident failure less likely than under independence [verified].
- Among 350+ LLMs, when two models both err they give the same wrong answer 60% of the time on one leaderboard. Shared provider, shared architecture and scale all raise the correlation (Kim et al.) [verified].
- Model errors are converging as capability rises, and judges favour models similar to themselves (Goel et al.) [verified].
- The project's own measurements (error phi 0.04 on one corpus, 0.58 on another, 0.785 between two Jev pins) are this literature's point: diversity is a measured property of a pair of models on a task.

**Power laws and ceilings.**
- Per-problem failure falls exponentially in attempts, but the aggregate across problems follows a power law when single-attempt success probabilities are heavy-tailed (Schaeffer et al.) [verified].
- Han (2026) gives the false-accept side of this note's argument for serial verification gates [verified]:
  - with a Beta latent false-accept rate, failure decays polynomially, about k^(-b), with rho_v = 1/(a + b + 1);
  - an atom at false-accept rate 1 sets a "blind-spot ceiling";
  - survivorship is the mechanism;
  - R repeated verdicts per instance identify the first R moments;
  - the ceiling is ill-posed to estimate;
  - decorrelation (model family, modality, evidence source) is the lever, not more gates.
- Stroebl, Kapoor and Narayanan show that a verifier's false-positive rate caps what resampling can buy, and that the optimal number of samples is often below ten [verified]. The paper's v3 (March 2026) is retitled "The Limits of Inference Scaling Through Resampling".
- The Odds Law treats independent gates as multiplying the odds, with shared error sources setting a floor (Aksu) [verified].

**Recent LLM evidence on correlated verification.**
- MAKER's red-flagging discards and resamples overly long or malformed responses. The authors report that it "reduces some of these correlated errors", call correlated errors "an open foundational problem", and suggest adding prompt noise [verified].
- Verifier errors within GRPO groups of eight rollouts correlate at 0.530 [0.500, 0.560] over 24,998 groups, an effective sample of 1.70 per group (Xin) [verified].
- Cross-model consensus beats self-consistency because independently trained models' wrong answers scatter, with a shared-error floor (Liu) [verified].
- Beam-style verifier-guided search can amplify verifier errors (Fadeeva et al.) [verified].
- Weaver combines weak verifiers weighted by accuracies estimated with little labelled data (Saad-Falcon et al.) [verified].

**Quality engineering and diagnostic testing.**
- Inspection with type I and type II error changes the acceptance probability, outgoing quality and total inspection of a sampling plan (Collins, Case and Bennett 1973) [memory; citation confirmed by search].
- Retesting rejected items reduces the scrapping of good items; retesting accepted items raises outgoing quality; the right policy depends on test accuracy and capacity (Ding, Greenberg and Matsuo 1998) [verified]. Greenberg and Stokes (1995) treat repetitive testing under inspection error [memory; citation confirmed by search].
- Two tests read in "parallel" (positive if either is) or in "series" (positive only if both are) combine through conditional covariances. Positive dependence in sensitivity lowers the sensitivity of parallel interpretation, and positive dependence in specificity lowers the specificity of serial interpretation (Gardner, Stryhn, Lind and Collins 2000; the covariance model is Vacek 1985) [memory; citation confirmed by search].

**Checkpoint intervals.**
- Young's first-order optimum checkpoint interval is sqrt(2 delta M) [memory; citation confirmed by search]; Daly (2006) gives higher-order estimates [verified record].
- For silent errors found only by a verification, the whole period is lost rather than half of it, which shortens the optimal period to the sqrt(C / lambda) form (Aupy et al. 2013 [verified abstract]; the formula [memory]; Benoit, Cavelan, Robert and Sun on patterns with partial verifications [memory; citation confirmed by search]).

## 3. Formulas to implement

Notation used throughout:

| symbol | meaning |
| --- | --- |
| p | proposer accuracy per attempt |
| t | catch rate on wrong candidates |
| f | false-alarm rate on correct candidates |
| m | attempt budget per step |
| n | steps in a chain |
| h(theta) | P(an attempt is held \| theta) = p theta + (1 - p) t |

All sums are finite and need no special functions. Under these assumptions steps are independent tasks; T2's chain is built that way.

### 3.1 Moment estimator

From labelled chain rows, per gate or step kind, per evidence configuration:

```
mu_hat  = (steps whose first correct candidate was held) / (steps with at least one correct candidate)
psi_hat = (second correct candidate held) / (steps whose first correct was held and that reached a second correct one)
rho_hat = (psi_hat - mu_hat) / (1 - mu_hat)
a_hat   = mu_hat (1 / rho_hat - 1)
b_hat   = (1 - mu_hat) (1 / rho_hat - 1)
```

Only distinct candidates count: deduplicate by candidate hash. If psi_hat <= mu_hat, report "no detectable frailty" and use the independent formulas.

The third-moment check is P(held a third time | held twice) = (a + 2)/(a + b + 2). Report it beside the fit. In T2 it was 70.2% under the fit and 74% to 84% observed.

### 3.2 Censored beta-geometric likelihood

For step instance i:

- h_i = number of distinct correct candidates held;
- r_i = number of distinct correct candidates that passed (0 or 1 under `runChain`, more on probe steps).

The order of holds and passes does not matter:

```
L_i(a, b) = B(a + h_i, b + r_i) / B(a, b)
          = prod_{j=0..h_i-1} (a + j) * prod_{j=0..r_i-1} (b + j) / prod_{j=0..h_i+r_i-1} (a + b + j)
log L(a, b) = sum_i log L_i(a, b)
```

Maximise over (log a, log b) by Nelder-Mead or a grid. Take a profile interval for rho = 1/(a + b + 1) over the region where log L >= max - 1.92.

T2 gives the values in section 2 (p = 0.8: 590 steps, of which 76 held a first correct candidate and reached a second; ICC 0.50 [0.38, 0.61]).

**Why stopping on the ruling is ignorable.** Whether a step gets another attempt depends only on rulings already observed and on the proposer's draws, which do not depend on theta. The probability of an observed step history therefore factors as P(rulings | theta, truths) times P(continue or stop | observed history). The second factor does not involve (a, b), so it drops out of the likelihood: the stopping rule is ignorable for likelihood and Bayesian inference.

Naive rates computed on retry rows are biased. Realised false alarm inside T2's chains was 21% to 23% against 15% to 17% held-out, because a retry row exists only after a hold. The likelihood is not biased.

The same argument needs labels whose selection depends only on observed quantities (missing at random). Labelling every attempt of a randomly sampled step satisfies it. Labelling rows because they were denied does not, unless the selection is modelled.

### 3.3 Step commit and chain completion under the beta

With m fresh, distinct candidates:

```
P(step exhausts) = E[h(theta)^m] = sum_{k=0..m} C(m, k) p^k ((1 - p) t)^(m - k) E[theta^k]
S(m) = 1 - P(step exhausts)                                  (step commits)
W(m) = (1 - p)(1 - t) sum_{j=0..m-1} E[h(theta)^j]          (step commits a wrong candidate)
     with E[h^j] expanded the same way
chain completes                    = prod over steps S_i(m)
chain completes with every commit right = prod over steps (S_i(m) - W_i(m))
```

If a wrong commit poisons later steps, the last line is also chain success.

If the proposer has only L distinct correct candidates (T2: L = 3), replace E[theta^k] with E[theta^min(k, L)]: byte repeats are held exactly when their first copy was. Table A uses this with t = 1.

For t = 1 and large m, using the gamma function only for the constant:

```
P(step exhausts) ~ Gamma(a + b) / Gamma(a) * (p m)^(-b)
```

For T2's fit the constant is 0.1672 and b = 0.917. This gives 0.021, 0.011, 0.0059 and 0.0031 at m = 12, 24, 48 and 96, matching the exact sums. With b <= 1 the expected number of attempts to commit, E[1/(p(1 - theta))], is infinite.

**Latent version.** E[theta^k] = integral of Phi((z - sqrt(r) x)/sqrt(1 - r))^k phi(x) dx. I used composite Simpson with 1,600 panels on x in [-8, 8].

### 3.4 The completion interval from two numbers

Given only mu and psi:

```
E[theta^2] = mu psi
Var = mu psi - mu^2
lower law: theta = 0 w.p. 1 - mu/psi,  theta = psi w.p. mu/psi
upper law: theta = y w.p. 1 - w,       theta = 1 w.p. w,
           w = Var / ((1 - mu)^2 + Var),  y = (mu - w) / (1 - w)
```

For T2: the lower law is {0 w.p. 0.732, 0.559 w.p. 0.268}, exactly `sim/main.ts`'s current law. The upper law is {0.078 w.p. 0.922, 1 w.p. 0.078}.

For any law on [0, 1] with these two moments, (1 - E_upper[h^m])^n <= completion <= (1 - E_lower[h^m])^n. The reasoning:

- h(theta)^m = (p theta + (1 - p) t)^m has a non-negative third derivative on [0, 1].
- Over laws with two fixed moments, the expectation of such a function is minimised by the lower principal representation (an atom at 0) and maximised by the upper (an atom at 1). This is the theory of moment spaces and Tchebycheff systems (Karlin and Studden) [memory].
- I checked it numerically. Over 34,485 feasible random three-point laws with the T2 moments, E[theta^3] stayed in [0.04722, 0.07850], inside the bounds [0.04687, 0.07870]. The beta gives 0.05888.
- For m <= 2 the interval collapses to a point: completion is exactly determined by the two numbers.

T2 (p = 0.8, t = 1, n = 8; chain completion):

| m | optimistic (atom at 0) | beta | pessimistic (atom at 1) | independent |
| --- | --- | --- | --- | --- |
| 1 | 4.6% | 4.6% | 4.6% | 4.6% |
| 2 | 29.5% | 29.5% | 29.5% | 42.1% |
| 3 | 52.0% | 49.2% | 45.0% | 76.6% |
| 6 | 85.2% | 71.7% | 52.0% | 99.1% |
| 12 | 98.8% | 84.2% | 52.1% | 100.0% |
| 48 | 100.0% | 95.4% | 52.1% | 100.0% |

As m grows, the optimistic bound tends to 1 and the pessimistic bound tends to (1 - w)^n = (1 - 0.078)^8 = 52.1%. The two measured numbers cannot certify completion above 52% however many retries are allowed. Only the deeper moments, or the tail near theta = 1, can.

### 3.5 The posterior after k holds

At run time the truth of a held candidate is unknown, so the posterior uses rulings only:

```
posterior(theta | k holds, no commit) ∝ Beta(theta; a, b) * h(theta)^k
M(k, j) = E[theta^j h(theta)^k] = sum_{i=0..k} C(k, i) p^i ((1 - p) t)^(k - i) E[theta^(i + j)]
E[theta | k] = M(k, 1) / M(k, 0)
pi_k = p (1 - E[theta | k]) + (1 - p)(1 - t)      chance the next attempt commits
q_k  = p (1 - E[theta | k]) / pi_k                 precision of that commit
```

pi_k does not increase with k: h is increasing in theta, so the posteriors are ordered by likelihood ratio. q_k falls with k whenever t < 1. This is Stroebl's and Han's survivorship seen from the hold side.

p and t must come from labelled first attempts (unselected rows), not from retries.

### 3.6 One-step look-ahead escalation

Let c_retry be the cost of one more proposal and verification, and c_esc the cost of the next tier, which is assumed to resolve the step. The expected cost from k holds is:

```
J(k) = min(c_esc, c_retry + (1 - pi_k) J(k + 1))
```

Because pi_k is non-increasing, this is the monotone case of optimal stopping (Chow, Robbins and Siegmund) [memory]. The one-step look-ahead rule is optimal: escalate at the first k with `pi_k <= c_retry / c_esc`.

Add a precision rule: escalate at the first k with q_k below the gate's precision target. Escalate at whichever rule fires first. This rule ignores the rest of the chain and assumes escalation settles the step; the pool rule below handles the chain.

### 3.7 The shared attempt pool and its reservation rule

As simulated (common random numbers):

- A chain has a pool of P attempts.
- Step s (0-based, of n) may use at most `allow_s = min(cap, left - R * (n - s - 1))` attempts, where `left` is what remains of the pool and R is the reservation per later step.
- Every attempt costs one, commit or not.
- A step that reaches its allowance without committing ends the chain as exhausted.

With R = 0 and no cap, a step may spend the whole pool.

For a single chain with nothing else to spend on, R = 0 dominates every other rule pathwise: any run that completes under a stricter allowance commits at the same attempts under a looser one.

R = 1 is exactly lossless. A step that would dip into a one-per-later-step reservation leaves some later step with no attempt, so that chain fails anyway. R = 1 only stops spending on chains already lost (completion 84.8% either way, 14.1 against 14.6 attempts per chain). R = 2 costs completion (82.7%).

Recommendation: a pool with R = 1, sized from the fit through 3.3, with the escalation rule of 3.6 deciding when a step stops drawing on it.

### 3.8 The second opinion: a router, never a releaser

A model V2 of a different family judges a candidate that V1 held. If V2's pass committed the candidate (the "OR" rule, parallel interpretation on the pass side), then for a single candidate:

```
P(H1 and H2 | correct) = f1 f2 + phi_f sqrt(f1 (1 - f1) f2 (1 - f2))      = f_or, the combined false alarm
P(H1 and H2 | wrong)   = t1 t2 + phi_t sqrt(t1 (1 - t1) t2 (1 - t2))      = t_or, the combined catch rate
q_or = p (1 - f_or) / (p (1 - f_or) + (1 - p)(1 - t_or))
precision of a release = p (f1 - f_or) / (p (f1 - f_or) + (1 - p)(t1 - t_or))
```

Here phi_f and phi_t are the phi coefficients between V1's and V2's holds on correct and on wrong candidates.

With t1 = 0.999 the miss covariance is tiny, so q_or is set by t2 whatever phi is. At f1 = 0.15 and a lenient V2 (f2 = 0.15, t2 = 0.948):

| phi | f_or | t_or | q_or | q, V1 alone |
| --- | --- | --- | --- | --- |
| 0.04 | 0.028 | 0.947 | 98.65% | 99.96% |
| 0.3 | 0.061 | 0.949 | 98.66% | 99.96% |
| 0.58 | 0.096 | 0.951 | 98.66% | 99.96% |

Release trades V1's catch rate for V2's. In the chain simulation wrong commits rose from 0.03% to 1.2% (a factor of about 40) at every phi, while phi decided only how much completion came back.

V2's verdict therefore never commits. It may do one of two things:

1. **Order the human queue** (recommended). On escalation, V2 scores every held candidate of the step, and the human reviews them best first.
2. **Route.** On a V1 hold, a V2 pass sends the candidate to human review; a V2 hold counts as a hold and the step resamples.

Ordering beat routing in simulation: same completion, fewer human reviews, higher precision (Table C).

### 3.9 Verification granularity

Verifying a block of k steps at once, with each step's work adding one more thing to object to:

```
a_k = p^k (1 - f)^k + (1 - p^k)(1 - t)
cost per committed step (proposer units) = (k + c_v) / (k a_k)
block precision = p^k (1 - f)^k / a_k
```

c_v is one verification's cost in proposals. With a_k ≈ e^(-lambda k), lambda = -ln(p (1 - f)), minimising (1 + c_v/k) e^(lambda k) gives:

```
k* = (sqrt(c_v^2 + 4 c_v / lambda) - c_v) / 2  ≈  sqrt(c_v / lambda)  for small c_v lambda
```

False alarms enter lambda exactly as errors do. For p = 0.9 and f = 0.05, lambda = 0.157. Then k* = 0.248, 2.08 and 4.43 at c_v = 0.01, 1 and 10, against numerical optima of 1, 2 and 4 (Table E). The plain square root gives 0.25, 2.53 and 7.99.

A Jev check costs a small fraction of a proposal, so k* < 1: verify every step. The formula matters only for an expensive tier, such as a human or a frontier model auditing blocks of reversible committed steps.

Coarser blocks also lower precision, because the share of bad blocks grows while t stays fixed. Under frailty, one step the verifier dislikes stalls its whole block.

### 3.10 The frontier for one ROC

With the latent factor u ~ N(0, r) and the binormal ROC (separation d, bar b):

```
f(u) = Phi((b - d - u) / sqrt(1 - r))
t(u) = Phi((b - u) / sqrt(1 - r))
a(u) = p (1 - f(u)) + (1 - p)(1 - t(u))
C(b, m) = E_u[1 - (1 - a(u))^m]
W(b, m) = E_u[(1 - p)(1 - t(u)) (1 - (1 - a(u))^m) / a(u)]
commit precision = 1 - W / C
chain completion = C^n
completion with every commit right = (C - W)^n
```

I used Simpson with 800 panels over x in [-8, 8], with u = sqrt(r) x.

Sweeping b traces the frontier for a given (ROC, m, r). The bar picks the precision; m and r set how far completion falls below the independent curve (r = 0). A ledger is compared against it by plugging in the measured d (from AUC on unselected rows), r and p, and reading where the observed (precision, completion) lands.

## 4. Tables

### Reproduction notes

- RNG: mulberry32 with Box-Muller normals, and Marsaglia-Tsang gamma draws for beta variates. This is not the repository's `src/math.ts`; a reimplementation will reproduce exact tables exactly and Monte Carlo tables within their stated error.
- Monte Carlo standard error at 20,000 chains is about 0.35 points at 50% and 0.17 points at 94%.

Parameters shared by Tables C, C' and the closed-form check:

| setting | value |
| --- | --- |
| proposer | p = 0.8, n = 8, three fresh proposals per step unless stated |
| primary V1 | d = 4.070 (AUC 0.998), bar 3.034, f1 = 15.0%, t1 = 99.88%, step factor r = 0.746 on both classes |
| second opinion V2 (assumed) | d = 2.660 (AUC 0.97), its own step factor r2 = 0.746 |
| V2 lenient bar | 1.623: f2 = 15.0%, t2 = 94.8% |
| V2 strict bar | 2.576: t2 = 99.5%, f2 = 46.7% |
| V2 latent score | x2 = R x1 + sqrt(1 - R^2)(v_i + e2), where x1 = u_i + e1 is V1's latent and v_i ~ N(0, r2) is V2's step factor; R is shared by correct and wrong candidates |
| human (assumed) | passes 98% of correct and 1% of wrong candidates, independently of both models; a human approval commits |

R is solved so that phi between V1 and V2 holds on correct candidates equals the target, through Phi2 at the two marginals:

| phi | R, lenient bar | R, strict bar |
| --- | --- | --- |
| 0.04 | 0.0895 | 0.0766 |
| 0.3 | 0.5334 | 0.5668 |
| 0.58 | 0.8338 | 0.9990 |

The strict-bar phi 0.58 is infeasible: at marginals 0.15 and 0.467 the largest attainable phi is sqrt(0.15 · 0.533 / (0.467 · 0.85)) = 0.449. That row ran at the solver's bound R = 0.999, close to maximal dependence.

### Table A. Reproducing T2 completion

Exact computation, no simulation. n = 8, t = 1, at most three distinct correct candidates per step (3.3 with L = 3). For the strict rows, f is the chain's own base rate at bar 0.9 and only the latent model applies.

| p | attempts | mean f | independent | two-point {0, 0.56} (current sim) | beta frailty | latent probit | observed (Wilson 95%) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.8 | 3 | 15.0% | 76.6% | 52.0% | 49.2% | 49.0% | 48% [38.5, 57.7] |
| 0.9 | 3 | 15.0% | 90.1% | 61.2% | 56.8% | 56.4% | 53% [43.3, 62.5] |
| 0.8 | 6 | 15.0% | 96.9% | 67.7% | 61.2% | 60.7% | 62% [52.2, 70.9] |
| 0.9 | 6 | 15.0% | 97.3% | 68.1% | 61.5% | 61.0% | 58% [48.2, 67.2] |
| 0.8 | 3 | 54.5% | 9.3% | - | - | 1.4% | 0% [0, 3.7] |
| 0.9 | 3 | 54.5% | 15.8% | - | - | 1.9% | 0% [0, 3.7] |

### Table B. Exhaustion against the attempt budget

Exact. p = 0.8, t = 1, fresh distinct candidates, beta(0.162, 0.917); latent r = 0.746 by quadrature.

| attempts m | independent (1-a)^m | beta | latent | 8-step completion, beta | 8-step completion, latent |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.20e-1 | 0.320 | 0.320 | 4.6% | 4.6% |
| 2 | 1.02e-1 | 0.142 | 0.142 | 29.5% | 29.5% |
| 3 | 3.28e-2 | 0.085 | 0.085 | 49.2% | 49.0% |
| 6 | 1.07e-3 | 0.041 | 0.043 | 71.7% | 70.5% |
| 12 | 1.15e-6 | 0.021 | 0.024 | 84.2% | 82.1% |
| 24 | 1.33e-12 | 0.011 | 0.015 | 91.4% | 89.0% |
| 48 | 1.77e-24 | 0.006 | 0.009 | 95.4% | 93.1% |
| 96 | 3.12e-48 | 0.003 | 0.006 | 97.5% | 95.6% |

The log-log slope of beta exhaustion between m = 48 and 96 is -0.918; the theory gives -b = -0.917. Doubling the budget roughly halves exhaustion, where independence would square it.

### Table B2. The posterior after k holds

Exact. Beta(0.162, 0.917), p = 0.8.

| holds so far k | E[theta \| k], t = 1 | P(next commits), t = 1 | E[theta \| k], t = 0.99 | P(next commits), t = 0.99 | precision of that commit, t = 0.99 |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.150 | 68.0% | 0.150 | 68.2% | 99.71% |
| 1 | 0.303 | 55.7% | 0.304 | 55.9% | 99.64% |
| 2 | 0.498 | 40.2% | 0.500 | 40.2% | 99.50% |
| 3 | 0.652 | 27.9% | 0.653 | 27.9% | 99.28% |
| 4 | 0.743 | 20.5% | 0.744 | 20.6% | 99.03% |
| 5 | 0.796 | 16.3% | 0.797 | 16.5% | 98.78% |
| 6 | 0.829 | 13.7% | 0.830 | 13.8% | 98.55% |

With t = 1 every commit is right, so the precision column is 100% throughout.

The one-step look-ahead rule (t = 0.99) escalates after these numbers of holds:

| c_esc / c_retry | 3 | 10 | 30 | 100 | 300 |
| --- | --- | --- | --- | --- | --- |
| escalate after k holds | 3 | 9 | 29 | > 60 | > 60 |

On cost alone, cheap retries justify long runs. The precision rule binds first: a 99% target stops after four holds.

### Table C. Remedies under the fitted model

Monte Carlo, 20,000 chains per row, seed 9000 + i for row i in the order listed (rows 0 to 21).

"Human after the k-th hold" works as follows:

1. Once a step has k holds, its next attempt slot goes to the human instead.
2. The human first reviews the held candidates in order and commits the first one approved.
3. Remaining slots are fresh proposals reviewed by the human.
4. If the budget ends exactly at the k-th hold, the human reviews the held candidates once.

A candidate a human already rejected through routing is not shown again.

| i | policy | chain completes | commit precision | completes, all commits right | step exhausts | proposals / chain | V2 calls / chain | human reviews / chain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | resample, 3 attempts (today) | 49.2% | 99.97% | 49.1% | 8.5% | 8.73 | 0.00 | 0.00 |
| 1 | resample, 6 attempts | 70.5% | 99.98% | 70.4% | 4.3% | 11.44 | 0.00 | 0.00 |
| 2 | resample, 12 attempts | 82.1% | 99.97% | 81.9% | 2.4% | 13.61 | 0.00 | 0.00 |
| 3 | V2 releases at lenient bar, phi 0.04 | 87.8% | 98.77% | 79.7% | 1.6% | 9.54 | 3.14 | 0.00 |
| 4 | V2 releases at strict bar, phi 0.04 | 72.9% | 99.86% | 72.0% | 3.9% | 9.39 | 3.25 | 0.00 |
| 5 | V2 pass routes to human, lenient bar, phi 0.04 | 87.2% | 99.96% | 86.9% | 1.7% | 9.65 | 3.19 | 1.07 |
| 6 | V2 releases, lenient, phi 0.3 | 77.4% | 98.79% | 70.2% | 3.2% | 9.39 | 3.25 | 0.00 |
| 7 | V2 releases, strict, phi 0.3 | 57.1% | 99.82% | 56.4% | 6.7% | 9.01 | 3.29 | 0.00 |
| 8 | V2 routes to human, lenient, phi 0.3 | 76.5% | 99.95% | 76.2% | 3.3% | 9.46 | 3.26 | 0.80 |
| 9 | V2 releases, lenient, phi 0.58 | 66.0% | 98.75% | 59.7% | 5.1% | 9.14 | 3.28 | 0.00 |
| 10 | V2 releases, strict, phi 0.58 (infeasible; ran at R = 0.999) | 49.3% | 99.87% | 48.8% | 8.5% | 8.73 | 3.27 | 0.00 |
| 11 | V2 routes to human, lenient, phi 0.58 | 65.2% | 99.95% | 65.0% | 5.2% | 9.21 | 3.30 | 0.52 |
| 12 | human after the 1st hold | 92.6% | 99.73% | 90.6% | 1.0% | 9.63 | 0.00 | 4.36 |
| 13 | human after the 2nd hold | 93.2% | 99.88% | 92.3% | 0.9% | 10.58 | 0.00 | 1.94 |
| 14 | human after the 3rd hold (on exhaustion) | 93.5% | 99.93% | 92.9% | 0.8% | 11.37 | 0.00 | 1.00 |
| 15 | V2 releases at strict bar (phi 0.04), then human on exhaustion | 94.1% | 99.81% | 92.7% | 0.8% | 10.47 | 3.62 | 0.51 |
| 16 | V2 routes to human (lenient, phi 0.04), then human on exhaustion | 93.9% | 99.93% | 93.3% | 0.8% | 9.93 | 3.28 | 1.38 |
| 17 | same, phi 0.3 | 93.7% | 99.93% | 93.2% | 0.8% | 10.33 | 3.58 | 1.33 |
| 18 | same, phi 0.58 | 93.8% | 99.92% | 93.2% | 0.8% | 10.73 | 3.86 | 1.26 |
| 19 | human on exhaustion, V2 orders the held candidates (phi 0.04) | 93.9% | 99.96% | 93.6% | 0.8% | 11.37 | 2.00 | 0.80 |
| 20 | same, phi 0.3 | 93.8% | 99.95% | 93.4% | 0.8% | 11.36 | 1.98 | 0.80 |
| 21 | same, phi 0.58 | 93.2% | 99.96% | 92.9% | 0.9% | 11.36 | 1.99 | 0.81 |

How to read it:

- Retries alone climb slowly (49% to 82% from 3 to 12 attempts).
- Releasing on V2 recovers completion in proportion to how independent V2 is, and always at the release precision.
- A human on exhaustion is the strongest single lever: 93.5% at one review per chain, more efficient than routing disagreements (87.2% at 1.07).
- Letting V2 order the human's queue keeps that completion with 20% fewer reviews and the best precision. Ordering is almost insensitive to phi, because V2 only ranks candidates the human then judges.
- Row 15 halves human load, but it releases on V2 and is shown only for comparison.

### Table C'. The same policies when the proposer carries the frailty

Same as Table C, except:

- each step's p_i ~ Beta(0.863, 0.216) (mean 0.8, ICC 0.481);
- V1's false alarms are independent across attempts (r1 = 0, f1 = 15%);
- seed 19000 + i, using the row numbers of Table C.

| i | policy | chain completes | commit precision | completes, all commits right | V2 calls / chain | human reviews / chain |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | resample, 3 attempts | 41.2% | 99.95% | 41.0% | 0.00 | 0.00 |
| 1 | resample, 6 attempts | 63.2% | 99.91% | 62.8% | 0.00 | 0.00 |
| 3 | V2 releases, lenient, phi 0.04 | 51.7% | 98.20% | 44.7% | 3.27 | 0.00 |
| 4 | V2 releases, strict, phi 0.04 | 45.6% | 99.74% | 44.6% | 3.26 | 0.00 |
| 5 | V2 routes to human, phi 0.04 | 47.4% | 99.93% | 47.1% | 3.27 | 0.81 |
| 14 | human on exhaustion | 49.9% | 99.64% | 48.4% | 0.00 | 1.74 |
| 15 | V2 releases strict, then human on exhaustion | 51.3% | 99.48% | 49.1% | 3.37 | 1.59 |
| 16 | V2 routes, then human on exhaustion | 50.9% | 99.65% | 49.5% | 3.29 | 2.27 |
| 19 | human on exhaustion, V2 orders | 51.1% | 99.70% | 49.9% | 1.87 | 1.61 |

When repeated holds are the verifier being right, verification-side remedies buy at most 10 points, and releases cost more precision. Only more or better proposals help (six attempts: 63%). In that world the human tier must do the step, not only judge it.

The two worlds produce the same "held again" signal, so labels on held candidates are what tells them apart (section 6).

### Table D. The frontier for one ROC

Quadrature (3.10). Binormal AUC 0.97 (d = 2.660), p = 0.8, n = 8, step factor on both classes. Each cell is commit precision / chain completion.

| false alarm f | catch t | independent, m = 3 | frailty r = 0.746, m = 3 | frailty, m = 12 |
| --- | --- | --- | --- | --- |
| 2% | 72.8% | 93.51% / 96.7% | 94.06% / 91.2% | 94.11% / 99.2% |
| 5% | 84.5% | 96.08% / 92.9% | 96.50% / 81.0% | 96.57% / 96.8% |
| 10% | 91.6% | 97.72% / 86.3% | 98.02% / 64.4% | 98.10% / 90.4% |
| 15% | 94.8% | 98.49% / 78.6% | 98.71% / 49.4% | 98.79% / 82.1% |
| 25% | 97.6% | 99.22% / 60.0% | 99.36% / 26.1% | 99.43% / 62.1% |
| 40% | 99.2% | 99.67% / 30.1% | 99.74% / 7.4% | 99.78% / 31.8% |

Precision barely depends on frailty or m: under the shared strict/lenient factor it even rises slightly. Completion depends on both.

### Table E. Verify every k steps

Exact (3.9). Dependent chain (a block is right only if all k steps are), p = 0.9, t = 0.99, f = 0.05 per step of work, 24 steps, unbounded retries, no frailty.

| k | P(all 24 committed steps right) | cost / step, c_v = 0.01 | c_v = 1 | c_v = 10 |
| --- | --- | --- | --- | --- |
| 1 | 97.2% | 1.18 | 2.34 | 12.85 |
| 2 | 96.9% | 1.37 | 2.05 | 8.19 |
| 3 | 96.6% | 1.60 | 2.12 | 6.90 |
| 4 | 96.2% | 1.86 | 2.32 | 6.51 |
| 6 | 95.3% | 2.53 | 2.95 | 6.75 |
| 8 | 94.2% | 3.44 | 3.86 | 7.72 |
| 12 | 91.2% | 6.26 | 6.78 | 11.47 |

### Table F. Retry budget rules

Common random numbers: every rule sees the same 40,000 chains, with each step's first committing attempt drawn once, up to 64 attempts. Seed 5151; beta(0.162, 0.917), p = 0.8, t = 1, n = 8.

| budget rule | chain completes | Monte Carlo SE | attempts used / chain |
| --- | --- | --- | --- |
| 3 per step (today) | 49.8% | 0.25 pts | 8.8 |
| 6 per step | 72.1% | 0.22 pts | 11.5 |
| pool of 24, no per-step cap | 84.8% | 0.18 pts | 14.6 |
| pool of 24, cap 6 per step | 72.0% | 0.22 pts | 11.5 |
| pool of 24, reserve 1 per later step | 84.8% | 0.18 pts | 14.1 |
| pool of 24, reserve 2 per later step | 82.7% | 0.19 pts | 13.3 |
| pool of 48, no per-step cap | 93.9% | 0.12 pts | 16.9 |

At the same worst-case spend as today's three per step, a shared pool lifts completion from 49.8% to 84.8% (mean spend 14.6 attempts against 8.8). Per-step caps waste budget on easy steps and starve hard ones.

## 5. Recommended design in this codebase's terms

**Keep both invariants as they are.** Every commit has an `act` from a verifier tier: V1, or a human whose approval is a verification. There is no loop runner: the human tier is reached through `stopReason: "exhausted"` and a resume from the last checkpoint, or through a step-level hook that returns a `Verification`.

1. **Retries are fresh bytes.** Deduplicate by candidate hash in `runChain` or in the caller's `propose`. A byte repeat is not an attempt: it reuses a verdict. Count only distinct candidates toward holds.
2. **Budget per chain, not per step.** Use a pool with a one-per-later-step reservation (3.7), sized from the fitted frailty through 3.3. `maxAttempts` stays as a hard per-step cap and remains a finite integer.
3. **Escalate on the posterior.** At each hold, compute pi_k and q_k (3.5) from the gate's fitted (a, b) and from p and t measured on labelled first attempts. Escalate when pi_k <= c_retry / c_esc or q_k falls below the gate's precision target (3.6). Without a fit, escalate at exhaustion.
4. **The escalation tier is the human review queue**, reached when the rule fires or at exhaustion. A floor, a one-way door or a refusal on the gate keeps its meaning: a floored step goes to review directly, and a refusal still ends the chain.
5. **A second opinion of another family orders the reviewer's queue** of held candidates (Table C, rows 19 to 21). Its verdict never commits. Routing V1-hold/V2-pass candidates to the human is the fallback when there is no exhaustion tier.
6. **Releasing on V2 alone is out.** It trades the primary's catch rate for the second model's: a factor of about 40 in wrong commits at every phi (rows 3, 6, 9). It is never acceptable on a one-way door.
7. **Verify every step.** Reserve the k* formula (3.9) for an expensive auditing tier over reversible steps.
8. **Fix the simulation.** Replace the two-point law in `sim/main.ts` section 5 with the beta, and print the interval of 3.4 beside it, so the sim stops showing the optimistic extreme as the correlated case.
9. **Restate the docs.** The `runChain` paragraph in `docs/architecture.md` should state completion with the frailty formula (3.3), not the independent one with a caveat. The T2 report's six-attempt predictions should be restated for three distinct correct styles.

## 6. What the ledger must record, and how to label it

Rows carry `chain`, `chain:step:<name>` and `chain:attempt:<n>` today (`chainTags`), and `isUnselected` already excludes attempts after the first. To measure completion, exhaustion and the frailty rather than compute them, each verification row needs:

- **chain run id**, shared by every row of one `runChain` call;
- **step instance key**: a hash of the before-state plus the step name, stable across attempts. It is the cluster for every estimator above. The step name alone is not enough, because the frailty belongs to the instance;
- **candidate hash**, the after-state hash, to deduplicate byte repeats and to pair V1 and V2 verdicts on one candidate;
- **holds before**: distinct-candidate holds already on this step instance;
- **tier**: `primary`, `second` or `human`, plus the tier's model, so a pair's phi is measured per model pair;
- **committed**: true on the row whose ruling committed the step.

And one **chain summary row** per run, with:

- outcome: `ok`, `exhausted`, `refused` or `escalated`;
- `stoppedAt`;
- distinct attempts per step;
- the step that escalated and how the escalation resolved;
- the pool size and reservation.

Completion and per-step exhaustion are counted from summary rows with Wilson intervals. They are never computed from the formula.

Labelling:

- **Cluster-sampled blind review.** For a seeded uniform sample of step instances, blind-label every attempt of the instance, not rows chosen by their ruling. This makes the likelihood of 3.2 valid. It also gives the held-again and held-a-third-time rates, and p and t from first attempts. In T2, 76 held-then-retried events in one run gave the ICC to about ±0.11.
- **Probe steps.** For a seeded fraction of steps, have the verifier judge R = 3 independent candidates whatever its rulings, committing the first act as usual. The extras are proposed and verified in shadow and blind-labelled. They are unselected and identify the first three moments of the frailty (Han). They are the only clean evidence on the tail that decides large-m completion.
- **Second-opinion pairs.** On escalated and probe steps, ask V2 on the same candidates and record phi between V1 and V2 holds on labelled correct candidates, and separately on wrong ones. Table C's numbers assume a V2 that has not been measured.
- **Human escalation decisions are not blind labels.** The reviewer saw the candidates in V2's order and knew V1 held them. Record them with a source of their own (an escalation review), keep them out of fits, and keep the blind cluster sample separate.

## 7. Pitfalls and the assumptions everything rests on

Pitfalls:

- **Verifier frailty and proposer frailty look the same without labels.** Both raise "held again". In Table C' verification-side remedies barely help and releases cost more. Fit the frailty on labelled correct candidates only.
- **A two-number fit cannot certify completion for long budgets.** Here it caps any certificate at 52%. Report the interval of 3.4, and fit the third moment from probe steps before promising more.
- **Releasing on a second opinion** is an OR rule on the pass side. Its precision is set by the weaker model's catch rate, whatever the correlation.
- **Retrying until commit has infinite expected cost when b <= 1.** Keep `maxAttempts` finite, which `attemptsOf` already enforces, and add the pool and escalation rules.
- **Do not feed V1's verdict or its reasons to V2 or to the proposer** (invariant 8). Decorrelate through model family, paraphrase, or red-flagging malformed and overlong outputs.
- **Do not fit on rows chosen by their ruling**, such as `--denied`, without modelling the selection. Retry rows are already excluded from unselected evidence; the censored likelihood is the way to use them.
- **Do not pool p = 0.8 and p = 0.9 runs that share instances** as if they were independent evidence. The pooled 95/170 has the same instances counted twice.
- **The beta pooled over families mixes a family where the verifier dislikes most correct answers** (warranty, 24/27 held-out false alarms) with families where it never false-alarms. Fit per step kind once rows allow.

Assumptions behind the tables:

- steps are independent tasks (no poisoning), as in T2; Table E alone assumes poisoning;
- p is constant within a step, except in Table C';
- t = 1 in Tables A, B and F; t1 = 0.9988 in Table C;
- one latent factor shared by correct and wrong candidates;
- V2's ROC and ICC, and the human's 98% / 1% accuracy, are assumed, and the human is independent of both models;
- phi is mapped to a candidate-level latent correlation R, applied to both classes;
- costs are in proposer units;
- escalation resolves a step;
- the T2 corpus is authored mutations of templates, and chain steps cycle six families.

## 8. Open questions, and confidence in each recommendation

| recommendation or claim | confidence | what would change it |
| --- | --- | --- |
| A step-level frailty explains T2's completion gap (beta and probit both reproduce it; the probit predicts the strict bar out of sample) | high | a second run whose held-again rate does not move with the bar as the probit says |
| Beta as the working law | medium | the third moment runs 74% to 84% against the beta's 70%; probe steps decide whether the tail near theta = 1 is heavier |
| Human tier at exhaustion, with V2 ordering the queue, as the default escalation | medium-high qualitatively | the numbers depend on V2's real ROC and its phi with Jev on correct candidates, never measured on a verification task (T5's 0.04 and 0.58 were on other tasks), and on the human's accuracy |
| Never release on V2 alone | high | only a measured V2 catch rate at least V1's, which would make V2 the better primary |
| Shared pool with one reserved attempt per later step | high for one chain | a fleet sharing a human queue or proposer budget needs the stopping rule of 3.6 at fleet level, not derived here |
| Posterior escalation rule (pi_k, q_k) | medium | monotone and closed form, but its thresholds inherit the beta tail and need p and t from first attempts |
| Verify every step | high while a check costs a small fraction of a proposal | an expensive verifier tier |
| Ledger fields and cluster-sampled labels | high | standard likelihood theory; the open cost is blind-labelling whole step instances |

Open questions:

- In production, does proposer frailty dominate verifier frailty? T2's scripted proposer was iid by design.
- How should the posterior rule combine with gate floors, and should blind audits that hold an act count as holds?
- What is a fleet-level allocation rule for a human queue of fixed capacity?
- Is the probit's single ICC stable across model pins and corpora?

## Sources

- Aksu, H. (2026). Odds Law: the decomposition algebra on how intelligence organizes itself to solve difficult problems reliably. arXiv 2606.15712. https://arxiv.org/abs/2606.15712 [verified]
- Aupy, G., Benoit, A., Hérault, T., Robert, Y., Vivien, F. and Zaidouni, D. (2013). On the combination of silent error detection and checkpointing. arXiv 1310.8486. https://arxiv.org/abs/1310.8486 [verified abstract]
- Avizienis, A. (1985). The N-version approach to fault-tolerant software. *IEEE TSE* SE-11(12), 1491-1501. https://doi.org/10.1109/TSE.1985.231893 [memory; citation confirmed by search]
- Benoit, A., Cavelan, A., Robert, Y. and Sun, H. (2016). Optimal resilience patterns to cope with fail-stop and silent errors. IPDPS 2016. https://my.vanderbilt.edu/hongyangsun/files/2017/02/ipdps16.pdf ; Cavelan, A., Raina, S. K., Robert, Y. and Sun, H. (2015). Assessing the impact of partial verifications against silent data corruptions. ICPP 2015. https://cdn.vanderbilt.edu/t2-my/my-prd/wp-content/uploads/sites/2355/2017/02/icpp15.pdf [memory; citations confirmed by search; PDFs not readable here]
- Chow, Y. S., Robbins, H. and Siegmund, D. (1971). *Great Expectations: The Theory of Optimal Stopping*. Houghton Mifflin. (monotone case; no URL checked) [memory]
- Collins, R. D., Case, K. E. and Bennett, G. K. (1973). The effects of inspection error on single sampling inspection plans. *International Journal of Production Research* 11(3), 289-298. https://doi.org/10.1080/00207547308929972 [memory; citation confirmed by search]
- Daly, J. T. (2006). A higher order estimate of the optimum checkpoint interval for restart dumps. *Future Generation Computer Systems* 22(3), 303-312. https://laro.lanl.gov/esploro/outputs/journalArticle/A-higher-order-estimate-of-the/9916364420003761 [verified record]
- Ding, J., Greenberg, B. S. and Matsuo, H. (1998). Repetitive testing strategies when the testing process is imperfect. *Management Science* 44(10), 1367-1378. https://ideas.repec.org/a/inm/ormnsc/v44y1998i10p1367-1378.html [verified]
- Eckhardt, D. E. and Lee, L. D. (1985). A theoretical basis for the analysis of multiversion software subject to coincident errors. *IEEE TSE* SE-11(12), 1511-1517, https://doi.org/10.1109/TSE.1985.231895 ; NASA TM 86369, https://ntrs.nasa.gov/citations/19850015006 [verified, technical memorandum abstract]
- Fadeeva, E., Li, X., Sachan, M. and Panov, M. (2026). Verifier-guided self-consistency: test-time reasoning with imperfect generators and verifiers. arXiv 2611.06606. https://arxiv.org/abs/2611.06606 [verified]
- Gardner, I. A., Stryhn, H., Lind, P. and Collins, M. T. (2000). Conditional dependence between tests affects the diagnosis and surveillance of animal diseases. *Preventive Veterinary Medicine* 45, 107-122. https://doi.org/10.1016/S0167-5877(00)00119-7 [memory; citation and abstract sentence confirmed by search]
- Goel, S. et al. (2025). Great models think alike and this undermines AI oversight. arXiv 2502.04313. https://arxiv.org/abs/2502.04313 [verified]
- Greenberg, B. S. and Stokes, S. L. (1995). Repetitive testing in the presence of inspection errors. *Technometrics* 37(1), 102-111. https://doi.org/10.1080/00401706.1995.10485893 [memory; citation confirmed by search]
- Han, J. (2026). Partially correlated verifier cascades in LLM harnesses: concave log-odds, polynomial reliability, and blind-spot ceilings. arXiv 2607.13918. https://arxiv.org/abs/2607.13918 [verified]
- Karlin, S. and Studden, W. J. (1966). *Tchebycheff Systems: With Applications in Analysis and Statistics*. Interscience. (principal representations; no URL checked) [memory; the bound used was checked numerically]
- Kim, E., Garg, A., Peng, K. and Garg, N. (2025). Correlated errors in large language models. ICML 2025. arXiv 2506.07962. https://arxiv.org/abs/2506.07962 [verified]
- Knight, J. C. and Leveson, N. G. (1986). An experimental evaluation of the assumption of independence in multiversion programming. *IEEE TSE* 12(1), 96-109. https://www.kth.se/social/files/564df871f2765419e306178d/KnightLeveson.pdf [memory; citation, 27 versions and one million tests confirmed by search]
- Littlewood, B. and Miller, D. R. (1989). Conceptual modeling of coincident failures in multiversion software. *IEEE TSE* 15(12), 1596-1614. https://ntrs.nasa.gov/citations/19900036555 [verified]
- Liu, N. (2026). LLMs as a jury: cross-model consensus can outperform process reward models for LLM reasoning. arXiv 2607.10139. https://arxiv.org/abs/2607.10139 [verified]
- Meyerson, E. et al. (2025). Solving a million-step LLM task with zero errors (MAKER). arXiv 2511.09030. https://arxiv.org/html/2511.09030v1 [verified: red-flagging and correlated-errors passages]
- Nicola, V. F. and Goyal, A. (1990). Modeling of correlated failures and community error recovery in multiversion software. *IEEE TSE* 16(3), 350-359. https://doi.org/10.1109/32.48942 [memory; citation and beta-binomial model confirmed by search]
- Qu, Y., Tan, M. and Kutner, M. H. (1996). Random effects models in latent class analysis for evaluating accuracy of diagnostic tests. *Biometrics* 52(3), 797-810. (no URL checked) [memory; citation confirmed by search]
- Randell, B. (1975). System structure for software fault tolerance. *IEEE TSE* SE-1(2), 220-232. https://doi.org/10.1109/TSE.1975.6312842 [memory; citation confirmed by search]
- Saad-Falcon, J. et al. (2025). Shrinking the generation-verification gap with weak verifiers. NeurIPS 2025. arXiv 2506.18203. https://arxiv.org/abs/2506.18203 [verified]
- Schaeffer, R. et al. (2025). How do large language monkeys get their power (laws)? ICML 2025. arXiv 2502.17578. https://arxiv.org/abs/2502.17578 [verified]
- Scott, R. K., Gault, J. W. and McAllister, D. F. (1987). Fault-tolerant software reliability modeling. *IEEE TSE* 13(5), 582-592. https://doi.org/10.1109/TSE.1987.233463 [memory; citation confirmed by search]
- Stroebl, B., Kapoor, S. and Narayanan, A. (2024; v3 2026). Inference scaling fLaws: the limits of LLM resampling with imperfect verifiers (v3: The limits of inference scaling through resampling). arXiv 2411.17501. https://arxiv.org/abs/2411.17501 [verified]
- Tomek, L. A., Muppala, J. K. and Trivedi, K. S. (1993). Modeling correlation in software recovery blocks. *IEEE TSE* 19(11), 1071-1086. https://scholars.duke.edu/publication/687932 [verified]
- Vacek, P. M. (1985). The effect of conditional dependence on the evaluation of diagnostic tests. *Biometrics* 41(4), 959-968. (no URL checked) [memory; citation confirmed by search]
- Xin, E. (2026). Are verifier errors independent within a GRPO group? Evidence from Qwen2.5 rollouts. arXiv 2609.06386. https://arxiv.org/abs/2609.06386 [verified]
- Young, J. W. (1974). A first order approximation to the optimum checkpoint interval. *Communications of the ACM* 17(9), 530-531. https://doi.org/10.1145/361147.361115 [memory; citation confirmed by search]

The numbers in this note were computed by seeded scripts in a session scratch folder that is not part of the repository; tables that back shipped code are to be reproduced under `sim/`.
