# Anytime-valid rollout: e-processes for promotion, e-detectors for demotion

*Research note, 2026-11-12. Foundations review of `Rollout` (`src/acceptance.ts`, `src/rollout.ts`): whether anytime-valid inference can replace or complement the planned acceptance test and the audit-window demotion rule. Docs only. URLs are in the sources at the end; every citation is tagged [verified] (abstract or text read in this session) or [memory] (not checked this session).*

Today a gate is promoted by a planned fixed sample: the first N eligible acts in ledger order, sealed until complete and labelled, judged once by an exact one-sided Clopper-Pearson bound (149 clean acts for a 98% promise at 95% confidence, or 313 with at most two wrong). It is demoted when, once 30 audits exist, the accuracy of the last 200 blind audits falls below the promise. This note extends the two earlier notes that touch the subject (`Compounding decisions with Jev/math_of_compounding_decisions.md` on the SPRT, `Jev novel patterns catalog/learning_and_tooling.md` on repeated inspection) and does not repeat them.

The conclusions, in brief:

- **The 149-act plan is already anytime-valid.** The zero-error plan is a sequential probability ratio test with alternative q = 1. Its labels can be read as they arrive and it can stop at the first wrong act; sealing it buys nothing.
- **No test escapes the information floor.** A sequential test that promotes a 99% gate at a 98% promise with 90% power needs at least 762 labelled acts on average. A fixed plan needs 1,271.
- **The value of an e-process is operational, not raw power.** One e-process per configuration, computed from the ledger, adapts to the gate: a 99.9% gate is promoted after about 180 acts and a 99.5% gate after about 300. It needs no choice of `maxErrors`, no sealing and no failed-window search.
- **Demotion should be an e-detector.** A Shiryaev-Roberts mixture on audit outcomes comes with an explicit false-alarm guarantee. It cuts false demotion of a healthy 99% gate within 10,000 acts from 68% to 4% at an audit rate of 0.1, and can demote after 4 consecutive audited errors instead of 30 audits. It lets more wrong acts through on mild drift: that speed was paid for by having no false-alarm control. The audit rate is the lever.
- **Groups and late labels are where validity is actually lost.** Session correlation inflates false promotion to about 20% whatever the test, unless the session is the unit. Consuming labels in arrival order inflates it to 29% or 90% when wrong acts are labelled later. Advancing in ledger order keeps it at 3.8%.

## 1. What the literature establishes

### Test martingales and Ville's inequality

A test supermartingale is a nonnegative process E_n with E_0 = 1 whose conditional expectation does not increase under the null. Ville's inequality bounds the chance that it ever crosses a level: P(sup_n E_n ≥ 1/alpha) ≤ alpha. Rejecting the null the first time E_n reaches 1/alpha is therefore valid however often, and for whatever reason, one looks. This is the core of safe anytime-valid inference: Ramdas, Grünwald, Vovk and Shafer (2022) [verified]; Shafer (2021), *Testing by betting* [verified, metadata and abstract only]; Ville (1939) [memory]. Howard, Ramdas, McAuliffe and Sekhon unify the classical martingale tail bounds as line-crossing inequalities (2020) [verified] and build time-uniform confidence sequences from them (2021) [verified]. The confidence-sequence idea goes back to Darling and Robbins (1967) and Robbins (1970) [memory for content; citations verified]. The SPRT is Wald (1945) [memory for content; citation verified].

### Betting on 0/1 outcomes is a likelihood ratio

Let X = 1 for a right act and p0 the promised accuracy. A bet with predictable fraction lambda multiplies the bettor's capital by 1 + lambda (X − p0). Write q = p0 + lambda p0 (1 − p0). The factor is then X q/p0 + (1 − X)(1 − q)/(1 − p0), the likelihood ratio of Bernoulli(q) to Bernoulli(p0). Its mean under true accuracy p is linear in p:

`E_p[factor] = 1 + (p − p0)(q − p0) / (p0 (1 − p0))`

So the factor has mean at most 1 for every p ≤ p0 exactly when q ≥ p0. That is why a test of the composite null "accuracy ≤ p0" may only use alternatives at or above p0. A two-sided mixture, or any component with q < p0, grows in expectation when p is below both q and p0, and is invalid.

BRAVO, the original ballot-polling risk-limiting audit, is this test with a fixed q and rejection at 1/alpha (Wald's SPRT with Ville's threshold), as described in Stark's ALPHA paper [verified] (Lindeman, Stark and Yates 2012 [verified, metadata only]). ALPHA lets q depend on the past by truncated shrinkage, `eta_j = min(u, max(mu_j + c/sqrt(d + j − 1), (d eta_0 + sum_{k<j} X_k)/(d + j − 1)))`. It accepts per-draw upper bounds (sampling weights) and Bernoulli sampling [verified]. Waudby-Smith and Ramdas build confidence intervals and sequences for bounded means from such betting martingales and from the method of mixtures (JRSS-B 2024) [verified].

### Change detection: CUSUM, Shiryaev-Roberts and e-detectors

Shin, Ramdas and Rinaldo (2022) define an e-detector: a process M with E[M_tau] ≤ E[tau] at every stopping time tau, under every pre-change law in a composite class (Definition 2.2) [verified]. The guarantee is Theorem 2.4: the first time M reaches 1/alpha has expected value (the average run length to a false alarm, ARL) at least 1/alpha, under every pre-change law in the class [verified].

Given e-processes started at each time j, the Shiryaev-Roberts (SR) form sums them and the CUSUM form takes their maximum (Definition 2.6). For a baseline increment L_n both have recursions (Definition 2.11) [verified]:

- `SR_n = L_n (SR_{n−1} + 1)`
- `CU_n = L_n max(CU_{n−1}, 1)`

Fixed mixtures of e-detectors are e-detectors (Proposition 2.3). A supremum over the post-change parameter is not in general (Remark 3.1). If the initial weights of the e-processes sum to at most 1, so that the process does not restart, P(ever alarm) ≤ alpha holds instead, but detection delay then grows with the change time (Remark 2.7) [verified]. The paper recommends e-SR when the pre-change law is not stationary or not known. The framework does not need i.i.d. data, and the ARL guarantee holds without the assumptions used for delay bounds [verified].

The classical procedures are Page's CUSUM (1954) [verified citation; content memory] and the Shiryaev-Roberts statistic (Shiryaev 1963, Roberts 1966) [memory]. Their optimality theory is Lorden (1971) [verified citation; content memory], Moustakides (1986) [verified title; content memory] and Pollak (1985) [verified title; content memory]. A CUSUM on individual Bernoulli inspection outcomes detects a shift in a proportion much faster than a p-chart on grouped samples (Reynolds and Stoumbos 1999) [verified, abstract-level].

### Risk-limiting audits

A risk-limiting audit (RLA) has a known minimum chance of correcting a wrong reported outcome; its risk limit is the largest chance it fails to [verified, ALPHA]. SHANGRLA reduces many social choice functions to nulls of the form "the mean of this finite list of bounded nonnegative numbers is at most 1/2" (assorters). The audit stops without a full hand count if and only if every null is rejected [verified]. Kaplan-Markov applies Markov's inequality to a martingale built from the sample (Stark 2009) [verified, abstract via search]. RiLACS builds RLAs from confidence sequences [verified]. Bernoulli ballot polling includes each ballot independently with a fixed probability (Ottoboni et al. 2019) [verified].

| RLA concept | Rollout counterpart | Transfers? |
| --- | --- | --- |
| Risk limit alpha: the most chance of certifying a wrong outcome | The most chance of promoting a gate that breaks its promise | Yes |
| Reported outcome | The promise: accuracy at least p0 on acts | Yes |
| Ballot manifest, checked by a compliance audit first | A complete, append-only ledger; integrity checks before any test | Yes; the guarantee is void if rows can vanish |
| Full hand count when the audit does not confirm | Shadow: every decision made by a person | Yes: inconclusive means stay in shadow, and demotion means return to it |
| BRAVO (SPRT at 1/alpha) | Test (c) below | Yes |
| ALPHA (predictable eta_j, per-draw bounds) | The plug-in bet; inverse-probability weights with per-row bounds | Yes |
| Bernoulli ballot polling | The per-act audit coin | Yes |
| Assorters with half-average nulls | Bounded per-act scores in [0, u] with a mean null; graded labels | Yes |
| "Phantoms to evil zombies": a missing ballot is scored worst | An unlabelled act counts as wrong | Yes |
| Public random seed | A logged audit draw or seed and counter | Yes |
| A fixed finite population, audited once | An open, drifting stream | No: RLAs certify a list once; a gate needs change detection after promotion |

An RLA does not limit the chance of an unnecessary full hand count; that is a cost. The counterpart here is a false demotion: it costs review work, not safety.

### Late outcomes and filtrations

When treatment affects whether and when an outcome arrives, the inverse-probability-weighted error of a treatment effect "is not a martingale with respect to any filtration". Per-arm errors are martingales only in a chosen event-time filtration (Lindon and Kallus 2026) [verified]. E-processes valid in a coarser filtration are not automatically valid in a finer one; lifting them needs an "adjuster" and costs a logarithmic factor (Choe and Ramdas 2024) [verified]. The practical lesson for a ledger is to fix the order in which outcomes are consumed independently of when or whether they arrive. Section 3.1 does this.

### Weighted sampling

Anytime-valid confidence sequences for off-policy evaluation hold while the logging policy adapts, without uniformly bounded importance weights, at arbitrary stopping times (Waudby-Smith, Wu, Ramdas, Karampatziakis and Mineiro 2022) [verified]. The Horvitz-Thompson weight 1/pi makes a sampled indicator unbiased for the population (Horvitz and Thompson 1952) [memory].

### Conformal test martingales

Conformal martingales test exchangeability online. Vovk's review covers conformal versions of CUSUM and Shiryaev-Roberts with validity results that "limit the probability of a false alarm or the frequency of false alarms" (Vovk 2021) [verified]. Vovk et al. use them to decide when to retrain (2021) [verified]. Plug-in betting functions are in Fedorova et al. (2012) [verified]; the original construction is Vovk, Nouretdinov and Gammerman (2003) [memory].

### Not usable here

The universal SPRT of Bibaut, Kallus and Lindon (2022) is asymptotically calibrated under dependence [verified, abstract via search]. Its type I error rests on a strong invariance principle, which cannot be trusted when errors number in single digits, as they do near a 98% promise.

## 2. Results derived for this note

### 2.1 The zero-error plan is an SPRT with q = 1

Take the likelihood ratio of Bernoulli(q = 1) to Bernoulli(p0). Each right act multiplies it by 1/p0, and a wrong act sets it to 0 for good. So LR_n = p0^(−n) until the first wrong act, and 0 after.

It first reaches 1/alpha at n* = ceil(ln(1/alpha) / ln(1/p0)). At p0 = 0.98 and alpha = 0.05 that is ceil(2.9957/0.020203) = ceil(148.28) = 149, since 0.98^148 = 0.05029 > 0.05 and 0.98^149 = 0.04928. The event "the LR ever reaches 20" is exactly "the first 149 acts are all right", whatever the cap, because a wrong act ends the process. That is the pass event of the planned zero-error test, so the planned test is this sequential test and is anytime-valid as it stands. Its exact type I error at p = 0.98 is 4.928% at every cap from 149 to 20,000 (dynamic programming, table 4.1b).

Consequences:

- Labels of the 149-act plan may be read as they arrive.
- The first wrong label is a final rejection.
- A pass can be declared at the 149th right label in the planned sample.

For `maxErrors = k > 0` the Clopper-Pearson rule at a fixed n is not a supermartingale threshold. Declaring a pass early is invalid. Declaring failure at the (k+1)-th wrong label in the planned sample is valid in any reading order, because the end-of-sample decision is then already fixed. That is curtailment.

The minimum is not specific to this plan. A right act raises any valid likelihood-ratio bet by at most 1/p0. So no test that promotes on runs of right acts can promote before 149 acts at this promise and confidence.

### 2.2 The information floor

Wald's bound on the expected sample size of a sequential test (Wald 1945 [memory]) applies to any test with P_{p0}(promote) ≤ alpha and P_p(promote) ≥ 1 − beta:

`E_p[N] ≥ ((1 − beta) ln((1 − beta)/alpha) + beta ln(beta/(1 − alpha))) / KL(p || p0)`

where `KL(p || p0) = p ln(p/p0) + (1 − p) ln((1 − p)/(1 − p0))` is in nats per act. For the composite null "accuracy ≤ p0" the boundary point p0 is the least favourable. At p0 = 0.98 and alpha = 0.05 (computed):

| true accuracy p | KL (nats/act) | ln(1/alpha)/KL (beta → 0) | floor at 90% power | floor at 80% power |
| --- | --- | --- | --- | --- |
| 0.985 | 0.000698 | 4,295 | 3,407 | 2,733 |
| 0.99 | 0.003119 | 960 | 762 | 611 |
| 0.995 | 0.008183 | 366 | 290 | 233 |
| 0.999 | 0.016187 | 185 | 147 (but at least 149, section 2.1) | 118 (at least 149) |

The smallest fixed Clopper-Pearson plans at 95% confidence with the stated power (computed exactly):

| true p | target power | plan | exact power |
| --- | --- | --- | --- |
| 0.99 | 80% | 969 acts, at most 12 wrong | 82.1% |
| 0.99 | 90% | 1,271 acts, at most 17 wrong | 90.7% |
| 0.995 | 80% | 386 acts, at most 3 wrong | 87.0% |
| 0.995 | 90% | 456 acts, at most 4 wrong | 91.9% |
| 0.999 | 90% | 236 acts, at most 1 wrong | 97.6% |

A 98% promise is reliably testable in a few hundred labels only for gates near 99.5% or better. A gate expected at 99% needs about a thousand labels whatever test is used. Anytime validity reallocates labels between good and marginal gates; it does not create information.

### 2.3 A finite-horizon false-alarm bound for Shiryaev-Roberts

Theorem 2.4 of Shin et al. bounds the mean time to a false alarm. Applications usually want a probability over a horizon. Suppose that, before the change, every increment satisfies E[L_t | past] ≤ 1, and fix a horizon n. Define Y_k = SR_k + (n − k) for k ≤ n. Then:

- E[Y_k | past] = E[L_k | past](SR_{k−1} + 1) + n − k ≤ SR_{k−1} + 1 + n − k = Y_{k−1}.
- So Y is a nonnegative supermartingale with Y_0 = n (since SR_0 = 0).
- Ville's inequality gives P(max_{k≤n} Y_k ≥ A) ≤ n/A, and SR_k ≤ Y_k.

Hence:

`P(false alarm within n observations) ≤ n/A`

The same bound holds for any fixed mixture of SR statistics, by the same argument on the weighted sum (weights summing to 1). It also holds for CUSUM statistics, since a CUSUM is at most the SR built from the same increments. The bound becomes vacuous once n approaches A; it is useful for short horizons and for choosing A.

### 2.4 What the current demotion rule does, exactly

`Rollout.watch` reads the last `window` = 200 audited rows of the enforce phase and demotes when there are at least `minAuditRows` = 30 and right/acted < promised. Audits are drawn only among act rulings (`Engine.settle`), so every audited row is an act. At a 0.98 promise the rule therefore demotes when the wrong audits exceed 2% of those read. Enumerating every count from 30 to 200 in floating point:

| audited rows read | wrong audits tolerated (one more demotes) |
| --- | --- |
| 30 to 49 | 0 |
| 50 to 99 | 1 |
| 100 to 149 | 2 |
| 150 to 199 | 3 |
| 200, sliding window | 4 |

There is no floating-point edge: any fraction equal to 49/50 rounds to the same double as 0.98.

So the reading "it demotes at the first audited error once 30 audits exist" is right only between audit 30 and audit 49. An error among audits 1 to 29 demotes at audit 30. A healthy 99% gate shows at least one wrong audit among its first 49 with probability 1 − 0.99^49 = 38.9%, which is most of its false demotions. Simulated, 38.0% of healthy gates are demoted within 1,000 acts at an audit rate of 0.05, which is about 50 audits (table 4.2a). Later the 200-audit window dilutes errors: after 5,000 healthy acts at a rate of 0.1 it spans the last 2,000 acts.

### 2.5 Wrong acts executed before a demotion

Each enforce act is audited independently with probability r, and audited acts go to review instead of executing. If a detector needs D audits after a change to error rate e, it sees them over about D/r acts. Of those, (1 − r) D/r execute and a fraction e is wrong:

`wrong acts executed ≈ e (1 − r) D / r`, plus `e (1 − r) Lambda` if audit labels arrive Lambda acts late.

As a check, the SR mixture at A = 1000 with r = 0.1 and a drop to 95% demotes after a mean of 1,586 acts, which gives 1,586 × 0.9 × 0.05 = 71.4; the simulation gives 71.4. D is set by the detector and the size of the drop. The factor (1 − r)/r is the lever: 19 at r = 0.05, 9 at 0.1 and 4 at 0.2.

## 3. Recommended design

### 3.1 The act sequence, the labelled prefix and missing labels

Keep how the sequence is built today (`acceptanceSample`, without the size limit):

- Acts are rows the policy would have acted on and an oracle answered; floors, bypasses and failed-open rows are excluded.
- Ordering is ledger order, within one configuration identity's shadow rows.
- A repeated state is a retry and counts once.
- The group rule of section 3.5 applies.
- Sources are filtered by trust class.
- A label that cannot be read counts as wrong.

The order is fixed by the ledger before any label is read. It must never be the order in which labels arrive (table 4.4).

The e-process consumes this sequence in order. The simplest valid rule is the contiguous labelled prefix: advance only while the next act in ledger order is labelled. An equivalent, more general statement follows from monotonicity. For a fixed number of acts, the mixture e-value of section 3.2 increases when a wrong act is replaced by a right one: each component multiplies by ((1 − eps_k)/p0)/(eps_k/(1 − p0)) > 1. So any evaluation that counts every not-yet-labelled act as wrong, at the position it occupies, is pointwise at or below the e-value of the true labels. Promoting when it crosses therefore stays within Ville's bound. In practice:

- Evaluate at every prefix length, with unlabelled acts counted as wrong.
- Promote at the first prefix where the e-value reaches the threshold.
- A late right label can only raise the e-value.
- A label deadline is not needed for validity, only for progress.

Two caveats about using the same imputation elsewhere:

- **Futility (3.4).** Counting unlabelled acts as wrong raises the reverse e-value, so its guarantee for good gates holds only on the labelled prefix. Run futility on the labelled prefix.
- **Demotion (3.8).** Counting a missing audit label as an error inflates false alarms and voids the ARL guarantee. Run the detector on the labelled prefix of audits. Treat an audit overdue past a deadline as a separate, explicit operational alarm (raise the audit rate or hold enforce), not as an error inside the detector.

### 3.2 Promotion e-value: the log-grid mixture

Inputs:

- `p0`, the promised accuracy.
- `alpha` (default 0.05).
- The grid `c_k = 0.025 × 32^(k/11)` for k = 0 to 11, so c runs from 0.025 to 0.8.
- `eps_k = (1 − p0) c_k`, the alternative error rates. At p0 = 0.98 these are 0.00050, 0.00069, 0.00094, 0.00129, 0.00176, 0.00242, 0.00331, 0.00454, 0.00622, 0.00852, 0.01168 and 0.01600.
- Weights `w_k = 1/12`.

With S right and F wrong acts in the evaluated prefix:

`logE(S, F; p0) = logsumexp_k [ ln(w_k) + S ln((1 − eps_k)/p0) + F ln(eps_k/(1 − p0)) ]`

where `logsumexp(x_1..x_K) = m + ln(sum_k exp(x_k − m))` with m = max_k x_k. Promote at the first evaluated prefix where `logE ≥ ln(1/alpha)` (or the attempt-adjusted threshold of section 3.6).

Each component is the likelihood ratio of Bernoulli(q_k = 1 − eps_k) against Bernoulli(p0), with q_k > p0 because c_k < 1. By the identity in section 1 its factor has mean at most 1 whenever the act's accuracy, given everything earlier in the sequence, is at most p0. A fixed mixture of test supermartingales is one, so P(ever promote) ≤ alpha under that null. Do not replace the mixture by the maximum over the grid (a generalized likelihood ratio): that is not a supermartingale.

The e-value depends only on (S, F). A restore recomputes it from the ledger, and a checkpoint is only a cache. Behaviour at p0 = 0.98 and alpha = 0.05 (exact):

| wrong acts in the prefix | 0 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| acts needed to promote | 179 | 313 | 430 | 535 | 632 |

The first wrong act costs 133 extra right acts, the second 116, the third 104 and the fourth 96.

An equally valid alternative is the ALPHA-style plug-in bet: `q_t = min(0.9995, max(p0 + 0.02/sqrt(100 + t), (100 × 0.995 + S_t)/(100 + t)))` from the t acts before act t, with factor `X q_t/p0 + (1 − X)(1 − q_t)/(1 − p0)`. Its power is similar (table 4.1a, column e). It is path-dependent, so it is less convenient to recompute and audit. Prefer the mixture.

### 3.3 The anytime-valid lower bound, for the grade

Rescale the grid with the candidate accuracy x, so that `eps_k(x) = (1 − x) c_k`, and define:

`L_n = sup { x in (0, 1) : logE(S, F; x) ≥ ln(1/alpha) }`

Each component's factor for a right act, `(1 − c_k (1 − x))/x = (1 − c_k)/x + c_k`, decreases in x. The factor for a wrong act, c_k, does not depend on x. So logE decreases in x and L_n is found by bisection; it is 0 if no x qualifies. If every act's accuracy given the past is at most x, then L_n > x implies logE(S, F; x) ≥ ln(1/alpha), so P(there is an n with L_n > x) ≤ alpha. L_n and its running maximum are therefore anytime-valid lower confidence bounds on accuracy.

Promotion at the promise is the event L_n ≥ p0. A shadow status may show L_n at every evaluation without the optional-stopping problem that makes today's estimated grade unsafe to watch. Examples at alpha = 0.05 (computed):

| right acts | wrong acts | L_n |
| --- | --- | --- |
| 149 | 0 | 0.9761 |
| 179 | 0 | 0.9801 |
| 300 | 0 | 0.9881 |
| 312 | 1 | 0.9800 |
| 500 | 2 | 0.9829 |
| 1,000 | 5 | 0.9856 |

### 3.4 Futility: curtailment, a reverse test, and a cap

No futility rule affects the false-promotion guarantee: stopping without promoting only removes promotions. Futility exists to save labels and to say, with a stated guarantee, when to stop testing a configuration.

1. **Curtailment (free).** With a cap of N acts and n already read, stop when promotion has become impossible even if every remaining act is right: `logsumexp_k [ ln(w_k) + (S + N − n) ln((1 − eps_k)/p0) + F ln(eps_k/(1 − p0)) ] < ln(1/alpha)`. Decisions are unchanged; only the stopping time shortens.
2. **Reverse test (a guarantee for good gates).** Choose `q_f`, the lowest accuracy whose loss you would regret; the default is `p0 + (1 − p0)/2`, which is 0.99 at a 98% promise.
   - Alternatives below it: `r_j = 1 − (1 − q_f) g_j` with g in {1.5, 2, 3, 4, 6, 8}, weights 1/6. At q_f = 0.99 these are 0.985, 0.98, 0.97, 0.96, 0.94 and 0.92. Each g_j (1 − q_f) must stay below 1.
   - `logR = logsumexp_j [ ln(1/6) + S ln(r_j/q_f) + F ln((1 − r_j)/(1 − q_f)) ]`, computed on the labelled prefix.
   - Retire when `logR ≥ ln(1/beta)`, with beta = 0.1.
   - Each factor has mean `1 + (p − q_f)(r_j − q_f)/(q_f (1 − q_f)) ≤ 1` for p ≥ q_f, so a gate whose every act is at least q_f is retired by this rule with probability at most beta.
   - At q_f = 0.99 it fires at:

     | right acts so far | 0 | 50 | 100 | 150 | 200 | 250 | 300 | 350 | 400 |
     | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
     | wrong acts that retire | 2 | 3 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
3. **A cap from the label budget.** At N acts with neither threshold crossed, report "inconclusive" and stay in shadow.

Exact effect (table 4.1c): at a cap of 1,000 the reverse test cuts the mean labels spent on a 97% gate from 299 to 197 and on a 98% gate from 433 to 365. It retires a 99% gate 4.5% of the time, lowering its promotion probability from 51.6% to 51.2%. Do not stop on a point estimate below the promise. Do not use Wald's lower boundary at an arbitrary q1 without stating which accuracy it protects.

### 3.5 Groups

Validity needs the null to hold conditionally: each unit's mean, given every earlier unit in the consumed order, is at most p0. Acts in one session share context and errors, so a right act raises the chance that the next act of the same session is right. Under a marginal accuracy of 98% the act-level conditional mean then exceeds 98% inside good sessions, the product of bets compounds that, and false promotion reaches 20.9% at an intra-class correlation (ICC) of 0.2 (table 4.3). The fixed plan without a group cap does no better (20.3%). Cap 3 per session leaves 7.3% to 8.6%. Two valid units:

- **One act per group** (`maxPerGroup: 1`): the first act, as the cap works today. If first acts are systematically different (the first tool call is usually a read), take instead the group's act with the smallest hash of its row id, decided when the group closes. Either choice must not depend on labels. Valid if groups are independent of each other.
- **Group mean.** X_g is the mean correctness of the group's first k acts (k fixed in the plan) and lies in [0, 1].
  - Per component k: `log P_k += ln( X_g (1 − eps_k)/p0 + (1 − X_g) eps_k/(1 − p0) )`, and `logE = logsumexp_k (ln w_k + log P_k)`.
  - The factor is linear in X_g, so the identity of section 1 still bounds its mean by 1 when E[X_g | past] ≤ p0.
  - Order groups by the ledger position of their first act. Advance through the contiguous prefix of groups that are closed and fully labelled.
  - Closure must be defined without labels: a session-end row, k acts reached, or a fixed idle time.
  - With unequal group sizes the estimand is the mean accuracy per group, not per act. Fixing k keeps the two close.

Either way, one group contributes at most ln(1/p0) to the log e-value, because a group mean of 1 multiplies by at most 1/p0. A 98% promise therefore needs at least 149 groups even when every act is right. One act per group reaches that bound with the fewest labels. The group mean used a median of 265 sessions, about 2,650 labels, at 99.5% (table 4.3). Choose the coarsest grouping you can afford: sessions of one user, repository or day may still share errors. Estimate the ICC from labelled shadow rows at each candidate level (one-way analysis of variance). No test can detect from its own data that its unit is too fine.

### 3.6 One e-process per identity: re-promotion and many configurations

The row identity is what rows carry: `policyHash`, `questionHash`, `evidenceVersion` and the model pin. An attempt is a stretch of that identity's shadow rows: from its first eligible act, or from the first after its most recent enforce row. The e-process of an attempt starts at that act, which the ledger alone determines, and is never restarted. This replaces the fixed plan's "a rejected configuration stays rejected" and the `failedWindow` / `earliestAccepted` search over phase starts. There is one start, so there is no window to choose.

- **Retirement** (futility or cap) is an economic decision with no validity role. A retired attempt may be reopened and its e-process continues from its current value at no cost to the guarantee.
- **Restarting** an e-process from 1 on the same identity is a second test and spends alpha again.
- **Re-promotion after a demotion** starts a new attempt, because evidence from before enforce is stale.
- **Changing the plan** (alpha, grid, cap) over the same rows is plan shopping and must count as a new attempt.

For the j-th attempt on a gate, counting attempts across identities if you want a per-gate guarantee, the options are:

| option | rule | guarantee | cost |
| --- | --- | --- | --- |
| A | Require a new evidence version for each attempt; record j | Per attempt: alpha | None, but j attempts give up to j × alpha |
| B | Spend: attempt j uses threshold 1/(alpha w_j) with sum of w_j ≤ 1, for example `w_j = 6/(pi^2 j^2)` | P(any false promotion over all attempts) ≤ alpha | Clean acts to promote: 207 (j = 1), 283 (j = 2), 327 (j = 3), against 179 unspent. With 2^(−j): 218 and 256. |
| C | Keep 1/alpha per attempt | Bound is j × alpha after j attempts | Must be documented; this is today's behaviour |

Each doubling of the threshold costs about ln 2 / ln(0.9995/0.98) ≈ 35 clean acts. The fixed plan has the same multiplicity today: the docs ask users to record how many configurations were tried. Recommendation: A by default, with j shown in every status, and B as an opt-in for gates where the family-wide guarantee matters.

### 3.7 The minimal step, if the planned sample stays

If the fixed plan is kept, two changes are free and valid:

- Curtail: declare rejection as soon as the planned sample's read labels hold `maxErrors + 1` wrong acts, in any reading order.
- For `maxErrors = 0`, drop the sealing: read labels as they arrive and declare a pass at the 149th right label (section 2.1).

`failedWindow` and the checkpoint logic stay as they are.

### 3.8 Demotion detector

Let `e0 = 1 − p0` be the promised error rate. The post-change alternatives are `e1_k = min(s_k e0, (1 + e0)/2)` with s in {2, 4, 8}, weights 1/3. At p0 = 0.98 these are 0.04, 0.08 and 0.16; the clip keeps e1 < 1 for low promises. For each audit outcome x in the labelled prefix of the enforce phase's audits, in ledger order (x = 1 if the audited act was wrong):

- `L_k(x) = x e1_k/e0 + (1 − x)(1 − e1_k)/(1 − e0)`
- SR mixture (recommended): `m_k ← L_k(x) (m_k + 1)`, starting at m_k = 0.
- CUSUM mixture (more conservative): `m_k ← L_k(x) max(m_k, 1)`, starting at 0.
- Alarm (demote) when `sum_k m_k / 3 ≥ A`. Keep log m_k for numerical range. The SR update in logs is `log m ← log L + log1p(exp(log m))`, which is `log L + log m + log1p(exp(−log m))` when log m is large.

Guarantee: suppose every audited act's chance of being wrong, given all earlier audits, is at most e0. Then the mean number of audits to a false alarm is at least A (Shin et al., Theorem 2.4, with Proposition 2.3 for the mixture), and P(false alarm within n audits) ≤ n/A (section 2.3). A gate better than its promise alarms much less often than the bound allows (table 4.2a).

Graded labels fit unchanged: for x in [0, 1] with mean at most e0 the factor is linear in x, so the same bound holds.

Defaults and options:

| detector | false demotions | speed |
| --- | --- | --- |
| SR mixture, A = 1000 (default) | ARL ≥ 1,000 audits | Demotes after 4 consecutive wrong audits from a fresh phase |
| SR mixture, A = 300 | More | Faster |
| CUSUM mixture, A = 1000 | Fewest | Slowest; 4 consecutive errors |
| CUSUM mixture, A = 100 | Rare in practice, though its formal ARL is only ≥ 100 | 3 consecutive errors |

The roadmap's "acts to first judgement" is then about 4/r acts.

Do not use a non-restarting e-process for demotion. Its delay grows with how long the gate has been healthy (table 4.2c).

Two further rules:

- **One audit per session.** Audits from one session share errors as acts do. Count at most one audit per session in the detector, or define the detector on session-level audit means.
- **Label latency** delays every detector by the time an audit label takes to arrive, and adds e (1 − r) Lambda wrong acts (section 2.5).

### 3.9 Verdict-dependent audits (optional)

An audit probability that depends on the verdict, for example more audits near the bar, is valid with inverse-probability weights. For every enforce act t, audited or not:

- `Y_t = x_t a_t / pi_t`, where a_t = 1 if audited and pi_t is the probability actually used for act t.
- Then `E[Y_t | past] = E[x_t | past]`, the overall error rate, as long as the audit coin is independent of correctness given what was logged.
- Factors `1 + lambda_k (Y_t − e0)` with constant `lambda_k` in [0, 1/e0] are valid for the overall null "error ≤ e0". The simulation used lambda in {1, 2.5, 5, 10, 20} with weights 1/5.
- Run the SR and CUSUM recursions on these act-level factors. The detector steps on every act, so A is counted in acts, not audits: A = 10,000 acts is about 1,000 audits at a mean rate of 0.1.

Conditions:

- pi_t is fixed before the label, from information logged before it.
- pi_t > 0 on every act; set a floor such as 0.05.
- lambda must not depend on the current act's stratum unless the null is per stratum ("each confidence band meets its promise").
- Every enforce act carries its pi_t.

Changing a uniform audit rate mid-phase, for example raising it after a tripwire (3.10), is valid for the audits-only detector of 3.8 as long as the coin stays independent of correctness.

The weights cost variance (table 4.5). Stratified audits help only when drift concentrates where audits concentrate, and hurt against uniform drift. Without weights they are invalid. Keep uniform audits as the decision detector, and use weighted oversampling near the bar at most as a separate caution-raising detector, or with an explicit per-band promise.

### 3.10 Label-free tripwire (optional)

Over the confidences of all asks of the gate:

- Nonconformity `a_t = 1 − confidence_t`.
- Smoothed conformal p-value `p_t = (#{i ≤ t : a_i > a_t} + U_t #{i ≤ t : a_i = a_t}) / t`, with U_t uniform on [0, 1]. Ties are common because decision models repeat values.
- Betting functions `f_eps(p) = eps p^(eps − 1)`, each with mean 1 under a uniform p, for eps in {0.05, 0.1, 0.2, 0.35, 0.5} with equal weights.
- SR mixture `m_eps ← f_eps(p_t)(m_eps + 1)`; alarm when the mean of m_eps reaches A, counted in asks.

Under exchangeability the p_t are independent and uniform, so the ARL is at least A asks.

An alarm may only raise caution: raise the audit rate, or flag the gate for a person. It never demotes on its own, never lowers anything, and never enters model-visible state (invariant 8). Restart it with a fresh reference after a person acknowledges the alarm.

It detects a change in the confidence distribution and is blind to a calibration break that leaves that distribution unchanged.

### 3.11 Fields in plans, checkpoints and rows

**Plan** (part of the scope hash):

- `method`: "fixed" or "e-mixture-v1"
- `alpha`
- the grid's `c` values or a named grid
- `futility: { qf, beta }` or none
- `cap`
- the group unit: `tagPrefix` plus "first", "hash" or "mean" and `k`
- the attempt-spending rule
- for demotion: `{ kind: "sr-mix" | "cusum-mix", A, shifts }`, replacing `window` and `minAuditRows`

**Checkpoint** (format 4). Everything in it can be re-derived from the ledger, so it is a cache and a record, not evidence:

- `scopeHash`, `mode`, `afterId`
- `origin`: the attempt's first act id
- `attempt` (j)
- `prefixEnd`, `S`, `F`, `logE`, `logR`
- on an enforce checkpoint, `crossedAt`: the act id at which logE crossed, so a restore re-derives the crossing
- `retired: { at, reason }`
- for the detector: `auditPrefixEnd` and `logM` per component

**Rows:**

- On every enforce act eligible for audit: `auditProb` (the pi actually used) and `auditDraw` (the uniform draw, or a seed and counter so anyone can recompute which acts were audited), whenever the rate can vary.
- `auditDesign`, a hash of the audit rule.
- Labels already carry `outcome.at` and `source`. If an overdue-audit alarm is used, decide "overdue" from ledger append order where the ledger exposes it, not from vendor timestamps.

### 3.12 What stays

These remain as they are:

- Identity scoping.
- The act definition, retries counted once, trust classes, and "an unreadable label counts as wrong".
- The `MeasuredGrade`-only path into enforce. A measured grade would carry the e-value, alpha, the crossing act and L_n.
- Ledger-order phase boundaries and draining in-flight work at transitions.
- Audits opt-in, and the rule that only audits demote.

## 4. Operating characteristics

### 4.0 How the numbers were produced

All simulations use a seeded xoshiro128** generator. The 32-bit seed is expanded into its four state words by a splitmix32-style mix:

- `x += 0x9e3779b9`
- `z = (x ^ x>>>16) × 0x85ebca6b`
- `z = (z ^ z>>>13) × 0xc2b2ae35`
- `z ^= z>>>16`

A uniform draw combines two outputs into 53 bits. Beta variates use Marsaglia-Tsang gamma draws. Tables marked exact come from dynamic programming over error counts, or from closed forms, and involve no Monte Carlo. A reproduction with another generator should match the simulated figures within Monte Carlo error: about ±0.3 points at 5% with 20,000 runs, and ±0.4 at 5% with 10,000.

| script (not in the repository) | content | runs per cell | seeds |
| --- | --- | --- | --- |
| `promote.ts` | promotion, simulated | 20,000 | 1000 to 1059: one per cell in method order (a, a′, b, b′, c, c2, d1, d2, e, e without futility) by p order (0.97, 0.98, 0.985, 0.99, 0.995, 0.999); the same seeds at caps 313, 600 and 1000 |
| `exact.ts`, `exact2.ts`, `fixedexact.ts`, `floor.ts`, `spend.ts` | exact figures | none | none |
| `demote2.ts` | demotion | 10,000 | 7000 to 7023 |
| `dependence.ts` | clustering and late labels | 10,000 | 31000 to 31008 |
| `ipw2.ts` | verdict-dependent audits | 5,000 | 51000 to 51015 |
| `conformal.ts` | tripwire | 1,000 | 71000 to 71003 |
| `layered.ts`, `layered_sr.ts` | negative result | 10,000 | 91000 to 91011 |

Further detail on the seeds:

- **`demote2.ts`.** No change: 7000 to 7002 at p = 0.99 for r = 0.05, 0.1, 0.2; 7003 to 7005 at p = 0.98. Change at act 0 to 0.95, 0.90 and 0.80: 7006 to 7014. Change at act 5000: 7015 to 7023. In each cell all detectors read the same simulated stream. For each act the audit coin is drawn first, then correctness.
- **`dependence.ts`.** Clustering at (0.98, ICC 0, 0.05, 0.2) uses 31000 to 31002, and at 0.995 uses 31003 to 31005. Late labels use 31006 to 31008.
- **`ipw2.ts`.** No change, healthy then at the promise, four configurations each: 51000 to 51007. Drift near the bar then uniform drift: 51008 to 51015. For each act the stratum is drawn first, then correctness, then the audit coin.
- **`conformal.ts`.** The exchangeable stream uses 71000; the three shifts use 71001 to 71003.
- **`layered.ts`, `layered_sr.ts`.** For each base rate, one healthy seed then three drift seeds.

### 4.1 Promotion

H0: accuracy ≤ 0.98, alpha = 0.05. Each act is right with probability p, independently.

**Methods compared:**

- (a) The planned 149 acts, 0 wrong allowed.
- (b) The planned 313 acts, at most 2 wrong.
- (c) A Bernoulli SPRT against q1 = 0.995: rejection at 20, a lower (futility) boundary at LR ≤ 0.1, curtailment, and a cap.
- (d) The recommended mixture of 3.2 with curtailment and the reverse test of 3.4 (q_f = 0.99, beta = 0.1).
- (e) The ALPHA-style plug-in of 3.2. Its curtailment uses the largest bet. Its futility is a plug-in reverse bet, `eta′_t = min(0.989, max(0.90, (50 × 0.98 + S_t)/(50 + t)))` against q_f = 0.99 at threshold 10.

**4.1a, cap 600.** Each cell is P(promote) · mean / median acts to a decision. Probabilities for (a), (b) and (d) are exact and for (c) exact without curtailment, which does not change decisions. Acts for (a), (b) and (d) are exact; acts for (c) and (e) are simulated. (a) and (b) stop at the failing wrong act; read in full they always take 149 and 313 acts.

| true p | (a) 149, 0 wrong | (b) 313, ≤2 wrong | (c) SPRT q1 = 0.995 | (d) mixture + reverse test | (e) plug-in + reverse bet |
| --- | --- | --- | --- | --- | --- |
| 0.97 | 1.07% · 33/23 | 0.42% · 100/89 | 0.38% · 104/86 | 0.48% · 122/118 | 0.7% · 211/208 |
| 0.98 | 4.93% · 48/35 | 4.97% · 147/134 | 4.31% · 176/149 | 3.78% · 186/179 | 3.9% · 306/338 |
| 0.985 | 10.52% · 60/46 | 15.08% · 186/178 | 14.65% · 241/212 | 11.49% · 236/222 | 11.3% · 351/357 |
| 0.99 | 22.37% · 78/69 | 39.35% · 238/268 | 43.21% · 308/291 | 34.13% · 292/293 | 33.2% · 377/403 |
| 0.995 | 47.38% · 105/139 | 79.26% · 293/313 | 87.09% · 301/290 | 79.19% · 297/313 | 78.6% · 323/326 |
| 0.999 | 86.15% · 138/149 | 99.60% · 313/313 | 99.91% · 218/198 | 99.84% · 205/179 | 99.8% · 203/174 |

Further simulated variants at cap 600, P(promote) for p = 0.97 / 0.98 / 0.985 / 0.99 / 0.995 / 0.999:

| variant | P(promote) | mean acts |
| --- | --- | --- |
| SPRT against q1 = 0.99 | 0.1 / 1.8 / 9.3 / 37.2 / 85.4 / 100.0% | 165 / 248 / 316 / 396 / 404 / 318 |
| Mixture uniform on q in (0.98, 1), 40 points, with the plug-in reverse bet | 0.1 / 1.9 / 8.1 / 29.8 / 77.9 / 99.8% | 132 / 196 / 249 / 316 / 339 / 252 |
| Log-grid mixture with the plug-in reverse bet (rather than the mixture reverse test of (d)) | 0.5 / 3.4 / 11.6 / 34.4 / 79.2 / 99.9% | 130 / 193 / 241 / 294 / 298 / 205 |
| (e) without futility | 0.6 / 3.9 / 11.2 / 33.3 / 78.4 / 99.9% | 339 / 355 / 372 / 381 / 324 / 203 |

**4.1b, exact type I error at p = 0.98, no futility,** P(promote) by cap:

| cap | 149 | 313 | 600 | 1,000 | 5,000 | 20,000 |
| --- | --- | --- | --- | --- | --- | --- |
| SPRT q1 = 0.995 | 0.000% | 2.985% | 4.383% | 4.818% | 4.952% | 4.952% |
| log-grid mixture | 0.000% | 3.344% | 3.785% | 4.129% | 4.629% | (computed to 5,000) |
| zero-error plan (q = 1) | 4.928% | 4.928% | 4.928% | 4.928% | 4.928% | 4.928% |

A simulated check of the SPRT at cap 20,000 gave 5.42% on 4,000 runs, 1.2 standard errors above the exact 4.95%: noise.

**4.1c, the recommended test (d), exact.** Curtailment is always on. Each cell is P(promote) / P(retired by the reverse test) / mean acts / median / 90th percentile:

| true p | cap 313 with reverse test | cap 600 with reverse test | cap 600 without | cap 1,000 with reverse test | cap 1,000 without |
| --- | --- | --- | --- | --- | --- |
| 0.97 | 0.47% / 9.1% / 66 / 56 / 129 | 0.48% / 35.8% / 122 / 118 / 218 | 0.48% / - / 133 / 123 / 219 | 0.48% / 76.8% / 197 / 164 / 418 | 0.48% / - / 299 / 288 / 429 |
| 0.98 | 3.34% / 4.5% / 97 / 84 / 179 | 3.78% / 16.0% / 186 / 179 / 314 | 3.78% / - / 193 / 179 / 314 | 4.12% / 36.3% / 365 / 397 / 622 | 4.13% / - / 433 / 422 / 627 |
| 0.985 | 9.09% / 2.6% / 123 / 112 / 219 | 11.49% / 8.3% / 236 / 222 / 391 | 11.50% / - / 241 / 224 / 391 | 14.86% / 16.3% / 485 / 516 / 771 | 14.95% / - / 529 / 531 / 775 |
| 0.99 | 24.33% / 1.2% / 159 / 168 / 289 | 34.13% / 3.1% / 292 / 293 / 454 | 34.18% / - / 295 / 295 / 455 | 51.17% / 4.5% / 549 / 593 / 894 | 51.62% / - / 570 / 613 / 894 |
| 0.995 | 59.50% / 0.3% / 199 / 179 / 313 | 79.19% / 0.6% / 297 / 313 / 492 | 79.29% / - / 299 / 313 / 494 | 95.87% / 0.6% / 378 / 313 / 723 | 96.31% / - / 382 / 313 / 723 |
| 0.999 | 96.70% / 0.0% / 197 / 179 / 313 | 99.84% / 0.0% / 205 / 179 / 313 | 99.85% / - / 205 / 179 / 313 | 99.98% / 0.0% / 206 / 179 / 313 | 100.00% / - / 206 / 179 / 313 |

**4.1d, cap sensitivity of the other sequential tests** (simulated), P(promote) for p = 0.98 / 0.985 / 0.99 / 0.995 / 0.999:

| test | cap 313 | cap 600 | cap 1,000 |
| --- | --- | --- | --- |
| (c) SPRT q1 = 0.995 | 2.9 / 9.1 / 24.4 / 60.4 / 96.7% | 4.3 / 15.2 / 43.7 / 87.2 / 99.9% | 4.8 / 17.7 / 52.8 / 93.0 / 99.9% |
| SPRT q1 = 0.99 | 0.3 / 1.1 / 5.4 / 22.4 / 74.3% | 1.8 / 9.3 / 37.2 / 85.4 / 100.0% | 3.6 / 19.5 / 67.6 / 99.1 / 100.0% |
| (e) plug-in with futility | 3.0 / 7.3 / 17.6 / 41.9 / 84.2% | 3.9 / 11.3 / 33.2 / 78.6 / 99.8% | 4.0 / 14.5 / 50.0 / 96.1 / 100.0% |

How to read these tables:

- **Same maximum label budget.** At 313 acts the fixed Clopper-Pearson plan (b) is more powerful than any sequential test: 39.4% against 24.3% at 99%, and 79.3% against 59.5% at 99.5%. That gap is the price of anytime validity.
- **What the sequential tests buy.** Very good gates promote early: the median is 179 acts at 99.9%. Marginal gates get a longer run: at a cap of 1,000, 99.5% promotes 95.9% of the time with a mean of 378 acts. And `maxErrors` need not be chosen in advance.
- **The SPRT against a single alternative** is the strongest choice if the operator can name the gate's likely accuracy, and weaker away from it.

### 4.2 Demotion

Promise 0.98. Each enforce act is audited independently with probability r. Detectors read audit outcomes only, with labels immediate.

Detectors compared:

- the current rule (window 200, minimum 30)
- CUSUM mixture over e1 in {0.04, 0.08, 0.16}, at A = 100 and at A = 1000
- CUSUM against e1 = 0.05 alone, at A = 1000
- SR mixture over the same grid, at A = 100, 300 and 1000
- a non-restarting mixture e-process over the same grid, alarm at 20, which bounds P(ever false alarm) by 5%

10,000 runs per cell.

**4.2a, no change.** P(demoted within 1,000 acts / within 10,000 acts):

| detector | healthy 0.99, r = 0.05 | 0.99, r = 0.1 | 0.99, r = 0.2 | at promise 0.98, r = 0.05 | 0.98, r = 0.1 | 0.98, r = 0.2 |
| --- | --- | --- | --- | --- | --- | --- |
| current rule | 38.0 / 56.0% | 43.6 / 68.1% | 47.3 / 83.5% | 61.0 / 93.8% | 72.4 / 99.0% | 79.8 / 100.0% |
| CUSUM mix, A = 100 | 0.1 / 1.1% | 0.3 / 2.3% | 0.5 / 4.4% | 0.9 / 12.5% | 2.3 / 23.6% | 4.7 / 42.1% |
| CUSUM e1 = 0.05, A = 1000 | 0.0 / 0.0% | 0.0 / 0.0% | 0.0 / 0.0% | 0.0 / 0.2% | 0.0 / 0.6% | 0.0 / 1.5% |
| CUSUM mix, A = 1000 | 0.0 / 0.0% | 0.0 / 0.1% | 0.0 / 0.1% | 0.1 / 1.1% | 0.1 / 2.4% | 0.4 / 4.7% |
| SR mix, A = 1000 | 0.1 / 2.0% | 0.3 / 4.3% | 0.7 / 8.5% | 0.8 / 23.9% | 2.8 / 46.3% | 7.6 / 73.4% |
| SR mix, A = 300 | 0.5 / 16.3% | 1.9 / 32.1% | 5.6 / 56.5% | 3.2 / 65.9% | 11.2 / 90.5% | 28.2 / 99.3% |
| SR mix, A = 100 | 4.6 / 67.3% | 12.6 / 90.6% | 31.2 / 99.3% | 14.3 / 97.2% | 37.5 / 99.9% | 69.2 / 100.0% |
| e-process, no restart | 0.2 / 0.2% | 0.2 / 0.2% | 0.2 / 0.2% | 1.2 / 2.4% | 1.9 / 3.3% | 2.1 / 3.0% |

**4.2b, a drop from 0.99 at act 0** (immediately after promotion). Each cell is wrong acts executed after the change before demotion, as mean / median / 90th percentile, with the mean acts to demotion in parentheses. Runs end at 50,000 acts; "undetected 0.0%" means a handful of runs.

Drop to 0.95:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 35.1 / 30 / 49 (740) | 16.4 / 14 / 24 (363) | 7.3 / 6 / 12 (182) |
| CUSUM mix, A = 100 | 196.1 / 155 / 408 (4126) | 92.7 / 73 / 193 (2059) | 40.4 / 31 / 87 (1012) |
| CUSUM e1 = 0.05, A = 1000 | 365.2 / 320 / 644 (7690), undetected 0.0% | 173.6 / 151 / 306 (3856) | 77.2 / 67 / 137 (1928) |
| CUSUM mix, A = 1000 | 358.6 / 308 / 695 (7552) | 169.3 / 146 / 327 (3761) | 75.0 / 64 / 146 (1873) |
| SR mix, A = 1000 | 152.7 / 128 / 296 (3212) | 71.4 / 60 / 139 (1586) | 31.6 / 26 / 62 (790) |
| SR mix, A = 300 | 93.7 / 77 / 182 (1973) | 44.4 / 37 / 87 (985) | 19.5 / 16 / 39 (487) |
| SR mix, A = 100 | 54.5 / 44 / 107 (1149) | 25.6 / 21 / 51 (567) | 11.3 / 9 / 23 (282) |
| e-process, no restart | 224.3 / 178 / 481 (4721) | 105.7 / 83 / 227 (2347) | 46.6 / 36 / 101 (1163) |

Drop to 0.90:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 57.9 / 56 / 75 (608) | 27.4 / 27 / 37 (304) | 12.2 / 12 / 18 (152) |
| CUSUM mix, A = 100 | 99.9 / 81 / 198 (1050) | 47.2 / 38 / 95 (524) | 21.3 / 17 / 43 (265) |
| CUSUM e1 = 0.05, A = 1000 | 208.4 / 194 / 326 (2191) | 98.5 / 92 / 155 (1094) | 44.1 / 41 / 70 (550) |
| CUSUM mix, A = 1000 | 154.9 / 133 / 289 (1628) | 72.8 / 62 / 137 (809) | 32.9 / 28 / 62 (410) |
| SR mix, A = 1000 | 100.6 / 86 / 185 (1058) | 47.6 / 41 / 89 (528) | 21.4 / 18 / 41 (268) |
| SR mix, A = 300 | 74.1 / 64 / 138 (779) | 34.9 / 30 / 66 (387) | 15.7 / 13 / 30 (196) |
| SR mix, A = 100 | 51.4 / 43 / 98 (540) | 24.0 / 20 / 46 (267) | 10.9 / 9 / 22 (136) |
| e-process, no restart | 88.4 / 68 / 189 (928) | 41.3 / 31 / 90 (459) | 19.0 / 14 / 42 (237) |

Drop to 0.80:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 114.2 / 113 / 145 (601) | 53.9 / 53 / 70 (299) | 24.0 / 23 / 33 (149) |
| CUSUM mix, A = 100 | 72.3 / 63 / 135 (380) | 34.1 / 29 / 65 (189) | 15.2 / 13 / 29 (95) |
| CUSUM e1 = 0.05, A = 1000 | 172.3 / 164 / 261 (906) | 81.7 / 78 / 124 (453) | 36.3 / 35 / 56 (226) |
| CUSUM mix, A = 1000 | 104.7 / 92 / 183 (550) | 49.1 / 43 / 87 (272) | 22.0 / 19 / 40 (137) |
| SR mix, A = 1000 | 84.1 / 75 / 146 (441) | 39.6 / 35 / 71 (220) | 17.7 / 16 / 32 (110) |
| SR mix, A = 300 | 66.9 / 59 / 120 (351) | 31.6 / 28 / 58 (175) | 14.2 / 12 / 26 (88) |
| SR mix, A = 100 | 51.9 / 45 / 94 (272) | 24.6 / 21 / 46 (136) | 11.0 / 9 / 21 (68) |
| e-process, no restart | 57.6 / 48 / 118 (303) | 27.2 / 22 / 56 (151) | 12.2 / 10 / 25 (76) |

**4.2c, a late drop after 5,000 healthy acts at 0.99.** Same cells as 4.2b. Runs with a false alarm before the change are excluded; FA is their share.

Drop to 0.95:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 71.3 / 61 / 137 (1502); FA 49% | 34.0 / 30 / 65 (755); FA 56% | 15.0 / 13 / 29 (371); FA 69% |
| CUSUM mix, A = 100 | 190.3 / 150 / 402 (4005); FA 1% | 90.9 / 71 / 193 (2020); FA 1% | 40.1 / 31 / 85 (1000); FA 2% |
| CUSUM e1 = 0.05, A = 1000 | 361.2 / 317 / 638 (7603); FA 0% | 170.7 / 149 / 302 (3795); FA 0% | 75.5 / 66 / 134 (1885); FA 0% |
| CUSUM mix, A = 1000 | 355.0 / 309 / 682 (7469); FA 0% | 167.1 / 145 / 326 (3714); FA 0% | 73.9 / 64 / 144 (1848); FA 0% |
| SR mix, A = 1000 | 129.1 / 105 / 260 (2718); FA 1% | 60.7 / 49 / 123 (1349); FA 2% | 27.0 / 22 / 55 (672); FA 4% |
| SR mix, A = 300 | 72.9 / 57 / 152 (1535); FA 7% | 34.1 / 26 / 72 (758); FA 17% | 15.2 / 12 / 33 (377); FA 32% |
| SR mix, A = 100 | 37.9 / 29 / 82 (799); FA 39% | 17.9 / 13 / 40 (395); FA 68% | 7.9 / 6 / 17 (196); FA 91% |
| e-process, no restart | 486.1 / 444 / 801 (10232); FA 0% | 330.4 / 310 / 512 (7335); FA 0% | 235.3 / 226 / 341 (5879); FA 0% |

Drop to 0.90:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 66.9 / 59 / 127 (703); FA 49% | 31.9 / 28 / 61 (353); FA 56% | 14.3 / 12 / 28 (177); FA 69% |
| CUSUM mix, A = 100 | 96.9 / 79 / 197 (1018); FA 1% | 46.8 / 38 / 94 (519); FA 1% | 20.4 / 16 / 42 (253); FA 2% |
| CUSUM e1 = 0.05, A = 1000 | 202.9 / 189 / 322 (2134); FA 0% | 96.9 / 90 / 155 (1077); FA 0% | 42.9 / 40 / 69 (535); FA 0% |
| CUSUM mix, A = 1000 | 151.0 / 129 / 284 (1588); FA 0% | 72.3 / 62 / 135 (804); FA 0% | 32.0 / 27 / 61 (399); FA 0% |
| SR mix, A = 1000 | 82.0 / 68 / 161 (862); FA 1% | 39.5 / 33 / 78 (439); FA 2% | 17.2 / 14 / 34 (213); FA 5% |
| SR mix, A = 300 | 54.4 / 44 / 111 (572); FA 8% | 26.1 / 21 / 53 (290); FA 17% | 11.4 / 9 / 24 (141); FA 33% |
| SR mix, A = 100 | 34.1 / 27 / 72 (357); FA 39% | 16.0 / 13 / 34 (177); FA 67% | 7.1 / 5 / 15 (88); FA 91% |
| e-process, no restart | 288.2 / 275 / 439 (3033); FA 0% | 196.9 / 190 / 284 (2187); FA 0% | 140.6 / 138 / 192 (1755); FA 0% |

Drop to 0.80:

| detector | r = 0.05 | r = 0.1 | r = 0.2 |
| --- | --- | --- | --- |
| current rule | 65.7 / 58 / 123 (344); FA 49% | 30.5 / 27 / 58 (169); FA 56% | 13.5 / 12 / 26 (83); FA 69% |
| CUSUM mix, A = 100 | 71.0 / 61 / 135 (372); FA 1% | 33.9 / 29 / 65 (187); FA 1% | 15.0 / 13 / 29 (92); FA 2% |
| CUSUM e1 = 0.05, A = 1000 | 167.9 / 160 / 255 (882); FA 0% | 80.2 / 76 / 124 (444); FA 0% | 35.5 / 34 / 55 (221); FA 0% |
| CUSUM mix, A = 1000 | 102.4 / 91 / 180 (537); FA 0% | 49.1 / 43 / 87 (271); FA 0% | 21.7 / 19 / 39 (134); FA 0% |
| SR mix, A = 1000 | 66.3 / 57 / 125 (347); FA 1% | 31.3 / 27 / 60 (173); FA 2% | 13.9 / 12 / 27 (86); FA 5% |
| SR mix, A = 300 | 48.3 / 40 / 96 (253); FA 7% | 22.7 / 19 / 45 (125); FA 17% | 10.0 / 8 / 21 (62); FA 33% |
| SR mix, A = 100 | 33.9 / 27 / 71 (177); FA 39% | 16.1 / 13 / 34 (89); FA 67% | 7.1 / 5 / 16 (44); FA 91% |
| e-process, no restart | 238.8 / 229 / 354 (1255); FA 0% | 164.5 / 160 / 233 (912); FA 0% | 117.0 / 115 / 157 (729); FA 0% |

**4.2d, the fewest consecutive wrong audits that can demote** from a fresh phase:

| detector | wrong audits |
| --- | --- |
| current rule | 30 audits, whatever their outcome, before any demotion |
| SR mixture at A = 100 | 3 |
| CUSUM mixture at A = 100 | 3 |
| SR mixture at A = 300 or 1000 | 4 |
| CUSUM mixture at A = 1000 | 4 |
| CUSUM against e1 = 0.05 at A = 1000 | 8 |
| non-restarting e-process | 2 |

Reading 4.2:

- **The current rule is fast on mild drift only because it has no false-alarm control.** At r = 0.1 it demotes 68% of healthy gates within 10,000 acts, and had already demoted 56% before a change at act 5,000.
- **The SR mixture at A = 1000** cuts that to 4.3% (2% before the late change). It beats the current rule on severe drops (39.6 against 53.9 wrong acts at 0.80) and loses on mild ones (71.4 against 16.4 at 0.95).
- **A history of health costs it nothing.** A late drop to 0.90 is caught after 39.5 wrong acts, against 47.6 for a drop at act 0.
- **The non-restarting e-process gets slower the longer the gate has been healthy:** 330 wrong acts against 106.
- **To match the current rule's speed on mild drift, raise r.** The SR mixture at r = 0.2 lets 31.6 wrong acts through at 0.95, with 8.5% false demotions of healthy gates within 10,000 acts.

### 4.3 Clustering

Sessions of 10 contiguous acts. A session's error rate is Beta-distributed with mean 1 − p and ICC rho: Beta(e k, (1 − e) k) with k = (1 − rho)/rho, and a fixed rate at rho = 0. Each run generates 600 sessions. Methods:

- the fixed 149/0 plan on all acts, on the first 3 per session, and on the first per session
- the log-grid mixture (no futility, cap 600 acts) on all acts and on the first 3 per session
- session-mean betting with an ALPHA plug-in: `eta_j = min(0.9995, max(0.98 + 0.02/sqrt(20 + j), (20 × 0.995 + sum X)/(20 + j)))`, cap 600 sessions

10,000 runs per cell. Cells are P(promote), with the median acts or sessions at promotion where given.

| p | ICC | fixed, no cap | fixed, ≤3 per session | fixed, 1 per session | mixture, no cap | mixture, ≤3 per session | session mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.98 | 0 | 4.4% | 4.9% | 4.8% | 3.3% (179 acts) | 3.6% (179 acts) | 0.0% |
| 0.98 | 0.05 | 8.9% | 5.4% | 5.0% | 7.7% (179) | 4.5% (179) | 0.0% |
| 0.98 | 0.2 | 20.3% | 8.6% | 4.5% | 20.9% (179) | 7.3% (179) | 0.1% (469 sessions) |
| 0.995 | 0 | 47.2% | 47.3% | 47.7% | 79.3% (179) | 79.3% (179) | 100.0% (266 sessions) |
| 0.995 | 0.05 | 54.3% | 48.5% | 47.1% | 80.8% (179) | 80.3% (179) | 100.0% (265) |
| 0.995 | 0.2 | 67.0% | 53.4% | 45.9% | 84.2% (179) | 79.9% (179) | 99.2% (265) |

The rows at 0.995 show that clustering also inflates the apparent power of the invalid methods. One act per session is exact for the fixed plan. The 4.4% at ICC 0 sits 2.4 standard errors from the exact 4.93%: noise.

### 4.4 Late labels

Acts at times 0 to 599 at p = 0.98. A label arrives after an exponential delay whose mean is d_right for right acts and d_wrong for wrong ones. The log-grid mixture with cap 600 is computed either on labels in arrival order or on the ledger-order sequence, as section 3.1 prescribes. 10,000 runs per row. P(promote):

| mean delay, right / wrong | arrival order | ledger-order prefix |
| --- | --- | --- |
| 20 / 20 | 3.8% | 3.8% |
| 20 / 200 | 29.4% | 3.8% |
| 20 / 1,000 | 90.3% | 3.7% |

The exact ledger-order figure is 3.785% (table 4.1b, cap 600).

### 4.5 Verdict-dependent audits

Two strata: near the bar (30% of acts) and high confidence (70%). Mean audit rate 0.1 in both designs:

- uniform audits at 0.1
- stratified audits at 0.2167 near the bar and 0.05 elsewhere

Error rates by world, near / high:

| world | near the bar | high confidence | overall accuracy |
| --- | --- | --- | --- |
| healthy | 0.025 | 0.0036 | 0.9900 |
| at the promise, errors near the bar | 0.05 | 0.00714 | 0.9800 |
| near-bar drift | 0.20 | 0.0036 | 0.9375 |
| uniform drift | 0.05 | 0.05 | 0.95 |

Detectors:

- the Bernoulli SR mixture of 3.8 on audits only, alarm at 1,000 audits
- the inverse-probability-weighted SR mixture of 3.9 on every act, lambda in {1, 2.5, 5, 10, 20}, alarm at 10,000 acts

5,000 runs per cell.

| design and detector | healthy: P(alarm in 10,000 acts) | at promise, near-bar errors: P(alarm in 10,000) | near-bar drift: wrong acts executed (mean / median / p90) | uniform drift: wrong acts executed |
| --- | --- | --- | --- | --- |
| uniform, Bernoulli on audits | 4.4% | 45.4% | 60.9 / 51 / 117 | 71.4 / 59 / 138 |
| uniform, weighted per act | 6.9% | 30.7% | 92.9 / 65 / 209 | 129.1 / 93 / 291 |
| stratified, weighted per act | 4.7% | 28.2% | 39.3 / 31 / 80 | 163.4 / 114 / 370 |
| stratified, unweighted (invalid) | 31.7% | 98.1% | 18.3 / 16 / 33 | 70.6 / 60 / 136 |

A first pass (`ipw.ts`, 5,000 runs, seeds 51000 to 51015) used a bet grid up to lambda = 40, a high-confidence audit rate of 0.0357, and an alarm at 1,000 acts, which is far looser than 1,000 audits. It gave 30.4% (uniform) and 72.6% (stratified) false alarms on the healthy gate within 10,000 acts. That calibration error is the pitfall noted in 3.9: an act-level detector's A is counted in acts.

### 4.6 Label-free tripwire

The conformal SR mixture of 3.10 at A = 20,000 asks. Pre-change confidences are Beta(8, 1.2) rounded to 0.01. 1,000 runs per row.

| stream | result |
| --- | --- |
| exchangeable | P(alarm within 20,000 asks) 20.1% |
| change at ask 5,000 to Beta(6, 1.2) | asks to alarm: mean 363, median 196; undetected within 20,000: 0.1%; alarm before the change: 5.6% |
| change to Beta(4, 1.2) | mean 26, median 23; undetected 0.0%; alarm before the change: 7.5% |
| change to Beta(8, 2) | mean 65, median 58; undetected 0.0%; alarm before the change: 6.0% |

### 4.7 Negative result: escalating audits on a sensitive alarm

The design tested: a sensitive detector only triples the audit rate for the rest of the phase, while the SR mixture at A = 1000 decides demotion. 10,000 runs per cell. The audit coin stays independent of correctness, so the demotion detector's guarantee holds.

- **CUSUM mixture at A = 100 as the early warning.** It almost never fired before the demotion detector: the audit rate was raised in 0.0% of healthy runs. Wrong acts executed at r = 0.1 were 69.6, 45.8 and 35.7 for drops to 0.95, 0.90 and 0.80, essentially the plain detector's numbers.
- **SR mixture at A = 100 as the early warning.** It raised the rate in 67.5%, 90.5% and 99.1% of healthy runs within 10,000 acts (r = 0.05, 0.1, 0.2). It demoted healthy gates within 10,000 acts in 3.9%, 10.1% and 21.7% of runs. At r = 0.1 it cut wrong acts executed to 37.3, 30.4 and 28.5.

That is mostly a permanently higher audit budget, not a smarter detector. The early warning is not recommended. If more audits are wanted, raise r.

## 5. Pitfalls and assumptions

1. **The guarantees hold under a conditional null, in the consumed order.** For promotion: each act's chance of being right, given every earlier act in the sequence, is at most p0. For demotion before a change: each audited act's chance of being wrong, given every earlier audit, is at most e0. Independence is not required; this condition is. Session correlation breaks it (4.3). No test can detect that its own unit is too fine.
2. **Bets and stopping rules may use only the consumed prefix,** never the current act's label or later labels. Only thresholding at 1/alpha (or at A) is covered. Reporting E at a calendar time chosen with other information, or averaging e-values across gates evaluated in different orders, is not (Choe and Ramdas).
3. **Promotion alternatives must lie above p0.** Use Ville's 1/alpha, not Wald's approximate boundaries. Mixtures are valid, maxima are not.
4. **Never restart an e-process of one identity.** Restarts, re-promotion after demotion and plan changes over the same rows are new attempts. Many configurations tried on one gate multiply the false-promotion bound unless alpha is spent (3.6). The fixed plan has the same gap today.
5. **Labels are assumed correct, blind, and from trusted sources.** Label error is outside every guarantee here. For promotion, unread labels count as wrong. Never consume labels in arrival order (4.4).
6. **A promotion certifies the stretch it saw,** and only under the conditional null. Later drift is the detector's job.
7. **Units matter for the demotion guarantee.** The ARL is in audits for the audits-only detector and in acts for the weighted one. n/A becomes vacuous as n approaches A. A gate exactly at its promise is demoted within 10,000 acts in 24% to 73% of runs by the SR mixture at A = 1000 (4.2a). That is the guarantee working, not a defect.
8. **The audit coin must be independent of correctness** given what was logged, with pi > 0 on every act. Log the pi actually used. Do not let lambda depend on the current act's stratum for an overall null. Weighted detectors pay in variance.
9. **Demotion detection waits for labels.** Label latency adds wrong acts executed. A missing audit label must not be imputed as an error inside the detector; use a separate overdue alarm.
10. **The information floor (2.2) means the promise must sit well below the gate's true accuracy** for promotion to be practical.
11. **The conformal tripwire fires on benign non-stationarity** (time of day, user mix), needs smoothed p-values for tied confidences, and cannot see calibration drift. It may only raise caution and must never feed model-visible state.
12. **Numerics.** Keep everything in log space with logsumexp. The SR recursion grows without bound in log terms and is safe with log1p. Counts-only formulas avoid accumulating rounding over long paths.
13. **Checkpoints.** The checkpoint must not be the source of truth for the attempt's origin, its crossing or its attempt index. All three are derived from the ledger. A checkpoint is only a cache, as today's ledger re-verification already assumes.

## 6. Open questions, and confidence in each recommendation

**Open questions:**

- **How strongly do acts within a session share errors in the pilot?** The intra-class correlation decides between act-level and one-per-session promotion. Estimate it from labelled shadow rows at the session, user and repository levels.
- **Is a 98% promise realistic for the pilot's gates?** The floor says a 99% gate needs about a thousand labels. A lower promise, or a gate with a higher bar and less coverage, may be the practical path.
- **What A and audit rate r?** These are cost choices. Price a false demotion (a new acceptance run of a few hundred labels) against a wrong act executed.
- **Should re-promotion require a new evidence version (option A) or spend alpha (option B)?**
- **Is a per-band promise wanted near the bar?** It would make verdict-dependent audits cleaner (3.9).
- **How do label latencies in the pilot compare with audit intervals?** If labels take longer than the detector's D/r acts, latency dominates the wrong acts executed.

**Confidence:**

| recommendation | confidence | why |
| --- | --- | --- |
| Zero-error plan is anytime-valid; curtail fixed plans; drop sealing for maxErrors = 0 | High | Exact derivation and dynamic programming |
| Ledger-order prefix with unlabelled acts counted as wrong | High | Monotonicity argument; simulation 4.4 |
| One act per group, or group means, when sessions share errors | High on validity; medium on whether the label cost is acceptable | 4.3 |
| SR mixture e-detector for demotion with an explicit A | High on validity; medium on the defaults (A = 1000, shifts {2, 4, 8}) | Shin et al.; 4.2 |
| Replace the planned sample with the log-grid mixture e-process, reverse test and cap | Medium | Valid and simpler to verify, but the gain is in adaptivity and operations, not power at an equal maximum budget (4.1) |
| Spending alpha across attempts | Medium | Correct, costs about 30 clean acts at the first attempt; whether the family-wide guarantee is wanted is a product decision |
| Verdict-dependent audits with weights | Medium-low | Valid, but help only for drift where audits concentrate (4.5) |
| Conformal tripwire raising the audit rate | Medium-low | Valid under exchangeability, but real traffic is rarely exchangeable and it cannot see calibration drift |
| Escalating audits on a sensitive alarm | Not recommended | 4.7 |

## Sources

- Bibaut, A., Kallus, N. and Lindon, M. (2022, revised 2024). Near-optimal non-parametric sequential tests and confidence sequences with possibly dependent observations. arXiv:2212.14411. https://arxiv.org/abs/2212.14411 [verified: abstract via search summary]
- Choe, Y. J. and Ramdas, A. (2024, revised 2026). Combining evidence across filtrations. arXiv:2402.09698; accepted at JRSS-B. https://arxiv.org/abs/2402.09698 [verified]
- Darling, D. A. and Robbins, H. (1967). Confidence sequences for mean, variance, and median. *PNAS* 58(1), 66-68. https://doi.org/10.1073/pnas.58.1.66 [verified: citation and DOI; content memory]
- Fedorova, V., Gammerman, A., Nouretdinov, I. and Vovk, V. (2012). Plug-in martingales for testing exchangeability on-line. ICML 2012. https://arxiv.org/abs/1204.3251 [verified]
- Horvitz, D. G. and Thompson, D. J. (1952). A generalization of sampling without replacement from a finite universe. *JASA* 47, 663-685. [memory; no URL checked]
- Howard, S. R., Ramdas, A., McAuliffe, J. and Sekhon, J. (2020). Time-uniform Chernoff bounds via nonnegative supermartingales. *Probability Surveys* 17, 257-317. https://arxiv.org/abs/1808.03204 [verified]
- Howard, S. R., Ramdas, A., McAuliffe, J. and Sekhon, J. (2021). Time-uniform, nonparametric, nonasymptotic confidence sequences. *Annals of Statistics* 49(2), 1055-1080. https://arxiv.org/abs/1810.08240 [verified]
- Lindeman, M., Stark, P. B. and Yates, V. S. (2012). BRAVO: ballot-polling risk-limiting audits to verify outcomes. EVT/WOTE 2012. https://www.stat.berkeley.edu/~stark/Preprints/bpa2pp.pdf [verified: bibliographic record, and the method as described in ALPHA; the PDF itself could not be parsed]
- Lindon, M. and Kallus, N. (2026). Design-based anytime-valid inference for randomized experiments with delayed outcomes and staggered entry. arXiv:2603.25971. https://arxiv.org/abs/2603.25971 [verified]
- Lorden, G. (1971). Procedures for reacting to a change in distribution. *Annals of Mathematical Statistics* 42(6), 1897-1908. https://doi.org/10.1214/aoms/1177693055 [verified: citation; content memory]
- Moustakides, G. V. (1986). Optimal stopping times for detecting changes in distributions. *Annals of Statistics* 14(4). https://doi.org/10.1214/aos/1176350164 [verified: title via DOI; content memory]
- Ottoboni, K., Bernhard, M., Halderman, J. A., Rivest, R. L. and Stark, P. B. (2019). Bernoulli ballot polling: a manifest improvement for risk-limiting audits. Voting'19. https://arxiv.org/abs/1812.06361 [verified]
- Page, E. S. (1954). Continuous inspection schemes. *Biometrika* 41(1-2), 100-115. https://doi.org/10.1093/biomet/41.1-2.100 [verified: citation; content memory]
- Pollak, M. (1985). Optimal detection of a change in distribution. *Annals of Statistics* 13(1). https://doi.org/10.1214/aos/1176346587 [verified: title via DOI; content memory]
- Ramdas, A., Grünwald, P., Vovk, V. and Shafer, G. (2022, revised 2023). Game-theoretic statistics and safe anytime-valid inference. arXiv:2210.01948; published in *Statistical Science* 2023 [memory for the venue]. https://arxiv.org/abs/2210.01948 [verified]
- Reynolds, M. R. Jr. and Stoumbos, Z. G. (1999). A CUSUM chart for monitoring a proportion when inspecting continuously. *Journal of Quality Technology* 31(1), 87-108. https://doi.org/10.1080/00224065.1999.11979900 [verified: citation and abstract-level summary]
- Robbins, H. (1970). Statistical methods related to the law of the iterated logarithm. *Annals of Mathematical Statistics* 41(5), 1397-1409. https://doi.org/10.1214/aoms/1177696786 [verified: citation; content memory]
- Roberts, S. W. (1966). A comparison of some control chart procedures. *Technometrics* 8, 411-430. [memory; no URL checked]
- Shafer, G. (2021). Testing by betting: a strategy for statistical and scientific communication. *JRSS-A* 184(2), 407-431. https://doi.org/10.1111/rssa.12647 [verified: citation and abstract-level summary]
- Shin, J., Ramdas, A. and Rinaldo, A. (2022, revised 2023). E-detectors: a nonparametric framework for sequential change detection. arXiv:2203.03532. https://arxiv.org/abs/2203.03532 [verified: Definitions 2.2, 2.6, 2.11 and 2.12, Theorem 2.4, Proposition 2.3, Remarks 2.7 and 3.1 read]
- Shiryaev, A. N. (1963). On optimum methods in quickest detection problems. *Theory of Probability and Its Applications* 8, 22-46. [memory; no URL checked]
- Stark, P. B. (2009). Risk-limiting postelection audits: conservative P-values from common probability inequalities. *IEEE Transactions on Information Forensics and Security* 4(4). https://www.stat.berkeley.edu/~stark/Preprints/pvalues09.pdf [verified: citation and abstract via search; derivations not read]
- Stark, P. B. (2020). Sets of half-average nulls generate risk-limiting audits: SHANGRLA. arXiv:1911.10035. https://arxiv.org/abs/1911.10035 [verified]
- Stark, P. B. (2022). ALPHA: audit that learns from previously hand-audited ballots. arXiv:2201.02707; published in *Annals of Applied Statistics* 2023 [memory for the venue]. https://arxiv.org/abs/2201.02707 [verified, including the BRAVO description, the test supermartingale, the choice of eta_j, Bernoulli sampling and sampling weights]
- Ville, J. (1939). *Étude critique de la notion de collectif*. Gauthier-Villars. [memory; no URL checked]
- Vovk, V. (2021). Testing randomness online. *Statistical Science* 36(4), 595-611. https://arxiv.org/abs/1906.09256 [verified]
- Vovk, V., Nouretdinov, I. and Gammerman, A. (2003). Testing exchangeability on-line. ICML 2003. [memory; a bibliographic listing was seen, the paper was not read; no URL checked]
- Vovk, V., Petej, I., Nouretdinov, I., Ahlberg, E., Carlsson, L. and Gammerman, A. (2021). Retrain or not retrain: conformal test martingales for change-point detection. arXiv:2102.10439. https://arxiv.org/abs/2102.10439 [verified]
- Wald, A. (1945). Sequential tests of statistical hypotheses. *Annals of Mathematical Statistics* 16(2), 117-186. https://doi.org/10.1214/aoms/1177731118 [verified: citation; content memory, including the expected-sample-size bound used in 2.2]
- Waudby-Smith, I. and Ramdas, A. (2024). Estimating means of bounded random variables by betting. *JRSS-B* (discussion paper). https://arxiv.org/abs/2010.09686 [verified]
- Waudby-Smith, I., Stark, P. B. and Ramdas, A. (2021). RiLACS: risk-limiting audits via confidence sequences. E-Vote-ID 2021, 124-139. https://arxiv.org/abs/2107.11323 [verified]
- Waudby-Smith, I., Wu, L., Ramdas, A., Karampatziakis, N. and Mineiro, P. (2022, revised 2024). Anytime-valid off-policy inference for contextual bandits. arXiv:2210.10768. https://arxiv.org/abs/2210.10768 [verified]

The numbers in this note were computed by seeded scripts in a session scratch folder that is not part of the repository; tables that back shipped code are to be reproduced under `sim/`.
