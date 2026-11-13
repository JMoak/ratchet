# Pooling dependent judges and deferring between tiers

*Research note, 2026-11-12. Foundations review: the theory under `pool()`, the cascade, the sequential strategy and battery combiners, with the design it implies and the seeded simulations behind it. Docs only; URLs are in the sources at the end.*

The engine pools member answers in log-odds with a correlation correction, escalates cascades on the first tier's confidence and replaces its answer, stops sequential runs on a pooled bar, and combines batteries with `logodds`, `any`, `all` or a logistic model. This note asks what the principled versions of those operations are, what they need measured, and what to change. The short answers:

- The engine's generalised least squares weights w = R^-1 1 are the Bayes-optimal weights of a specific model: member logits jointly normal given the truth, every member calibrated alone, and every member equally strong. Under that model R is the within-class correlation of the logits, not the phi of correctness the ledger measures now. Phi is attenuated (a latent 0.85 reads as 0.42 to 0.60) and has a ceiling set by the members' error rates.
- Every calibrated logit already contains the gate's base rate, so summing logits counts the prior once per effective member. At a base rate of 0.8, three calibrated members who learned nothing pool to 0.95 or 0.985 instead of 0.8. Subtract the prior before pooling and add it back once.
- One operator covers replicas and different families. The pool is already an extremizer: it multiplies the mean logit by 1'R^-1 1, about 1.03 for replicas of one model and up to n for independent members. Different R, not different operators.
- At 100 to 300 labels, a structured pool (correlation shrunk toward the family prior, strength from class-mean gaps, weights non-negative and at most 1, prior offset) beat or tied every alternative in three simulated panels, including logistic stacking, which was noisier until about 300 rows.
- Why ensembles of similar judges stop helping is the N-version difficulty theory: phi is the covariance of two models' difficulty functions over the item mix, which is why one pair read 0.04 on one corpus and 0.58 on another. The ledger can compute a hard ceiling: no combiner that follows a unanimous panel beats 1 - P(all wrong).
- Cascades should pool the tiers they asked rather than replace, and defer by the measured gain per confidence bin rather than by tier-1 confidence alone; the act bar on the final verdict carries the promise, the deferral rule only spends money.
- A sequential test is valid under exchangeable positive correlation when the likelihood ratio is that of the joint law; under compound symmetry that ratio is exactly the design-effect pool. Ask next the member that adds the most separation per unit cost; a member that adds none is a copy.
- For all-of and any-of batteries, the Frechet interval is a sound readout of how much the marginals alone leave open, but not a safe rule: its lower end is no more cautious than the product where acting happens, and it is not a bound at all when members' errors are correlated. The default should be the product (or noisy-OR) followed by a two-parameter Platt fit.

## 1. The principled model, and the right dependence measure

### The Gaussian-logit (supra-Bayesian) model

Let the truth be Y in {0, 1} with base rate pi and prior log-odds lambda0 = logit(pi). Member i reports z_i, the logit of its p(yes). Suppose that given Y = y the vector z is multivariate normal, z | y ~ N(mu_y, Sigma), with the same covariance in both classes. Then the posterior log-odds given all members is the prior plus the log-likelihood ratio:

    L(z) = lambda0 + log N(z; mu_1, Sigma) - log N(z; mu_0, Sigma)
         = lambda0 + dmu' Sigma^-1 (z - m),   dmu = mu_1 - mu_0,  m = (mu_1 + mu_0) / 2.

This is the dependent-sources consensus model of Winkler (1981) and the linear "supra-Bayesian" combination reviewed by Clemen and Winkler (1999) and Genest and Zidek (1986). It is linear in the members' logits; the weights are Sigma^-1 dmu.

Now impose that every member is calibrated on its own. Member i alone has z_i | y ~ N(mu_yi, sigma_i^2), and its own posterior is lambda0 + (dmu_i / sigma_i^2)(z_i - m_i). Calibration says that posterior equals z_i for every z_i, which forces dmu_i = sigma_i^2 and m_i = lambda0: the class means are lambda0 +- sigma_i^2 / 2. A member calibrated this way is right with probability Phi(sigma_i / 2) at a base rate of 0.5 (an 86% member has sigma = 2 Phi^-1(0.86) = 2.16; a 96.5% member 3.62).

Write Sigma = D R D with D = diag(sigma) and R the correlation matrix. Then dmu = D sigma (the vector of sigma_i^2), and

    Sigma^-1 dmu = D^-1 R^-1 D^-1 D sigma = D^-1 R^-1 sigma,

so the optimal pool of calibrated members is

    L(z) = lambda0 + sum_i w_i (z_i - lambda0),   w_i = (R^-1 sigma)_i / sigma_i.

Three special cases matter. When members are equally strong (all sigma_i equal), w = R^-1 1, which is exactly the engine's generalised least squares weighting. When R = I, every w_i = 1: independent calibrated logits are summed (naive Bayes, the Nitzan-Paroush weighting already in the existing research note). When R has one correlation rho everywhere and members are equally strong, R^-1 1 = 1 / (1 + (n - 1) rho) on every member: the engine's design-effect shrink n_eff / n is the exact Bayes rule for exchangeable calibrated Gaussian members, not an approximation. When members differ in strength the engine's weights are not optimal: a strong member correlated with weaker ones should get relatively more weight, and a weak member correlated with a strong one can get a negative unconstrained weight (it is then dropped by a non-negative solve).

In data terms the same weights are w = Sigma^-1 d with d_i = m1_i - m0_i (the gap between member i's mean logit on true and false rows) and Sigma_ij = r_ij sqrt(v_i v_j) (v_i its within-class variance). Under calibration d_i = v_i = sigma_i^2 and the two forms coincide; the data form keeps working when a member is somewhat over- or underconfident.

### Why R must be the within-class correlation of the logits

Sigma is the covariance of the logits given the truth. The unconditional covariance adds a signal term, pi (1 - pi) dmu dmu', so any two informative members look correlated even when their errors are independent; it must not be used. Phi of correctness is a different quantity again. Member i is right when (z_i - lambda0) has the sign of the truth, so its correctness indicator is the latent normal z_i cut at a threshold. For a bivariate normal pair, the phi of two dichotomised variables is smaller in magnitude than the latent correlation r (the tetrachoric problem), and the smaller the error rates, the more it shrinks. Phi is also bounded by the marginals: for error rates e1 <= e2,

    phi_max = sqrt( e1 (1 - e2) / (e2 (1 - e1)) ).

For jev-1.13 (14.2% wrong) and haiku-5.5 (3.5% wrong) on e2e T5, phi cannot exceed 0.47 however correlated the two are; for the BoolQ pair (5.0% and 7.4%) it cannot exceed 0.81. Table A1 shows the attenuation: at a latent correlation of 0.85, phi reads 0.60 for two members at 86% and 84%, and 0.42 for members at 86% and 96.5%. Plugging phi into R^-1 1 therefore under-corrects, pooling correlated members as if they were less correlated than they are.

Phi is also noisy where it matters. It is driven by the handful of rows where a member is wrong. T5's cross-family phi of 0.043 rests on 2 shared errors among 37 and 9; its bootstrap 95% interval is -0.08 to 0.20, and one shared error more or less moves it to 0.104 or -0.017 (table G1). In table A2, at n = 100 phi was undefined (a member never wrong) in 66 of 2,000 cross-family samples. The within-class logit correlation uses every row: its standard deviation was 0.02 to 0.03 for a same-family pair (phi: 0.07 to 0.12) and 0.06 to 0.10 for a cross-family pair (phi: 0.07 to 0.11). The tetrachoric correlation undoes the attenuation under bivariate normality but is the noisiest of the three (standard deviation 0.19 to 0.23 cross-family).

Phi is the right quantity in one place: for votes. When members contribute only their leaning (yes or no), exchangeable binary votes are a beta-binomial process, and the phi between two replicas' correctness is exactly that process's intraclass correlation (section 4 and table C). So the rule is: pool logits with the within-class logit correlation; count or bound votes with phi. The engine pools logits but measures phi.

Copula models give the same separation in more generality: each source's quality goes in its marginal, the dependence goes in a copula with one dependence parameter (Jouini and Clemen, 1996). The Gaussian-logit model is the Gaussian copula with normal marginals on the logit scale; a rank correlation within class, converted by r = 2 sin(pi rho_s / 6), is the robust alternative when logits are heavy-tailed or pinned.

### The prior is counted once per effective member

Every calibrated member's logit already contains lambda0, because calibration is measured on the gate's traffic. Summing logits, with any weights, counts the prior sum_i w_i times instead of once. The engine's `poolJudge` sums w_i logit(p_i) with no prior term.

A worked example. A gate with base rate 0.8 has lambda0 = 1.386. Three calibrated members each answer p = 0.8, which for a calibrated member means it saw no evidence either way (its log-likelihood ratio is 0); the right pooled answer is 0.8.

- The engine at rho 0 pools 3 x 1.386 = 4.159, p = 0.985.
- The engine's family default (two pins of one model at 0.75, one other family at 0) gives weights 1/1.75, 1/1.75 and 1, summing to 2.143: 2.143 x 1.386 = 2.970, p = 0.951.
- The corrected pool lambda0 + sum_i w_i (z_i - lambda0) = 1.386, p = 0.8.

Three members who learned nothing would clear a 0.95 act bar. The bias always points toward the majority class, which on a tool gate is usually "allow". In simulation B2 (base rate 0.8), the uncorrected sum of three calibrated members had a held-out log loss of 0.088, worse than the best single member alone (0.071); the same GLS weights with the prior offset went from 0.059 to 0.049. Bordley (1982) derived a multiplicative pooling formula axiomatically; that it divides each expert's odds by the prior odds is my recollection of its form, not verified this session.

### Extremizing: when the pool should be more confident than the mean logit

When every member reports the same delta = z_i - lambda0, the pool is lambda0 + (sum_i w_i) delta, and for equally strong members sum_i w_i = 1'R^-1 1. So the engine's pool is already an extremizer of the mean logit, by the factor 1'R^-1 1 (table C): 1.03 for three members at r 0.95 (replicas of one model), 1.11 at 0.85, 1.50 at 0.5, 3 at 0; for two pins at 0.93 plus another family at 0.15, 1.77.

The partial-information framework of Satopaa, Pemantle and Ungar (2016) says the same from the forecasting side. Each forecaster reports a calibrated conditional expectation given its own information set; with complete overlap the right aggregate is the average, with no overlap it is a vote followed by extremizing by the total information, and between the two the amount of extremizing falls as overlap rises. Within-class correlation is the Gaussian measure of that overlap. So replicas of one model and models of different families do not need different operators; they need different R. The same paper contrasts this with the measurement-error view (forecasts as noisy readings of one true probability), whose averages are underconfident and confined to the convex hull of the forecasts.

A pool should be less confident than the mean logit only when members are individually overconfident, that is, when their spread is noise rather than information. Baron, Mellers, Tetlock, Stone and Ungar (2014) give two reasons to extremize averaged forecasts (forecasters hold different information, and the probability scale compresses averages toward 0.5), and averaging probabilities rather than logits is underconfident even for calibrated members (Ranjan and Gneiting, 2010, show a non-trivial linear pool of distinct calibrated forecasts is uncalibrated). Satopaa et al. (2014) fit one extremizing parameter on the mean logit. In simulation B, fitting a slope on top of the structured pool at n = 100 cost variance and log loss (B1: 0.068 +- 0.009 against 0.061 +- 0.001 without it), so the slope is not part of the default.

### Stacking

Breiman (1996) found that stacked regressions need non-negative combination weights to help reliably. The forecast-combination puzzle, that simple averages often beat estimated optimal weights, is explained by the finite-sample error of estimating the weights (Smith and Wallis, 2009). Both point the same way at 100 to 300 labels: a structured pool with few free parameters, shrunk toward a prior, beats a free logistic stack. Simulation B agrees: the logistic stack's log loss had a standard deviation of 0.010 to 0.012 across fits at n = 100 against 0.000 to 0.005 for the structured pools, and ridging the stack toward the prior pool rather than toward 0 did not help (0.068 against 0.069 at n = 100).

### Estimating the dependence from 100 to 300 rows

Shrink each measured correlation toward a prior instead of using it raw: Ledoit and Wolf (2004) shrink a sample covariance toward a structured target with an intensity chosen to minimise expected loss, and Schafer and Strimmer (2005) give an analytic intensity for shrinking correlations toward zero. The simplest version that fits this engine shrinks each pair on the Fisher z scale toward its family prior with a fixed pseudo-count (section 2, formula 3). In table A2, with n0 = 30 pseudo-rows, the shrunk estimate's standard deviation was 0.02 (same family) and 0.05 to 0.08 (cross family), with a small pull toward the prior. Simulation B compares every estimator end to end.

## 2. Why ensembles of similar judges stop helping

### The difficulty-function theory

Eckhardt and Lee (1985) modelled N-version software with a difficulty function theta(x): the probability that a version written by a randomly chosen team fails on input x. Two versions developed independently fail independently on each fixed input, but not on a random one: P(both fail) = E_x[theta(x)^2] = E[theta]^2 + Var(theta). (The variance result is verified this session through secondary sources; the formula in this form is my statement of it.) Independent development therefore does not give independent failures; the excess is the variance of difficulty over the input profile, and the spikier the difficulty, the worse. Littlewood and Miller (1989) extended this to versions built by different methodologies, A and B: P(both fail) = E[theta_A theta_B] = E[theta_A] E[theta_B] + Cov(theta_A, theta_B), and argued that forced design diversity lowers coincident failure. That the covariance can be negative, making a diverse pair better than independent, is my recollection, not verified this session. Knight and Leveson (1986) tested the independence assumption directly: 27 versions written from one specification at two universities, run on a million inputs, failed together far more often than independence predicts.

For two decision models answering once each, with errors independent given the item, the covariance of their error indicators over items is exactly Cov_x(theta_A(x), theta_B(x)), and

    phi = Cov_x(theta_A, theta_B) / sqrt( e_A (1 - e_A) e_B (1 - e_B) ),   e = E[theta].

So phi is not a property of a pair of models. It is a property of the pair and the item distribution: it is the covariance of their difficulty functions under the traffic mix.

### 0.04 on one corpus, 0.58 on another

jev-1.13 and haiku-5.5 correlated at 0.58 on BoolQ and at 0.04 on T5's rule corpus. Table G2 shows how little it takes. Suppose two judges whose errors are independent within strata, and a stratum of items that both find hard (ambiguous or mislabelled items, where each is "wrong" with probability 0.85). At the BoolQ error rates (5.0% and 7.4%), phi is 0 with no such stratum, 0.22 when it holds 2% of items, and 0.45 at 4%, with P(B wrong | A wrong) at 59%; BoolQ measured 0.58 and 73%, which a stratum of about 5% reproduces. That BoolQ has label noise of that order is my recollection, not verified this session. T5's corpus was built the other way: it upweighted difficulty sources specific to Jev (raw arithmetic, counting with open results, relational rule exceptions) on which haiku was strong, so the two difficulty functions barely covaried. Both corpora fit one model. What transfers between them is the per-stratum error rates, not the phi: if the ledger records a stratum key (template family, digest flags), phi for a new traffic mix follows from

    P(both wrong) = sum_s pi_s P(A wrong | s) P(B wrong | s)

under within-stratum independence, which is itself checkable on rows where both answered.

### A ceiling the ledger can compute

For a binary question, on any item where every member is wrong, all members give the same wrong answer. A combiner that follows a unanimous panel, which includes every pool with non-negative weights, is then wrong too. So

    accuracy <= 1 - P(all members wrong),

estimated from labelled rows where every member answered, with an exact (Clopper-Pearson) interval. On T5's held-out items jev-1.13 and haiku-5.5 were both wrong on 2 of 260 (0.77%, 95% interval 0.09% to 2.75%): no unanimity-respecting combiner of the two could exceed 99.2% there, and the cascade reached 98.5%. For replicas the same theory gives the replica ceiling: with per-item error theta drawn from a beta distribution with mean e and intraclass correlation ICC, a majority of infinitely many replicas fails exactly where theta > 1/2. At e = 14% and ICC 0.87 (the replica phi measured in T5), that ceiling is 13.9% wrong against 14.0% for one call (table G3): no number of replicas helps.

### The two 2026 papers the project cites

Both exist and match the existing research note. "Nine Judges, Two Effective Votes" (Kohli, arXiv 2605.29800) finds that nine frontier judges from seven families deliver about two independent votes on NLI tasks, that panels fall 8 to 22 points short of independent voting, that established aggregation methods close at most 11% of the gap even with correct answers, and that the best single judge matched or beat the panel in every condition; its recommendation is that correlated judges, not the aggregation method, are the bottleneck and that bigger panels cannot replace genuinely independent evaluation. "How Many Humans Are 32 LLM Judges Worth?" (Li, Yu and Li, arXiv 2609.21277) finds that a panel's human-equivalent size depends on what it is matched to (binary-error diagnostic about 2.0 to 2.2, distributional matching 2.3 to 3.75, spectral matching 4.2 to 6.5) and recommends evaluating panels against the specific target and choosing them by spectral diversity rather than accuracy or binary agreement alone. Both support the same reading as the difficulty theory: a cross-family panel is not automatically independent, and the cross-family default of 0 is optimistic for some tasks.

## 3. Cascade deferral

### What the theory says

Jitkrittum et al. (2023) derive the Bayes-optimal deferral rule for a two-model cascade: defer x when eta_2(x) - eta_1(x) > c, where eta_i(x) is the probability that model i's prediction is right on x and c is the cost of deferring. Confidence-based deferral (defer when model 1's top probability is below a bar) produces the same deferral curve if and only if eta_1 and eta_1 - eta_2 order the items identically; a sufficient condition is that model 2's error is constant across inputs. It fails when model 2 is a specialist (good on a subgroup, poor elsewhere), under label noise (both models at chance on noisy items, so deferring them wastes budget), and under distribution shift. Their post-hoc remedies regress the gain in correctness from model 1's probability vector on a labelled validation set where model 2 also answered, and they warn that the regression can overfit when model 2's error is hard to predict.

Learning to defer trains the classifier and the rejector together (Madras, Pitassi and Zemel, 2018; Mozannar and Sontag, 2020, with a consistent surrogate loss; Verma and Nalisnick, 2022, who show the earlier multiclass surrogate is not calibrated for the expert's correctness and fix it with one-vs-all classifiers). The engine cannot train the oracles, so only the post-hoc version transfers, and the quantity it needs is the one Verma and Nalisnick insist on: a calibrated estimate of the upper tier's correctness on the item. With few expert labels, Hemmer et al. (2023) learn an expertise predictor semi-supervised; Zellinger and Thomson (2025) model the joint distribution of calibrated confidences along the cascade with a Markov copula and report a 10.2% larger gain in the regime of 30 or fewer training examples (4.3% on average for three or more models). Dekoninck, Baader and Vechev (2025) unify routing and cascading into cascade routing with an optimal strategy and find that good quality estimators are the critical factor. Conformal Cascade (Dou, Lian and Li, 2026) defers on the size of a conformal prediction set and guarantees coverage of at least 1 - K alpha at the accepting tier for K tiers. "Stopping and Routing LLM Judge Panels" (Zhu, Xie and Rao, 2026) estimates from a small labelled audit set whether each candidate judge is a copy (dropped), a complement (added everywhere) or a specialist (routed to the slices where it helps), and stops adding judges when the validation gain falls below a threshold. Learn then Test (Angelopoulos et al., 2021) recasts choosing thresholds as multiple testing, which gives finite-sample risk control for several thresholds at once.

### When the upper tier is not uniformly better, and whether to pool

The rule above with "replace" in it is the engine's default: the deferred item's answer is model 2's. Pooling changes eta_2 into eta_pool, the probability that the pooled verdict is right, which is at least as large whenever the tiers are calibrated and the pool uses their correlation, because it keeps tier 1's evidence instead of discarding it. Pooling also mends the specialist failure on its own: where tier 2 is weak its calibrated logits are small, so the pool leans on tier 1 there. Simulation D tests this with three item types the application can see, tiers calibrated within type, within-type tier correlation 0.1 (D1, D2) or 0.8 (D3), fits on 200 rows where both tiers answered:

- Upper tier uniformly better (D1): confidence bar and replace 97.5%; confidence bar and pool 97.9%; binned gain and pool 98.2%.
- Upper tier a specialist, worse than tier 1 on one type (D2): 94.6%, 95.9% and 96.2%.
- Shared difficulty, upper tier no better (D3): nothing helps much (93.0% alone, at most 93.7%), as on BoolQ.

Crossing the bins with the item type, the natural fix for a specialist, did not help at 200 rows (9 cells of about 22 rows each). Asking both tiers on every item and pooling (at rho 0) was as good or better than any cascade in D1 and D2 (98.4%, 96.5%). That ranking did not hold on real data: in T5, pooling all three members at rho 0 (two Jev pins plus haiku) reached 96.5% against the cascade's 98.5%, and pair-aware weights reached 97.7%. The simulation assumes each tier is calibrated where it is asked; T5's haiku had ECE 0.062 and luna's confidences sat near 1 (mean 0.989), and a pool is only as good as the calibration of its members on the deferred slice. Pool against replace is therefore a measured choice per gate, not a default to assume.

### What to measure on items both tiers answered

All of these come from one sample: a random, confidence-independent slice of traffic on which every tier answers whatever the first tier said, labelled blind. A cascade's own rows pair the tiers only on escalated items, which conditions on tier 1's confidence (T5 read -0.08 from those rows against 0.04 over all items).

- Per bin of tier-1 confidence: tier 1's accuracy, tier 2's accuracy and the pool's accuracy, and so the gain curve.
- The tiers' within-class logit correlation, for the pool's weights.
- Tier 2's calibration on the slice that would be deferred.
- The count of items both tiers got wrong, for the ceiling.

### Fitting bars jointly from few labels

Separate the two bars by what they promise. The act bar on the final verdict carries the gate's promise and is fitted on the final verdict of the configuration as it runs, on unselected rows, exactly as bars are fitted now. The deferral rule only decides where money is spent; a deferral rule that is wrong costs coverage or spend, not the promise, as long as the act bar is fitted on what the cascade actually outputs. A cascade bar chosen to maximise fit-split accuracy (as in T5) is optimistic and should not be read as a precision promise. For a finite-sample guarantee over several bars at once, Learn then Test's fixed-sequence testing is the tool; I have not checked how much coverage it leaves at 100 to 300 labels (open question).

## 4. Sequential stopping under dependence

### A valid test for exchangeable, positively correlated samples

Wald's error bound does not need independent observations. It needs the likelihood ratio of the joint law of everything observed so far. Under the null that ratio is a nonnegative martingale with mean 1, so by Ville's inequality the probability that it ever reaches 1/alpha is at most alpha, at any stopping time (Ramdas, Grunwald, Vovk and Shafer, 2023, on test martingales and anytime-valid inference; mixture SPRTs, Robbins 1970, in Johari et al., 2022). The engine's run is "SPRT-shaped, not an SPRT" only because it pools at a stated rho rather than with the joint law. Under the right joint law it is an SPRT.

For replicas the joint law is exchangeable. For votes it is beta-binomial: if, given the truth, each replica says yes with a per-item probability theta drawn from Beta(a, b), then k yes votes out of n have likelihood C(n, k) B(k + a, n - k + b) / B(a, b), and the ratio between the two truths follows. That ratio saturates. At single-call accuracy 0.86 and replica intraclass correlation 0.87 (T5's replica phi), one vote is worth a ratio of 6.14, three unanimous votes 7.15, nine 8.14 and a hundred 10.59 (table C); the posterior moves from 0.86 to 0.89 over nine unanimous replicas, where counting them as independent says 1.0000.

For logits, take the compound-symmetric random-effects model: replica k on an item reports z_k = u + e_k, with u | y ~ N(lambda0 +- V/2, rho V) and e_k ~ N(0, (1 - rho) V), so each draw alone is a calibrated logit of total variance V. The mean of k draws is normal with variance rho V + (1 - rho) V / k given the truth, and the exact log-likelihood ratio is

    LLR_k = V (zbar_k - lambda0) / (rho V + (1 - rho) V / k) = sum_{j <= k} (z_j - lambda0) / (1 + (k - 1) rho).

This is exactly the engine's design-effect pool (with the prior offset). As k grows it tends to (zbar - lambda0) / rho: the item effect is the ceiling, and the run may never reach its bar, which is the right outcome (stop at the sample cap and review). For a fixed positive sum, LLR_k falls as rho rises, so pooling at an upper confidence bound for rho is conservative. Simulation E1 (single call 86%, latent intraclass correlation 0.95, at most 9 samples, bar 0.95): pooling as independent erred on 11.2% of settled items against a 5% promise; the design effect at the phi a ledger would measure (0.77) erred on 2.9%; the exact ratio on 2.2%; first-to-lead-by-2 counting votes as independent on 13.5%. The engine's `independentLead` already never settles on a single family.

### Which member to ask next

Chernoff (1959) introduced the sequential design of experiments, choosing at each step the experiment that best separates the hypotheses, and proved the procedure asymptotically optimal; Naghshvar and Javidi (2013) generalised it as active sequential hypothesis testing. In the Gaussian-logit model the separation a set S of members provides is the Mahalanobis distance between the two class means,

    D^2(S) = d_S' Sigma_SS^-1 d_S,

and the expected log-likelihood ratio under either class is D^2 / 2. The index for the next member is the gain in separation per unit cost, (D^2(S + j) - D^2(S)) / cost_j. A member whose gain is about zero is a copy of members already asked. Simulation E2 (J1 86% and J2 84% at latent correlation 0.93, H 96.5% at 0.15 with both; costs 1, 1 and 7): J1 alone gives D^2 = 4.67, adding J2 adds 0.00, adding H adds 11.14 (1.59 per unit of cost). Ordering by the index (J1, then H, then J2) kept the same error as J1, J2, H at about 8% lower cost (5.32 against 5.80 at a 0.95 bar; 7.16 against 7.79 at 0.99). The second pin was never worth asking.

## 5. Battery shape under unknown dependence

### The Frechet interval

For a conjunction of n events with probabilities p_i, max(0, sum_i p_i - (n - 1)) <= P(all) <= min_i p_i; for a disjunction, max_i p_i <= P(any) <= min(1, sum_i p_i). The lower conjunction bound is the union bound on the failures. Ruling on the cautious end by the action's polarity (the lower end when acting on "all hold", the upper end of "any applies" when acting on "none applies", which is again a union bound on the complements) looks like the natural "unknown dependence" default.

It is not, for two reasons the simulation made plain. First, the bounds hold for the true conditional probabilities of the conditions given everything observed. A member's p_j is calibrated given its own answer, not given the other members' answers. When members' errors are correlated (one model asked k questions about one state, the normal case for a battery), selecting items on which every p_j is high selects items where the shared error happened to be favourable. In table F2 (k = 8, member noise correlation 0.6), the union bound's 0.9 to 0.99 band stated 0.961 and observed 0.905, and its band above 0.99 stated 0.997 and observed 0.981. Second, in the band where acting happens the union bound and the product are nearly the same number, so ruling on the lower end buys almost no caution where it would matter. The interval is still worth printing: its width says how much the answer depends on dependence the gate has not measured.

### Noisy-OR, noisy-AND and the learned combiner

Simulation F (conditions' truths from a Gaussian copula with equicorrelation 0 or 0.5, members 93% accurate with noise correlation 0 or 0.6, k = 3 and 8; held-out 40,000; fitted combiners refitted 200 times on 200 rows):

- The log-odds sum is the wrong shape, as T2 found: AUC 0.54 to 0.92, ECE 0.19 to 0.31, and at k = 8 it saturated on 99% to 100% of items.
- The product (noisy-AND at independence) was the best-calibrated fixed pool when members were independent (ECE 0.002 to 0.022), and below the act band it was conservative when the conditions' truths were positively dependent (table F2, k = 3, truth dependence 0.5, member noise correlation 0.6: stated 0.754, observed 0.783 in the 0.5 to 0.9 band).
- min (the Frechet upper end, the engine's `all` at rho 1) was the most overconfident in the act band when members were independent (k = 8: stated 0.960, observed 0.940).
- Product plus a two-parameter Platt fit on 200 rows had ECE 0.010 to 0.016 in every configuration, the only combiner calibrated in all of them.
- The engine's learned combiner (logistic regression on member logits clamped to +-7) is misspecified for a conjunction: a conjunction is close to the minimum of the logits, which no weighted sum represents. Its AUC was 0.686 to 0.948 against the product's 0.925 to 0.968; with eight correlated members it acted on 4.2% of items at 18.5% precision. A diagnostic at larger n (`diagF.ts`) showed the gap does not close with data: at k = 8 and noise correlation 0.6, AUC 0.675, 0.752 and 0.770 at 200, 1,000 and 5,000 rows, against 0.844, 0.928 and 0.928 for the same regression on log p features, which nest the product. At 200 rows the log p regression was itself unstable (its ECE was 0.050 to 0.099, and its coverage at the 0.9 bar fell to between 0.0% and 24.7% in four of the eight configurations), so it is the right basis for a learned all-of combiner only once rows are plentiful.

### Why a stated correlation on an all-of battery must never default upward

The engine's `all` moves from the product toward min as the stated correlation rises. min p >= the product, so for a gate that acts when all conditions hold, a higher correlation makes the gate act more often: it is the permissive direction. Battery members are usually one model asked several questions about one state, so a default keyed on model family would push it upward. There is also a category error to avoid: for `any` and `all`, the dependence that sets P(all) is the dependence between the conditions' truths, while the members' error correlation is a separate quantity that distorts each p_j. The two should not share one parameter.

## 6. Recommended design

Everything below is written to be implemented without the scripts. Logits are z = logit(p) with p clamped to [1e-6, 1 - 1e-6] (|z| <= 13.8). Do not clamp the pool's inputs to +-7: in B2 and B3 the +-7 clamp cost 0.003 to 0.005 of log loss, because it understates the strongest member's evidence. "Unselected labelled rows" means rows of the current configuration labelled from trusted sources that the oracle's confidence did not select (shadow, blind audit, and the panel-audit sample below).

### Default aggregator for judge members that are evidence for one answer

1. Prior. pi_hat = (number of true rows + 1) / (number of rows + 2) over unselected labelled rows of the gate; lambda0 = logit(pi_hat). With no labels, lambda0 = 0 and step 6 applies.
2. Strength. For each member i, over unselected labelled rows where it answered: m1_i and m0_i are its mean logit on true and false rows; d_i = max(m1_i - m0_i, 0); v_i = (sum over rows of (z_i - m_{y,i})^2) / (n - 2), the pooled within-class variance; c_i = (m1_i + m0_i) / 2.
3. Correlation. For each pair, over rows where both answered, the pooled within-class Pearson correlation
   r_hat_ij = sum_y sum_rows (z_i - m_{y,i})(z_j - m_{y,j}) / sqrt( sum_y sum_rows (z_i - m_{y,i})^2 * sum_y sum_rows (z_j - m_{y,j})^2 ),
   then shrink on the Fisher z scale toward the pair's prior r0 with a prior worth n0 = 30 rows:
   r_ij = tanh( (n0 atanh(r0) + (n_ij - 3) atanh(r_hat_ij)) / (n0 + n_ij - 3) ), with r_hat clamped to [-0.995, 0.995] and n_ij - 3 floored at 0.
   r0 = 0.75 when the two members share an oracle id or `modelFamily` (the existing default), else 0. Then clamp every r_ij to [0, 0.99] as the engine does now.
4. Weights. Sigma_ij = r_ij sqrt(v_i v_j) with Sigma_ii = v_i. Solve Sigma w = d for w >= 0 by the engine's active set (`nonNegativeGls` with right-hand side d instead of 1: solve on the active members, drop the most negative weight, solve again; drop the member most correlated with the others when singular). Clamp each w_i to [0, 1]. Under calibration w_i <= d_i / v_i = 1 already; the clamp keeps any member from counting more than once, which also guarantees that members who agree are never pooled above their independent sum.
5. Pool. L = lambda0 + sum_i w_i (z_i - c_i); p = sigmoid(L).
6. No labels (or a member or pair with fewer than 30 rows). Fall back member by member: d_i = v_i (equal strength), c_i = lambda0, and r_ij = r0. With every member on the fallback this is today's GLS path on the family-prior matrix, and it should keep today's cap (never more confident than the same answers at rho 0), because nothing measured justifies leaving caution.
7. The cap. With measured strengths, drop the engine's magnitude cap |L - lambda0| <= |sum_i (z_i - c_i)|. It binds only when members disagree, and there it penalises exactly the case the weights are for: a down-weighted family that is confidently wrong. In simulation B it cost log loss and calibration (B1 at 300 rows: 0.061 and ECE 0.005 with the cap, 0.058 and 0.003 without; B3: 0.080 and 0.012 against 0.069 and 0.003), while the weight clamp alone was harmless. This loosens a rule the engine adopted deliberately (finding V2-1), so it is the owner's decision; the clamp in step 4 keeps V2-1's guarantee for agreeing members.
8. Record a configuration change. New weights can change winners: bump the gate's `evidenceVersion` when the weights are re-estimated, as for adopting a matrix now.

Pick and rate verdicts take the same weights on each option's log-probability (product of experts), with the prior offset applied per option as log p_prior(option).

### A learned stack

Use a logistic stack (the existing `fitLogistic`) over member logits only when all of these hold: at least 300 unselected labelled rows of the current configuration; it beats the structured pool on held-out log loss by a margin fixed before fitting (for example 0.005) on a split the pool never saw; and its fitted weights are non-negative (refit with the offending member dropped otherwise). Below 300 rows it was noisier in every scenario (B: standard deviation 0.010 to 0.012 at 100 rows). An optional extremizing slope, fitted as logistic regression of the truth on L - lambda0 with a ridge (l2 0.05) pulling the slope toward 1 and the intercept unpenalised, is subject to the same 300-row condition.

### Cascade

- Always pool the tiers asked, with the default aggregator's weights over those tiers (the simulation used the equal-strength form, (z_1 + z_2) / (1 + r_hat) with r_hat the clamped within-class correlation; the strength-aware form is the same aggregator). Keep "replace" available and choose between them per gate on held-out labelled rows, since T5's real data ranked pooled members below the cascade.
- Deferral by binned gain. From the panel-audit sample: cut tier-1 confidence max(p, 1 - p) into 5 bins of equal count; in each bin b compute g_b = (number right after pooling - number right at tier 1) / (n_b + 1); defer every item whose tier-1 confidence falls in a bin with g_b > c. Use c = 0.002 (a tie-breaker; raise it when spend matters); a bin with no rows defers. With more than about 500 rows, cross the bins with a stratum key the application can see.
- The promise. The act bar is fitted on the cascade's final verdict, on unselected rows of the configuration, as every gate bar is now. The deferral rule is a spend lever and carries no promise.
- Build only when it can pay. Before building, check on the panel-audit sample that the upper tier is right where the lower tier is wrong (P(tier 2 wrong | tier 1 wrong) well below tier 2's error rate) and that the ceiling 1 - P(both wrong) is above the target.

### Sequential

- Pool with the default aggregator at every step (the prior offset included). For members of one family, pool at an upper confidence bound for their correlation rather than its estimate: rho_up = tanh(atanh(r_ij) + 1.645 / sqrt(n_ij - 3)), clamped to [0, 0.99]. Under compound symmetry this is the exact likelihood ratio sum (z_j - lambda0) / (1 + (k - 1) rho), made conservative.
- Settle when max(sigmoid(L), 1 - sigmoid(L)) reaches `settleAbove`. Ville's inequality then bounds the chance of settling wrongly under the model; the bound holds only if the model does, so the settled verdicts' calibration is checked on unselected rows like any other.
- Next member: with S the members already asked, ask the j that maximises (D^2(S + j) - D^2(S)) / cost_j, where D^2(S) = d_S' Sigma_SS^-1 d_S over the default aggregator's d and Sigma. Before any labels, use d_i = v_i = 1 and r_ij = r0, which makes every same-family member after the first nearly worthless and any other family worth asking.
- Stop and review when the sample cap is reached, or when no remaining member would add D^2 > 0.1 (all of them are copies). The 0.1 threshold is untested.
- A sequential member sampled again is the same member: its correlation with itself is the 0.99 the engine already uses.

### Batteries

- All-of: P = product of p_j. Any-of: P = 1 - product of (1 - p_j). Member weights, if stated, stay exponents.
- Then a two-parameter Platt fit on unselected labelled combined rows: u = clamp(logit(clamp(P, 1e-9, 1 - 1e-9)), -12, 12); q = sigmoid(a u + b), with a and b chosen by Newton's method to minimise mean log loss + (0.05 / 2)(a - 1)^2, b unpenalised. With fewer than 30 such rows, use P as it is.
- Report the Frechet interval beside the verdict as a readout: all-of [max(0, 1 - sum (1 - p_j)), min p_j]; any-of [max p_j, min(1, sum p_j)]. Never rule on it, and never call it a bound unless the members' error correlation has been measured near 0.
- A stated correlation on an all-of battery whose go side is yes never defaults upward. The `all` and `any` correlation, if kept, means dependence between the conditions' truths and is the caller's to state; it is not inferred from model family.
- For a learned all-of combiner with plenty of rows (more than 1,000; the 200-row fit was unstable), use features log p_j (p clamped at 1e-6), which nest the product; for any-of, log(1 - p_j). Not the clamped logits of `batteryFeatures`.
- Give members their own truths (`memberTruths`) so each p_j's calibration can be checked; an inherited battery truth scores a member against a question it was not asked.

## 7. What the ledger must record

- A panel-audit sample: a random, confidence-independent fraction of requests on which every member and every tier is asked regardless of stopping or deferral, tagged (for example `panel-audit`), labelled blind, and counted as unselected. It feeds the within-class correlations, the strengths, the cascade gain curve, tier 2's calibration on the deferred slice, the next-member index and the ceiling. A cascade's or a sequential run's own rows cannot, because the strategy chose which members answered.
- A stratum key on each row (template family, digest flags), so error rates, phi and P(both wrong) can be computed per stratum and recombined for a new traffic mix.
- In the compound row's `detail`: lambda0 and the row count behind it; for each member d_i, v_i, c_i and w_i; each pair's r used with its source (measured, shrunk, prior) and its n; whether the cap applied; for cascades the deferral rule's bins, gains and version; for sequential runs the rho bound used and the index values that chose each member.
- The panel's both-wrong count and n per gate, from the panel-audit sample, so reports can print the ceiling 1 - P(all wrong) with its exact interval.
- Phi stays in the ledger for what it is right for: vote-level dependence (lead counting, beta-binomial bounds) and the ceiling.

## 8. Tables

All tables come from seeded simulations. Each block names the script, the seeds and the parameters. Common to all: the seeded generator is mulberry32, normals are Box-Muller, and a member "at accuracy a" is a calibrated Gaussian-logit member with sigma = 2 Phi^-1(a), its logit z = lambda0 + s sigma^2 / 2 + sigma e with s = +1 for a true item and -1 for a false one and e standard normal (correlated across members through the Cholesky factor of R). ECE uses ten equal-width bins of confidence max(p, 1 - p) on [0.5, 1]; log loss clamps p to [1e-6, 1 - 1e-6].

### A: phi against the latent correlation, and the spread of three estimators

Script `pool.ts A`. A1: base rate 0.5, 400,000 items per cell, seed 1000 + round(100 r). A2: seed 2000 + n + round(1000 r), 2,000 replications per row. The tetrachoric estimate solves Phi2(Phi^-1(e1), Phi^-1(e2); r) = P(both wrong) by bisection, with Phi2 integrated by Plackett's identity, after smoothing e1 = (wrong1 + 1) / (n + 2), e2 = (wrong2 + 1) / (n + 2) and P(both wrong) = (both + 0.5) / (n + 2). The shrunk estimate is formula 3 of section 6 with n0 = 30 and r0 = 0.75 (same family) or 0 (cross family).

#### A1. Phi of correctness against the latent within-class logit correlation r (Gaussian-logit, base rate 0.5, 400,000 items)

| member accuracies | r = 0.1 | r = 0.3 | r = 0.5 | r = 0.75 | r = 0.85 | r = 0.95 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.86 / 0.84 | 0.05 | 0.15 | 0.28 | 0.48 | 0.60 | 0.77 |
| 0.86 / 0.965 | 0.03 | 0.11 | 0.20 | 0.36 | 0.42 | 0.47 |
| 0.95 / 0.95 | 0.03 | 0.10 | 0.20 | 0.41 | 0.53 | 0.72 |

#### A2. Sampling spread of three dependence estimates at n labelled rows (2,000 replications; mean +- SD)

| pair | true r | n | phi of correctness | tetrachoric (smoothed as stated above) | within-class logit correlation | logit correlation shrunk to family prior (n0 = 30) | rows with phi undefined |
| --- | --- | --- | --- | --- | --- | --- | --- |
| same family (0.86 / 0.84) | 0.85 | 100 | 0.59 +- 0.12 | 0.83 +- 0.09 | 0.85 +- 0.03 | 0.83 +- 0.02 | 0 |
| same family (0.86 / 0.84) | 0.85 | 200 | 0.59 +- 0.08 | 0.84 +- 0.06 | 0.85 +- 0.02 | 0.84 +- 0.02 | 0 |
| same family (0.86 / 0.84) | 0.85 | 300 | 0.60 +- 0.07 | 0.84 +- 0.05 | 0.85 +- 0.02 | 0.84 +- 0.02 | 0 |
| cross family (0.86 / 0.965) | 0.1 | 100 | 0.03 +- 0.11 | 0.18 +- 0.23 | 0.10 +- 0.10 | 0.08 +- 0.08 | 66 |
| cross family (0.86 / 0.965) | 0.1 | 200 | 0.03 +- 0.08 | 0.13 +- 0.21 | 0.10 +- 0.07 | 0.09 +- 0.06 | 3 |
| cross family (0.86 / 0.965) | 0.1 | 300 | 0.03 +- 0.07 | 0.11 +- 0.19 | 0.10 +- 0.06 | 0.09 +- 0.05 | 0 |

### B: pooling a mixed panel at 100 to 300 labelled rows

Script `pool.ts B`. Panel: members at 0.86, 0.84 and 0.965; within-class correlation 0.85 between the first two (one family) and 0.10 between each and the third. Seeds: B1 31000, B2 32000, B3 33000; the held-out set is 20,000 items from seed + 99; fits of n rows come from seed + n, 300 replications per n; the oracle is the Gaussian-logit fit (linear discriminant) on 200,000 items from seed + 7. B2 sets the base rate to 0.8. B3 adds, with probability 0.06 per item, a trap in which both members of the first family report z = -s |2.5 + 0.7 e| (confidently wrong together) while the third member is unaffected; B3 has no oracle row because the Gaussian model is wrong there. Methods: "sum" adds the logits; "scalar mean phi" shrinks the sum by 1 / (1 + 2 rho) at the mean of the three pairs' phi, clamped to [0, 0.99]; "GLS on phi matrix" is the engine's non-negative GLS on the phi matrix (a pair with undefined phi takes its family prior) with the engine's cap; the "GLS on latent" rows use the within-class logit correlation, raw or shrunk (n0 30), with equal strength and the cap; "prior offset" subtracts lambda0 = logit((true + 1) / (n + 2)) before pooling and adds it back once; "Platt (a, b)" fits a slope (ridge 0.05 toward 1) and an unpenalised intercept on the offset GLS pool; "LDA" is the unconstrained Gaussian-logit fit w = S^-1 (m1 - m0) with S the pooled within-class covariance; "Gaussian-logit, shrunk corr, w >= 0 + prior offset" is formulas 1 to 5 of section 6 without the [0, 1] clamp and without the cap; "recommended as written" adds the clamp and the cap; "clamp w only (no cap)" is section 6 as recommended; "logistic stack" fits all three logits unclamped (l2 0.01 toward 0, or l2 0.05 toward the family-prior GLS weights). The last column is the weight on the third member (for the scalar rule, the common shrink factor).

#### B1. Mixed panel (two pins of one family at r 0.85, one other family at r 0.1; accuracies 0.86 / 0.84 / 0.965), base rate 0.5

| method | n | log loss (mean +- SD) | Brier | ECE | accuracy | weight on the other-family member (mean +- SD) |
| --- | --- | --- | --- | --- | --- | --- |
| best single member alone | - | 0.087 | 0.025 | 0.002 | 96.7% | - |
| oracle (Gaussian-logit, 200k rows) | - | 0.056 | 0.016 | 0.003 | 97.9% | 0.95 |
| sum (rho 0) | 100 | 0.079 +- 0.000 | 0.021 | 0.011 | 97.2% | 1.00 +- 0.00 |
| scalar mean phi (engine) | 100 | 0.073 +- 0.001 | 0.021 | 0.005 | 97.2% | 0.70 +- 0.07 |
| scalar mean phi (engine) | 200 | 0.072 +- 0.000 | 0.021 | 0.004 | 97.2% | 0.70 +- 0.06 |
| scalar mean phi (engine) | 300 | 0.072 +- 0.000 | 0.021 | 0.004 | 97.2% | 0.70 +- 0.04 |
| GLS on phi matrix (engine) | 100 | 0.063 +- 0.001 | 0.018 | 0.005 | 97.8% | 0.94 +- 0.07 |
| GLS on phi matrix (engine) | 200 | 0.063 +- 0.001 | 0.018 | 0.004 | 97.8% | 0.94 +- 0.06 |
| GLS on phi matrix (engine) | 300 | 0.063 +- 0.001 | 0.018 | 0.005 | 97.8% | 0.96 +- 0.05 |
| GLS on latent logit corr | 100 | 0.061 +- 0.001 | 0.017 | 0.006 | 97.9% | 0.90 +- 0.07 |
| GLS on latent logit corr | 200 | 0.061 +- 0.001 | 0.017 | 0.006 | 97.9% | 0.90 +- 0.06 |
| GLS on latent logit corr | 300 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.9% | 0.91 +- 0.05 |
| GLS on shrunk latent corr | 100 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.9% | 0.92 +- 0.06 |
| GLS on shrunk latent corr | 200 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.9% | 0.91 +- 0.05 |
| GLS on shrunk latent corr | 300 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.9% | 0.91 +- 0.04 |
| GLS shrunk + prior offset | 100 | 0.061 +- 0.001 | 0.017 | 0.005 | 97.8% | 0.92 +- 0.06 |
| GLS shrunk + prior offset | 200 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.8% | 0.91 +- 0.05 |
| GLS shrunk + prior offset | 300 | 0.061 +- 0.000 | 0.017 | 0.005 | 97.8% | 0.91 +- 0.04 |
| GLS shrunk + Platt (a,b) | 100 | 0.068 +- 0.009 | 0.019 | 0.007 | 97.4% | 1.02 +- 0.19 |
| GLS shrunk + Platt (a,b) | 200 | 0.064 +- 0.004 | 0.018 | 0.006 | 97.6% | 0.96 +- 0.15 |
| GLS shrunk + Platt (a,b) | 300 | 0.063 +- 0.003 | 0.018 | 0.005 | 97.6% | 0.97 +- 0.12 |
| LDA (Gaussian-logit fit) | 100 | 0.062 +- 0.004 | 0.017 | 0.004 | 97.7% | 0.97 +- 0.15 |
| LDA (Gaussian-logit fit) | 200 | 0.059 +- 0.002 | 0.016 | 0.003 | 97.8% | 0.96 +- 0.11 |
| LDA (Gaussian-logit fit) | 300 | 0.058 +- 0.001 | 0.016 | 0.003 | 97.9% | 0.96 +- 0.09 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 100 | 0.061 +- 0.003 | 0.017 | 0.004 | 97.8% | 0.97 +- 0.14 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 200 | 0.059 +- 0.002 | 0.016 | 0.003 | 97.8% | 0.96 +- 0.11 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 300 | 0.058 +- 0.001 | 0.016 | 0.003 | 97.9% | 0.96 +- 0.09 |
| recommended as written (clamp w to [0,1], cap) | 100 | 0.063 +- 0.003 | 0.018 | 0.005 | 97.7% | 0.92 +- 0.09 |
| recommended as written (clamp w to [0,1], cap) | 200 | 0.062 +- 0.002 | 0.017 | 0.005 | 97.8% | 0.93 +- 0.07 |
| recommended as written (clamp w to [0,1], cap) | 300 | 0.061 +- 0.001 | 0.017 | 0.005 | 97.8% | 0.94 +- 0.06 |
| recommended as written, logits clamped to +-7 | 100 | 0.064 +- 0.003 | 0.018 | 0.005 | 97.7% | 1.00 +- 0.01 |
| recommended as written, logits clamped to +-7 | 200 | 0.063 +- 0.001 | 0.018 | 0.006 | 97.8% | 1.00 +- 0.00 |
| recommended as written, logits clamped to +-7 | 300 | 0.062 +- 0.001 | 0.017 | 0.006 | 97.8% | 1.00 +- 0.00 |
| recommended, clamp w only (no cap) | 100 | 0.060 +- 0.003 | 0.017 | 0.003 | 97.8% | 0.92 +- 0.09 |
| recommended, clamp w only (no cap) | 200 | 0.058 +- 0.002 | 0.016 | 0.003 | 97.8% | 0.93 +- 0.07 |
| recommended, clamp w only (no cap) | 300 | 0.058 +- 0.001 | 0.016 | 0.003 | 97.9% | 0.94 +- 0.06 |
| recommended, cap only (w >= 0 unclamped) | 100 | 0.063 +- 0.003 | 0.018 | 0.005 | 97.7% | 0.97 +- 0.14 |
| recommended, cap only (w >= 0 unclamped) | 200 | 0.062 +- 0.002 | 0.017 | 0.005 | 97.8% | 0.96 +- 0.11 |
| recommended, cap only (w >= 0 unclamped) | 300 | 0.061 +- 0.001 | 0.017 | 0.005 | 97.8% | 0.96 +- 0.09 |
| logistic stack, ridge to 0 (l2 .01) | 100 | 0.069 +- 0.012 | 0.019 | 0.007 | 97.5% | 1.03 +- 0.24 |
| logistic stack, ridge to 0 (l2 .01) | 200 | 0.062 +- 0.005 | 0.017 | 0.006 | 97.7% | 0.92 +- 0.18 |
| logistic stack, ridge to 0 (l2 .01) | 300 | 0.060 +- 0.003 | 0.017 | 0.005 | 97.8% | 0.91 +- 0.12 |
| logistic stack, ridge to prior pool (l2 .05) | 100 | 0.068 +- 0.011 | 0.019 | 0.007 | 97.6% | 1.09 +- 0.19 |
| logistic stack, ridge to prior pool (l2 .05) | 200 | 0.062 +- 0.005 | 0.017 | 0.005 | 97.7% | 1.02 +- 0.16 |
| logistic stack, ridge to prior pool (l2 .05) | 300 | 0.060 +- 0.003 | 0.017 | 0.004 | 97.8% | 1.03 +- 0.12 |

#### B2. The same panel at base rate 0.8 (the prior is in every member's logit)

| method | n | log loss (mean +- SD) | Brier | ECE | accuracy | weight on the other-family member (mean +- SD) |
| --- | --- | --- | --- | --- | --- | --- |
| best single member alone | - | 0.071 | 0.020 | 0.002 | 97.2% | - |
| oracle (Gaussian-logit, 200k rows) | - | 0.045 | 0.012 | 0.003 | 98.3% | 0.94 |
| sum (rho 0) | 100 | 0.088 +- 0.000 | 0.021 | 0.015 | 97.3% | 1.00 +- 0.00 |
| scalar mean phi (engine) | 100 | 0.073 +- 0.002 | 0.020 | 0.006 | 97.3% | 0.65 +- 0.08 |
| scalar mean phi (engine) | 200 | 0.072 +- 0.002 | 0.020 | 0.006 | 97.3% | 0.65 +- 0.06 |
| scalar mean phi (engine) | 300 | 0.072 +- 0.001 | 0.020 | 0.006 | 97.3% | 0.65 +- 0.05 |
| GLS on phi matrix (engine) | 100 | 0.062 +- 0.002 | 0.017 | 0.007 | 97.9% | 0.90 +- 0.11 |
| GLS on phi matrix (engine) | 200 | 0.062 +- 0.002 | 0.017 | 0.007 | 97.9% | 0.90 +- 0.08 |
| GLS on phi matrix (engine) | 300 | 0.061 +- 0.002 | 0.017 | 0.007 | 97.9% | 0.90 +- 0.07 |
| GLS on latent logit corr | 100 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.91 +- 0.07 |
| GLS on latent logit corr | 200 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.91 +- 0.05 |
| GLS on latent logit corr | 300 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.91 +- 0.05 |
| GLS on shrunk latent corr | 100 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.93 +- 0.06 |
| GLS on shrunk latent corr | 200 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.92 +- 0.05 |
| GLS on shrunk latent corr | 300 | 0.059 +- 0.001 | 0.017 | 0.007 | 98.0% | 0.91 +- 0.04 |
| GLS shrunk + prior offset | 100 | 0.049 +- 0.001 | 0.014 | 0.004 | 98.2% | 0.93 +- 0.06 |
| GLS shrunk + prior offset | 200 | 0.048 +- 0.001 | 0.013 | 0.004 | 98.2% | 0.92 +- 0.05 |
| GLS shrunk + prior offset | 300 | 0.048 +- 0.000 | 0.013 | 0.004 | 98.2% | 0.91 +- 0.04 |
| GLS shrunk + Platt (a,b) | 100 | 0.056 +- 0.010 | 0.015 | 0.006 | 98.0% | 1.02 +- 0.18 |
| GLS shrunk + Platt (a,b) | 200 | 0.052 +- 0.004 | 0.014 | 0.005 | 98.1% | 1.00 +- 0.14 |
| GLS shrunk + Platt (a,b) | 300 | 0.050 +- 0.003 | 0.014 | 0.004 | 98.2% | 0.96 +- 0.12 |
| LDA (Gaussian-logit fit) | 100 | 0.051 +- 0.006 | 0.014 | 0.004 | 98.2% | 0.99 +- 0.17 |
| LDA (Gaussian-logit fit) | 200 | 0.048 +- 0.002 | 0.013 | 0.003 | 98.2% | 0.98 +- 0.12 |
| LDA (Gaussian-logit fit) | 300 | 0.047 +- 0.001 | 0.013 | 0.003 | 98.3% | 0.96 +- 0.10 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 100 | 0.050 +- 0.005 | 0.014 | 0.004 | 98.2% | 0.98 +- 0.16 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 200 | 0.048 +- 0.002 | 0.013 | 0.003 | 98.3% | 0.98 +- 0.12 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 300 | 0.047 +- 0.001 | 0.013 | 0.003 | 98.3% | 0.96 +- 0.10 |
| recommended as written (clamp w to [0,1], cap) | 100 | 0.051 +- 0.004 | 0.014 | 0.004 | 98.1% | 0.93 +- 0.09 |
| recommended as written (clamp w to [0,1], cap) | 200 | 0.049 +- 0.002 | 0.014 | 0.004 | 98.2% | 0.94 +- 0.07 |
| recommended as written (clamp w to [0,1], cap) | 300 | 0.049 +- 0.001 | 0.014 | 0.004 | 98.2% | 0.94 +- 0.07 |
| recommended as written, logits clamped to +-7 | 100 | 0.054 +- 0.006 | 0.015 | 0.005 | 98.0% | 1.00 +- 0.00 |
| recommended as written, logits clamped to +-7 | 200 | 0.052 +- 0.003 | 0.015 | 0.004 | 98.0% | 1.00 +- 0.00 |
| recommended as written, logits clamped to +-7 | 300 | 0.052 +- 0.002 | 0.014 | 0.004 | 98.0% | 1.00 +- 0.00 |
| recommended, clamp w only (no cap) | 100 | 0.049 +- 0.004 | 0.014 | 0.003 | 98.2% | 0.93 +- 0.09 |
| recommended, clamp w only (no cap) | 200 | 0.047 +- 0.002 | 0.013 | 0.003 | 98.3% | 0.94 +- 0.07 |
| recommended, clamp w only (no cap) | 300 | 0.047 +- 0.001 | 0.013 | 0.003 | 98.3% | 0.94 +- 0.07 |
| recommended, cap only (w >= 0 unclamped) | 100 | 0.051 +- 0.004 | 0.014 | 0.005 | 98.1% | 0.98 +- 0.16 |
| recommended, cap only (w >= 0 unclamped) | 200 | 0.049 +- 0.002 | 0.014 | 0.004 | 98.2% | 0.98 +- 0.12 |
| recommended, cap only (w >= 0 unclamped) | 300 | 0.049 +- 0.001 | 0.014 | 0.004 | 98.2% | 0.96 +- 0.10 |
| logistic stack, ridge to 0 (l2 .01) | 100 | 0.057 +- 0.012 | 0.015 | 0.006 | 98.0% | 0.99 +- 0.20 |
| logistic stack, ridge to 0 (l2 .01) | 200 | 0.051 +- 0.005 | 0.014 | 0.004 | 98.1% | 0.94 +- 0.17 |
| logistic stack, ridge to 0 (l2 .01) | 300 | 0.049 +- 0.003 | 0.014 | 0.004 | 98.2% | 0.89 +- 0.14 |
| logistic stack, ridge to prior pool (l2 .05) | 100 | 0.056 +- 0.011 | 0.015 | 0.006 | 98.0% | 1.09 +- 0.17 |
| logistic stack, ridge to prior pool (l2 .05) | 200 | 0.051 +- 0.005 | 0.014 | 0.004 | 98.2% | 1.06 +- 0.14 |
| logistic stack, ridge to prior pool (l2 .05) | 300 | 0.049 +- 0.003 | 0.013 | 0.004 | 98.2% | 1.02 +- 0.13 |

#### B3. Misspecified: the same panel plus 6% shared traps where both pins are confidently wrong together (base rate 0.5)

| method | n | log loss (mean +- SD) | Brier | ECE | accuracy | weight on the other-family member (mean +- SD) |
| --- | --- | --- | --- | --- | --- | --- |
| best single member alone | - | 0.089 | 0.025 | 0.002 | 96.6% | - |
| sum (rho 0) | 100 | 0.137 +- 0.000 | 0.036 | 0.024 | 95.3% | 1.00 +- 0.00 |
| scalar mean phi (engine) | 100 | 0.117 +- 0.002 | 0.034 | 0.011 | 95.3% | 0.67 +- 0.06 |
| scalar mean phi (engine) | 200 | 0.116 +- 0.002 | 0.034 | 0.011 | 95.3% | 0.67 +- 0.05 |
| scalar mean phi (engine) | 300 | 0.116 +- 0.001 | 0.034 | 0.011 | 95.3% | 0.67 +- 0.04 |
| GLS on phi matrix (engine) | 100 | 0.089 +- 0.003 | 0.025 | 0.011 | 97.1% | 0.95 +- 0.07 |
| GLS on phi matrix (engine) | 200 | 0.089 +- 0.002 | 0.025 | 0.011 | 97.1% | 0.95 +- 0.05 |
| GLS on phi matrix (engine) | 300 | 0.089 +- 0.001 | 0.025 | 0.012 | 97.1% | 0.96 +- 0.04 |
| GLS on latent logit corr | 100 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.91 +- 0.07 |
| GLS on latent logit corr | 200 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.92 +- 0.05 |
| GLS on latent logit corr | 300 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.92 +- 0.05 |
| GLS on shrunk latent corr | 100 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.93 +- 0.06 |
| GLS on shrunk latent corr | 200 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.93 +- 0.05 |
| GLS on shrunk latent corr | 300 | 0.085 +- 0.001 | 0.024 | 0.010 | 97.2% | 0.92 +- 0.04 |
| GLS shrunk + prior offset | 100 | 0.086 +- 0.001 | 0.024 | 0.009 | 97.1% | 0.93 +- 0.06 |
| GLS shrunk + prior offset | 200 | 0.085 +- 0.001 | 0.024 | 0.009 | 97.1% | 0.93 +- 0.05 |
| GLS shrunk + prior offset | 300 | 0.085 +- 0.001 | 0.024 | 0.009 | 97.1% | 0.92 +- 0.04 |
| GLS shrunk + Platt (a,b) | 100 | 0.093 +- 0.009 | 0.026 | 0.012 | 96.5% | 0.98 +- 0.21 |
| GLS shrunk + Platt (a,b) | 200 | 0.089 +- 0.004 | 0.025 | 0.010 | 96.7% | 0.95 +- 0.15 |
| GLS shrunk + Platt (a,b) | 300 | 0.087 +- 0.003 | 0.025 | 0.009 | 96.8% | 0.93 +- 0.13 |
| LDA (Gaussian-logit fit) | 100 | 0.075 +- 0.006 | 0.021 | 0.005 | 97.3% | 1.00 +- 0.16 |
| LDA (Gaussian-logit fit) | 200 | 0.071 +- 0.002 | 0.020 | 0.004 | 97.4% | 0.99 +- 0.12 |
| LDA (Gaussian-logit fit) | 300 | 0.070 +- 0.002 | 0.019 | 0.004 | 97.4% | 0.97 +- 0.09 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 100 | 0.073 +- 0.004 | 0.020 | 0.005 | 97.3% | 0.99 +- 0.15 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 200 | 0.070 +- 0.002 | 0.020 | 0.004 | 97.4% | 0.98 +- 0.12 |
| Gaussian-logit, shrunk corr, w >= 0 + prior offset | 300 | 0.070 +- 0.002 | 0.019 | 0.004 | 97.4% | 0.97 +- 0.09 |
| recommended as written (clamp w to [0,1], cap) | 100 | 0.082 +- 0.003 | 0.023 | 0.011 | 97.2% | 0.93 +- 0.08 |
| recommended as written (clamp w to [0,1], cap) | 200 | 0.080 +- 0.002 | 0.023 | 0.011 | 97.3% | 0.94 +- 0.07 |
| recommended as written (clamp w to [0,1], cap) | 300 | 0.080 +- 0.001 | 0.023 | 0.012 | 97.3% | 0.94 +- 0.06 |
| recommended as written, logits clamped to +-7 | 100 | 0.087 +- 0.003 | 0.024 | 0.015 | 97.2% | 1.00 +- 0.00 |
| recommended as written, logits clamped to +-7 | 200 | 0.085 +- 0.001 | 0.024 | 0.015 | 97.3% | 1.00 +- 0.00 |
| recommended as written, logits clamped to +-7 | 300 | 0.085 +- 0.001 | 0.024 | 0.015 | 97.3% | 1.00 +- 0.00 |
| recommended, clamp w only (no cap) | 100 | 0.072 +- 0.004 | 0.020 | 0.004 | 97.3% | 0.93 +- 0.08 |
| recommended, clamp w only (no cap) | 200 | 0.070 +- 0.002 | 0.020 | 0.004 | 97.4% | 0.94 +- 0.07 |
| recommended, clamp w only (no cap) | 300 | 0.069 +- 0.002 | 0.019 | 0.003 | 97.4% | 0.94 +- 0.06 |
| recommended, cap only (w >= 0 unclamped) | 100 | 0.082 +- 0.004 | 0.023 | 0.011 | 97.2% | 0.99 +- 0.15 |
| recommended, cap only (w >= 0 unclamped) | 200 | 0.080 +- 0.002 | 0.023 | 0.011 | 97.3% | 0.98 +- 0.12 |
| recommended, cap only (w >= 0 unclamped) | 300 | 0.080 +- 0.001 | 0.023 | 0.012 | 97.3% | 0.97 +- 0.09 |
| logistic stack, ridge to 0 (l2 .01) | 100 | 0.082 +- 0.011 | 0.022 | 0.008 | 97.1% | 1.05 +- 0.25 |
| logistic stack, ridge to 0 (l2 .01) | 200 | 0.075 +- 0.005 | 0.021 | 0.006 | 97.3% | 0.98 +- 0.19 |
| logistic stack, ridge to 0 (l2 .01) | 300 | 0.072 +- 0.003 | 0.020 | 0.005 | 97.4% | 0.93 +- 0.14 |
| logistic stack, ridge to prior pool (l2 .05) | 100 | 0.081 +- 0.010 | 0.022 | 0.008 | 97.1% | 1.12 +- 0.21 |
| logistic stack, ridge to prior pool (l2 .05) | 200 | 0.075 +- 0.006 | 0.021 | 0.006 | 97.3% | 1.07 +- 0.16 |
| logistic stack, ridge to prior pool (l2 .05) | 300 | 0.073 +- 0.004 | 0.020 | 0.005 | 97.4% | 1.05 +- 0.13 |

### C: exact ratios for unanimous replica votes, and the extremizing factor

Script `betabin.ts`, analytic (no seed). Under the truth, a replica's per-item probability of voting for it is theta ~ Beta(acc s, (1 - acc) s) with s = 1 / ICC - 1, so ICC is the intraclass correlation (the phi between two replicas' correctness). The ratio for n unanimous votes is B(a + n, b) / B(b + n, a) with a = acc s and b = (1 - acc) s.

| single-call accuracy | replica ICC | n unanimous votes | exact LR (beta-binomial) | posterior at prior 0.5 | if counted as independent |
| --- | --- | --- | --- | --- | --- |
| 0.86 | 0.87 | 1 | 6.14 | 0.8600 | 0.860000 |
| 0.86 | 0.87 | 3 | 7.15 | 0.8773 | 0.995704 |
| 0.86 | 0.87 | 9 | 8.14 | 0.8905 | 1.000000 |
| 0.86 | 0.87 | 100 | 10.59 | 0.9137 | 1.000000 |
| 0.86 | 0.5 | 1 | 6.14 | 0.8600 | 0.860000 |
| 0.86 | 0.5 | 3 | 13.39 | 0.9305 | 0.995704 |
| 0.86 | 0.5 | 9 | 29.50 | 0.9672 | 1.000000 |
| 0.86 | 0.5 | 100 | 167.00 | 0.9940 | 1.000000 |
| 0.86 | 0.1 | 1 | 6.14 | 0.8600 | 0.860000 |
| 0.86 | 0.1 | 3 | 70.98 | 0.9861 | 0.995704 |
| 0.86 | 0.1 | 9 | 4666.04 | 0.9998 | 1.000000 |
| 0.86 | 0.1 | 100 | 3543906213.51 | 1.0000 | 1.000000 |

The extremizing factor 1'R^-1 1 on the mean logit, for equally strong calibrated members:

- 3 exchangeable at r 0.95: 1.03
- 3 exchangeable at r 0.85: 1.11
- 3 exchangeable at r 0.5: 1.50
- 3 exchangeable at r 0: 3.00
- two pins at 0.93 + other family at 0.15: 1.77

### D: cascade deferral

Script `cascade.ts`. Base rate 0.5; three item types with weights 0.5, 0.3, 0.2 (one type in D3); within each type both tiers are calibrated Gaussian-logit members with the stated accuracies, their noise correlated at the stated r. Seeds: D1 41000, D2 42000, D3 43000; held-out 40,000 items from seed + 1; each rule's 400 fits of 200 rows come from seed + 7919 x (length of the rule's name). "Confidence bar" picks the bar on a grid from 0.50 to 1.00 in steps of 0.01 that maximises fit-split accuracy minus 0.002 per deferral. "Binned gain" is the rule of section 6 (c = 0.002; "3 bins x type" crosses three equal-count bins with the item type). Pooled rules pool at (z1 + z2) / (1 + r_hat), r_hat the fit split's within-class correlation clamped to [0, 0.99]. The reference row "both tiers on every item, pooled at rho 0" adds the two logits without a correlation correction, which is why its log loss in D3 is worse than either tier's.

#### D1. Upper tier uniformly better (T5-like: tier 2 strong everywhere)

Type weights 0.5, 0.3, 0.2; tier 1 / tier 2 accuracy by type: type 0: 97% / 98%; type 1: 78% / 97%; type 2: 80% / 96%; within-type tier correlation 0.1. Fit on 200 rows where both tiers answered, 400 replications, held-out 40,000.

| rule | accuracy (mean +- SD) | deferred | log loss | accuracy on items tier 1 kept |
| --- | --- | --- | --- | --- |
| tier 1 alone | 88.0% | 0% | 0.261 | - |
| tier 2 alone | 97.0% | 100% | 0.078 | - |
| both tiers on every item, pooled at rho 0 | 98.4% | 100% | 0.043 | - |
| confidence bar, replace (engine default) | 97.5% +- 0.5 | 45% | 0.076 | 98.7% |
| confidence bar, pool tiers | 97.9% +- 0.5 | 49% | 0.066 | 98.8% |
| binned gain (5 confidence bins), replace | 97.6% +- 0.4 | 52% | 0.070 | 99.1% |
| binned gain (5 bins), pool | 98.2% +- 0.4 | 56% | 0.055 | 99.4% |
| binned gain (3 bins x type), replace | 97.1% +- 0.6 | 49% | 0.082 | 98.0% |
| binned gain (3 bins x type), pool | 97.7% +- 0.7 | 54% | 0.067 | 98.2% |

#### D2. Upper tier a specialist (better on raw numbers, worse on relational items)

Type weights 0.5, 0.3, 0.2; tier 1 / tier 2 accuracy by type: type 0: 97% / 96%; type 1: 78% / 97%; type 2: 86% / 72%; within-type tier correlation 0.1. Fit on 200 rows where both tiers answered, 400 replications, held-out 40,000.

| rule | accuracy (mean +- SD) | deferred | log loss | accuracy on items tier 1 kept |
| --- | --- | --- | --- | --- |
| tier 1 alone | 89.3% | 0% | 0.240 | - |
| tier 2 alone | 91.4% | 100% | 0.187 | - |
| both tiers on every item, pooled at rho 0 | 96.5% | 100% | 0.088 | - |
| confidence bar, replace (engine default) | 94.6% +- 0.6 | 30% | 0.139 | 97.2% |
| confidence bar, pool tiers | 95.9% +- 0.6 | 42% | 0.111 | 98.3% |
| binned gain (5 confidence bins), replace | 94.6% +- 0.7 | 33% | 0.137 | 97.6% |
| binned gain (5 bins), pool | 96.2% +- 0.5 | 49% | 0.102 | 99.0% |
| binned gain (3 bins x type), replace | 95.2% +- 0.5 | 35% | 0.122 | 96.0% |
| binned gain (3 bins x type), pool | 95.9% +- 0.4 | 40% | 0.107 | 96.8% |

#### D3. Shared difficulty (BoolQ-like: tiers correlated at 0.8 within type, upper tier no better)

Type weights 1; tier 1 / tier 2 accuracy by type: type 0: 93% / 93%; within-type tier correlation 0.8. Fit on 200 rows where both tiers answered, 400 replications, held-out 40,000.

| rule | accuracy (mean +- SD) | deferred | log loss | accuracy on items tier 1 kept |
| --- | --- | --- | --- | --- |
| tier 1 alone | 93.0% | 0% | 0.175 | - |
| tier 2 alone | 93.0% | 100% | 0.175 | - |
| both tiers on every item, pooled at rho 0 | 94.0% | 100% | 0.184 | - |
| confidence bar, replace (engine default) | 93.5% +- 0.3 | 9% | 0.171 | 95.6% |
| confidence bar, pool tiers | 93.6% +- 0.4 | 7% | 0.169 | 95.1% |
| binned gain (5 confidence bins), replace | 93.3% +- 0.3 | 17% | 0.171 | 96.3% |
| binned gain (5 bins), pool | 93.7% +- 0.5 | 16% | 0.163 | 96.6% |
| binned gain (3 bins x type), replace | 93.1% +- 0.2 | 20% | 0.172 | 96.2% |
| binned gain (3 bins x type), pool | 93.7% +- 0.5 | 24% | 0.161 | 97.2% |

### E: sequential stopping and member choice

Script `seq.ts`. E1: seed 51000, 200,000 items, base rate 0.5, single-call accuracy 0.86 (V = (2 Phi^-1(0.86))^2), latent intraclass correlation 0.95 under the random-effects model of section 4, at most 9 samples; the measured phi is between the first two replicas over all items; an item that never settles counts 9 samples. E2: seed 52000, 200,000 items, base rate 0.5, the panel and costs in the heading; the pool for the members asked is the exact Gaussian-logit ratio d_S' Sigma_SS^-1 z_S; an unsettled item is decided by the pooled lean in the "error overall" column.

#### E1. Sequential sampling of replicas (single-call accuracy 86%, latent ICC 0.95; the phi a ledger would measure between two replicas: 0.77; 200,000 items, at most 9 samples)

| pooling rule | bar | settled | error among settled | promised at most | mean samples |
| --- | --- | --- | --- | --- | --- |
| independent (rho 0) | 0.95 | 93.6% | 11.21% | 5.0% | 2.64 |
| design effect at measured phi 0.77 | 0.95 | 53.3% | 2.89% | 5.0% | 5.04 |
| design effect at latent ICC 0.95 (exact LR) | 0.95 | 45.8% | 2.18% | 5.0% | 5.47 |
| lead-by-2 votes counted as independent (nominal 1/(1+(0.14/0.86)^2) = 97.4% right) | - | 99.7% | 13.45% | 2.6% | 2.17 |
| independent (rho 0) | 0.99 | 89.6% | 9.99% | 1.0% | 3.48 |
| design effect at measured phi 0.77 | 0.99 | 27.8% | 0.85% | 1.0% | 7.07 |
| design effect at latent ICC 0.95 (exact LR) | 0.99 | 18.9% | 0.52% | 1.0% | 7.58 |

Mean of 9 replicas is wrong on 13.46% of items against 14.01% for one call: the item effect is the ceiling.

#### E2. Which member next (Gaussian-logit panel: J1 86%, J2 84% at latent r 0.93 with J1, H 96.5% at r 0.15 with both; costs 1, 1, 7)

Separation D^2 (Mahalanobis distance between the classes, the expected-evidence scale): J1 alone 4.67; adding J2 gives 4.67 (+0.00 for cost 1, 0.00 per unit); adding H gives 15.81 (+11.14 for cost 7, 1.59 per unit); all three 15.83. The index (gain in D^2 per unit cost, Chernoff's rule in Gaussian form) asks H second.

| order | bar | settled | error among settled | error overall (unsettled decided by the pooled lean) | mean cost |
| --- | --- | --- | --- | --- | --- |
| J1 (cheap) > J2 (pin of J1) > H (other family) | 0.95 | 91.0% | 1.15% | 2.84% | 5.80 |
| J1 (cheap) > H (other family) > J2 (pin of J1) | 0.95 | 91.2% | 1.15% | 2.83% | 5.32 |
| H (other family) | 0.95 | 84.6% | 0.54% | 3.56% | 7.00 |
| J1 (cheap) > J2 (pin of J1) > H (other family) | 0.99 | 80.4% | 0.20% | 2.42% | 7.79 |
| J1 (cheap) > H (other family) > J2 (pin of J1) | 0.99 | 80.7% | 0.20% | 2.42% | 7.16 |
| H (other family) | 0.99 | 70.8% | 0.16% | 3.56% | 7.00 |

### F and F2: all-of batteries

Script `battery.ts` (F) and `diagF2.ts` (F2). Condition truths: a Gaussian copula with equicorrelation rc and P(each holds) = q (0.88 at k = 3, 0.955 at k = 8); member j is a calibrated Gaussian-logit judge of condition j at accuracy 0.93 (prior logit(q)), members' noise correlated at rm; the battery is true when every condition holds. F seeds: 61000 to 61003 for k = 3 and 61004 to 61007 for k = 8, in the order (rc, rm) = (0, 0), (0.5, 0), (0, 0.6), (0.5, 0.6); held-out 40,000 items from the seed; fitted combiners take 200 fits of 200 rows from seed + 5. "Act precision at 0.90" acts wherever the combiner says 0.90 or more, with no label fit. Platt is the section 6 fit; the learned rows use l2 0.01 toward 0 with an unpenalised intercept. F2: seed 77 + k, 200,000 items per configuration, mean stated P(all) against observed in three bands.

#### F. All-of batteries: act when every condition holds (held-out 40,000; learned combiner refitted on 200 rows, 200 times)

##### k = 3 conditions, P(each holds) = 0.88, truth dependence rc = 0, member noise correlation rm = 0, member accuracy 0.93; P(all hold) = 68.3%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.897 | 0.288 | 70.8% | 96.4% | 89.3% |
| noisy-AND, product (all at rho 0) | 0.962 | 0.002 | 97.6% | 52.6% | 6.8% |
| Frechet lower bound (union bound) | 0.961 | 0.007 | 97.7% | 52.4% | 15.5% |
| min (Frechet upper; all at rho 1) | 0.961 | 0.005 | 97.3% | 54.3% | 7.5% |
| product + Platt (a, b) on its logit, 200 rows | 0.962 | 0.010 | 97.5% +- 0.6 | 53.0% | 8.5% |
| learned logistic on log p (nests the product), 200 rows | 0.962 | 0.063 | 98.0% +- 1.2 | 24.7% | 5.3% |
| learned logistic on clamped logits (engine), 200 rows | 0.934 | 0.020 | 97.4% +- 0.8 | 47.0% | 1.9% |

##### k = 3 conditions, P(each holds) = 0.88, truth dependence rc = 0.5, member noise correlation rm = 0, member accuracy 0.93; P(all hold) = 74.5%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.920 | 0.200 | 79.5% | 93.7% | 89.2% |
| noisy-AND, product (all at rho 0) | 0.968 | 0.008 | 98.5% | 57.3% | 8.4% |
| Frechet lower bound (union bound) | 0.967 | 0.009 | 98.5% | 57.2% | 16.7% |
| min (Frechet upper; all at rho 1) | 0.967 | 0.006 | 98.3% | 59.0% | 7.7% |
| product + Platt (a, b) on its logit, 200 rows | 0.968 | 0.010 | 97.8% +- 0.5 | 62.9% | 13.6% |
| learned logistic on log p (nests the product), 200 rows | 0.968 | 0.050 | 97.2% +- 0.9 | 63.1% | 5.5% |
| learned logistic on clamped logits (engine), 200 rows | 0.948 | 0.017 | 97.4% +- 0.7 | 58.2% | 3.7% |

##### k = 3 conditions, P(each holds) = 0.88, truth dependence rc = 0, member noise correlation rm = 0.6, member accuracy 0.93; P(all hold) = 67.8%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.808 | 0.272 | 72.0% | 92.9% | 84.8% |
| noisy-AND, product (all at rho 0) | 0.957 | 0.020 | 96.7% | 56.1% | 15.3% |
| Frechet lower bound (union bound) | 0.948 | 0.031 | 96.6% | 56.0% | 25.0% |
| min (Frechet upper; all at rho 1) | 0.964 | 0.017 | 96.7% | 58.2% | 16.9% |
| product + Platt (a, b) on its logit, 200 rows | 0.957 | 0.014 | 97.5% +- 0.7 | 51.2% | 9.2% |
| learned logistic on log p (nests the product), 200 rows | 0.956 | 0.072 | 96.9% +- 1.8 | 9.9% | 4.8% |
| learned logistic on clamped logits (engine), 200 rows | 0.867 | 0.058 | 98.1% +- 1.9 | 33.3% | 0.1% |

##### k = 3 conditions, P(each holds) = 0.88, truth dependence rc = 0.5, member noise correlation rm = 0.6, member accuracy 0.93; P(all hold) = 74.7%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.847 | 0.188 | 80.4% | 91.7% | 85.9% |
| noisy-AND, product (all at rho 0) | 0.965 | 0.008 | 98.1% | 60.8% | 17.1% |
| Frechet lower bound (union bound) | 0.957 | 0.020 | 98.1% | 60.7% | 26.1% |
| min (Frechet upper; all at rho 1) | 0.970 | 0.004 | 98.1% | 63.2% | 17.7% |
| product + Platt (a, b) on its logit, 200 rows | 0.965 | 0.011 | 98.0% +- 0.4 | 61.7% | 14.1% |
| learned logistic on log p (nests the product), 200 rows | 0.965 | 0.060 | 97.3% +- 1.0 | 57.2% | 4.6% |
| learned logistic on clamped logits (engine), 200 rows | 0.890 | 0.041 | 96.5% +- 1.7 | 49.0% | 0.2% |

##### k = 8 conditions, P(each holds) = 0.955, truth dependence rc = 0, member noise correlation rm = 0, member accuracy 0.93; P(all hold) = 68.7%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.542 | 0.313 | 68.7% | 100.0% | 100.0% |
| noisy-AND, product (all at rho 0) | 0.933 | 0.003 | 96.4% | 46.8% | 2.0% |
| Frechet lower bound (union bound) | 0.932 | 0.010 | 96.5% | 46.5% | 12.7% |
| min (Frechet upper; all at rho 1) | 0.931 | 0.016 | 95.4% | 52.3% | 1.9% |
| product + Platt (a, b) on its logit, 200 rows | 0.933 | 0.014 | 96.3% +- 0.7 | 47.0% | 2.8% |
| learned logistic on log p (nests the product), 200 rows | 0.931 | 0.087 | 99.1% +- 0.3 | 0.1% | 1.2% |
| learned logistic on clamped logits (engine), 200 rows | 0.863 | 0.031 | 94.7% +- 1.7 | 36.9% | 0.3% |

##### k = 8 conditions, P(each holds) = 0.955, truth dependence rc = 0.5, member noise correlation rm = 0, member accuracy 0.93; P(all hold) = 79.8%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.624 | 0.199 | 80.0% | 99.7% | 99.7% |
| noisy-AND, product (all at rho 0) | 0.951 | 0.022 | 98.5% | 53.4% | 3.8% |
| Frechet lower bound (union bound) | 0.950 | 0.016 | 98.5% | 53.0% | 11.5% |
| min (Frechet upper; all at rho 1) | 0.949 | 0.013 | 98.1% | 59.1% | 1.9% |
| product + Platt (a, b) on its logit, 200 rows | 0.951 | 0.010 | 97.3% +- 0.5 | 66.9% | 6.1% |
| learned logistic on log p (nests the product), 200 rows | 0.948 | 0.063 | 97.2% +- 1.3 | 56.0% | 2.0% |
| learned logistic on clamped logits (engine), 200 rows | 0.894 | 0.024 | 95.5% +- 1.2 | 60.8% | 2.3% |

##### k = 8 conditions, P(each holds) = 0.955, truth dependence rc = 0, member noise correlation rm = 0.6, member accuracy 0.93; P(all hold) = 69.3%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.576 | 0.305 | 69.5% | 99.6% | 99.4% |
| noisy-AND, product (all at rho 0) | 0.925 | 0.040 | 94.8% | 56.7% | 11.4% |
| Frechet lower bound (union bound) | 0.915 | 0.054 | 94.8% | 56.5% | 21.7% |
| min (Frechet upper; all at rho 1) | 0.946 | 0.035 | 94.9% | 61.6% | 15.0% |
| product + Platt (a, b) on its logit, 200 rows | 0.925 | 0.016 | 96.7% +- 0.6 | 44.7% | 2.4% |
| learned logistic on log p (nests the product), 200 rows | 0.918 | 0.099 | 0.1% +- 0.2 | 0.0% | 1.2% |
| learned logistic on clamped logits (engine), 200 rows | 0.686 | 0.084 | 18.5% +- 23.8 | 4.2% | 0.0% |

##### k = 8 conditions, P(each holds) = 0.955, truth dependence rc = 0.5, member noise correlation rm = 0.6, member accuracy 0.93; P(all hold) = 79.6%

| combiner | AUC | ECE | act precision at 0.90 (as stated, no fit) | coverage at 0.90 | saturated (<0.001 or >0.999) |
| --- | --- | --- | --- | --- | --- |
| log-odds sum (engine default) | 0.629 | 0.197 | 80.2% | 99.1% | 99.0% |
| noisy-AND, product (all at rho 0) | 0.939 | 0.016 | 97.4% | 63.3% | 13.6% |
| Frechet lower bound (union bound) | 0.928 | 0.034 | 97.4% | 63.0% | 22.3% |
| min (Frechet upper; all at rho 1) | 0.954 | 0.011 | 97.4% | 68.7% | 16.8% |
| product + Platt (a, b) on its logit, 200 rows | 0.939 | 0.014 | 97.3% +- 0.5 | 63.8% | 6.7% |
| learned logistic on log p (nests the product), 200 rows | 0.922 | 0.075 | 88.8% +- 25.3 | 41.5% | 1.8% |
| learned logistic on clamped logits (engine), 200 rows | 0.720 | 0.051 | 88.8% +- 9.2 | 47.7% | 0.1% |

#### F2. Stated against observed P(all hold) by band

| k | rc | rm | combiner | band | rows | mean stated P(all) | observed P(all) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 0 | 0 | product | 0.5-0.9 | 34699 | 0.753 | 0.753 |
| 3 | 0 | 0 | product | 0.9-0.99 | 60748 | 0.962 | 0.961 |
| 3 | 0 | 0 | product | 0.99-1 | 44920 | 0.996 | 0.996 |
| 3 | 0 | 0 | union bound | 0.5-0.9 | 34207 | 0.754 | 0.759 |
| 3 | 0 | 0 | union bound | 0.9-0.99 | 60546 | 0.962 | 0.961 |
| 3 | 0 | 0 | union bound | 0.99-1 | 44877 | 0.996 | 0.996 |
| 3 | 0 | 0 | min | 0.5-0.9 | 32638 | 0.752 | 0.728 |
| 3 | 0 | 0 | min | 0.9-0.99 | 57182 | 0.962 | 0.953 |
| 3 | 0 | 0 | min | 0.99-1 | 51827 | 0.996 | 0.995 |
| 3 | 0 | 0.6 | product | 0.5-0.9 | 29295 | 0.748 | 0.694 |
| 3 | 0 | 0.6 | product | 0.9-0.99 | 47516 | 0.962 | 0.937 |
| 3 | 0 | 0.6 | product | 0.99-1 | 64974 | 0.997 | 0.992 |
| 3 | 0 | 0.6 | union bound | 0.5-0.9 | 28534 | 0.749 | 0.690 |
| 3 | 0 | 0.6 | union bound | 0.9-0.99 | 47308 | 0.962 | 0.937 |
| 3 | 0 | 0.6 | union bound | 0.99-1 | 64927 | 0.997 | 0.992 |
| 3 | 0 | 0.6 | min | 0.5-0.9 | 26886 | 0.746 | 0.657 |
| 3 | 0 | 0.6 | min | 0.9-0.99 | 44643 | 0.962 | 0.931 |
| 3 | 0 | 0.6 | min | 0.99-1 | 72242 | 0.997 | 0.993 |
| 3 | 0.5 | 0.6 | product | 0.5-0.9 | 28398 | 0.754 | 0.783 |
| 3 | 0.5 | 0.6 | product | 0.9-0.99 | 50559 | 0.962 | 0.961 |
| 3 | 0.5 | 0.6 | product | 0.99-1 | 70802 | 0.997 | 0.996 |
| 3 | 0.5 | 0.6 | union bound | 0.5-0.9 | 27535 | 0.755 | 0.783 |
| 3 | 0.5 | 0.6 | union bound | 0.9-0.99 | 50329 | 0.962 | 0.961 |
| 3 | 0.5 | 0.6 | union bound | 0.99-1 | 70751 | 0.997 | 0.996 |
| 3 | 0.5 | 0.6 | min | 0.5-0.9 | 25924 | 0.752 | 0.746 |
| 3 | 0.5 | 0.6 | min | 0.9-0.99 | 47420 | 0.963 | 0.957 |
| 3 | 0.5 | 0.6 | min | 0.99-1 | 78750 | 0.997 | 0.996 |
| 8 | 0 | 0 | product | 0.5-0.9 | 51258 | 0.759 | 0.759 |
| 8 | 0 | 0 | product | 0.9-0.99 | 78035 | 0.958 | 0.958 |
| 8 | 0 | 0 | product | 0.99-1 | 16952 | 0.994 | 0.994 |
| 8 | 0 | 0 | union bound | 0.5-0.9 | 50146 | 0.760 | 0.768 |
| 8 | 0 | 0 | union bound | 0.9-0.99 | 77349 | 0.958 | 0.959 |
| 8 | 0 | 0 | union bound | 0.99-1 | 16893 | 0.994 | 0.994 |
| 8 | 0 | 0 | min | 0.5-0.9 | 43562 | 0.756 | 0.708 |
| 8 | 0 | 0 | min | 0.9-0.99 | 73839 | 0.960 | 0.940 |
| 8 | 0 | 0 | min | 0.99-1 | 31863 | 0.995 | 0.990 |
| 8 | 0 | 0.6 | product | 0.5-0.9 | 35252 | 0.748 | 0.653 |
| 8 | 0 | 0.6 | product | 0.9-0.99 | 54060 | 0.961 | 0.905 |
| 8 | 0 | 0.6 | product | 0.99-1 | 59422 | 0.997 | 0.981 |
| 8 | 0 | 0.6 | union bound | 0.5-0.9 | 33826 | 0.749 | 0.647 |
| 8 | 0 | 0.6 | union bound | 0.9-0.99 | 53637 | 0.961 | 0.905 |
| 8 | 0 | 0.6 | union bound | 0.99-1 | 59349 | 0.997 | 0.981 |
| 8 | 0 | 0.6 | min | 0.5-0.9 | 29992 | 0.745 | 0.580 |
| 8 | 0 | 0.6 | min | 0.9-0.99 | 48649 | 0.962 | 0.891 |
| 8 | 0 | 0.6 | min | 0.99-1 | 74332 | 0.997 | 0.983 |
| 8 | 0.5 | 0.6 | product | 0.5-0.9 | 33067 | 0.756 | 0.798 |
| 8 | 0.5 | 0.6 | product | 0.9-0.99 | 59186 | 0.962 | 0.955 |
| 8 | 0.5 | 0.6 | product | 0.99-1 | 67705 | 0.997 | 0.992 |
| 8 | 0.5 | 0.6 | union bound | 0.5-0.9 | 31542 | 0.758 | 0.797 |
| 8 | 0.5 | 0.6 | union bound | 0.9-0.99 | 58703 | 0.962 | 0.955 |
| 8 | 0.5 | 0.6 | union bound | 0.99-1 | 67619 | 0.997 | 0.992 |
| 8 | 0.5 | 0.6 | min | 0.5-0.9 | 27140 | 0.754 | 0.734 |
| 8 | 0.5 | 0.6 | min | 0.9-0.99 | 52842 | 0.963 | 0.946 |
| 8 | 0.5 | 0.6 | min | 0.99-1 | 84885 | 0.997 | 0.993 |

### G: the cross-family pair of T5, strata, and the replica ceiling

Script `difficulty.ts`. G1 uses T5's counts (from the single-strategy ledgers on 260 held-out items: jev-1.13 37 errors, haiku-5.5 9, both 2), seed 71000, 5,000 bootstrap resamples of the 2 x 2 table (resamples in which a judge never or always erred are skipped); the tetrachoric value uses the smoothing of table A2. G2 is analytic: a shared stratum of share f in which each judge errs with probability 0.85 independently, and a remainder whose error rates are set so the overall rates hold. G3: per-item error theta ~ Beta(e s, (1 - e) s), s = 1 / ICC - 1, seed 72000 + round(100 ICC), 400,000 items per row.

#### G1. The cross-family pair of e2e T5, from its counts (260 held-out items; jev-1.13 37 errors, haiku-5.5 9, both 2)

- phi 0.043; bootstrap 95% interval -0.08 to 0.20 (5,000 resamples). One more shared error moves it to 0.104, one fewer to -0.017.
- tetrachoric (smoothed as in table A2) 0.18.
- both wrong 0.77% (Clopper-Pearson 95% 0.09% to 2.75%): no combiner that follows a unanimous panel can be right on more than 99.2% of these items, and the 95% interval for that ceiling is 97.2% to 99.9%. The cascade reached 98.5%.

#### G2. Phi of two judges whose errors are independent within strata, as the shared-difficulty stratum grows (Eckhardt-Lee: phi is the covariance of the difficulty functions over the item mix)

| overall error A / B | shared stratum share f | P(wrong) in it | phi | P(B wrong given A wrong) |
| --- | --- | --- | --- | --- |
| 5.0% / 7.4% | 0% | 0.85 | 0.00 | 7% |
| 5.0% / 7.4% | 1% | 0.85 | 0.11 | 20% |
| 5.0% / 7.4% | 2% | 0.85 | 0.22 | 33% |
| 5.0% / 7.4% | 3% | 0.85 | 0.34 | 46% |
| 5.0% / 7.4% | 4% | 0.85 | 0.45 | 59% |
| 14.2% / 3.5% | 0% | 0.85 | 0.00 | 4% |
| 14.2% / 3.5% | 1% | 0.85 | 0.09 | 8% |
| 14.2% / 3.5% | 2% | 0.85 | 0.18 | 12% |
| 14.2% / 3.5% | 3% | 0.85 | 0.28 | 16% |
| 14.2% / 3.5% | 4% | 0.85 | 0.37 | 20% |

#### G3. Replica ceiling under the difficulty model: per-item error theta ~ Beta(mean e, ICC); a majority of infinitely many replicas fails where theta > 1/2

| single-call error e | ICC (phi between two replicas) | majority of 3 | majority of 9 | ceiling P(theta > 1/2) |
| --- | --- | --- | --- | --- |
| 14% | 0.1 | 7.6% wrong | 3.2% wrong | 0.8% wrong |
| 14% | 0.3 | 10.7% wrong | 8.6% wrong | 7.2% wrong |
| 14% | 0.6 | 13.2% wrong | 12.7% wrong | 12.5% wrong |
| 14% | 0.87 | 14.0% wrong | 14.0% wrong | 13.9% wrong |

## 9. Pitfalls and assumptions

- The simulations favour Gaussian-logit methods by construction. Every member in A, B1, B2, C, D and E is a calibrated Gaussian-logit judge, so the methods derived from that model are bound to look good there. B3 (shared traps) and F (conjunctions with correlated members) are the only checks under a different law. Real decision models are not Gaussian on the logit scale: Jev's errors cluster in strata, generative models' confidences pile up near 1, and a model whose logits are pinned has a tiny within-class variance, which makes d_i / v_i, and so its weight, unstable (the [0, 1] clamp bounds the damage, nothing removes it).
- T5's real data ranked always-pool below the cascade (96.5% for three members pooled at rho 0 against 98.5%; 97.7% with pair-aware weights). The simulated advantage of pooling over replacing rests on each tier being calibrated on the slice it is asked, which T5's upper tiers were not. Choose pool or replace per gate on held-out labelled rows.
- Every quantity in section 6 must come from unselected rows. A correlation read from a cascade's own rows is conditioned on escalation, and one read from rows a reviewer chose because they were unsure is distorted by the selection itself (Berkson's paradox), as `memberCorrelation`'s comment already says.
- The base rate in the prior offset is the gate's base rate on unselected rows. If traffic shifts, the offset shifts; it is part of the configuration and belongs in the row's detail.
- R is a property of the traffic mix, not of the models (section 2). Re-estimate it when the mix moves, per stratum where the ledger has strata, and when a pin changes.
- Dropping the magnitude cap (section 6, step 7) makes the pool more confident on items where members disagree. It is the right call under the measured model and the wrong one if the correlations are badly mis-estimated; that is why the no-label fallback keeps the cap.
- The sequential and Frechet guarantees are conditional on the model they assume. Ville's bound holds for the joint law used; the Frechet bound holds for probabilities calibrated given everything observed. Check settled verdicts and battery verdicts on unselected rows; never read either as a certificate.
- Weights that change winners are a configuration change. Re-estimating them without bumping `evidenceVersion` mixes configurations in the evidence.
- The +-7 logit clamp of `batteryFeatures` must not leak into the pool (it cost log loss in B2 and B3).
- Simulated tables are one draw per configuration from a fixed held-out set; the reported spreads are across fits, not across held-out sets.

## 10. Open questions, and confidence in each recommendation

- The structured aggregator (shrunk within-class correlation, strengths, non-negative weights at most 1, prior offset): medium-high. It is backed by the derivation and by B1 to B3. The next test needs no spend: re-pool T5's recorded member answers, fitting on the fit split and scoring the held-out split, and compare it with the engine's GLS on phi.
- The prior offset: high in principle; its size grows with the distance of the base rate from 0.5, and it matters most on gates whose base rate is lopsided (tool gates).
- Dropping the magnitude cap when strengths are measured: medium; an owner's decision.
- The family priors: medium-low for the cross-family value. 0 matches the engine and T5's rule corpus, but both 2026 judge-panel papers and BoolQ say different families can share errors heavily on some tasks. A value such as 0.3 is defensible and untested.
- Pooling cascade tiers and deferring by binned gain: medium. Simulation supports it; T5's real ranking warns that tier calibration decides it.
- A finite-sample guarantee over deferral and act bars together (Learn then Test): open; I have not measured how much coverage it leaves at 100 to 300 labels.
- The exact likelihood ratio for sequential stopping with an upper-bound rho: high in theory, medium in practice, because the intraclass correlation must itself be estimated; the upper-bound version was not simulated.
- The next-member index: medium; the stop threshold D^2 gain below 0.1 is untested.
- The battery default (product or noisy-OR, then Platt): medium-high. That the Frechet interval is not a guarantee under correlated member errors: high.
- The difficulty-function account of 0.04 against 0.58: medium. It is consistent with both measurements and with the N-version literature, not proven for these corpora; recording strata would test it.
- Recalibrating a tier whose confidences sit near 1 before pooling it: open; the Platt fit above is the obvious candidate and was not tested on such a tier.

## Sources

Tags: [verified] means the abstract or text was fetched this session; [memory] means it was not. A [verified] tag on a source does not extend to every detail attributed to it; details stated as recollection in the text are [memory].

- Angelopoulos, A. N., Bates, S., Candes, E. J., Jordan, M. I. and Lei, L. (2021). Learn then Test: calibrating predictive algorithms to achieve risk control. arXiv 2110.01052. https://arxiv.org/abs/2110.01052 [verified: abstract; the fixed-sequence detail is memory]
- Baron, J., Mellers, B. A., Tetlock, P. E., Stone, E. and Ungar, L. H. (2014). Two reasons to make aggregated probability forecasts more extreme. *Decision Analysis* 11(2), 133-145. https://pubsonline.informs.org/doi/10.1287/deca.2014.0293 [verified: abstract]
- Bordley, R. F. (1982). A multiplicative formula for aggregating probability assessments. *Management Science* 28(10), 1137-1148. https://pubsonline.informs.org/doi/10.1287/mnsc.28.10.1137 [verified: abstract; the formula's form is memory]
- Breiman, L. (1996). Stacked regressions. *Machine Learning* 24, 49-64. https://mlanthology.org/mlj/1996/breiman1996mlj-stacked [verified: abstract]
- Chernoff, H. (1959). Sequential design of experiments. *Annals of Mathematical Statistics* 30(3), 755-770. https://doi.org/10.1214/aoms/1177706205 [verified: bibliographic, through secondary sources; pages are memory]
- Clemen, R. T. and Winkler, R. L. (1999). Combining probability distributions from experts in risk analysis. *Risk Analysis* 19(2), 187-203. https://econpapers.repec.org/RePEc:wly:riskan:v:19:y:1999:i:2:p:187-203 [verified: abstract]
- Dekoninck, J., Baader, M. and Vechev, M. (2025). A unified approach to routing and cascading for LLMs. ICML 2025, PMLR 267. https://arxiv.org/abs/2410.10347 [verified: abstract]
- Dou, Y., Lian, S. and Li, S. (2026). Conformal Cascade: distribution-free accuracy guarantees for multi-tier LLM inference. arXiv 2607.25018. https://arxiv.org/abs/2607.25018 [verified: abstract]
- Eckhardt, D. E. and Lee, L. D. (1985). A theoretical basis for the analysis of multiversion software subject to coincident errors. *IEEE TSE* SE-11(12), 1511-1517. https://doi.org/10.1109/TSE.1985.231895 (NASA record: https://ntrs.nasa.gov/citations/19850015006) [verified: bibliographic and the variance result through secondary sources; the formula E[theta]^2 + Var(theta) is memory]
- Frechet inequalities. Wikipedia. https://en.wikipedia.org/wiki/Fr%C3%A9chet_inequalities [verified]
- Genest, C. and Zidek, J. V. (1986). Combining probability distributions: a critique and an annotated bibliography. *Statistical Science* 1(1), 114-135. https://doi.org/10.1214/ss/1177013825 [verified: bibliographic]
- Hemmer, P., Thede, L., Vossing, M., Jakubik, J. and Kuhl, N. (2023). Learning to defer with limited expert predictions. AAAI 2023, 37(5), 6002-6011. https://arxiv.org/abs/2304.07306 [verified: abstract]
- Jitkrittum, W., Gupta, N., Menon, A. K., Narasimhan, H., Rawat, A. S. and Kumar, S. (2023). When does confidence-based cascade deferral suffice? NeurIPS 2023. https://arxiv.org/abs/2307.02764 [verified: text]
- Johari, R., Koomen, P., Pekelis, L. and Walsh, D. (2022). Always valid inference: continuous monitoring of A/B tests. *Operations Research* 70(3), 1806-1821. https://econpapers.repec.org/RePEc:inm:oropre:v:70:y:2022:i:3:p:1806-1821 [verified: abstract]
- Jouini, M. N. and Clemen, R. T. (1996). Copula models for aggregating expert opinions. *Operations Research* 44(3), 444-457. https://pubsonline.informs.org/doi/10.1287/opre.44.3.444 [verified: abstract]
- Knight, J. C. and Leveson, N. G. (1986). An experimental evaluation of the assumption of independence in multiversion programming. *IEEE TSE* SE-12(1), 96-109. https://doi.org/10.1109/TSE.1986.6312924 [verified: abstract and secondary summaries]
- Kohli, G. (2026). Nine judges, two effective votes: correlated errors undermine LLM evaluation panels. arXiv 2605.29800. https://arxiv.org/abs/2605.29800 [verified: abstract]
- Ledoit, O. and Wolf, M. (2004). A well-conditioned estimator for large-dimensional covariance matrices. *Journal of Multivariate Analysis* 88(2), 365-411. https://econpapers.repec.org/RePEc:eee:jmvana:v:88:y:2004:i:2:p:365-411 [verified: abstract]
- Li, C., Yu, Y. and Li, Y. (2026). How many humans are 32 LLM judges worth? arXiv 2609.21277. https://arxiv.org/abs/2609.21277 [verified: abstract]
- Littlewood, B. and Miller, D. R. (1989). Conceptual modeling of coincident failures in multiversion software. *IEEE TSE* 15(12), 1596-1614. https://ntrs.nasa.gov/citations/19900036555 [verified: abstract-level; the negative-covariance reading is memory]
- Madras, D., Pitassi, T. and Zemel, R. (2018). Predict responsibly: improving fairness and accuracy by learning to defer. NeurIPS 2018. https://proceedings.neurips.cc/paper/2018/hash/09d37c08f7b129e96277388757530c72-Abstract.html [verified: abstract]
- Mozannar, H. and Sontag, D. (2020). Consistent estimators for learning to defer to an expert. ICML 2020, PMLR 119, 7076-7087. https://arxiv.org/abs/2006.01862 [verified: abstract]
- Naghshvar, M. and Javidi, T. (2013). Active sequential hypothesis testing. *Annals of Statistics* 41(6), 2703-2738. https://arxiv.org/abs/1203.4626 [verified: abstract]
- Ramdas, A., Grunwald, P., Vovk, V. and Shafer, G. (2023). Game-theoretic statistics and safe anytime-valid inference. *Statistical Science* 38(4), 576-601. https://arxiv.org/abs/2210.01948 [verified: abstract; the statement of Ville's inequality for likelihood ratios is memory]
- Ranjan, R. and Gneiting, T. (2010). Combining probability forecasts. *JRSS Series B* 72(1), 71-91. https://econpapers.repec.org/RePEc:bla:jorssb:v:72:y:2010:i:1:p:71-91 [verified: abstract]
- Robbins, H. (1970). Statistical methods related to the law of the iterated logarithm. *Annals of Mathematical Statistics* 41(5), 1397-1409. https://doi.org/10.1214/aoms/1177696786 [memory; cited through Johari et al.]
- Satopaa, V. A., Baron, J., Foster, D. P., Mellers, B. A., Tetlock, P. E. and Ungar, L. H. (2014). Combining multiple probability predictions using a simple logit model. *International Journal of Forecasting* 30(2), 344-356. https://econpapers.repec.org/RePEc:eee:intfor:v:30:y:2014:i:2:p:344-356 [verified: abstract]
- Satopaa, V. A., Pemantle, R. and Ungar, L. H. (2016). Modeling probability forecasts via information diversity. *JASA* 111(516), 1623-1633. https://arxiv.org/abs/1406.2148 [verified: text]
- Schafer, J. and Strimmer, K. (2005). A shrinkage approach to large-scale covariance matrix estimation and implications for functional genomics. *Statistical Applications in Genetics and Molecular Biology* 4(1), article 32. https://doi.org/10.2202/1544-6115.1175 [verified: abstract]
- Smith, J. and Wallis, K. F. (2009). A simple explanation of the forecast combination puzzle. *Oxford Bulletin of Economics and Statistics* 71(3), 331-355. https://econpapers.repec.org/RePEc:bla:obuest:v:71:y:2009:i:3:p:331-355 [verified: abstract]
- Verma, R. and Nalisnick, E. (2022). Calibrated learning to defer with one-vs-all classifiers. ICML 2022, PMLR 162. https://arxiv.org/abs/2202.03673 [verified: abstract]
- Winkler, R. L. (1981). Combining probability distributions from dependent information sources. *Management Science* 27(4), 479-488. https://pubsonline.informs.org/doi/10.1287/mnsc.27.4.479 [verified: abstract]
- Zellinger, M. J. and Thomson, M. (2025). Rational tuning of LLM cascades via probabilistic modeling. *TMLR* 2025. https://arxiv.org/abs/2501.09345 [verified: abstract]
- Zhu, B., Xie, Y. and Rao, Y. (2026). Stopping and routing LLM judge panels. arXiv 2608.19802. https://arxiv.org/abs/2608.19802 [verified: abstract]

The numbers in this note were computed by seeded scripts in a session scratch folder that is not part of the repository (`lib.ts`, `pool.ts`, `betabin.ts`, `cascade.ts`, `seq.ts`, `battery.ts`, `diagF.ts`, `diagF2.ts`, `difficulty.ts`); tables that back shipped code are to be reproduced under `sim/`.
