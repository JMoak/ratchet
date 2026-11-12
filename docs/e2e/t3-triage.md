# T3: business decisions beyond agents

*Wave 1, track T3 of the end-to-end evaluation, run 2026-11-12 against `typesafe/jev-1.13`
(reported as `typesafe/jev-1.13-20260917`) through OpenRouter, at git HEAD `c9155b9`. Raw
outputs: `experiments/out/e2e/t3-triage/2026-11-12T10-19-41-682Z-live/` (gitignored). Runner,
corpora, spot-check sample and repro scripts: `experiments/e2e/t3-triage/`.*

The vision says the same engine that gates agent tool calls fits triage, routing, approvals
and moderation, and that four habits make it work: fit thresholds per question, compute
numbers and dates in code, decompose and pool (optionally learning the combiner), and start new
gates from a borrowed calibration profile graded honestly. This track tested each on new,
authored business scenarios through the real engine, ledger, review command and CLI.

## Headline

- **Digesting in code is the largest effect measured.** On 219 refund and expense requests
  judged against a written policy, Jev was right 66.7% of the time on raw dates and amounts and
  99.1% on the same facts digested with `compare` and `count` (71 items right only when digested,
  0 right only raw; exact McNemar p < 1e-15). On date-dependent items: 30.8% raw, 100% digested.
- **The default battery combiner inverts a disjunctive moderation battery.** Four sub-questions
  (threat, harassment, spam, self-harm) pooled with the gate default, `logodds` at correlation
  0, leaned the right way on 48.1% of held-out posts despite an AUC of 0.995: one confident yes
  is outvoted by three confident noes. At the gate's own 0.9 publish bar it would have
  **published 51 of the 56 held-out posts that needed moderator action**. Isotonic recalibration
  of the same pool scored 99.1%, `max` 94.4%, the learned logistic combiner 93.5%.
- **`relativeTime` manufactures confident errors at policy boundaries.** Rendering dates as
  "1 month ago" gave 70.8% accuracy and, at a 0.9 act bar, 10 wrong auto-approvals out of 37
  (27%), all refunds 31 to 44 days old against a 30-day window. Raw dates: 1 wrong in 21.
- **Cold start works and grades stay consistent, with two caveats.** A profile built from the
  routing ledger lent bars to a sibling product's gates; precision above every borrowed bar met
  its promise on the sibling's labels, and the urgency gate walked borrowed, estimated, measured.
  All four surfaces printed the same grade sentence at all 38 checkpoints with the levers
  aligned. Under each surface's own defaults they disagree, and under the engine's default
  `minSupport` a borrowing gate regresses to `none` at 20 to 29 labels.
- **English rubrics did not beat translated ones here**: routing was identical on all 180
  translated-vs-English pairs; urgency favoured the translated rubric 7 to 3 (p = 0.34).
- **`ratchet review` can invert labels**: it never shows the question, and asks "Approve?" with
  y recorded as truth = yes for whatever the question asks.

Track spend: **$0.0547** (1,807 paid requests, from the run's ledgers), against a $1.00 cap.

## What ran

| phase | corpus | gates | requests | labels |
| --- | --- | --- | --- | --- |
| approvals | 219 requests (110 refunds, 109 expenses) of an imagined retailer, Larkspur Outfitters, each rendered raw, digested and with relative dates | `approvals.raw`, `.digest`, `.relative` (judge) | 657 | blind review census through `ratchet review` |
| routing | 256 tickets for an imagined invoicing SaaS, Brindle Ledger, from 96 templates; 8 queues, 4 urgency levels | `route` (pick), `urgency` (rate), batched per ticket | 256 | `labelAsDecider` |
| moderation | 222 posts on an imagined anglers' forum, 4 sub-labels each, split fit 111 / held-out 111 before any call | `mod.action` (battery, default combine), `mod.action.learned` (frozen logistic) | 320 | blind review census, members inherit |
| multilingual | 60 Brindle tickets in en, es, de, ja from 20 templates; English and translated rubrics | 14 gates (one per cell and question) | 420 | `labelAsDecider` |
| coldstart | 140 tickets for an imagined grocery marketplace, Fernhill Market, from 56 templates; re-worded routing and urgency questions | `sib.route`, `sib.urgency` (policy from profile), `sib.route.stale`, `sib.route.other` | 154 | `labelAsDecider`, in ledger order |

Protocol, as `experiments/e2e/DECIDER.md` requires: every label and its `why` were fixed in
`experiments/e2e/t3-triage/corpus/*.json` by `build.ts` before the first live call; the run's
`manifest.json` records the corpus hashes (approvals `5fddd34f`, routing `d85e314c`, sibling
`105d4750`, moderation `4dcc749e`, multilingual `9701f6b8`), git HEAD, model pins and every frozen
fit with its timestamp. Approval labels are the written policy applied in code to the facts
(`refundVerdict`, `expenseVerdict` in `corpus/approvals.ts`). Routing and moderation labels were
written against the criteria and rubric the model sees. Fit-then-freeze-then-validate held for
routing (bars frozen after the fit half) and moderation (all five combiners and their bars
frozen after the fit split). No label was changed after a model answered; there is no
`corrections.json`. Ambiguous items: approvals 7 of 219, routing route 18 / urgency 8 of 256,
moderation 8 of 222, sibling about 5%; every headline number is reported with and without them
where they matter.

Reproduce: `bun experiments/e2e/t3-triage/build.ts` (refuses to rebuild once a live run exists),
`bun experiments/e2e/t3-triage/main.ts [--offline]`, then
`bun experiments/e2e/t3-triage/analyze.ts <run dir>`. `--offline` runs the same wiring on seeded
`SimOracle`s that know the labels (53 seconds, no spend); its numbers describe the simulator.

Rates carry Wilson 95% intervals unless marked exact (Clopper-Pearson); paired arms use the
exact McNemar test.

## 1. Approvals desk: raw vs digested vs relative dates

Policy in the state's trusted fields: six refund rules (30-day window, 60 for VIP; final sale;
unused unless defective; receipt; amount not above price; at most 2 refunds in 90 days, 4 for
VIP) and five expense rules (60-day submission; receipt from $25; meals $75 per attendee, no
alcohol; business class only over 6 hours; hotels $250 a night, $350 in high-cost cities). The
digest arm states each comparison with `compare` (for example "days from delivery to this request
(36 days) exceeds refund window for this tier (30 days) by 6 days"), `count` and `band`; the
relative arm turns dates into `relativeTime` phrases and digests nothing else. Policy
`actAbove 0.9, refuseBelow 0.1`.

| arm | accuracy | unambiguous | expected (mean confidence) | posture | ECE | Brier | AUC | date items (52) | amount items (80) | categorical (87) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| raw | 66.7% [60.2, 72.6] | 66.5% | 75.0% | overconfident | 0.094 | 0.189 | 0.789 | 30.8% | 65.0% | 89.7% |
| digest | **99.1% [96.7, 99.7]** | **100% (212/212)** | 94.8% | underconfident | 0.054 | 0.006 | 1.000 | 100% | 100% | 97.7% |
| relative | 70.8% [64.4, 76.4] | 70.8% | 77.4% | overconfident | 0.081 | 0.188 | 0.793 | 46.2% | 62.5% | 93.1% |

- Digest vs raw: 71 right only digested, 0 right only raw (p < 1e-15); dates 36 vs 0
  (p = 2.9e-11), amounts 28 vs 0 (p = 7.5e-9). Brier, digest minus raw, -0.183 [-0.212, -0.155]
  (paired bootstrap).
- Relative vs raw: 21 vs 12 (p = 0.16) overall; better on dates (8 vs 0, p = 0.008) but far worse
  at acting (below). Digest vs relative: 62 vs 0 (p = 1.2e-13).
- The digest arm's two errors are the two ambiguous lapsed-VIP refunds, labelled deny on the
  cautious reading; every arm approved them. With the 7 ambiguous labels flipped: raw 65.3%,
  digest 97.7%, relative 69.4%.
- Raw failures are systematic, not noise: hotel stays within the nightly limit 0 of 11, late
  submissions 0 of 10, meals over the per-attendee limit 0 of 9, refunds just past the window
  1 of 14.

What each policy would have done (the soft action, shadow mode):

| arm | auto-approved | wrongly (exact 95%) | auto-denied | wrongly | to review |
| --- | --- | --- | --- | --- | --- |
| raw | 21 | 1 (4.8% [0.1, 23.8]) | 35 | 1 | 163 |
| digest | 100 | **0 (0% [0, 3.6])** | 106 | 0 (0% [0, 3.4]) | 13 |
| relative | 37 | **10 (27.0% [13.8, 44.1])** | 39 | 1 | 143 |

The digest arm decided 206 of 219 requests on its own with no error; the raw arm, 56. All ten
of the relative arm's wrong approvals are refunds 31 to 44 days after delivery that
`relativeTime` rendered "1 month ago" against a 30-day window, approved at go 0.90 to 0.95.

Floors: 22 requests over the automation limit or paid by wire (66 rows across the arms) never
acted; on 13 of those rows the model's answer alone would have acted and the floor held it.
`compare` printed floating-point noise into 89 of 219 digested states ("by 4.200000000000003
USD"); accuracy on those was 98.9% vs 99.2% on the rest, so no measurable cost here.

## 2. Routing and urgency

| question | accuracy | unambiguous | expected | posture | ECE | Brier | report bar at 95% (coverage) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| route (8 queues) | 98.4% [96.1, 99.4] | 99.2% | 97.6% | calibrated | 0.016 | 0.014 | 0.57 (100%) |
| urgency (4 levels) | 84.4% [79.4, 88.3] | 86.3% | 85.8% | calibrated | 0.043 | 0.098 | 0.79 (71.9%) |

The route question is near ceiling: its four errors come from two of 96 templates (an API
outage, i8, which is arguably a bug and is flagged ambiguous; and recurring invoices sent a day
late, g5, which the model called billing). Urgency errors cluster too: 13 templates always wrong,
6 mixed, 77 always right, and every miss is one level off (within one level: 256 of 256).
Urgency's reliability is not flat: 0.7 to 0.8 stated, 62.5% right (n 24); 0.9 to 1.0 stated,
98.6% right (n 145). `shortlist()` top-2 holds the truth for 100% of routes and 99.6% of urgency.

Frozen bars (fit half, 128 tickets) read once on the validation half (128):

| question | promise | own bar (conservative) | validation coverage, precision (exact) |
| --- | --- | --- | --- |
| route | 90% | 0.57 | 100%, 98.4% [94.5, 99.8] |
| route | 95% | 0.62 | 99.2%, 98.4% [94.4, 99.8] |
| urgency | 90% | 0.83 | 64.1%, 96.3% [89.7, 99.2] |
| urgency | 95% | 0.88 | 59.4%, 97.4% [90.8, 99.7] |

One global bar, fitted conservatively on the pooled fit halves of route, urgency and the raw and
digested approval questions (`analyze.ts`), read on each question's validation half:

| promise | global bar | route | urgency | approvals.raw (no bar of its own) | approvals.digest |
| --- | --- | --- | --- | --- | --- |
| 90% | 0.64 | 0.8 points coverage lost | about right | **76.7% [65.4, 85.8] precision: too low** | about right |
| 95% | 0.82 | **4.7 points coverage lost** | about right | 90.0% [76.3, 97.2]: below the promise | about right |

On the same items, the raw rendering made Jev overconfident (66.7% right against 75.0% stated)
and the digested one underconfident (99.1% against 94.8%), with both intervals clear of the
stated figure.

## 3. Moderation battery

Members: threat, harassment, spam, self-harm, each a judge question with yes/no criteria, asked
in one request. The combined question is "needs moderator action" (any member true); the gate
publishes when P(no action) is at least 0.9. A hash-matched upload is a refuse floor: 10 of 10
were refused with no call, no member rows and no cost.

Fit split: 104 answered requests. Member error correlation measured the ledger's way (member
rows inherit the battery's truth): 0.488. Against each member's own label: -0.013. Logistic
weights 0.11, 0.43, 0.41, 0.36, bias 3.57. All frozen before the held-out call.

Held-out (108 answered requests), each combiner read once:

| combiner | accuracy (lean) | unambiguous | ECE | Brier (pYes) | AUC | publish bar (fit, 98% point) | held-out coverage | held-out precision (exact) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| logodds, rho 0 (gate default) | **48.1% [39.0, 57.5]** | 48.1% | 0.504 | 0.494 | 0.995 | 0.9999993 | 47.2% | 100% [93.0, 100] |
| logodds, measured rho 0.488 | 48.1% | 48.1% | 0.478 | 0.448 | 0.995 | 0.997 | 47.2% | 100% [93.0, 100] |
| max | 94.4% [88.4, 97.4] | 96.2% | 0.060 | 0.031 | 0.997 | 0.81 | 48.1% | 96.2% [86.8, 99.5] |
| learned (fitLogistic) | 93.5% [87.2, 96.8] | 95.2% | 0.157 | 0.050 | 0.997 | 0.69 | 47.2% | 100% [93.0, 100] |
| isotonic on the logodds pool | **99.1% [94.9, 99.8]** | 100% | 0.003 | 0.011 | 0.988 | 1.0 | 46.3% | 100% [92.9, 100] |

- Learned vs default logodds: 50 vs 1 discordant (p = 4.1e-14); isotonic vs logodds 56 vs 1;
  max vs logodds 51 vs 1. Learned vs max: 0 vs 1 (p = 1.0), Brier learned minus max +0.019
  [0.006, 0.028]. Isotonic vs learned: 6 vs 0 (p = 0.031).
- The default pool ranks almost perfectly (AUC 0.995) but its lean and its confidence are
  inverted for a disjunction: a clear spam post scores pYes 0.0001. At the gate's own 0.9 bar it
  published 103 of 108 held-out posts, 51 of which needed action (threat 6, spam 15, harassment
  20, self-harm 8, ambiguous 2). Fitting the bar on the composite rescues the ranking, but only
  at 0.9999993. `ratchet report` does expose the gate once labels exist: 50.0% observed against
  98.4% expected, ECE 0.484, grade estimated.
- A measured correlation only shrinks the pool; it cannot move a lean, and here it moved Brier
  by -0.046.
- The learned gate (`combine: LogisticModel`) reproduced `poolLearned` on its own members
  exactly (max difference 0), agreed with the default gate's second call on 107 of 108 leans,
  and would have published 2 posts, both correctly.
- Members on their own questions: threat 99.1%, harassment 95.8%, spam 100%, self-harm 96.2%.
  As the ledger scores them, against the battery's truth: 59.0%, 70.3%, 63.2%, 56.1%, which
  `ratchet report` prints as badly overconfident members.
- Post hoc (a finding, not a refit): `fitLogistic` with its default 400 iterations stops far from
  convergence. On the same fit split, 20,000 iterations take the fit log-loss from 0.241 to
  0.046 and held-out from 101/108 at ECE 0.157 to 107/108 at ECE 0.020
  (`repro/logistic-convergence.ts`).

## 4. Multilingual (invariant 9)

| language | rubric | route | urgency | urgency ECE |
| --- | --- | --- | --- | --- |
| en | English | 95.0% [86.3, 98.3] | 88.3% [77.8, 94.2] | 0.081 |
| es | English | 95.0% | 88.3% | 0.096 |
| es | translated | 95.0% | 90.0% | 0.031 |
| de | English | 95.0% | 91.7% | 0.105 |
| de | translated | 95.0% | 90.0% | 0.116 |
| ja | English | 95.0% | 83.3% | 0.080 |
| ja | translated | 95.0% | 90.0% | 0.114 |

- Route: identical in every cell; the 3 misses per cell are all the ambiguous API-outage
  template (i8), so routing is 100% on unambiguous tickets in every language and rubric. No pair
  is discordant (180 of 180 agree).
- Urgency, English vs translated rubric: es 2 vs 3, de 1 vs 0, ja 0 vs 4 (p = 0.125); pooled 3 vs
  7 (p = 0.34; three renderings per ticket, so not independent).
- English ticket vs the same ticket in another language, both English rubric: no significant
  difference (urgency de 0 vs 2, ja 4 vs 1, es 3 vs 3).

## 5. Cold start with profiles

`ratchet profile build` on the routing ledger and `buildProfile` in code produced the same
profiles (pick `bdc0535c`, rate `0ec82905`). Pick bars: 90% and 95% at 0.57, 98% at 0.92 (support
239); rate: 90% at 0.78, 95% at 0.88, none at 98%. The sibling took the highest promise its
profile had a bar for (rule fixed before any sibling call): route 98% (act above 0.97), urgency
95% (act above 0.93), each with `barSource`.

Grade walk, labels arriving in ledger order, read at 19 checkpoints per gate from `Gate.report()`,
`ratchet report` (JSON and text), `checkGate` and `ratchet check`, and `ratchet trail` (JSON and
text), all with the promise, `--min-support 30` and `--min-estimated 30` aligned:

| labels | sib.route (98%) | sib.urgency (95%) | engine with its default minSupport 20 | without a profile |
| --- | --- | --- | --- | --- |
| 0 to 19 | borrowed | borrowed | borrowed | none |
| 20 to 29 | borrowed | borrowed | **none** from 25 labels for both gates (route from 20 under the engine's full defaults) | none |
| 30 to 119 | estimated | estimated | estimated | estimated |
| 120 to 140 | estimated (149 acts needed, 110 exist) | **measured**: 59 acts, 0 wrong, exact bound 95.05% | same | same |

The aligned surfaces agreed on the grade word and the full sentence at every one of the 38
checkpoints (0 mismatches). Under each surface's defaults they did not: `Gate.report()` (95%,
minSupport 20) read `sib.route` measured from 80 labels while `ratchet report` (98%, 30) read it
estimated, and at 0 labels the engine read `sib.urgency` borrowed while `ratchet report` read
none.

Is the borrowed bar honest on the sibling's own labels?

| gate | promise | borrowed bar | rows at or above | precision (exact) | at the act bar | precision (exact) | sibling's own conservative bar |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sib.route | 98% | 0.92 | 119 (85%) | 99.2% [95.4, 100] | 110 at 0.97 | 100% [96.7, 100] | none (too few rows) |
| sib.urgency | 95% | 0.88 | 82 (59%) | 97.6% [91.5, 99.7] | 68 at 0.93 | 100% [94.7, 100] | 0.91 |

Both point estimates meet the promise; neither interval's lower end does at the borrowed bar,
and urgency's own measured grade proves its act bar. The sibling's own conservative urgency bar
(0.91) sits slightly above the borrowed 0.88.

Expiry: a gate that declared the pick profile and whose newest answers came from `jev-1.14` read
`borrowed (stale)` on all four surfaces, with the sentence "which no longer matches the gate's
model"; a `jev-1.14` gate without `barSource` read `none` everywhere.

## 6. Claim verdicts

| claim | verdict | evidence |
| --- | --- | --- |
| Thresholds must be fitted per question | **Proved** (in this setting) | Same items, raw overconfident (66.7% vs 75.0%) and digested underconfident (99.1% vs 94.8%); one global bar too low for raw approvals (76.7% [65.4, 85.8] at a 90% promise) and too high for routing (4.7 points coverage lost at 95%). Route and urgency alone were both calibrated, so the two-sided failure needs the approvals questions. |
| Digesting numbers and dates in code helps | **Proved**, large | 99.1% vs 66.7%, 71 vs 0 discordant; 0 wrong auto-decisions in 206. Caveat: `relativeTime` alone does not help and is unsafe at boundaries. |
| Learned or isotonic beats fixed pooling held-out | **Proved against the default logodds pool; disproved against `max`** for the learned combiner | Learned 93.5%, isotonic 99.1%, logodds 48.1%, max 94.4%; learned vs max 0 vs 1 discordant, Brier worse by 0.019. Isotonic beat everything. A learned combiner run to convergence reached 107/108 post hoc. |
| English rubrics beat translated ones | **Inconclusive**, leaning against | Route identical on 180 pairs; urgency 3 vs 7 for translated (p = 0.34). |
| Borrowed bars are safe | **Not disproved**, limited | Precision above each borrowed bar met its promise as a point estimate (99.2%, 97.6%); urgency's act bar earned a measured grade. One donor gate, one sibling, same task type: the easiest case for borrowing. |
| Grades are honest and consistent across surfaces | **Proved with aligned levers; disproved under defaults** | 0 mismatches in 38 aligned checkpoints over seven readings (four structured, three printed); engine and CLI defaults disagree (measured vs estimated); the engine's default minSupport makes a borrowing gate regress to none at 20 to 29 labels. |
| Floors only raise caution; one-way doors never act | **Confirmed** | 0 of 66 floored approval rows acted (13 held from act); 10 of 10 hash-matched posts refused with no call. |
| The same engine fits business decisions | **Confirmed, with the battery caveat** | Approvals, routing and moderation ran on the stock engine, ledger, review and CLI with no adapter. |

## Findings

Most important first. Each has a minimal repro under `experiments/e2e/t3-triage/repro/` that
needs no network.

**T3-01 (high, design gap and docs): the default battery combiner inverts a disjunctive
battery.** `src/gate.ts:135` pools a battery with `logodds` at correlation 0 unless told
otherwise; `docs/vision.md:97` and `docs/architecture.md:224,367` present log-odds as the way to
combine decomposed sub-questions. Log-odds pooling treats members as evidence for one
proposition; for "any of these risks" one confident yes is outvoted by confident noes. Live:
48.1% held-out accuracy at AUC 0.995, and 51 of 56 posts that needed action would have been
published at the gate's 0.9 bar. Repro: `bun experiments/e2e/t3-triage/repro/battery-disjunction.ts`
(a clear spam post and a clear threat both publish at go above 0.998; `combine: "max"` holds
them). Fix: in `gate.ts` and the docs, say that `logodds` is for members that are evidence for
the same answer and that a disjunction takes `"max"` or a learned or recalibrated combiner;
consider a `GateSpec` flag (`members: "evidence" | "any" | "all"`) that picks the pool, or a
report warning when one member is confident yes and the pool is confident no.

**T3-02 (high, design gap): `ratchet review` can invert labels.** It prints only the state
(`src/cli/review.ts:98`), asks "Approve? [y]es / [n]o" (`:112`) and records y as truth = yes for
the gate's judge question (`:135`), whatever the question asks. On a gate phrased "does this need
moderator action?" (act = publish, `goIsYes: false`) a reviewer who approves a harmless post
records "needs action", and one who refuses a harmful post records "no action needed", which
scores a gate that published it as right. Those labels are blind-class: they fit bars and fill
acceptance samples. `--denied` inherits the same inversion. This track's labels are unaffected
(the harness answered from the truth boolean). Repro: `repro/review-polarity.ts`. Fix: print the
row's `prompt` with each item and ask for that question's answer ("Needs moderator action?
[y]es / [n]o"); for a gate whose recorded go side is "no" (`recordedGoIsYes`), either ask whether
to allow the action and record the truth to match, or refuse without an explicit
`--answers yes-means-<prompt>` flag.

**T3-03 (medium, engine design gap): a borrowing gate regresses to `none` before it can be
estimated, and the bar that replaces the borrowed one is a point estimate.** Lending is decided
by "no fitted bar" (`src/engine.ts:450`, `src/cli/common.ts:214`), not by "no grade of its own".
With the engine's default `minSupport` 20 and `minEstimated` 30, a gate with 20 to 29 labels has
a fitted bar, loses the borrowed one, and grades `none`. Live: both sibling gates showed it. The
fitted bar is `fitThreshold`'s point estimate, so 19 right of 20 at confidence 0.70 yields a 0.70
bar at a 90% promise, against a borrowed 0.97 read with a Wilson bound (19/20 has a Wilson lower
bound of 0.76). `docs/architecture.md:333-334` says a borrowed bar and a fitted bar "mean the
same thing" because a profile reads `fitThreshold`'s conservative mode, but the bar `report`
fits, and that displaces the borrowed one, is the non-conservative one. Repro: `repro/borrow-gap.ts`. Fix: lend while the gate's own grade is weaker than estimated
(`n < minEstimated`), and fit the report's bar with `conservative: true` (or say in the report
that it is a point estimate), so own rows can only tighten a borrowed bar.

**T3-04 (medium, docs mismatch and ergonomics): the engine and the CLI default to different
levers, so the same ledger grades differently.** `Gate.report()` defaults to a 95% promise and
minSupport 20 (`src/engine.ts:429-430`); `ratchet report`, `check` and `trail` to 98% and 30
(`src/cli/report.ts:351-352`). `docs/design/evidence-grades.md:60` says CLI commands expose the
same levers "with the same names and defaults". Live: the sibling routing gate read measured in
the engine and estimated in `ratchet report` from 80 labels on. Repro: `repro/default-levers.ts`
(part 1: 60 clean acts, engine measured, CLI estimated). Fix: one set of defaults in one place
(an exported `REPORT_DEFAULTS`), and print the promise and support next to the grade in
`QuestionReport` as the CLI already does.

**T3-05 (medium, docs and helper design): `relativeTime` rounding makes confident errors at policy
windows.** It rounds to the nearest whole unit (`src/recipes/digest.ts:53`): 25 and 29 days are
"4 weeks ago", 31 to 44 days "1 month ago", 45 to 74 days "2 months ago", 76 to 104 days "3 months
ago". `docs/live-findings.md:94-95` advises "make dates relative" and `docs/design/gate-and-state.md:100`
shows `relativeTime` as the date digest. Live: 10 of 37 relative-arm auto-approvals were wrong
(27%, all refunds 31 to 44 days old against a 30-day window), against 1 of 21 raw and 0 of 100
digested. Repro: `repro/digest-precision.ts`. Fix: document that windows take
`compare(daysBetween(...), window)` and that `relativeTime` is for recency; give `relativeTime`
day precision below about 90 days, or floor rather than round so it never moves a date inside a
window.

**T3-06 (medium, engine defaults): `fitLogistic` stops before converging.** 400 iterations of plain
gradient descent at learning rate 0.1 on features clamped to plus or minus 7
(`src/compound/learned.ts:32-34`) left the fit log-loss at 0.241; 20,000 iterations reach 0.046,
and the held-out battery goes from 101/108 at ECE 0.157 to 107/108 at ECE 0.020. The learned
combiner's measured result in this track (93.5%) understates what the method gives. Repro:
`repro/logistic-convergence.ts <run dir>` (post hoc, on this run's fit split). Fix: stop on a
gradient-norm or loss tolerance with a higher iteration cap, or use Newton/IRLS (a handful of
features converges in about ten steps), and return the final loss so callers can see convergence.

**T3-07 (medium, design gap): battery member labels and measured correlation assume every member
asks the battery's question.** `src/ledger/ledger.ts:190` scores each member against the
battery's truth. For a disjunctive battery the report then calls excellent members badly
overconfident (threat 99.1% on its own question, 59.0% in the report) and the ledger's measured
member correlation is 0.488 where the members' own errors correlate at -0.013. `src/gate.ts:35-37`
tells users to measure the correlation from the ledger. Repro: the report line in
`repro/battery-disjunction.ts`. Fix: let a battery member carry its own truth (an optional
per-member label, `Outcome.memberTruth` or labels on member rows that `inheritOutcome` does not
overwrite) and compute correlation from those; until then, document that member calibration and
correlation are against the battery's truth and meaningless for disjunctions. There is also no
helper for battery member correlation (`memberCorrelation` reads ensemble `members` only).

**T3-08 (low, design gap): `policyFromProfile` can return a policy that only acts on certainty.**
The act bar is the borrowed bar plus 0.05, clamped to 1 (`src/policy.ts:110`), so a bar at 0.95
or above gives `actAbove: 1`, which acts only on a stated 1.0 and whose acceptance sample may
never fill. Seen offline (bar 0.97); live bars were 0.92 and 0.88. Repro: `repro/default-levers.ts`
part 2. Fix: throw or warn when bar plus half-width reaches 1, or take the half-width from the
headroom.

**T3-09 (low, ergonomics): `compare` prints floating-point noise.** `src/recipes/digest.ts:31`
prints `Math.abs(actual - limit)` unrounded: "by 4.200000000000003 USD", "by
10.000000000000014 USD", in 89 of 219 digested states here, at no measured accuracy cost (98.9%
vs 99.2%). Repro: `repro/digest-precision.ts`. Fix: round the difference to the inputs' decimal
places (or `Number(diff.toPrecision(12))`).

**T3-10 (low, ergonomics): a floor sees only the rendered text.** `FloorRule` is
`(state: string, question)` (`src/floors.ts:10`), so a business floor on a number (an automation
limit on the amount) has to parse a rendering that differs between digest and raw states, or
look the record up out of band, as this track did by state text. Fix: pass the `StateLike` (or
the builder's entries) to floors, or add a `floorOn(field, predicate)` helper over `State`
entries.

## Limits

- Authored corpora, not traffic: tickets and posts come from 96, 56, 20 and 61 templates used two
  to four times each, so items from one template are correlated and intervals that treat items
  as independent are optimistic. Route errors came from 2 templates, urgency errors from 19.
- The labels are one decider's (the evaluation's author), written against rubrics that the same
  author wrote; the spot-check sample (`experiments/e2e/t3-triage/spotcheck.json`, 25 items, no
  labels) is for the coordinator's blind relabel. One label is arguable in hindsight (g5,
  recurring invoices a day late, labelled bug; billing's criteria mention invoices); it was not
  changed.
- The approvals digest arm moves most of the policy's arithmetic, including which tier's window
  applies, into code; it shows that Jev reliably combines stated comparisons with categorical
  rules, not that it can do the arithmetic.
- Routing was near ceiling, so it says little about per-question fitting on its own; the
  two-sided global-bar result rests on the approvals questions.
- Translations were written by the evaluation's author, not by native speakers or professional
  translators; the multilingual set is 20 templates.
- Cold start was tested on one donor gate and one sibling of the same task type on the same pin:
  the most favourable case for borrowing. Nothing here says how a profile from several unlike
  gates behaves.
- No oracle failed open in any live phase, so fail-open behaviour was not exercised live.
- Spend figures are the ledgers' recorded costs; the evaluation-wide guard read $0.0944 billed
  across every track at the end of this run.
