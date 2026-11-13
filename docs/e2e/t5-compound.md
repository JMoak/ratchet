# T5: do the compounding strategies compound?

Wave 1, track T5 of the end-to-end evaluation. The claims under test are the compounding claims
in [vision.md](../vision.md) and [architecture.md](../architecture.md) ("Compounding,
mechanically"): aggregation compounds accuracy only with independence; replicas of one model
are about one vote; different framings, decompositions or models add evidence; the design-effect
correction with a measured correlation improves calibration without changing winners; cascades
gain little unless the upper tier is differently wrong; sequential sampling stops early at the
same accuracy; and two independent judges' disagreement is a label-free error bound.

Run: `experiments/out/e2e/t5-compound/2026-11-12T10-35-57-202Z-main-live` (gitignored), git HEAD
`c9155b9`, corpus `corpus.json` with `corpusHash` `c137a783dc17...` (in `manifest.json`), models
`typesafe/jev-1.13-20260917`, `typesafe/jev-1.14-20261014`, `anthropic/claude-haiku-5.5` and
`openai/gpt-6-luna` through OpenRouter (as recorded on the rows), 12 strategies, 5,520 decision
rows, 10,031 billed answers, no failed-open row. Track spend **$0.596** recorded (four pilots
$0.170, main run $0.426) of a $2.50 cap. Code: `experiments/e2e/t5-compound/`.

## Headline

- **Compounding works here, and only through a differently-wrong model.** On 260 held-out items
  where jev-1.13 alone is 85.8% right (81.0 to 89.5), the cascade jev-1.13 then haiku-5.5 (bar
  0.91, fitted on the fit split) is **98.5% (96.1 to 99.4)**: 34 items fixed, 1 broken (McNemar
  p < 0.0001). It is cheaper than haiku alone ($0.000106 against $0.000153 per decision) and
  faster at the median (619 ms against 1,183 ms), and it is the only strategy that met a 98%
  precision target on held-out (95.8% coverage at 98.8%). The mechanism is the one the vision
  describes: jev-1.13's confidence sorts (1 wrong in the 130 held-out items it stated at 0.91 or
  more) and the upper tier is wrong elsewhere (phi with jev-1.13 is 0.04, P(haiku wrong | Jev
  wrong) 5.4%).
- **Same-model compounding buys nothing, and two Jev versions are one model.** Three replicas:
  +0.8 points (4 fixed, 2 broken, p 0.69). Three framings: 0.0 (2 / 2). jev-1.13 + jev-1.14:
  0.0 (5 / 5). The two pins share 33 of jev-1.13's 37 errors (phi 0.785).
- **The measured correlation fixes calibration for near-duplicates and breaks it for a mixed
  ensemble.** Re-pooled at the rho measured on the fit split, log loss falls from 0.483 to 0.332
  (framings), 0.441 to 0.317 (replicas) and 0.331 to 0.306 (two Jev pins); no winner changed in
  3,120 re-pools. But for jev-1.13 + jev-1.14 + haiku the one mean phi (0.16, averaging a 0.58 pair
  with two -0.04 pairs) makes it worse (0.095 to 0.102). Pair-aware weights from the same phi
  matrix (w = R^-1 1) beat every scalar on accuracy, Brier and log loss: **97.7%, 0.019,
  0.076** (ECE 0.023, against 0.012 at rho 0).
- **The engine's default correlation for explicit members is 0, the most optimistic value.** The
  framing ensemble is three answers from one model (measured phi 0.81) pooled as three
  independent votes: mean confidence 0.946 at 85.8% accuracy, ECE 0.099 against 0.056 for a single
  call.
- **Sequential with a confidence bar saves half the calls at no detectable cost; lead-by-2 is
  broken by correlated members.** seq-bar used 2.10 samples per item against 3 for the fixed
  ensemble at -1.2 points (-3.1 to 0.4, 1 / 4, p 0.38) and half the cost. seq-lead stopped as soon
  as jev-1.13 and jev-1.14 agreed (178 of 260 items) and was wrong on 26 of those: -7.3 points
  against the fixed ensemble (0 / 19, p < 0.0001).
- **Disagreement is a valid but nearly useless bound, and the sentence the engine prints about it
  is wrong for compound gates.** jev-1.13 against jev-1.14 disagree on 5.4% while each is wrong on
  13 to 15%. jev-1.13 against haiku disagree on 13.8%, and `describeGrade` prints "at least 13.8%
  wrong on this slice" for a gate whose pooled verdict is wrong on 3.5%.
- **The "80% regime" had to be built.** On clean rule application with digested facts jev-1.13 is
  at 98 to 99% (two pilots, n = 500). Its errors live in raw arithmetic in free text, counting with
  open results, and rule exceptions over relational documents. The generative models are 94 to
  100% on exactly those.

## What ran

### Corpus: 460 new items, five domains, labels fixed by construction

`experiments/e2e/t5-compound/corpus-gen.ts` writes `corpus.json` (version `t5-final-1`, seed 9173,
`corpusHash` `c137a783...` as recorded in the manifest: the sha256 of the corpus as data). Each domain is one fixed rubric
registered as a gate (`gates.ts`), with the item-specific facts in the state, the way an
application registers a decision point:

| domain | gate question (kind) | families | what makes an item hard |
| --- | --- | --- | --- |
| contract | is the Party required to take the Action? (judge) | 8 clause families (incident notice, damaged goods, subcontracting, audit access, invoice dispute, data deletion, warranty, non-solicitation), 47 variants | exceptions to exceptions, role swaps, a negative wording of every clause, dated facts in three families |
| eligibility | does the applicant qualify? (judge) | 6 rule sets (extra shift, course, business class, grant, parental leave, lease), 38 variants | waiver scope, alternative routes, raw clock times, dates and dollar amounts |
| policy | does the request comply? (judge) | 6 policies (meals, call retention, production access, returns, merge approvals, vendor onboarding), 41 variants | who may approve, in advance or after, raw bills, dates and access windows |
| entail | does the passage establish the claim? (judge) | 3 families (closed, open results, a corrected result) over 4 themes, 20 claim forms | quantifiers, negation, ties and exact counts that hinge on an unreported result |
| multihop | which team answers the query? (pick of 4 fixed teams) | 3 families over a 15-sentence service map | a completed and a scheduled handover, a paused job, two rule exceptions, three-hop chains |

Every label is computed from the variant's facts by the decider's charter (the clause, rule or
policy applied exactly), with a one-line `why`, and written before any model saw the item.
Entailment labels are computed by enumerating every way the open results could turn out (the
claim is established only if true in all of them). Two items (both eligibility, one held-out)
are flagged ambiguous; every table is also reported without them.

Splits are a seeded shuffle within each domain: 40 fit and 52 held-out per domain (200 / 260).
Fit rows choose the cascade bars, the fitted act bars and the measured correlation; held-out
rows are the evaluation, read once.

**Numbers in two formats.** The charter asks for numbers and dates to be compared in code
wherever the application holds them as data; those items keep the digested form ("9 hours
(short of the 11-hour minimum)"). The rest give the value the way a requester writes it in free
text ("Previous shift ended: Monday at 22:30", "Bill: $288 for 4 people"), which the
application does not hold as data. Values are drawn near each threshold but never on it, so no
label rests on whether a boundary is inclusive. In the held-out split 104 items have raw
numbers, 29 digested, 23 none (contract), plus 52 entailment and 52 multihop.

### Calibrating to the 80% regime: four pilots, then a freeze

The first corpus was far too easy. Four pilots (250 items each, fit-equivalent, never part of
the evaluation, each corpus file kept as the record of its run) measured jev-1.13, jev-1.14 and
haiku-5.5:

| pilot | generator change | jev-1.13 | jev-1.14 | haiku-5.5 | spend |
| --- | --- | --- | --- | --- | --- |
| 1 (`pilot-corpus.json`) | digested facts, plain wording | 98.4% | 98.4% | 98.0% | $0.039 |
| 2 (`pilot2-corpus.json`) | + negative wording of every rule, an irrelevant-but-salient fact per item, 20 claim forms, 14-sentence maps | 99.2% | 99.6% | 98.8% | $0.042 |
| 3 (`pilot3-corpus.json`) | + raw numbers in free text (half of numeric facts), boundary-selected claims | 93.2% | 94.0% | 97.2% | $0.044 |
| 4 (`pilot4-corpus.json`) | + dated contract facts, multihop rule exceptions, 85% raw | 90.4% | 90.4% | 96.0% | $0.045 |

The final mix was then frozen by structure, not by any model's answer to any item: 90% of
numeric facts raw, the three dated contract families, the open-result entailment family, the
multihop incident and three-hop families and the counting claims at weight 2, the
non-numeric merge-approval policy at 0.5. Pilot 1 exposed one generator bug (a supplier that
"has not responded" has not signed, so it is not an open result); all three models disagreed
with that label and were right. It is recorded in `corrections.json`, the theme was rephrased
before pilot 2, and no label in the evaluation corpus has been corrected. Each pilot corpus
file is the record of its run; they were drawn by earlier versions of the generator and the
current code regenerates only `corpus.json` (checked byte for byte).

That calibration is itself the first result: **on clean rule application with digested facts,
jev-1.13 is at the ceiling (98 to 99%, n = 500 over two pilots)**. The 80% regime exists, but
it is made of arithmetic over raw values, counting with open results, and rule exceptions over
long relational documents. Those are the structures this corpus upweights, and they are not
the same structures for every model, which matters for every claim below.

### Strategies, each through the real engine

`strategies.ts`; every strategy is a gate's `strategy` in its own `Engine` (shadow mode,
`keepState`, a `budgetUsd` cap, `timeoutMs` 60 s) writing its own `JsonlLedger`, so every row
carries `members` and `detail` as a user's would. One engine per strategy, the same five gates
in each.

| strategy | spec | calls per item |
| --- | --- | --- |
| single-jev113, single-jev114, single-haiku, single-luna | default oracle, no strategy | 1 |
| rep3-jev113 | `{ ensemble: { k: 3 } }` (engine default correlation 0.75) | 3 |
| framing3-jev113 | explicit members: original, paraphrase, negated with `negated: true` (judge) or shuffled options (pick); default correlation 0 | 3 |
| diverse2 | explicit members jev-1.13 + jev-1.14; default correlation 0 | 2 |
| diverse3 | + haiku-5.5; default correlation 0 | 3 |
| cascade-haiku, cascade-luna | tiers jev-1.13 (bar fitted on fit, frozen in the manifest) then the generative model | 1 + escalations |
| seq-bar | `sequential` over jev-1.13, jev-1.14, haiku-5.5, `settleAbove` 0.95, `maxSamples` 3 | 1 to 3 |
| seq-lead | the same plus `settleLead` 2 (not in `StrategySpec`'s type; finding T5-10) | 1 to 3 |

The cascade bar is the tier-1 confidence that maximises the cascade's accuracy on the fit split,
read from the two single ledgers (the most favourable bar for the cascade the fit split can
justify); it was frozen into `manifest.json` before any phase-2 call.

**Labels.** After each strategy's asks, every row was labelled from the corpus with source
`review:blind:decider` (`labelAsDecider`); for single-jev113 a seeded sample of 20 contract rows
went through the real `ratchet review` path first (`blindReview`, 20 answered, 0 missing).

**Analysis** (`analyze.ts`) reads only the ledgers, with the engine's readers:
`memberCorrelation`, `fitThreshold`, `coverageAt`, `ece`, `brier`, `pool`, `gradeOf` and
`describeGrade`. Paired comparisons use an exact McNemar test on discordant items and a paired
percentile bootstrap (2,000 resamples, seed 17).

## Results

All tables are held-out (n = 260, paired: every strategy answered every item) unless marked.
The full output, including the fit split and every table without the one held-out ambiguous
item (no conclusion changes; the largest shift is 0.4 points), is
`<run dir>/results.md` and `results.json`.

### Every strategy

| strategy | accuracy (95% CI) | mean conf | ECE | Brier | cost / decision | latency p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| single-jev113 | 85.8% (81.0 to 89.5) | 0.839 | 0.056 | 0.096 | $0.000021 | 103 / 165 |
| single-jev114 | 83.1% (78.0 to 87.1) | 0.831 | 0.075 | 0.092 | $0.000021 | 102 / 162 |
| single-haiku | 96.5% (93.6 to 98.2) | 0.914 | 0.062 | 0.034 | $0.000153 | 1,183 / 1,944 |
| single-luna | 97.7% (95.1 to 98.9) | 0.989 | 0.012 | 0.021 | $0.000080 | 2,758 / 3,718 |
| rep3-jev113 | 86.5% (81.9 to 90.2) | 0.864 | 0.039 | 0.092 | $0.000062 | 119 / 235 |
| framing3-jev113 | 85.8% (81.0 to 89.5) | 0.946 | 0.099 | 0.108 | $0.000062 | 122 / 197 |
| diverse2 (1.13 + 1.14) | 85.8% (81.0 to 89.5) | 0.918 | 0.061 | 0.096 | $0.000041 | 112 / 167 |
| diverse3 (+ haiku) | 96.5% (93.6 to 98.2) | 0.961 | 0.012 | 0.027 | $0.000192 | 1,183 / 2,108 |
| cascade-haiku | **98.5% (96.1 to 99.4)** | 0.927 | 0.059 | **0.020** | $0.000106 | 619 / 2,048 |
| cascade-luna | 97.7% (95.1 to 98.9) | 0.968 | 0.013 | 0.023 | $0.000063 | 176 / 3,862 |
| seq-bar | 95.4% (92.1 to 97.3) | 0.955 | 0.029 | 0.041 | $0.000097 | 212 / 1,951 |
| seq-lead | 89.2% (84.9 to 92.4) | 0.931 | 0.039 | 0.081 | $0.000047 | 199 / 1,335 |

By domain, jev-1.13 is 92.3% on contract and policy, 90.4% on entailment, and 76.9% on
eligibility and multihop. By fact format it is 100% on digested numbers with plain wording
(n 20) and 78.7 to 84.2% on raw numbers (n 104), while haiku and luna are 95.7 to 98.2% on raw
numbers. jev-1.14 is 65.4% on multihop.

### Paired against single jev-1.13

| strategy | fixed / broken | McNemar p | delta accuracy, points (95% CI) | delta ECE | delta Brier |
| --- | --- | --- | --- | --- | --- |
| single-jev114 | 4 / 11 | 0.12 | -2.7 (-5.8 to 0.0) | +0.019 | -0.005 |
| single-haiku | 35 / 7 | < 0.0001 | +10.8 (6.2 to 15.4) | +0.005 | -0.063 |
| single-luna | 35 / 4 | < 0.0001 | +11.9 (7.7 to 16.5) | -0.044 | -0.075 |
| rep3-jev113 | 4 / 2 | 0.69 | +0.8 (-0.8 to 2.7) | -0.017 | -0.004 |
| framing3-jev113 | 2 / 2 | 1.00 | 0.0 (-1.5 to 1.5) | +0.043 | +0.012 |
| diverse2 | 5 / 5 | 1.00 | 0.0 (-2.7 to 2.3) | +0.005 | 0.000 |
| diverse3 | 28 / 0 | < 0.0001 | +10.8 (7.3 to 14.6) | -0.044 | -0.069 |
| cascade-haiku | 34 / 1 | < 0.0001 | +12.7 (8.8 to 16.9) | +0.003 | -0.077 |
| cascade-luna | 35 / 4 | < 0.0001 | +11.9 (7.3 to 16.5) | -0.043 | -0.074 |
| seq-bar | 27 / 2 | < 0.0001 | +9.6 (5.8 to 13.5) | -0.027 | -0.056 |
| seq-lead | 10 / 1 | 0.012 | +3.5 (1.2 to 6.2) | -0.017 | -0.015 |

The comparisons the claims turn on:

| A vs B | A fixed / broken | McNemar p | delta accuracy, points (95% CI) | delta Brier |
| --- | --- | --- | --- | --- |
| diverse2 vs single-jev114 | 8 / 1 | 0.039 | +2.7 (0.4 to 5.0) | +0.004 |
| diverse3 vs single-haiku | 7 / 7 | 1.00 | 0.0 (-2.7 to 2.7) | -0.007 |
| cascade-haiku vs single-haiku | 6 / 1 | 0.13 | +1.9 (0.0 to 4.2) | -0.014 |
| cascade-haiku vs diverse3 | 6 / 1 | 0.13 | +1.9 (0.0 to 4.2) | -0.007 |
| cascade-haiku vs single-luna | 3 / 1 | 0.63 | +0.8 (-0.8 to 2.3) | -0.002 |
| cascade-luna vs single-luna | 5 / 5 | 1.00 | 0.0 (-2.3 to 2.7) | +0.001 |
| seq-bar vs diverse3 | 1 / 4 | 0.38 | -1.2 (-3.1 to 0.4) | +0.014 |
| seq-lead vs diverse3 | 0 / 19 | < 0.0001 | -7.3 (-10.4 to -4.2) | +0.054 |
| seq-lead vs seq-bar | 3 / 19 | 0.0009 | -6.2 (-9.6 to -2.7) | +0.041 |

### Coverage at a fixed precision target (bar fitted on fit, applied once to held-out)

`fitThreshold(scored fit rows, target, 20)`; the conservative (Wilson) mode found no 0.98 bar
for any strategy on 200 fit items. Cells: share of held-out items at or above the bar, at the
precision realised there.

| strategy | target 0.95 | target 0.98 |
| --- | --- | --- |
| single-jev113 | 88.8% at 90.0% (bar 0.61) | 57.7% at 98.0% (bar 0.87) |
| single-jev114 | 88.1% at 90.4% | 73.8% at 96.9% (missed) |
| single-haiku | 98.5% at 96.9% | 98.5% at 96.9% (missed) |
| single-luna | 100% at 97.7% | 100% at 97.7% (missed) |
| rep3-jev113 | 90.0% at 90.6% | 67.7% at 96.6% (missed) |
| framing3-jev113 | 86.2% at 91.1% | 56.9% at 97.3% (missed) |
| diverse2 | 92.7% at 89.2% | 56.9% at 98.6% |
| diverse3 | 100% at 96.5% | 94.2% at 98.0% |
| cascade-haiku | 100% at 98.5% | **95.8% at 98.8%** |
| cascade-luna | 98.5% at 98.0% | 11.5% at 100% (bar 0.99) |
| seq-bar | 100% at 95.4% | 55.4% at 97.9% (missed) |
| seq-lead | 94.2% at 91.4% | 71.2% at 96.8% (missed) |

Every 0.95 bar fitted on fit undershot on held-out for the Jev-only strategies (89 to 91%
delivered): fit accuracy was 89.5% against 85.8% held-out, so this is the fit-to-held-out
shift of a 200-item fit split, not a defect of the fit. The generative models' confidences are
pinned high (luna's mean confidence 0.989), so their bars cannot sort; a cascade inherits
jev-1.13's sorting and the upper tier's accuracy, which is why it alone met 0.98.

### Correlation, as the engine measures it

`memberCorrelation` over each compound ledger's fit rows (judge gates; it reads no pick rows):

| ledger | pairs (phi, n) | mean |
| --- | --- | --- |
| rep3-jev113 | replicas 0.91, 0.85, 0.86 (160 each) | 0.872 |
| framing3-jev113 | orig~para 0.77, orig~neg 0.75, para~neg 0.91 (160) | 0.811 |
| diverse2 | jev113~jev114 0.54 (160) | 0.542 |
| diverse3 | jev113~jev114 0.58, jev113~haiku -0.04, jev114~haiku -0.04 (160) | 0.165 |
| cascade-haiku | jev113~haiku -0.08 (68: escalated rows only) | -0.084 |
| seq-bar | jev113~jev114 0.60 (110), jev113~haiku 0.18 (36), jev114~haiku -0.19 (36) | 0.195 |

From the single ledgers on held-out: jev-1.13~jev-1.14 0.785 (37 / 44 errors, 33 shared),
jev~haiku 0.03 to 0.04, jev~luna 0.07 to 0.08, haiku~luna 0.53. On the pick gate (computed by
this track) replicas 0.56 to 0.74, framings 0.71 to 0.83, jev113~jev114 0.63, and every pair with
haiku or luna undefined because neither was ever wrong there. The same pair measured on the fit
split and on held-out differs by up to 0.32 (diverse2: 0.54 against 0.86): with 20 to 30 errors
behind each phi, rho is a noisy quantity at this sample size.

**Replicas are not bit-identical** on these items: the three replicas gave the same leading
answer on 247 of 260 rows (95.0%) and exactly the same probability on 66 (25.4%), with a mean
max-minus-min spread of 0.035; replica 1 matched a separate single-jev113 request's leading
answer on 253 of 260 (97.3%). Earlier runs on BoolQ found zero flips on 40 repeats; on items near
0.5 Jev does flip, but the flips are coin tosses, not information (+0.8 points, p 0.69).

### Re-pooling the recorded member answers at a stated correlation

`pool()` over each held-out row's members; "measured" is the fit-split `memberCorrelation` mean;
"best-fit" minimises fit-split log loss on a 0.05 grid.

| ensemble | rho 0 | rho 0.75 | measured | best-fit | winners changed |
| --- | --- | --- | --- | --- | --- |
| rep3-jev113 | ECE 0.085, LL 0.441 | 0.039, 0.314 | (0.87) 0.030, 0.317 | (0.55) 0.036, 0.316 | 0 |
| framing3-jev113 | **0.099, 0.483** (engine default) | 0.037, 0.332 | (0.81) 0.042, 0.332 | (0.55) 0.042, 0.337 | 0 |
| diverse2 | **0.061, 0.331** (engine default) | 0.041, 0.309 | (0.54) 0.027, 0.306 | (0.35) 0.035, 0.307 | 0 |
| diverse3 | **0.012, 0.095** (engine default) | 0.086, 0.162 | (0.16) 0.034, 0.102 | (0.05) 0.012, 0.096 | 0 |

`repool-weights.ts` on diverse3, with weights w = R^-1 1 from the fit-split phi matrix (0.634,
0.634, 1.0 for jev113, jev114, haiku) instead of a scalar: **accuracy 97.7%, ECE 0.023, Brier
0.019, log loss 0.076**, against 96.5%, 0.012, 0.027, 0.095 at rho 0, and 0.057 ECE / 0.132 log
loss at rho 0.5 (the default the evidence-grades design proposes for a second opinion).

### Cascades

Tier-1 bar 0.91 for both (the bar that maximised fit-split accuracy from the single ledgers;
on fit it escalated 45.5% and gave 98.0% with haiku and 98.5% with luna, in-sample).

| cascade | escalated | tier 1 / tier 2 right on the escalated items | kept at tier 1: wrong | cascade | upper tier alone |
| --- | --- | --- | --- | --- | --- |
| jev-1.13 then haiku | 130 (50.0%) | 71.5% / 97.7% | 1 of 130 | 98.5% | 96.5% |
| jev-1.13 then luna | 128 (49.2%) | 74.2% / 96.1% | 1 of 132 | 97.7% | 97.7% |

A bar sweep from the single ledgers (no new calls) gives the shape: escalating 19% already
reaches 93%, 47% reaches 96.9 to 97.3%, and escalating everything is the upper tier alone.
The cascade's own ledger pairs the tiers only on escalated rows: `memberCorrelation` gives
-0.08 (68 fit rows) and 0.17 (held), against 0.04 for the same pair on all held-out items and
0.005 on the same escalated items from the single ledgers.

### Sequential

| strategy | mean samples | stopped after 1 / 2 / 3 | wrong among those | accuracy | haiku calls | cost |
| --- | --- | --- | --- | --- | --- | --- |
| seq-bar (settleAbove 0.95) | 2.10 | 65 / 103 / 92 | 1 / 3 / 8 | 95.4% | 92 | $0.000097 |
| seq-lead (+ settleLead 2) | 1.82 | 65 / 178 / 17 | 1 / 26 / 1 | 89.2% | 17 | $0.000047 |
| diverse3 (fixed, same members) | 3.00 | 0 / 0 / 260 | | 96.5% | 260 | $0.000192 |

### Disagreement as a label-free bound

| pair | disagree (95% CI) | error A / B | at least one wrong | both wrong | gate's own error | what `describeGrade` prints |
| --- | --- | --- | --- | --- | --- | --- |
| jev-1.13 vs jev-1.14 (diverse2 rows) | 5.4% (3.2 to 8.8) | 12.7% / 14.6% | 16.2% | 11.2% | 14.2% | "at least 5.4% wrong on this slice" |
| jev-1.13 vs haiku (diverse3 rows) | 13.8% (10.2 to 18.6) | 13.1% / 3.1% | 15.0% | 1.2% | 3.5% | "at least 13.8% wrong on this slice" |
| jev-1.14 vs haiku (diverse3 rows) | 16.2% (12.2 to 21.1) | 15.4% / 3.1% | 17.3% | 1.2% | 3.5% | "at least 16.2% wrong on this slice" |

A three-judge label-free estimate that assumes conditionally independent errors (agreement
equations) put jev-1.13 at 1.3% and haiku at 11.5% wrong, against 11.5% and 3.8% true: with
two correlated judges it assigns the shared errors to the odd one out.

## Claim verdicts

| claim | verdict | evidence (held-out, n = 260) |
| --- | --- | --- |
| Replicas of one model are about one vote | **proved** | rep3 +0.8 points (4 / 2, p 0.69) at 3x cost; replica phi 0.85 to 0.91; leading answers identical on 95%. Same for framings of one model (0.0, 2 / 2, phi 0.75 to 0.91). |
| Different models add evidence | **proved for a differently-wrong model, disproved for a second Jev version** | + haiku: 28 / 0, +10.8 points; jev-1.13 + jev-1.14: 5 / 5, 0.0 (phi 0.785). Adding two Jevs to haiku: 7 / 7 accuracy, ECE 0.062 to 0.012. |
| Different framings add evidence | **disproved** on Jev | framing3 0.0 points; ECE worse at the engine's default (0.056 to 0.099). |
| The design-effect correction with a measured rho improves calibration without changing winners | **proved without changing winners; proved for same-model members; disproved for mixed members** | 0 winners changed in 3,120 re-pools. Log loss 0.483 to 0.332 (framings), 0.441 to 0.317 (replicas), 0.331 to 0.306 (two pins); 0.095 to 0.102 worse for diverse3, where pair-aware weights reach 0.076 and change 3 winners for the better. |
| Cascades gain little unless the upper tier is differently wrong | **proved (the converse: here it is differently wrong, and the cascade gains most)** | phi(jev, haiku) 0.04; cascade +12.7 points (34 / 1), best accuracy and the only 0.98 target met, at 69% of the upper tier's cost. The BoolQ cascade gained nothing at phi 0.58. |
| Sequential sampling stops early at the same accuracy | **supported for a confidence bar (inconclusive at this n); disproved for lead-by-k with correlated members** | seq-bar 2.10 samples, -1.2 points (-3.1 to 0.4) against the fixed 3-member ensemble at half the cost; seq-lead -7.3 points (0 / 19). |
| Two independent judges' disagreement is a label-free error bound | **true as stated, misleading as printed** | The rate bounds "at least one judge wrong" (5.4% against 16.2%; 13.8% against 15.0%), never the gate's error: the printed "at least 13.8% wrong" sits on a gate that is 3.5% wrong. Two Jev pins are not independent judges. |

**Default for a user who says cost is no constraint and wants the best decisions:** a cascade
from jev-1.13 to a generative model of a different family, with the tier-1 bar fitted on
labelled shadow rows and the tiers' error correlation measured on a sample where the upper tier
answered every item (not from the cascade's own ledger). Here that is jev-1.13 then
haiku-5.5 at 0.91: 98.5% held-out, the only strategy that met a 98% precision target, cheaper
and faster at the median than the upper tier alone. Its lead over single luna (+0.8, p 0.63) and
single haiku (+1.9, p 0.13) is not established at n = 260; what is established is that it is far
better than anything built from Jev alone, and that no replica, framing or Jev-version ensemble
should be the default. Not the engine's `{ ensemble: { k: 3 } }`, which buys calibration
(rho 0.75 sharpens an underconfident model by luck) and nothing else.

## Findings

Most important first. Categories: engine bug, design gap, Jev limitation, docs mismatch,
ergonomics, harness issue.

**T5-01. Explicit-member ensembles default to correlation 0.** High, design gap.
`src/engine.ts:651` and `:667`: `pool.correlation ?? (members ? 0 : 0.75)`. Replicas spelled
`{ k: 3 }` get 0.75; the same model listed as `members` gets 0, the most optimistic value, though
`docs/vision.md:81` says "when there is none [measured], default to pessimism". Live: the framing
ensemble (one model, measured phi 0.81) has mean confidence 0.946 at 85.8% accuracy, ECE 0.099
against 0.056 for one call and 0.042 at the measured rho; jev-1.13 + jev-1.14 (phi 0.54 to
0.79) ECE 0.061 against 0.027. Repro: `bun experiments/e2e/t5-compound/repro/explicit-members-default.ts`
(three identical 0.8 answers: 0.985 as members, 0.841 as `k: 3`; one clears a 0.95 bar, the
other does not). Fix: in `engine.ts` `decide()`, default explicit members that share an oracle
id or a model pin to 0.75 like replicas, and require or warn for a stated correlation otherwise
(record `correlationSource: "default" | "caller"` in `detail`); `docs/architecture.md:357` to
say so. Do not adopt a blanket 0.5 for different models: on diverse3 it raises log loss from
0.095 to 0.132 (T5-02).

**T5-02. One scalar correlation cannot pool a mixed ensemble; the measured mean makes it worse.**
High, design gap. `src/compound/aggregate.ts` (`PoolOptions.correlation`, `shrink`) and
`src/ledger/calibration.ts:464` (`memberCorrelation` returns pairs and their mean). With two
near-duplicates and one independent member (pairs 0.58, -0.04, -0.04; mean 0.165), re-pooling at
the mean worsens held-out log loss (0.095 to 0.102) and ECE (0.012 to 0.034); any uniform shrink
discounts the independent member as much as the duplicates. Weights w = R^-1 1 from the same
fit-split phi matrix give 97.7% accuracy (from 96.5%), Brier 0.019 (from 0.027), log loss 0.076
(ECE 0.023 against 0.012: the weights fix winners, not the shrink).
Repro: `bun experiments/e2e/t5-compound/repool-weights.ts <run dir>`. Fix: let `pool` take a
pairwise correlation matrix keyed by member key (or a `MemberCorrelation`) and derive weights
w = R^-1 1 plus the generalised design effect n_eff = n^2 / (1' R 1); make the ensemble path use
it when given; document in `memberCorrelation` that `mean` is right only for exchangeable
members. Note the weights can change winners, so this is a policy-relevant change (bump
`evidenceVersion`).

**T5-03. `describeGrade`'s disagreement sentence reads as the gate's error rate; the reader the
design promises does not exist.** Medium, docs mismatch / design gap.
`src/ledger/evidence.ts:408` prints "at least N% wrong on this slice"; `docs/design/evidence-grades.md:51-53`
calls the rate "a lower bound on the pair's error rate". Live, for a gate whose decision is the
pooled jev-1.13 + jev-1.14 + haiku verdict (3.5% wrong), the jev-1.13 vs haiku rate prints "at
least 13.8% wrong on this slice"; for the two Jev pins it prints 5.4% while each is 13 to 15%
wrong (union 16.2%), because they share 89% of errors. `checkBorrowed` (`evidence.ts:350`)
accepts any two different strings, so `typesafe/jev-1.13-*` and `typesafe/jev-1.14-*` pass as "two
different models". WP4's `disagreement(rows)`, `secondOpinion` and `check --max-disagreement`
are not implemented, so the caller computes the rate by hand. Repro:
`bun experiments/e2e/t5-compound/repro/disagreement-sentence.ts` (gate 0% wrong, sentence says
at least 30%). Fix: reword to "the two judges disagree on N%: at least one of them is wrong that
often; this is not this gate's error rate"; carry which member (or the pooled verdict) is the
gate's decision; implement `disagreement(rows)` in `calibration.ts` reading members by key; warn
when the two pins share a vendor/model family; correct the design doc's "pair's error rate" to
"the share of rows where at least one judge is wrong".

**T5-04. `sequential` ignores `Member.negated`.** Medium, engine bug.
`src/compound/sequential.ts:74` pushes the member's raw verdict; `ensemble` flips a negated
member back (`src/compound/ensemble.ts:87`, `untransform`). The same `Member[]` therefore means
opposite things in the two strategies, silently: a consistent oracle's 0.9 and its negation's 0.1
pool to 0.5 in `sequential` and 0.988 in `ensemble`, and the ledger records the unflipped 0.1 as
a member answer, which then corrupts `memberCorrelation`. Repro:
`bun experiments/e2e/t5-compound/repro/sequential-negated.ts`. Fix: export `untransform` from
`ensemble.ts` and apply it in `sequential.ts` (with `m.negated === true`); add a test that
`sequential` and `ensemble` agree on the same members.

**T5-05. Lead-by-k counts correlated votes as independent.** Medium, design gap.
`src/compound/sequential.ts:86-91`; `docs/architecture.md:404` presents `settleLead` as
"first-to-ahead-by-k" (the MAKER rule, which relies on independent samples). With members ordered
jev-1.13, jev-1.14, haiku, seq-lead stopped at two samples on 178 of 260 items whenever the two
Jev pins agreed, and was wrong on 26 of those (14.6%); -7.3 points against the fixed ensemble
(0 / 19, p < 0.0001) and -6.2 against the same run with only the confidence bar (3 / 19). Fix: in
`sequential.ts` count the lead in effective votes (discount by the design effect at the stated
correlation) or across distinct model keys only; document that the lead rule needs independent
members and that member order should put the most different member second.

**T5-06. `memberCorrelation` turns "no information" into "independent".** Medium, engine bug.
`src/ledger/calibration.ts:417` returns 0 when a member's correctness has no variance, and
`memberCorrelation` averages that 0 into `mean`, though its own doc comment says a missing pair is
absent "rather than 0, which would read as independence". Repro:
`bun experiments/e2e/t5-compound/repro/member-correlation-gaps.ts` (three identical replicas,
never wrong: every pair 0, mean 0, so a user pooling at the measured rho counts them as three
votes). Live, every pair with haiku or luna on the multihop gate had no errors to correlate.
Fix: return `undefined` from `errorCorrelation` when the denominator is 0, list such pairs with
`correlation: undefined` (or `degenerate: true`) and leave them out of `mean`.

**T5-07. `memberCorrelation` reads no pick or rate rows.** Medium, design gap.
`src/ledger/calibration.ts:471` (row needs a boolean truth) and `:475` (member must be a judge).
On the 92-item pick gate every compound ledger returns `n 0` and no pairs, so a pick ensemble's
rho cannot be measured from the ledger at all; this track computed 0.56 to 0.83 for the same-model
pick ensembles by hand. Repro: `member-correlation-gaps.ts` part 2. Fix: score a pick member by
`choice === truth` and a rate member by `level === truth` when `truth` is a string; same in
`inheritOutcome`.

**T5-08. jev-1.14 is not a second opinion for jev-1.13.** Medium, Jev limitation.
Held-out phi 0.785; 33 of jev-1.13's 37 errors are jev-1.14 errors; jev-1.14 is 2.7 points worse
(4 / 11, p 0.12) and 65.4% on multihop; pooling them gains nothing (5 / 5). In the first pilot
the two returned the same probability on 109 of 250 items. Fix: say so in
`docs/live-findings.md` and in WP4's second-opinion guidance (require a different model family,
not a different pin).

**T5-09. A cascade's own ledger cannot tell whether the cascade is worth it.** Low, docs mismatch.
`docs/live-findings.md` ("A cascade is only worth building when the ledger shows the upper tier
is more accurate on that question and its errors are not the same errors"). A cascade's rows pair
the tiers only on escalated items (68 of 160 fit rows here), and the value moved from -0.08 (fit)
to 0.17 (held) against 0.04 on all items from the single ledgers. Fix: document measuring tier
correlation on a shadow sample where the upper tier answers every item (a two-member ensemble
or audit), and note in `memberCorrelation`'s comment that cascade pairs are conditional on
escalation.

**T5-10. `settleLead` is honoured through a gate but rejected by its type.** Low, ergonomics.
`src/engine.ts:81` (`StrategySpec`'s sequential variant has no `settleLead`); the engine passes
unknown pool fields through to `sequential()`, so it works if the type is widened. Repro:
`bun experiments/e2e/t5-compound/repro/settle-lead-type.ts` (the `@ts-expect-error` is used, and
the run stops at 2 samples instead of 4). Fix: add `readonly settleLead?: number` to the
sequential spec and pass it explicitly in `decide()`.

**T5-11. Confirmed: Jev's confidence sorts, and its errors are where the docs say.** Confirmation
(Jev characterisation). On digested rule application jev-1.13 is at 98 to 99% (pilots 1 and 2,
n = 500); its held-out errors are raw arithmetic (78.7 to 84.2% on raw numbers against 100% on
digested plain items), relational rule exceptions (76.9% on multihop) and counting with open
results (90.4%), and 36 of 37 sit at confidence 0.42 to 0.88: 1 wrong in the 130 items stated at
0.91 or more. "Digest numbers in code" is the right advice, and a fitted bar plus escalation is
the right use of the residue. Replicas do flip on near-0.5 items (5% of rows here, against
zero in 40 BoolQ repeats in `docs/live-findings.md:33`), without adding accuracy.

No harness issue in `lib.ts` affected this track; `guard()` and the per-strategy `budgetUsd` held
(no strategy came near its cap).

## Limits

- **n.** 260 held-out items give accuracy intervals of plus or minus 2 to 5 points. The cascade's
  edge over the best single generative model (+0.8 and +1.9 points) and sequential's loss
  against the fixed ensemble (-1.2) are inside the noise. A 0.98 target cannot be validated
  with a Wilson bound on 200 fit items (no strategy got a conservative 0.98 bar).
- **The regime was built for Jev.** The corpus upweights the structures Jev gets wrong (raw
  arithmetic, counting, rule exceptions), chosen by structure from pilots that measured all three
  models, never by per-item answers. On those structures the generative models are strong, so
  this corpus favours escalation to them. On a corpus where the generative models are also at
  80%, or wrong where Jev is (BoolQ: phi 0.58), the cascade result would not carry over; the
  correlation measurement, not this result, is what transfers.
- **Labels are synthetic.** They are computed from templates by the charter, with no ambiguity
  beyond two flagged items; the coordinator's blind relabel of `spotcheck.json` is the check on
  them. Real requests are messier.
- **One run per strategy.** Jev's run-to-run flips (5% of replicated rows) mean each Jev-only
  strategy's accuracy carries about a point of request noise beyond sampling noise.
- **Fit-split rho is noisy** (up to 0.32 between fit and held-out for one pair), so "measured"
  and "best-fit" pooling results are one draw.
- **Not tested:** decomposition batteries (`combine`), learned pooling, `pool` inside a cascade,
  rate questions, and the Jev batch effect (every request here held one question).

## Reproduce

```
bun experiments/e2e/t5-compound/corpus-gen.ts final        # rewrites corpus.json and spotcheck.json (same seed, same bytes)
bun experiments/e2e/t5-compound/main.ts --offline           # SimOracle backends, no spend, same wiring
bun experiments/e2e/t5-compound/main.ts                     # live: phase 1, frozen bars, phase 2 (about 13 minutes, $0.43)
bun experiments/e2e/t5-compound/analyze.ts <run dir>        # results.md and results.json from the ledgers
bun experiments/e2e/t5-compound/repool-weights.ts <run dir> # pair-aware pooling (T5-02)
bun experiments/e2e/t5-compound/pilot-summary.ts <run dir> pilot4-corpus.json
bun experiments/e2e/t5-compound/repro/<name>.ts             # sequential-negated, member-correlation-gaps,
                                                            # explicit-members-default, settle-lead-type,
                                                            # disagreement-sentence
```

`main.ts --resume=<run dir>` continues a run that stopped, keeping its manifest and frozen bars;
`--only=a,b` runs a subset; `--corpus=<file>` runs a pilot corpus. Every live phase calls
`guard()` and checks this track's own recorded spend against its $2.50 cap.

## Addendum (2026-11-12): two keys on the act side

The foundations review ([report](../../reports/Foundations%20review%202026-11.md)) proposed "two
keys", acting only when a second model family would also act, as a default for gates. This
tests it on this run's recorded answers (the run directory named at the top), offline and with
no calls:

```
bun experiments/e2e/t5-compound/pooling-review.ts <run directory>
```

The same script compares the shipped pool with pooling weights fitted from the within-class
logit correlation, which were measured and not shipped (see `pool()` in
[architecture.md](../architecture.md#compounding-mechanically)).

The T5 judge gates act on yes: the policy is `{ actAbove: 0.95 }` with no `goIsYes` (main.ts),
and the rows' own `go` says the same (`inferGoIsYes` over 368 judge rows: go is yes). Each
strategy's go probability is p(yes) for one member or pool; "two keys" is the smaller go of the
members named; "unanimous lean" acts only when every member leans go, at the smallest go, else
never. Acting is right when the truth is the go side: 91 of 208 held-out items, so 43.8% is the
most any strategy can act on without a wrong act. Cells: share of held-out items acted on
(count), wrong acts, act precision and its exact one-sided 95% lower bound (`exactLowerBound`).

Bars fitted on the fit split with `fitThreshold(act-side rows, target, 20)`, point estimate and
conservative (Wilson) mode, applied once to held-out:

| strategy | target 0.95 | 0.95 conservative | target 0.98 | 0.98 conservative |
| --- | --- | --- | --- | --- |
| jev-1.13 alone | bar 0.65: 38.5% acted (80), 7 wrong, 91.3% (lower 84.2%) | no bar | bar 0.72: 35.1% acted (73), 4 wrong, 94.5% (lower 87.9%) | no bar |
| haiku-5.5 alone | bar 0.35: 44.2% acted (92), 4 wrong, 95.7% (lower 90.3%) | no bar | bar 0.70: 41.3% acted (86), 2 wrong, 97.7% (lower 92.9%) | no bar |
| log-odds, rho 0 | bar 0.13: 46.2% acted (96), 7 wrong, 92.7% (lower 86.7%) | bar 0.83: 38.5% acted (80), 0 wrong, 100.0% (lower 96.3%) | bar 0.52: 41.3% acted (86), 1 wrong, 98.8% (lower 94.6%) | no bar |
| shipped matrix (phi, GLS) | bar 0.14: 47.6% acted (99), 10 wrong, 89.9% (lower 83.5%) | no bar | bar 0.50: 41.8% acted (87), 1 wrong, 98.9% (lower 94.7%) | no bar |
| two keys: jev-1.13 and haiku-5.5 | bar 0.13: 48.6% acted (101), 12 wrong, 88.1% (lower 81.5%) | bar 0.35: 39.4% acted (82), 0 wrong, 100.0% (lower 96.4%) | bar 0.30: 40.4% acted (84), 0 wrong, 100.0% (lower 96.5%) | no bar |
| two keys: all three members | bar 0.13: 47.6% acted (99), 12 wrong, 87.9% (lower 81.1%) | bar 0.31: 39.4% acted (82), 0 wrong, 100.0% (lower 96.4%) | bar 0.30: 39.4% acted (82), 0 wrong, 100.0% (lower 96.4%) | no bar |
| unanimous lean: all three members | bar 0.50: 36.5% acted (76), 0 wrong, 100.0% (lower 96.1%) | no bar | bar 0.50: 36.5% acted (76), 0 wrong, 100.0% (lower 96.1%) | no bar |
| recorded cascade jev-1.13 then haiku-5.5 | bar 0.20: 44.7% acted (93), 4 wrong, 95.7% (lower 90.4%) | no bar | bar 0.92: 36.5% acted (76), 0 wrong, 100.0% (lower 96.1%) | no bar |

Fixed bars, no fitting noise:

| strategy | bar 0.7 | bar 0.8 | bar 0.9 |
| --- | --- | --- | --- |
| jev-1.13 alone | 37.5% acted (78), 6 wrong, 92.3% (lower 85.4%) | 28.8% acted (60), 2 wrong, 96.7% (lower 89.9%) | 22.6% acted (47), 0 wrong, 100.0% (lower 93.8%) |
| haiku-5.5 alone | 41.3% acted (86), 2 wrong, 97.7% (lower 92.9%) | 40.9% acted (85), 2 wrong, 97.6% (lower 92.8%) | 36.1% acted (75), 2 wrong, 97.3% (lower 91.8%) |
| log-odds, rho 0 | 39.9% acted (83), 0 wrong, 100.0% (lower 96.5%) | 38.5% acted (80), 0 wrong, 100.0% (lower 96.3%) | 38.0% acted (79), 0 wrong, 100.0% (lower 96.3%) |
| shipped matrix (phi, GLS) | 39.4% acted (82), 0 wrong, 100.0% (lower 96.4%) | 38.5% acted (80), 0 wrong, 100.0% (lower 96.3%) | 38.0% acted (79), 0 wrong, 100.0% (lower 96.3%) |
| two keys: jev-1.13 and haiku-5.5 | 33.2% acted (69), 0 wrong, 100.0% (lower 95.8%) | 26.4% acted (55), 0 wrong, 100.0% (lower 94.7%) | 18.8% acted (39), 0 wrong, 100.0% (lower 92.6%) |
| two keys: all three members | 31.7% acted (66), 0 wrong, 100.0% (lower 95.6%) | 25.0% acted (52), 0 wrong, 100.0% (lower 94.4%) | 17.8% acted (37), 0 wrong, 100.0% (lower 92.2%) |
| unanimous lean: all three members | 31.7% acted (66), 0 wrong, 100.0% (lower 95.6%) | 25.0% acted (52), 0 wrong, 100.0% (lower 94.4%) | 17.8% acted (37), 0 wrong, 100.0% (lower 92.2%) |
| recorded cascade jev-1.13 then haiku-5.5 | 41.8% acted (87), 0 wrong, 100.0% (lower 96.6%) | 41.3% acted (86), 0 wrong, 100.0% (lower 96.6%) | 39.4% acted (82), 0 wrong, 100.0% (lower 96.4%) |

At any bar of 0.5 or more, "unanimous lean" is identical to two keys over all three members by
construction, because both act only when every member's go clears the bar; they differ only
where a fitted bar fell below 0.5.

**Reading it:** at comparable coverage, two keys does not make fewer wrong acts than the pooled
log-odds, the shipped matrix or the cascade.

- **Fixed bars:** none of those four made a wrong act on these 208 items at 0.7, 0.8 or 0.9. Two
  keys simply acted on less: 33.2% at its loosest fixed bar (0.7), against 38 to 42% for the
  pools and the cascade at every bar. Fixed bars are also stricter for two keys, since its score
  is the minimum of the members' go.
- **Bars fitted for 0.98:** two keys (jev-1.13 and haiku-5.5) acted on 40.4% with 0 wrong. Pooled
  log-odds and the shipped matrix acted on 41.3 to 41.8% with 1 wrong each, and the cascade on
  36.5% with 0 wrong. That gap is a single act, which 208 items cannot separate: the exact lower
  bounds of 94.6 to 96.5% all overlap.
- **Against single models, two keys does help.** jev-1.13 alone made 6 wrong acts at 0.7.
  haiku-5.5 alone made 2 at every fixed bar: its confident errors clear any bar, and a second key
  is what stops them.
- **Two warnings from the fitting:**
  - The point-estimate 0.95 fit on 160 rows let most bars fall to 0.13 to 0.35, below a lean,
    and those strategies then made 4 to 12 wrong acts on held-out.
  - No strategy got a conservative 0.98 bar from 160 fit rows.
- **The cascade** reached the most coverage at zero wrong acts at fixed bars (41.8% at 0.7,
  against the 43.8% maximum).

So the gain is the second model family. The cascade and the pooled panel reached the same safety
at more coverage on these rows, and `concur` ships as the strictest way to combine, for a caller
who wants a rule that does not rest on the pool's calibration, not as a default.
