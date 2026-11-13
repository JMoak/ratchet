# Risk-controlled act bars: finite-sample guarantees under grouped data and shift

*Research note, 2026-11-12. Foundations review: how a gate's act bar should be fitted, reported and lent, with simulations. Docs only; URLs are in the sources at the end.*

A gate's reported act bar is today the lowest bar at which the lower end of a 95% Wilson interval on the precision of acting, over the unselected labelled rows at or above it, reaches the promise (`fitThreshold` with `conservative: true`, read by `fitActBar` in `src/ledger/bars.ts`). A profile lends a cold gate the lowest bin edge at which every donor gate with 30 tail rows clears the target the same way (`cautiousBar` in `src/ledger/profile-bins.ts`). Only the planned exact acceptance test promotes. That test caught both measured failures. A point-estimate bar fitted at 98% on 180 items delivered 91.2% on held-out template groups of the same families (e2e T1). The conservative bar frozen from 180 fit rows acted at 92.9% (exact lower bound 88.0%) on 241 fresh tool calls, and every wrong act was one semantic class: commands that switch a check off.

This note asks six questions. Is the Wilson scan valid given the search over thresholds? What do grouped data do to it? Which calibration maps work at 50 to 500 labels? What can a novelty gate guarantee? How should evidence be read under covariate shift? What calibration property does a cost-derived bar need?

The short answers:

- The scan is not covered by any multiple-testing argument. With independent rows it nonetheless held its nominal level in simulation.
- Its real defects are two. It treats grouped rows as independent, which broke the promise 7% to 18% of the time in simulation. And a bar that appears only at the edge of statistical power is usually wrong.
- An exact fixed-sequence fit with groups as the unit fixes both, at a cost in coverage.
- A pooled bar promises nothing about a new family of requests. Even the exactly right pooled bar failed on 21% to 35% of new families.
- A precision promise equal to the cost ratio a/(a+b) earns exactly nothing over reviewing everything.

Citation tags. **[v]**: I fetched the paper's text or abstract on 2026-11-12. **[s]**: I read the abstract in a web search listing on 2026-11-12 but did not fetch the paper. **[m]**: from memory, not re-checked this session; verify before relying on a detail.

## The simulation models

All numbers in this note come from seeded scripts. The random generator is mulberry32 with Box-Muller normals and Knuth's Poisson sampler. Each script consumes one stream in table order, so reproducing a cell means running the cells before it in the same order. Delivered precision and coverage are computed analytically from the population model at the fitted bar. No test sample enters except where a row says so.

**Model I (independent rows; Q1, Q3 model A, Q6).**

- Each row has a label Y ~ Bernoulli(0.6), with 1 meaning acting was right. T1's fit split was 60.6% approvals.
- The latent score is z | Y=1 ~ N(2.326, 1) and z | Y=0 ~ N(0, 1). AUC = Φ(2.326/√2) = 0.950.
- The stated act-side probability is s = 1/(1 + e^-(z-0.5)). Its leading answer (s ≥ 0.5) is right on 85.6% of rows. It is underconfident at the top, as Jev was on T1 (ECE 0.129 there).
- The true probability that acting is right is η(z) = sigmoid(ln(0.6/0.4) + 2.326z - 2.326²/2).
- Population quantities at a bar t on z:
  - right acts A(t) = 0.6·Φ̄(t - 2.326);
  - wrong acts W(t) = 0.4·Φ̄(t);
  - precision A/(A+W); coverage A+W.
- The oracle bar meets the promise exactly.
  - 95%: z = 1.539, s = 0.739, coverage 49.5% of rows (78.4% of approvals).
  - 98%: z = 2.094, s = 0.831, coverage 36.2% of rows (59.2% of approvals).
- Every bar-fitting procedure compared here is rank-based, so the s mapping matters only for where the probability grid falls.

**Model IIa (template or session clusters; Q2).**

- Rows come in groups of size 1 + Poisson(m̄ - 1), truncated to the rows left.
- A group shares one label Y_g ~ Bernoulli(0.6) and one offset u_g ~ N(0, ρ).
- A row's score is z = 2.326·Y_g + u_g + e, with e ~ N(0, 1 - ρ).
- Marginally this is model I. Groups are independent of each other, and ρ is the within-group score correlation (ICC).

**Model IIb (families of requests; Q2).**

- F families split the rows equally. Family f draws a denial shift b_f ~ N(0, τ²): in some families the denials look routine.
- Within a family, rows come in templates as in IIa, with mean size 3 and ρ = 0.5.
- Approval rows score 2.326 + u + e. Denial rows score b_f + u + e.
- Population precision integrates over families: W(t) = 0.4·Φ̄(t/√(1+τ²)).
- Precision on held-out templates of the calibration families uses the drawn b_f.
- A new family with shift b fails at bar t when 0.4·Φ̄(t - b) exceeds A(t)(1-T)/(0.6T). The chance of that has a closed form, Φ̄((t - Φ̄⁻¹(q))/τ) with q = A(t)(1-T)/(0.6T).

**Model III (Q3 model B, misspecified for Platt).**

- Approval z ~ N(2.8, 0.8²); denial z ~ N(0, 1.5²); AUC 0.95; same s mapping.
- The true log-odds are quadratic in z, so no logistic map in logit(s) is exact.

## 1. Multiplicity: is "scan, keep the lowest bar that clears" valid?

### What the literature offers

**Learn then Test** (Angelopoulos, Bates, Candès, Jordan, Lei, 2021) [v] treats risk control as multiple hypothesis testing.

- Each candidate bar λ carries the null hypothesis H_λ: risk(λ) > α.
- A procedure that controls the family-wise error rate at δ makes every bar it accepts valid at once.
- Fixed-sequence testing (Bauer, 1991) [m] does this for any order fixed before the data. Test in that order, accept while the p-value is at most δ, stop at the first failure. It needs no monotonicity. The proof is the first-null argument: an error requires accepting the first null in the order, which happens with probability at most δ. [m for the algorithm's detail; v for the framing]
- For a 0/1 loss, the exact binomial p-value P(Bin(n_λ, α) ≤ k_λ) is valid given the count n_λ above the bar. Here k_λ is the number of wrong acts above the bar.

**Trust or Escalate** (Jung, Brahman, Choi, ICLR 2025) [v] applies this recipe to LLM judges.

- At each λ it computes the exact binomial upper bound on the risk of disagreeing with humans among items with confidence ≥ λ.
- It tests by fixed sequence from λ = 0.999 downward and takes λ̂ = inf{λ : bound(λ′) ≤ α for every λ′ ≥ λ}.
- Guarantee: P(judge agrees with human | confidence ≥ λ̂) ≥ 1 - α, with probability ≥ 1 - δ over the calibration set.
- Calibration sets of 500 items (TL;DR, Chatbot Arena) and 392 (Auto-J); δ = 0.1 on TL;DR.
- It assumes an iid calibration set. Distribution shift is tested only empirically. Cascades split δ across judges.

**Selection with guaranteed risk** (SGR; Geifman and El-Yaniv, 2017) [v, full text] binary-searches the sorted confidences for ⌈log₂ m⌉ steps. Each step uses the exact binomial tail inversion B*(r̂, δ/⌈log₂ m⌉, n), the tightest bound in that setting, and a union bound covers every step.

**Conformal risk control** (Angelopoulos, Bates, Fisch, Lei, Schuster, ICLR 2024) [v] bounds the expectation of a per-item loss that is monotone in λ.

- Act precision is a ratio, not the average of a per-item loss.
- The monotone per-item loss that exists here is 1{s ≥ λ and acting wrong}. Its average is wrong acts per decision, which is not the promise.

**Conformal selection** (Jin and Candès, JMLR 2023) [s] runs Benjamini-Hochberg on conformal p-values.

- It controls the false discovery rate (FDR), which is one minus precision, in expectation, in finite samples, under exchangeability.
- Conformal Alignment (Gui, Jin, Ren, NeurIPS 2024) [s] applies it to deciding which foundation-model outputs to trust.
- SCOPE (Badshah, Emami, Sajjad, 2026) [v abstract] gives pairwise LLM judging the same kind of guarantee: error among non-abstained judgments at most α under exchangeability.
- All three bound an expectation over calibration draws, not the probability of a bad draw.

**"Judge, Retrieve, or Abstain"** (Badshah, Emami, Sajjad, COLM 2026) [v] is a 2026 paper with exactly the gap asked about.

- It computes a Clopper-Pearson upper bound for every pair of thresholds.
- Its main method keeps the pair with the largest coverage among those that pass, with no correction for the search.
- Its lemma covers a fixed pair only. A Bonferroni-corrected variant appears only as a conservative alternative.

**Probably Approximately Correct Labels** (Candès, Ilyas, Zrnic, ICML 2026) [v] makes the monotone version precise.

- When the loss is monotone in the threshold and you stop at the first crossing from the safe end, bounds that hold one threshold at a time suffice. No simultaneous correction is needed.
- They use betting confidence intervals (Waudby-Smith and Ramdas [m]).
- Their loss is averaged over all items, so it starts at zero at the safe end. Precision does not.
- So a precision sequence cannot start at the very top, where a handful of rows can never pass. It has to start where a zero-error tail could pass, and that start must not depend on labels.

**Where today's procedure stands.**

- Today's scan accepts the lowest passing bar even when bars above it failed. That is neither fixed-sequence nor Bonferroni, so no family-wise argument covers it.
- `gateBar` and `cautiousBar` in `profile-bins.ts` have the same shape.
- Wilson's z = 1.96 makes each test one-sided at 97.5%. A tail with zero errors then needs n/(n + 3.84) ≥ T: 73 rows for 95% and 189 for 98%. The exact one-sided 97.5% bound needs 72 and 183.

### What the simulation shows

Procedures compared (script `q1.ts`):

1. **Point scan**: the lowest distinct score whose tail has at least 30 rows and empirical precision ≥ T. This is today's point bar.
2. **Wilson scan**: the same with the engine's Wilson lower bound (z 1.96). This is today's conservative bar.
3. **Wilson fixed sequence**: the same Wilson test on the 99-edge grid s = 0.99, 0.98, ..., 0.01. Start at the first edge whose tail has at least max(30, ⌈T·1.96²/(1-T)⌉) rows and stop at the first failure.
4. **Learn then Test fixed sequence** at δ = 0.05 and at δ = 0.025, on the same 99 edges. Exact binomial p-value; start rule as in the recommended design below.
5. **The same at δ = 0.05 on a 19-edge grid**: s = 0.95, 0.90, ..., 0.05.
6. **Exact scan, lowest passing**: an exact binomial test at δ = 0.05 on every distinct score with at least 30 rows, with no correction.
7. **Bonferroni**: an exact test at δ/99 on the 99 edges, lowest passing.
8. **SGR** at δ = 0.05, keeping the lowest tested threshold that passed.
9. **Conformal selection (BH)** at FDR level 1 - T. Each repetition applies it to a fresh test batch of 1,000 rows. Precision is evaluated at the lowest selected score; the batch's own realized precision is also recorded.

Table 1 reports, for each cell, P(delivered precision < promise) / P(a bar is found) / coverage when found, as a percentage of the oracle's coverage. Violations are counted over all repetitions; a draw with no bar cannot violate. Settings: seed 20261112, model I, 4,000 repetitions per cell (2,000 at n = 2,000), cells run in the order shown.

| procedure | 50, 95% | 50, 98% | 180, 95% | 180, 98% | 500, 95% | 500, 98% | 2000, 95% | 2000, 98% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| point scan (today's point bar) | 19.1 / 20.8 / 117 | 5.6 / 5.6 / 153 | 52.0 / 99.9 / 99 | 60.6 / 94.7 / 107 | 51.4 / 100.0 / 100 | 54.7 / 99.9 / 101 | 49.8 / 100.0 / 100 | 54.9 / 100.0 / 100 |
| Wilson scan, lowest passing (today's conservative bar) | no bar | no bar | 1.2 / 14.1 / 86 | no bar | 1.7 / 93.1 / 74 | 1.5 / 1.7 / 106 | 1.9 / 100.0 / 90 | 2.1 / 90.8 / 71 |
| Wilson, fixed sequence, 99 edges | no bar | no bar | 0.9 / 12.0 / 87 | no bar | 0.6 / 72.0 / 62 | 1.1 / 1.1 / 106 | 0.7 / 93.7 / 88 | 1.0 / 63.0 / 59 |
| Learn then Test fixed sequence, exact, δ 0.05, 99 edges | no bar | no bar | 1.2 / 35.5 / 78 | no bar | 1.5 / 81.3 / 66 | 2.5 / 11.5 / 91 | 1.4 / 97.3 / 90 | 2.1 / 76.4 / 61 |
| Learn then Test fixed sequence, exact, δ 0.025, 99 edges | no bar | no bar | 0.9 / 13.6 / 87 | no bar | 0.6 / 72.9 / 61 | 1.6 / 1.9 / 104 | 0.6 / 93.7 / 88 | 1.0 / 63.6 / 59 |
| Learn then Test fixed sequence, exact, δ 0.05, 19 edges | no bar | no bar | 0.4 / 25.4 / 76 | no bar | 0.2 / 83.6 / 70 | 0.2 / 6.9 / 91 | 0.0 / 100.0 / 84 | 0.0 / 77.3 / 58 |
| exact scan, lowest passing, δ 0.05 | no bar | no bar | 2.9 / 39.3 / 79 | no bar | 3.3 / 98.0 / 78 | 2.6 / 14.3 / 91 | 3.6 / 100.0 / 91 | 4.0 / 97.2 / 75 |
| Bonferroni over 99 edges, δ 0.05 | no bar | no bar | no bar | no bar | 0.0 / 13.5 / 70 | no bar | 0.0 / 99.9 / 78 | 0.0 / 13.3 / 64 |
| SGR, δ 0.05 | no bar | no bar | no bar | no bar | 0.3 / 31.7 / 71 | no bar | 0.4 / 100.0 / 85 | 0.3 / 19.4 / 78 |
| conformal selection (BH), batch of 1,000 | 27.1 / 60.6 / 100 | no bar | 35.3 / 99.4 / 93 | 27.1 / 59.2 / 100 | 42.1 / 100.0 / 97 | 34.1 / 97.2 / 90 | 42.9 / 100.0 / 99 | 45.0 / 100.0 / 98 |

For conformal selection, the share of repetitions whose own batch fell below the promise was close to the population figure: 28.4%, 37.2%, 29.5%, 42.9%, 36.6%, 44.8% and 46.3% for the seven cells with a bar.

Table 1b reports, from the same runs, P(delivered < promise | a bar was found), with the median delivered precision in brackets. "-" means no bar was found.

| procedure | 50, 95% | 50, 98% | 180, 95% | 180, 98% | 500, 95% | 500, 98% | 2000, 95% | 2000, 98% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| point scan (today's point bar) | 91.8 (91.1) | 100.0 (92.2) | 52.1 (94.9) | 64.0 (97.6) | 51.4 (95.0) | 54.7 (97.9) | 49.8 (95.0) | 54.9 (97.9) |
| Wilson scan, lowest passing (today's conservative bar) | - | - | 8.7 (96.9) | - | 1.8 (97.8) | 85.3 (97.7) | 1.9 (96.4) | 2.3 (99.0) |
| Wilson, fixed sequence, 99 edges | - | - | 7.9 (96.8) | - | 0.8 (98.7) | 91.3 (97.7) | 0.7 (96.5) | 1.6 (99.3) |
| Learn then Test fixed sequence, exact, δ 0.05, 99 edges | - | - | 3.4 (97.7) | - | 1.9 (98.0) | 22.0 (98.4) | 1.4 (96.5) | 2.7 (99.2) |
| Learn then Test fixed sequence, exact, δ 0.025, 99 edges | - | - | 7.0 (96.8) | - | 0.8 (98.7) | 85.3 (97.7) | 0.6 (96.5) | 1.6 (99.3) |
| Learn then Test fixed sequence, exact, δ 0.05, 19 edges | - | - | 1.8 (98.4) | - | 0.2 (98.4) | 2.9 (98.4) | 0.0 (97.1) | 0.0 (99.3) |
| exact scan, lowest passing, δ 0.05 | - | - | 7.5 (97.7) | - | 3.4 (97.4) | 18.0 (98.4) | 3.6 (96.2) | 4.2 (98.9) |
| Bonferroni over 99 edges, δ 0.05 | - | - | - | - | 0.0 (98.4) | - | 0.0 (97.4) | 0.0 (99.3) |
| SGR, δ 0.05 | - | - | - | - | 0.9 (98.1) | - | 0.4 (96.9) | 1.3 (98.9) |
| conformal selection (BH), batch of 1,000 | 44.6 (95.4) | - | 35.5 (95.7) | 45.8 (98.1) | 42.1 (95.3) | 35.0 (98.3) | 42.9 (95.1) | 45.0 (98.1) |

**Reading.**

- With independent rows and a monotone precision curve, today's Wilson scan held its nominal one-sided 2.5%: violations of 1.2% to 2.1%.
- The same scan with an exact test at δ = 0.05 stayed under 5% (2.6% to 4.0%). The search costs little here because the tails are nested and the curve is monotone. That is an empirical result, not a guarantee.
- The point bar broke its promise about half the time at every sample size.
- Conformal selection broke it 27% to 45% of the time. That is its expectation-only guarantee working as stated: on average the FDR is right, but a single draw is below the promise often.
- **No valid procedure can promise 98% from 180 rows.** Model I's 98% tail holds about 65 rows at n = 180, fewer than the 149 that a zero-error test needs. At 50 rows nothing valid finds a bar at either promise.

**The defect that matters with independent rows is conditional, not marginal.**

- Every valid procedure guarantees P(a bar is found and it is bad) ≤ δ. Users see only found bars, and P(bad | found) can be large when finding is rare.
- At n = 500 and a 98% promise, today's conservative bar is found in 1.7% of samples, and 85.3% of those found bars are below the promise.
- With the same δ, the 99-edge fixed sequence is below the promise on 22.0% of found bars and the 19-edge fixed sequence on 2.9%.
- The fine grid lets the sequence keep stepping down until just before the first error. The bar then lands where the sample was luckiest.
- A coarse grid fixed in advance gave the most reliable found bars in every cell. It cost coverage at large n: 58% of the oracle's coverage at 2,000 rows and 98%, against 71% for the Wilson scan.

## 2. Grouped data

### What the literature offers

**Dunn, Wasserman and Ramdas** (JASA 2023) [s] give distribution-free prediction sets for two-layer hierarchical data. Pooling the per-group distribution functions gives only asymptotic coverage. Coverage for a new group is guaranteed by subsampling one observation per group; repeated subsampling recovers efficiency.

**Lee, Barber and Willett** (2023, revised 2025) [v] formalise hierarchical exchangeability, extend conformal prediction and the jackknife+ to it, and add "second-moment coverage" to control how much miscoverage varies from group to group.

**Lee and Ren** (2025, revised 2026) [v] treat the selection problem itself on hierarchical data: choosing units with good unobserved outcomes at a controlled FDR. They use conformal e-values with the e-BH procedure, in a subsampling version and a deterministic hierarchical version.

**Gibbs, Cherian and Candès** (JRSSB 2025) [s] give exact finite-sample coverage within each of a finite set of predefined groups, which may overlap. Mondrian conformal needs the groups to be disjoint.

**Multicalibration** (Hébert-Johnson, Kim, Reingold, Rothblum, ICML 2018) [m] asks for calibration on every group in a rich family. It needs a sample per group on the order of 1/(γα²), for a group of mass γ at tolerance α. Hundreds of labels do not reach that.

**The Kish design effect** [m]: n_eff = n / (1 + (m̄ - 1)ρ) for mean cluster size m̄ and intra-class correlation ρ. When the variants of a template share one label, as in T1's corpus, the correctness of a group's acts is identical within the group. ρ is then 1 for that quantity, and the evidence is worth about one observation per group.

### What the simulation shows

Procedures (script `q2.ts`): the point scan; today's Wilson scan; the Learn then Test fixed sequence on rows (δ 0.05, 99 edges); the same after keeping at most 3 rows per group (the acceptance plan's cap); the same on one random row per group (Dunn et al.'s single subsample); and the same with groups as units, defined in section A of the design below.

Table 2 reports P(violation) / P(a bar is found) / mean coverage of rows. Settings: model IIa, seed 20261113, 2,000 repetitions (1,000 at n = 2,000), in the order shown. The promise is checked on the population of new groups.

| setting | groups (mean) | point scan | Wilson scan (today) | fixed seq. on rows | at most 3 rows per group | one row per group | groups as units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 500 rows, size 1, ICC 0, 95% | 500 | 53.3 / 100.0 / 49.4 | 1.6 / 94.2 / 36.6 | 1.8 / 82.8 / 32.6 | 1.8 / 82.8 / 32.6 | 1.8 / 82.8 / 32.6 | 1.8 / 82.8 / 32.6 |
| 500 rows, size 3, ICC 0.3, 95% | 167 | 51.2 / 100.0 / 49.4 | 4.3 / 92.3 / 36.9 | 4.1 / 83.9 / 33.1 | 2.6 / 79.1 / 31.6 | 1.4 / 29.6 / 40.1 | 0.0 / 51.6 / 26.5 |
| 500 rows, size 3, ICC 0.6, 95% | 167 | 54.1 / 100.0 / 49.6 | 6.6 / 90.8 / 38.1 | 6.0 / 84.5 / 35.2 | 4.7 / 80.0 / 33.2 | 1.1 / 29.3 / 40.0 | 0.1 / 40.2 / 29.8 |
| 500 rows, size 10, ICC 0.3, 95% | 50 | 53.1 / 100.0 / 49.6 | 11.6 / 88.8 / 38.8 | 11.1 / 82.2 / 36.1 | 2.6 / 23.7 / 42.7 | no bar | no bar |
| 500 rows, size 10, ICC 0.6, 95% | 50 | 54.8 / 99.9 / 49.4 | 18.0 / 86.7 / 40.4 | 17.8 / 84.4 / 38.7 | 5.3 / 26.8 / 44.3 | no bar | no bar |
| 180 rows, size 3, ICC 0.6, 95% | 61 | 54.4 / 99.2 / 49.6 | 3.7 / 22.4 / 43.7 | 4.3 / 42.0 / 40.3 | 4.0 / 25.7 / 44.2 | no bar | no bar |
| 2000 rows, size 10, ICC 0.6, 95% | 200 | 52.8 / 100.0 / 49.5 | 17.2 / 100.0 / 44.4 | 15.9 / 96.3 / 44.5 | 5.4 / 86.4 / 36.2 | 0.8 / 43.0 / 36.3 | 0.0 / 67.0 / 17.6 |
| 2000 rows, size 3, ICC 0.6, 98% | 668 | 52.8 / 100.0 / 36.3 | 5.2 / 89.8 / 26.3 | 5.9 / 75.9 / 23.5 | 3.6 / 69.5 / 22.2 | 1.1 / 28.8 / 26.5 | 0.0 / 40.8 / 18.2 |
| 2000 rows, size 10, ICC 0.6, 98% | 201 | 56.2 / 99.6 / 36.6 | 15.4 / 85.7 / 28.6 | 17.2 / 78.3 / 26.7 | 2.9 / 31.0 / 29.6 | no bar | no bar |

**Reading of Table 2.**

- **The cause is the unit, not the search.** Clustering raised today's violation rate from 1.6% to 6.6% (size 3, ICC 0.6) and to 18.0% (size 10). The exact fixed sequence on rows was no better (6.0% and 17.8%), because it makes the same independence assumption.
- Capping rows per group helps partly.
- One row per group, or groups as units, holds the promise (0.0% to 1.4%) but finds a bar far less often.
- The first row is a sanity check: with groups of size 1, all four Learn then Test variants coincide.

Table 3 reports, for model IIb (seed continues from Table 2's stream, 2,000 repetitions, 1,000 for 30 families), each procedure's figures in this order:

- P(a bar is found);
- P(precision on held-out templates of the same families < promise), which is T1's evidence split;
- P(precision on the population of families < promise);
- the mean, over draws that found a bar, of the probability that a new family's precision is below the promise;
- mean coverage.

The first row of each block is the oracle pooled bar, exact on the population.

| families, rows, τ | procedure | found | same families | population | new family | coverage |
| --- | --- | --- | --- | --- | --- | --- |
| 10, 500, 0.5 | oracle pooled bar (s 0.782) | - | - | 0 | 35.4 | 44.7 |
| 10, 500, 0.5 | point scan | 99.6 | 54.0 | 56.0 | 39.5 | 44.9 |
| 10, 500, 0.5 | Wilson scan (today) | 70.7 | 5.7 | 11.5 | 20.4 | 34.1 |
| 10, 500, 0.5 | fixed seq. on rows | 62.3 | 5.5 | 10.6 | 17.6 | 30.2 |
| 10, 500, 0.5 | at most 3 rows per group | 58.0 | 3.7 | 7.8 | 15.6 | 29.0 |
| 10, 500, 0.5 | one row per group | 17.8 | 2.0 | 3.6 | 26.2 | 39.4 |
| 10, 500, 0.5 | groups as units | 25.6 | 0.2 | 0.3 | 10.7 | 27.5 |
| 10, 500, 0.5 | profile rule, families as donors (Wilson, 30) | 0.0 | 0.0 | 0.0 | - | - |
| 10, 500, 0.5 | every family clears (max of family point bars, ≥ 10 rows) | 29.1 | 0.8 | 1.8 | 15.1 | 30.5 |
| 10, 500, 1 | oracle pooled bar (s 0.901) | - | - | 0 | 21.4 | 22.1 |
| 10, 500, 1 | point scan | 84.4 | 53.8 | 64.0 | 33.2 | 34.7 |
| 10, 500, 1 | Wilson scan (today) | 28.7 | 5.5 | 22.6 | 30.7 | 33.0 |
| 10, 500, 1 | fixed seq. on rows | 27.5 | 4.2 | 14.8 | 26.5 | 27.1 |
| 10, 500, 1 | at most 3 rows per group | 23.6 | 3.3 | 13.6 | 27.1 | 28.1 |
| 10, 500, 1 | one row per group | 5.9 | 1.5 | 5.9 | 38.9 | 42.5 |
| 10, 500, 1 | groups as units | 8.3 | 0.3 | 7.8 | 26.7 | 29.1 |
| 10, 500, 1 | profile rule, families as donors (Wilson, 30) | 0.0 | 0.0 | 0.0 | - | - |
| 10, 500, 1 | every family clears (max of family point bars, ≥ 10 rows) | 10.7 | 1.1 | 7.6 | 27.4 | 29.2 |
| 30, 1500, 1 | oracle pooled bar (s 0.901) | - | - | 0 | 21.4 | 22.1 |
| 30, 1500, 1 | point scan | 89.7 | 57.5 | 61.4 | 27.0 | 28.6 |
| 30, 1500, 1 | Wilson scan (today) | 45.3 | 7.0 | 22.6 | 22.4 | 22.7 |
| 30, 1500, 1 | fixed seq. on rows | 24.3 | 3.5 | 11.0 | 21.7 | 21.2 |
| 30, 1500, 1 | at most 3 rows per group | 24.4 | 3.0 | 10.4 | 20.5 | 19.5 |
| 30, 1500, 1 | one row per group | 14.1 | 1.2 | 4.3 | 20.0 | 19.3 |
| 30, 1500, 1 | groups as units | 14.6 | 0.3 | 2.4 | 16.0 | 13.2 |
| 30, 1500, 1 | profile rule, families as donors (Wilson, 30) | 0.0 | 0.0 | 0.0 | - | - |
| 30, 1500, 1 | every family clears (max of family point bars, ≥ 10 rows) | 0.1 | 0.0 | 0.1 | 21.7 | 22.7 |

**Reading of Table 3.**

- When families differ, today's bar holds on new templates of the families it saw (5.5% to 7.0%). It breaks on the population of families 11.5% to 22.6% of the time.
- **Nothing pooled protects a new family.** Even the oracle bar, exact on the population, leaves 21.4% to 35.4% of new families below the promise. The oracle bar sits at a higher s when τ is larger, which is why τ = 1 fails fewer new families than τ = 0.5.
- A promise about a new family needs families as the unit, and many of them. If every one of G exchangeable families clears, the chance that more than ε of new families fail is at most (1-ε)^G. That is 59 families for 5% and 29 for 10%, at 95% confidence (`q56.ts`).
- The profile rule with families as donors never produced a bar. Each family's 50 rows cannot give a Wilson lower bound above 95%, which needs 73 clean rows in a tail.

### T1 in group units

T1's fit split had 180 items in 71 template groups (26 of them hand-authored singletons), 60.6% approvals, and 152 answered rows.

- With groups as units, a 95% bar at δ = 0.05 needs at least 59 acting groups above it and no wrong group.
- Acting groups at a bar are essentially the approval groups. More than 59 approval groups among 71 would make at least 83% of groups approvals, which fits 60.6% of items only if denial groups were far larger than approval groups. I do not have the exact approval-group count, so read this as near-certain rather than proven: **the honest output at 95% was "no bar"**.
- At 98% no unit-correct fit was possible: 149 groups are needed and there were 71.
- The row-based conservative fit returned no bar at 98%, which was correct. A 95% conservative bar was later frozen from the same 180 rows and delivered 92.9% (exact lower bound 88.0%) on 241 fresh calls, with every miss a check bypass.
- That is model IIb's failure in miniature: one family whose denials look routine, absent or thin in the fit set.

## 3. Calibration maps at 50 to 500 labels

### What the literature offers

**Venn-Abers predictors** (Vovk and Petej, UAI 2014) [s] are Venn predictors built on isotonic regression.

- Under iid data they are automatically well calibrated, at the price of a multiprobability output: a pair of probabilities instead of one.
- They fix a calibration failure of Zadrozny and Elkan's isotonic method.
- The inductive (IVAP) and cross (CVAP) versions (Vovk, Petej, Fedorova, NeurIPS 2015) [s] are computationally efficient.
- Merging the pair into one probability loses the formal guarantee but was consistently more accurate in their experiments.

**Beta calibration** (Kull, Silva Filho, Flach, AISTATS 2017) [s] fits a logistic model on ln s and -ln(1-s).

- Logistic calibration on raw scores can make probabilities worse than the scores, and its family does not contain the identity map.
- Beta calibration's family does contain it, and it is "as easy as fitting a logistic curve".

**Niculescu-Mizil and Caruana** (ICML 2005) [m] found that isotonic regression overfits small calibration sets, with Platt scaling better below about a thousand points.

**Temperature scaling** (Guo et al., 2017) [m] is Platt scaling without the intercept. It cannot move the probability at which the map crosses one half, so it cannot fix a shifted miscalibration.

### What the simulation shows

Methods (script `q3.ts`; s is clamped to [1e-9, 1 - 1e-9]):

- **raw**: the stated s.
- **Platt**: logistic regression of the smoothed targets (N+ + 1)/(N+ + 2) and 1/(N- + 2) on [logit s, 1], by Newton's method with ridge 1e-3.
- **temperature**: the same on [logit s] alone, with 0/1 targets.
- **beta**: logistic on [ln s, -ln(1-s), 1], unconstrained, ridge 1e-3.
- **isotonic (engine)**: pool-adjacent-violators with linear interpolation between blocks, as in `fitIsotonic`.
- **merged Venn-Abers**: p1/(1 - p0 + p1), defined in section D below.

Metrics are taken on one fixed test set of 2,000 rows drawn first: log loss (p clipped to [1e-6, 1 - 1e-6]), Brier score, and the exact mean of |p - η| (truth is known). The 90th percentile over repetitions is in brackets. Settings: seed 20261114, 300 repetitions (150 at n = 500); `bun q3.ts 300 A` and `bun q3.ts 300 B`, each from a fresh seed.

Table 4a, model I (Platt is exactly specified). Raw stated s: mean |s - η| = 0.126. At s = 0.832, η = 0.929.

| n | method | log loss | Brier | mean abs error to the true probability |
| --- | --- | --- | --- | --- |
| 50 | raw | 0.369 | 0.1126 | 0.126 (0.126) |
| 50 | Platt | 0.313 | 0.0961 | 0.054 (0.086) |
| 50 | temperature | 0.355 | 0.1069 | 0.094 (0.103) |
| 50 | beta | 0.352 | 0.0980 | 0.053 (0.087) |
| 50 | isotonic (engine) | 0.693 | 0.1051 | 0.076 (0.101) |
| 50 | merged Venn-Abers | 0.339 | 0.1018 | 0.088 (0.122) |
| 180 | raw | 0.369 | 0.1126 | 0.126 (0.126) |
| 180 | Platt | 0.299 | 0.0918 | 0.024 (0.041) |
| 180 | temperature | 0.340 | 0.1055 | 0.090 (0.094) |
| 180 | beta | 0.305 | 0.0923 | 0.027 (0.044) |
| 180 | isotonic (engine) | 0.430 | 0.0959 | 0.047 (0.060) |
| 180 | merged Venn-Abers | 0.312 | 0.0949 | 0.050 (0.067) |
| 500 | raw | 0.369 | 0.1126 | 0.126 (0.126) |
| 500 | Platt | 0.296 | 0.0910 | 0.015 (0.025) |
| 500 | temperature | 0.338 | 0.1052 | 0.089 (0.091) |
| 500 | beta | 0.298 | 0.0911 | 0.016 (0.026) |
| 500 | isotonic (engine) | 0.354 | 0.0931 | 0.033 (0.040) |
| 500 | merged Venn-Abers | 0.303 | 0.0927 | 0.034 (0.043) |

Table 4b, model III (Platt and temperature are misspecified). Raw stated s: mean |s - η| = 0.119. At s = 0.832, η = 0.835.

| n | method | log loss | Brier | mean abs error to the true probability |
| --- | --- | --- | --- | --- |
| 50 | raw | 0.366 | 0.1111 | 0.119 (0.119) |
| 50 | Platt | 0.296 | 0.0845 | 0.064 (0.096) |
| 50 | temperature | 0.381 | 0.1127 | 0.124 (0.140) |
| 50 | beta | 0.328 | 0.0829 | 0.052 (0.084) |
| 50 | isotonic (engine) | 0.616 | 0.0881 | 0.068 (0.090) |
| 50 | merged Venn-Abers | 0.311 | 0.0887 | 0.088 (0.125) |
| 180 | raw | 0.366 | 0.1111 | 0.119 (0.119) |
| 180 | Platt | 0.281 | 0.0789 | 0.036 (0.052) |
| 180 | temperature | 0.368 | 0.1111 | 0.117 (0.124) |
| 180 | beta | 0.271 | 0.0772 | 0.027 (0.041) |
| 180 | isotonic (engine) | 0.392 | 0.0805 | 0.043 (0.054) |
| 180 | merged Venn-Abers | 0.279 | 0.0802 | 0.047 (0.063) |
| 500 | raw | 0.366 | 0.1111 | 0.119 (0.119) |
| 500 | Platt | 0.278 | 0.0778 | 0.030 (0.039) |
| 500 | temperature | 0.366 | 0.1108 | 0.114 (0.119) |
| 500 | beta | 0.263 | 0.0760 | 0.017 (0.026) |
| 500 | isotonic (engine) | 0.319 | 0.0778 | 0.030 (0.036) |
| 500 | merged Venn-Abers | 0.269 | 0.0778 | 0.032 (0.041) |

Table 4c reports the inductive Venn-Abers width p1 - p0 from the same runs: near the bars (test rows with s between 0.70 and 0.86, around both oracle bars) and over all test rows.

| n | model I near the bars: median, 90th pct | model I all rows: median | model III near the bars: median, 90th pct | model III all rows: median |
| --- | --- | --- | --- | --- |
| 50 | 0.167, 0.333 | 0.125 | 0.200, 0.500 | 0.111 |
| 180 | 0.067, 0.170 | 0.053 | 0.083, 0.223 | 0.043 |
| 500 | 0.032, 0.093 | 0.027 | 0.038, 0.116 | 0.021 |

**Reading.**

- Beta calibration was best or within noise of best in both models at every n. Platt is as good only when the true map happens to be logistic in logit(s).
- Temperature scaling stayed at 0.09 to 0.12 mean error at every n. Jev's underconfidence needs an intercept.
- The engine's isotonic map returns hard 0 and 1 at the ends at small n, which ruins log loss (0.69 at n = 50). An exact 0 or 1 is also infinite in log-odds pooling.
- Merged Venn-Abers keeps log loss sane (0.34 at n = 50) at a mean error similar to isotonic.
- All six are dependency-free: Newton on two or three parameters, and pool-adjacent-violators.

**Run-to-run spread and averaging repeated asks** (`q56.ts`).

- Jev-1.13's absolute difference between two asks had a 90th percentile of 0.04. Treated as Gaussian jitter, one ask has a standard deviation of 0.04/(1.645·√2) = 0.0172. The one-sided 99% half-width is 0.040 for one ask, 0.023 for the mean of 3 and 0.018 for the mean of 5.
- The real spread is heavier-tailed: on jev-1.14, 11.4% of repeated requests moved more than 0.12. Use empirical quantiles, not the Gaussian.
- Averaging k asks shrinks the standard deviation by √k only if the jitter is independent from ask to ask. Cached identical replies (118 of 414 repeated T1 pairs were identical) shrink nothing.
- It does nothing for item-level error: replicas' errors correlated at phi 0.85 to 0.91.
- The mean of k asks has a different distribution from one ask, so a bar fitted on single asks is not the bar for averages. Averaging is a new configuration and needs its own fit and its own evidence version.

## 4. A novelty gate

**Testing for outliers with conformal p-values** (Bates, Candès, Lei, Romano, Sesia, Annals of Statistics 2023) [s] builds conformal p-values for whether a new point comes from the reference distribution.

- The ordinary ones are marginally valid and positively dependent.
- The authors add p-values valid conditionally on the reference set.

Vovk (2012) [m] gives the matching conditional result for inductive conformal predictors. Laxhammar and Falkman's conformal anomaly detection [m] is the earlier formulation of the same test.

**What it guarantees.** If the new state is exchangeable with the reference states, P(flagged) ≤ α. That bounds the availability cost of the floor: how often a familiar state is sent to review needlessly. It says nothing about how often a risky novel state is caught. That power depends entirely on the distance used. Nothing in the literature turns novelty into a precision guarantee without assumptions on how error relates to novelty.

Table 5 reports the realized false-alarm rate of a split conformal novelty test at α = 5%. Given the reference set, it is Beta(k, n+1-k) distributed with k = ⌊α(n+1)⌋. The table gives its mean and 95th percentile over reference draws (deterministic, `q4.ts`).

| reference rows n | k | mean false-alarm rate | 95th percentile |
| --- | --- | --- | --- |
| 50 | 2 | 3.92% | 9.14% |
| 180 | 9 | 4.97% | 7.88% |
| 500 | 25 | 4.99% | 6.68% |
| 2000 | 100 | 5.00% | 5.82% |

## 5. Covariate shift

**Conformal prediction under covariate shift** (Tibshirani, Barber, Candès, Ramdas, NeurIPS 2019) [s] reweights calibration points by the likelihood ratio between deployment and calibration covariates. It is valid when the ratio is known, and can work with a ratio estimated from unlabelled deployment data.

**Weighted conformalized selection** (Jin and Candès, 2023) [v] keeps finite-sample FDR control for selection under covariate shift.

**Conformal prediction beyond exchangeability** (Barber, Candès, Ramdas, Tibshirani, Annals of Statistics 2023) [m] bounds the coverage gap by a weighted total-variation distance.

**This is the easy case for the engine.** Strata computed in code from trusted fields (command class, tool, digest flags) have deployment shares that the ledger records for every ask, with no label needed. So the likelihood ratio per stratum is known up to the noise in the fit counts.

Table 6 gives zero-error planned acts per stratum at one-sided 95%, with Bonferroni across K strata (`q56.ts`).

| promise | K = 1 | K = 2 | K = 3 | K = 5 | total at K = 3 | total at K = 5 |
| --- | --- | --- | --- | --- | --- | --- |
| 95% | 59 | 72 | 80 | 90 | 240 | 450 |
| 98% | 149 | 183 | 203 | 228 | 609 | 1140 |

Allowing one error: 93 acts at 95% and 236 at 98%.

**A worked reweighting example** (`q56.ts`).

- 180 fit rows in a 50/35/15 mix over three strata are read for a 30/30/40 deployment mix.
- The unit weights are 0.60, 0.86 and 2.67, and the Kish effective size is 120 rows.
- With illustrative stratum precisions of 99.5%, 98% and 90% at a fixed bar, precision is 97.5% on the fit mix and 95.3% on the deployment mix.

**Is a per-stratum acceptance plan worth its cost?** Only for a stratum that is both a large share of deployment and costly when wrong.

- Three strata cost 240 planned acts at 95% instead of 59, and 609 at 98% instead of 149.
- Elsewhere, read the pooled evidence post-stratified (section F of the design) and put thin strata behind a floor.

## 6. Cost-derived bars and the calibration they need

**Decision calibration** (Zhao, Kim, Sahoo, Ma, Ermon, NeurIPS 2021) [v] asks that predicted and true outcome distributions look the same to every decision-maker in a class. Full distribution calibration is that requirement over all decision-makers, which is infeasible for many classes. Over decision-makers with a bounded number of actions it needs only polynomially many samples.

**Threshold calibration** (Sahoo, Zhao, Chen, Ermon, NeurIPS 2021) [s] shows that average calibration does not make threshold decisions reliable, and gives an algorithm that produces forecasts calibrated for threshold decisions.

**Neyman-Pearson classification** (Tong, Feng, Li, Science Advances 2018) [v abstract; mechanism m] controls one error type with high probability.

- The bar is an order statistic of held-out negative-class scores. Here that means the act-side scores of truly-deny rows.
- The rate at which denials are acted on is then at most ε with probability at least 1 - δ.
- It needs at least ⌈ln δ / ln(1-ε)⌉ denials: 59 at ε = δ = 5%.

**My inference for this engine.** With one cost ratio and a score that ranks monotonically, η = g(s) for an increasing g. The cost-optimal rule acts when η ≥ c = a/(a+b), that is, when s ≥ g⁻¹(c). So the only calibration property the cost bar needs is calibration at the bar, g(t) = c. Full calibration is not needed.

**The cost-versus-precision identity.**

1. Let a be the cost of a wrong act and b the cost of a wrong hold (holding an item acting would have got right). A policy that acts on a set S has expected cost per item C(S) = a·P(S, wrong) + b·P(not S, right). Holding everything costs C(∅) = b·P(right).
2. The difference is C(S) - C(∅) = a·P(S, wrong) - b·P(S, right).
3. If precision on S is exactly c = a/(a+b), then P(S, right) = c·P(S) and P(S, wrong) = (1-c)·P(S).
4. Then a·(1-c) = a·b/(a+b) = b·c, so the difference is zero.
5. **Acting on a tail whose precision equals the cost ratio gains nothing over reviewing everything.** Precision c + ε gains only ε·(a+b)·P(S) per item.
6. A tail-precision bar also acts on marginal items whose own η is below c, and each of those loses money.

Table 7 applies this to model I (`q56.ts`). Costs are per 1,000 rows, with a/b = c/(1-c).

| cost ratio c | precision bar: s, η at its margin, coverage, cost | cost bar (η ≥ c): s, tail precision, coverage, cost | acting where stated s ≥ c: coverage, cost |
| --- | --- | --- | --- |
| 0.95 (wrong act 19 times a wrong hold) | 0.739, 0.782, 49.5%, 600.0 | 0.853, 98.50%, 32.2%, 374.7 | 7.91%, 523.2 |
| 0.98 (wrong act 49 times a wrong hold) | 0.831, 0.929, 36.2%, 600.0 | 0.897, 99.30%, 22.3%, 455.1 | 1.17%, 588.5 |

Reviewing everything costs 600 per 1,000 in both rows.

Moving the 98% cost bar by ±0.05 in s raises the cost to 538.1 (bar lower; tail precision 98.37%) or 519.4 (bar higher; 99.83%). Moving the 95% cost bar by ±0.05 raises it to 418.7 or 417.6.

The last column is why the hook's placeholder bar of 0.95 acted on nothing. An underconfident model's stated probability seldom reaches a cost ratio read as a probability, and Jev's highest pYes on T1 was 0.95.

**Can calibration at the bar be tested with few labels?** Directly, no. An exact test that rows in a window just above the bar are right at least 98% of the time needs 149 clean rows inside the window. A shape-restricted estimate uses every row instead: the lower Venn-Abers probability p0 at the bar (section D). `fitThresholdByCost` finds the empirical cost-minimising bar without any calibration assumption, but at 49:1 its variance is driven by the few wrong acts near the bar.

## Recommended design

### A. An exact fixed-sequence act bar

This replaces the conservative mode `fitActBar` uses. The inputs are the current configuration's unselected labelled rows of trusted sources, scored on the act side (`scoredForAct`), the promise T and δ = 0.05, the acceptance test's level. Write α = 1 - T.

1. **Edges**, fixed in code and never chosen after seeing labels: e_1 = 0.95, e_2 = 0.90, ..., e_19 = 0.05. That is 19 edges at 0.05 steps on the act-side probability. A profile's 100 bins coarsen to these exactly (`coarsen` in `profile-bins.ts`).
2. **Units.** If the gate declares a group tag (reuse `RolloutSettings.group.tagPrefix`; a row with no such tag is a group of one), the unit is a group. Otherwise the unit is a row, and the report says "assumes rows are independent".
   - A group **acts at edge e** if any of its rows has an act-side probability ≥ e.
   - A group is **wrong at edge e** if any of its rows with an act-side probability ≥ e was wrong to act on.
   - So n(e) is the number of groups that act at e, and k(e) the number that are wrong at e. For row units these are the row counts.
3. **n_min** = ⌈ln δ / ln T⌉, the smallest unit count at which a tail with no wrong unit can pass. That is 59 at 95% and 149 at 98% for δ = 0.05, the same as `requiredActs(T, δ, 0)` in `acceptance.ts`.
4. **Start rule, label-free**: start at the highest edge e_j with n(e_j) ≥ n_min. This reads unit counts only, never labels. If no edge reaches n_min, return "no bar: too few units", with the largest n(e) and n_min.
5. **Test at each edge**, from the start downward:
   - p(e) = Σ_{i=0}^{k(e)} C(n(e), i) α^i (1-α)^(n(e)-i), the exact binomial lower tail.
   - **Accept** e if p(e) ≤ δ. Equivalently, the exact one-sided Clopper-Pearson lower bound on precision (`exactLowerBound`) is at least T.
6. **Stop rule**: stop at the first edge that is not accepted. The bar is the lowest accepted edge. Edges below the first failure are never tested, however they would come out.
7. **Output**: the bar; n(e), k(e) and rows at the bar; the exact lower bound at δ; coverage of rows; the start edge; n_min; the unit; and the point-estimate bar for reading only. Retire the Wilson scan from the act bar.

**What it guarantees.** If units are independent and identically distributed, the procedure controls the family-wise error rate at δ, under any shape of the precision curve: P(the bar is accepted and the precision of acting on units at or above it is below T) ≤ δ.

**The precise exactness statement for the start rule.**

- If the start edge is fixed in advance, or chosen from rows independent of the labelled fit rows, the guarantee holds exactly for the population precision. Such rows include the configuration's unlabelled shadow rows when labels are a uniform blind sample.
- If the start is chosen from the fit rows' own counts, the test is exact for the precision of the tail's own composition. That holds given the bin counts and by Hoeffding's (1956) [m] result that a Poisson-binomial lower tail is bounded by the binomial's at the same mean, in the region where tests reject. For the population precision it is then approximate.
- In the simulations it delivered 0.0% to 2.5% violations at δ = 0.05 (Table 1).

**What a group-unit bar promises.** It promises something about groups: at most α of acting groups contain a wrong act. That bounds row precision too when groups that contain a wrong act do not, on average, act on more rows than acting groups in general. This holds when variants share a label and a denial group crosses the bar only through its upper tail. Taking one row per group makes it hold by construction, at a loss of power.

**The "provisional" rule.** This is my heuristic. I have not tested it. Mark a found bar provisional when the accepted bar is the start edge itself, or when n at the bar is below 1.5·n_min. Say so in the report: "found at the edge of power; on similar data most such bars were below the promise".

The motivation is Table 1b: at n = 500 and 98%, 85% of today's found bars and 22% of the 99-edge fixed sequence's were below the promise. The 1.5 multiplier and the trigger conditions need their own simulation before shipping.

### B. Rebuilding the borrowed bar

**An observation on `cautiousBar`.** Walking up the edges, it skips any donor gate with fewer than `minSupport` (30) rows in its tail at that edge. A donor that fails the target at every edge where it has 30 rows therefore drops out of the vote at higher edges. The lent bar can then rest on the other donors at an edge where the failing donor's thin tail was never tested. Its doc comment says this is deliberate ("A gate with fewer rows in the tail was too rarely that sure to say anything there"). But it is the less cautious direction, and it undercuts the "strictest donor" intent. `gateBar` also takes the lowest passing edge rather than stopping at the first failure.

The rebuild:

1. For each donor gate d, run the exact fit of section A on d's act-side rows, with d's own groups as units, giving bar_d or none. This needs act-side profiles, which are on the backlog as W2-C: a judge profile still bins leading-answer confidence.
2. Donor d is **informative** at the promise if some edge has n_d(e) ≥ n_min. An informative donor with no bar **vetoes**: the profile lends no bar at that promise. A donor that is not informative is listed as such and does not vote.
3. The borrowed bar is the maximum of bar_d over informative donors. D is the number of informative donors.

**The 1/(D+1) argument.**

- Let B_g be gate g's true bar: the lowest edge at which its own precision meets T.
- If the D donors and the new gate are exchangeable draws from one population of gates, the new gate's B is the largest of D+1 exchangeable values with probability at most 1/(D+1), ties aside.
- A donor's fitted bar falls below its true bar only through a fit error. The donor that matters is the one with the largest true bar, and its error probability is at most δ.
- So P(the new gate's own precision at the borrowed bar < T) ≤ 1/(D+1) + δ.
- For 5% on average, D ≥ 19 (with δ = 0.05 the bound is then 0.10). For "at most 5% of new gates fail" with 95% confidence, D = 59 donors must all have bars that the new gate's lies under.

The report should print D and this bound. Under it, a profile with fewer than 19 informative donors lends a shadow bar that promises nothing per gate, and Table 3's oracle column shows this is not a technicality.

### C. What the report should print

For a gate's act bar:

- the bar, in this form: "act above 0.80: 64 groups (171 rows) at or above it, 0 wrong; exact one-sided 95% lower bound 95.4%; fixed sequence from 0.95 over 19 edges" (the figures are illustrative);
- the unit and the design effect: rows per group, and "N rows are about G independent observations";
- power: "a bar at T needs n_min clean units; the top edge with any units has M";
- the provisional mark, when it applies;
- a stratum table (section F);
- for a cost-derived policy, the local check: rows in [bar, bar + 0.05), right / total, against a/(a+b), and p0 at the bar (section D).

### D. Calibration maps and the review band

**Beta calibration.**

- The model: p(s) = sigmoid(a·ln s - b·ln(1-s) + c), equivalently logit p = a·ln s - b·ln(1-s) + c.
- Fit it by Newton's method on the log loss with features [ln s, -ln(1-s), 1], over labelled unselected rows. Clamp s away from 0 and 1. A small ridge (1e-3 here) keeps separable small samples finite.
- Kull et al. constrain a, b ≥ 0 so the map is monotone. If either fitted coefficient is negative, refit with that feature dropped.
- **Why the family contains the identity.** With a = b = 1 and c = 0, logit p = ln s - ln(1-s) = logit s, so p = s. A well-calibrated score is left alone. Platt on logit s also contains it; Platt on raw s does not.

**The inductive Venn-Abers predictor.**

1. Sort the labelled calibration rows by s.
2. For a query score s, add the pseudo-row (s, 0) and fit isotonic regression (pool-adjacent-violators on the 0/1 outcomes in s order). p0 is the fitted value at the pseudo-row's position.
3. Add (s, 1) instead and refit. p1 is the fitted value there. p0 ≤ p1.
4. **What it guarantees.** Under exchangeability, the pair is valid in Vovk's sense: the probability that corresponds to the true label is perfectly calibrated [s for validity; m for the exact statement].
5. **The merged probability** p = p1/(1 - p0 + p1) is a single number with good log loss. **What merging gives up**: the calibration guarantee; it is then just a good estimator.
6. Naive cost is two pool-adjacent-violators passes per query, O(n) each. Vovk et al. (2015) [s] give an O(n log n) precomputation.

**A band from Venn-Abers width and measured jitter**, replacing the fixed half-width around the bar as an option:

1. Let j_q be the empirical q-quantile (q = 0.99 suggested) of |s_rep - s_mean| over repeated asks of the same state and question under the pinned model. Rows sharing `stateHash` and question hash are in the ledger.
2. Act on a row with stated s only if p0(s′ - j_q) ≥ c for the row's s′ = s. Here c is the cost bar, or the promise for a precision gate.
3. In practice compute the act edge on a fine grid: the smallest grid value s* such that p0(u - j_q) ≥ c at every grid value u ≥ s*. Act above s*, review below.
4. The band then narrows as labels accrue and widens with jitter. In this model the Venn-Abers width near the bars is 0.17 to 0.20 at n = 50, 0.07 to 0.08 at n = 180 and 0.03 to 0.04 at n = 500, against a 99% single-ask jitter of about 0.04 (Table 4c and section 3).
5. Fit Venn-Abers on unselected rows only (invariant 5). This rule is not a substitute for the exact act bar of section A; it sits on top of it.

### E. A novelty floor

1. **Reference set R**: the current configuration's shadow and blind-audit rows. Labels are not needed. Never enforce acts, never chain retries.
2. **Distance**: d(x, y) = 1 - |S(x) ∩ S(y)| / |S(x) ∪ S(y)|, where S is the set of token shingles of the state's trusted fields only. A MinHash estimate with seeds fixed in code is acceptable if every score uses the same estimator.
3. **Test score**: a(x) = min_{i in R} d(x, x_i).
4. **Reference scores, leave-one-out**: a_i = min over j ≠ i in R of d(x_i, x_j).
   - For the exact version, also take the minimum with d(x_i, x), so every score is computed against the other n points.
   - Leaving the test point out is conservative: the test point then has one more neighbour than the reference points, so its score is stochastically smaller.
5. **p-value**: p(x) = (1 + #{i : a_i ≥ a(x)}) / (n + 1). The floor returns review when p(x) ≤ α and is silent otherwise, so it combines through `moreCautious` and can only raise caution.
6. A **deterministic companion floor**: a command class with fewer than m labelled groups in the fit set goes to review.

**What is guaranteed.** If x is exchangeable with R, P(p(x) ≤ α) ≤ α. Given one reference set, the realized rate varies; its 95th percentile is 7.9% at n = 180 and α = 5% (Table 5).

**What is not guaranteed:**

- that a novel state is caught;
- that a familiar state is safe;
- anything once R drifts or is fed from enforced acts. Feeding it enforced acts would let the gate's own actions define "familiar", a feedback loop of the kind invariant 8 forbids.

### F. Strata and the deployment-weighted bound

Strata s = 1..K are computed in code from trusted fields only, so untrusted text cannot steer a request into a well-evidenced stratum. At the bar:

- **For each stratum**: n_s labelled units at or above the bar, k_s of them wrong, and the Clopper-Pearson lower bound L_s at one-sided δ/K, where L_s = 1 - (the largest e with P(Bin(n_s, e) ≤ k_s) ≥ δ/K). A stratum with no labelled unit has L_s = 0.
- **A_s**: the deployment acts in stratum s over the reporting window, counted from every ask in the ledger without labels.
- **Deployment-weighted precision**: Σ_s A_s·p̂_s / Σ_s A_s, with p̂_s = 1 - k_s/n_s.
- **Its lower bound**: L = Σ_s A_s·L_s / Σ_s A_s.
  - This holds simultaneously with probability at least 1 - δ by Bonferroni, treating the A_s as the window's counts.
  - For future traffic the A_s are themselves estimates.
  - A thin stratum with a large A_s drags L down. That is the right behaviour: it says where to label next, or which stratum to floor.
- **Kish effective size** of the reweighted evidence: (Σ w_i)² / Σ w_i², with w_i = (A_s/ΣA) / (n_s/Σn) for a unit i in stratum s.

Allocate blind audits and the planned acceptance sample across strata in proportion to A_s times the stratum's cost of a wrong act. Run a separate per-stratum acceptance plan only where Table 6's price is worth paying.

### G. Which promise

Report the Neyman-Pearson false-act rate among denials beside precision: the rate at which truly-deny units are acted on, with its exact upper bound.

**Why.** Precision moves with the base rate. 198 of T1's 200 real calls were approvals, so precision there said little. A rate taken among denials does not move with the base rate.

**How to bound it.** Sort the m held-out deny units' act-side scores as d_(1) ≤ ... ≤ d_(m). Act only above d_(k), for the smallest k with Σ_{j=k}^{m} C(m,j)(1-ε)^j ε^(m-j) ≤ δ. Then P(the false-act rate among denials > ε) ≤ δ under iid units. This needs m ≥ 59 at ε = δ = 5%. [m for the construction; Tong et al.]

**For cost-derived policies**, state plainly that a tail-precision promise of c is not a cost policy at a/(a+b) = c (section 6). Choose the cost bar by the local check of section C, or by `fitThresholdByCost`, and keep the precision bar as the promise that acceptance tests.

## Pitfalls and assumptions

**Assumptions under every guarantee in this note:**

- Units are independent and identically distributed (or exchangeable), and the unit is defined before any label is read. The group tag is written at ask time.
- Labels are correct and come from blind or census review of unselected rows.
- The model pin, rubric, policy and rendering are frozen. That is the current configuration only.
- The edge grid, δ, the start rule and n_min are fixed in code.
- The fit is read once per configuration.
- The score at decision time is drawn from the same distribution as at fit time. Jitter belongs in the band, and averaged scores are a new configuration.

**What not to do:**

- Do not treat the exploratory bar as promotion evidence. Refitting at every new label is optional stopping. The fitted bar stays exploratory; only the planned exact acceptance test promotes, as now.
- Do not read a found bar as "95% safe" when finding it was unlikely (Table 1b). Use the provisional mark until it is validated.
- Do not accept guarantees that hold only in expectation (conformal risk control, conformal selection, SCOPE) as promotion evidence. They broke the promise on 27% to 45% of draws here.
- Do not choose the grouping tag, the strata or the grid after seeing failures. That is a garden of forking paths.
- Do not compute strata or novelty shingles from untrusted spans.
- Do not let enforced acts into the novelty reference set or into a fit (invariants 5 and 8).
- Do not pool raw isotonic outputs in log-odds. They can be exactly 0 or 1.
- Do not use temperature scaling for an underconfident judge. It has no intercept.
- Do not present a pooled or borrowed bar as a promise about a new family or a new gate. That needs families or gates as units, with 59 of them for 95/95, or the 1/(D+1) + δ bound printed.
- Do not treat a precision promise of 98% as honouring a 49:1 cost ratio.
- Do not trust precision across a label shift. Report the false-act rate among denials beside it.

## Open questions and confidence

| recommendation or question | confidence | what would settle it |
| --- | --- | --- |
| Groups, not rows, are the unit; rows overstate evidence under clustering | high | measured design effect per gate from the ledger (between-group variance of wrong acts) |
| Groups-as-units keeps useful coverage on real ledgers | medium | replay of T1 and T3 ledgers with template and session tags |
| Which tag is the right unit (session, template, command class, repository) | low | the same replay, comparing design effects by tag |
| Exact fixed sequence on 19 edges replaces the Wilson scan | high for validity and for the reliability of found bars; it costs coverage at large n (58% against 71% of the oracle's at 2,000 rows and 98%) | a grid-spacing sweep, and multi-start fixed sequence with δ split (Learn then Test) |
| The label-free start chosen from the fit rows' counts | medium-high: exact for the tail's own composition, approximately right for the population, 0.0% to 2.5% in simulation | start from unlabelled shadow rows where they exist |
| The provisional rule (start edge, or under 1.5·n_min units) | low; untested heuristic | a simulation of P(below promise given found and provisional) against not provisional |
| Rebuilt borrowed bar with vetoes and the 1/(D+1) + δ bound | medium-high on the argument; the exchangeability of gates is an assumption | act-side profiles (W2-C) and a leave-one-gate-out check on existing profiles |
| Beta calibration over isotonic below about 500 labels | medium-high | the same comparison on T1 to T5 ledgers |
| Venn-Abers lower probability plus measured jitter as the band | medium-low | a live shadow comparison against the fixed band |
| Novelty floor: the false-alarm bound | high | none needed |
| Novelty floor: usefulness | low; detection power unknown | whether it flags the check-bypass class in the 241 fresh calls, given T1's fit rows as reference |
| Per-stratum acceptance only for high-share, high-cost strata | medium | deployment shares per stratum from the hook journal |
| Cost-versus-precision identity | high (algebra) | none; which promise the product makes is a product decision |
| Whether η is monotone in Jev's act-side score on real gates | open | reliability by edge on T1 to T5; non-monotone pockets cost fixed-sequence power, not validity |

## Sources

- Angelopoulos, A. N., Bates, S., Candès, E. J., Jordan, M. I. and Lei, L. (2021). Learn then Test: calibrating predictive algorithms to achieve risk control. arXiv 2110.01052. https://arxiv.org/abs/2110.01052 [v]
- Angelopoulos, A. N., Bates, S., Fisch, A., Lei, L. and Schuster, T. (2024). Conformal risk control. ICLR 2024. https://arxiv.org/abs/2208.02814 [v]
- Badshah, S., Emami, A. and Sajjad, H. (2026). SCOPE: Selective Conformal Optimized Pairwise LLM Judging. arXiv 2602.13110. https://arxiv.org/abs/2602.13110 [v]
- Badshah, S., Emami, A. and Sajjad, H. (2026). Judge, Retrieve, or Abstain: uncertainty-guarded LLM judging with provable risk guarantees. COLM 2026. https://arxiv.org/abs/2608.17994 [v]
- Barber, R. F., Candès, E. J., Ramdas, A. and Tibshirani, R. J. (2023). Conformal prediction beyond exchangeability. *Annals of Statistics* 51(2). https://arxiv.org/abs/2202.13415 [m]
- Bates, S., Candès, E., Lei, L., Romano, Y. and Sesia, M. (2023). Testing for outliers with conformal p-values. *Annals of Statistics* 51(1), 149-178. https://arxiv.org/abs/2104.08279 [s]
- Bauer, P. (1991). Multiple testing in clinical trials. *Statistics in Medicine* 10(6), 871-890. https://doi.org/10.1002/sim.4780100609 [m]
- Candès, E. J., Ilyas, A. and Zrnic, T. (2026). Probably approximately correct labels. ICML 2026, PMLR 306. https://arxiv.org/abs/2506.10908 [v]
- Dunn, R., Wasserman, L. and Ramdas, A. (2023). Distribution-free prediction sets for two-layer hierarchical models. *JASA* 118(544), 2491-2502. https://arxiv.org/abs/1809.07441 [s]
- Geifman, Y. and El-Yaniv, R. (2017). Selective classification for deep neural networks. arXiv 1705.08500. https://arxiv.org/abs/1705.08500 [v]
- Gibbs, I., Cherian, J. J. and Candès, E. J. (2025). Conformal prediction with conditional guarantees. *JRSS Series B*. https://arxiv.org/abs/2305.12616 [s]
- Gui, Y., Jin, Y. and Ren, Z. (2024). Conformal alignment: knowing when to trust foundation models with guarantees. NeurIPS 2024. https://arxiv.org/abs/2405.10301 [s]
- Guo, C., Pleiss, G., Sun, Y. and Weinberger, K. Q. (2017). On calibration of modern neural networks. ICML 2017. https://proceedings.mlr.press/v70/guo17a.html [m]
- Hébert-Johnson, U., Kim, M. P., Reingold, O. and Rothblum, G. N. (2018). Multicalibration: calibration for the (computationally-identifiable) masses. ICML 2018, PMLR 80. https://proceedings.mlr.press/v80/hebert-johnson18a.html [m]
- Hoeffding, W. (1956). On the distribution of the number of successes in independent trials. *Annals of Mathematical Statistics* 27(3), 713-721. https://doi.org/10.1214/aoms/1177728178 [m]
- Jin, Y. and Candès, E. J. (2023). Selection by prediction with conformal p-values. *JMLR* 24. https://jmlr.org/papers/v24/22-1176.html [s]
- Jin, Y. and Candès, E. J. (2023). Model-free selective inference under covariate shift via weighted conformal p-values. arXiv 2307.09291. https://arxiv.org/abs/2307.09291 [v]
- Jung, J., Brahman, F. and Choi, Y. (2025). Trust or escalate: LLM judges with provable guarantees for human agreement. ICLR 2025. https://arxiv.org/abs/2407.18370 [v]
- Kish, L. (1965). *Survey Sampling*. Wiley. [m]
- Kull, M., Silva Filho, T. and Flach, P. (2017). Beta calibration: a well-founded and easily implemented improvement on logistic calibration for binary classifiers. AISTATS 2017, PMLR 54, 623-631. https://proceedings.mlr.press/v54/kull17a.html [s]
- Laxhammar, R. and Falkman, G. (2015). Inductive conformal anomaly detection for sequential detection of anomalous sub-trajectories. *Annals of Mathematics and Artificial Intelligence* 74, 67-94. https://doi.org/10.1007/s10472-013-9381-7 [m]
- Lee, Y., Barber, R. F. and Willett, R. (2023, revised 2025). Distribution-free inference with hierarchical data. arXiv 2306.06342. https://arxiv.org/abs/2306.06342 [v]
- Lee, Y. and Ren, Z. (2025, revised 2026). Selection from hierarchical data with conformal e-values. arXiv 2501.02514. https://arxiv.org/abs/2501.02514 [v]
- Niculescu-Mizil, A. and Caruana, R. (2005). Predicting good probabilities with supervised learning. ICML 2005. https://doi.org/10.1145/1102351.1102430 [m]
- Sahoo, R., Zhao, S., Chen, A. and Ermon, S. (2021). Reliable decisions with threshold calibration. NeurIPS 2021. https://papers.nips.cc/paper/2021/hash/0e65972dce68dad4d52d063967f0a705-Abstract.html [s]
- Tibshirani, R. J., Barber, R. F., Candès, E. J. and Ramdas, A. (2019). Conformal prediction under covariate shift. NeurIPS 2019. https://arxiv.org/abs/1904.06019 [s]
- Tong, X., Feng, Y. and Li, J. J. (2018). Neyman-Pearson classification algorithms and NP receiver operating characteristics. *Science Advances* 4(2), eaao1659. https://arxiv.org/abs/1608.03109 [v for the abstract; m for the order-statistic construction]
- Vovk, V. (2012). Conditional validity of inductive conformal predictors. ACML 2012, PMLR 25. https://proceedings.mlr.press/v25/vovk12.html [m]
- Vovk, V. and Petej, I. (2014). Venn-Abers predictors. UAI 2014, 829-838. https://arxiv.org/abs/1211.0025 [s]
- Vovk, V., Petej, I. and Fedorova, V. (2015). Large-scale probabilistic predictors with and without guarantees of validity. NeurIPS 2015. https://arxiv.org/abs/1511.00213 [s]
- Zhao, S., Kim, M. P., Sahoo, R., Ma, T. and Ermon, S. (2021). Calibrating predictions to decisions: a novel approach to multi-class calibration. NeurIPS 2021. https://arxiv.org/abs/2107.05719 [v]
- Project evidence: `docs/e2e/t1-toolgate.md`, `docs/e2e/findings.md` and `docs/rollout.md` (T1 fit and evidence splits, run-to-run spread). The 241 fresh-call figures (92.9%, exact lower bound 88.0%, every miss a check bypass) are from the end-to-end evaluation of 2026-11-12 as reported to this review.

The numbers in this note were computed by seeded TypeScript scripts (`lib.ts`, `procs.ts`, `q1.ts`, `q2.ts`, `q3.ts`, `q4.ts`, `q56.ts`) in a session scratch folder that is not part of the repository. Tables that back shipped code are to be reproduced under `sim/`.
