# No test shortens the road to a promise; a better gate and honest units do

*Architectural and statistical review of the engine, 2026-11-12. Six research notes sit behind it
in `../research_notes/Foundations review 2026-11/`; citations and URLs live there. Figures marked
"simulated" come from seeded scripts written during the review; the ones that back shipped code
are reproduced by `bun run sim`. Code observations were confirmed by reading the file named.*

The engine's strongest capability is that it refuses itself. In the end-to-end evaluation floors
were never lowered in 1,169 rechecked rows, one-way doors never acted, and the planned test twice
rejected a gate that a point estimate would have promoted. Its weak point is time to autonomy:
evidence arrives slowly, is counted in the wrong unit, and both the promotion and the demotion
rule are harsher on good gates than they need to be. Six lines of research converge on one
conclusion: no statistical technique shortens the road to a 98% promise. What shortens it is a
gate that is much better than its promise, and evidence counted in units that are actually
independent.

## What the research settled

| Question | Finding | Note |
| --- | --- | --- |
| Can a smarter test, or a strong model as a label proxy, replace the 149 human labels? | No. Any valid test needs at least 138 human labels for 80% power even on a perfect gate when the judge may be uninformative. At a 98% promise a 99% gate needs 969 labelled acts in a fixed plan for 80% power, and about 610 on average with the best sequential test; a 99.5% gate needs 386 in a fixed plan. | `label_efficiency_and_noise.md`, `anytime_valid_rollout.md` |
| What does shorten it? | A second model family on the act path rather than as a label proxy. A 99% gate passes the 149-act zero-error plan 22% of the time; a gate that acts only where a second model also passes raises that to 85 to 98% if the second model catches 90 to 99% of the first's errors, and to 44 to 47% if it catches half. How the two are combined matters less than having the second: see improvement 1. | `label_efficiency_and_noise.md` |
| Rows or groups? | Groups. With sessions of ten acts at intraclass correlation 0.2, false promotion is 20% uncapped and 4.5% at one act per session. A fitted bar breaks its promise 18% of the time at ten rows per group, about 0.1% with groups as units. Even the exactly right pooled bar fails on 21 to 35% of new command families. | `risk_controlled_bars.md`, `anytime_valid_rollout.md` |
| Is demotion sound? | No. The window rule demotes a healthy 99% gate 47% of the time within 1,000 acts at an audit rate of 0.2, and 84% within 10,000. A Shiryaev-Roberts mixture detector with a stated false-alarm rate does so 0.7% and 8.5% of the time. | `anytime_valid_rollout.md` |
| Are labels good enough? | Barely. If reviewers wrongly mark right acts wrong 2% of the time, a 98% promise is unverifiable at any sample size; at 1.25% a 99% gate passes 3.4% of the time instead of 22.4%. The evaluation's blind relabel (4 of 157 disagreements) implies about 1.3% per reviewer. | `label_efficiency_and_noise.md` |
| Why do chains stall? | Each step carries a latent "this verifier dislikes this step" propensity. A beta frailty fitted from two ledger rates reproduces the observed completion (49.2 / 56.8 / 61.2 / 61.5% predicted against 48 / 53 / 62 / 58%). | `verified_chains.md` |
| Is the pool right? | Not quite. Summing calibrated logits counts the gate's base rate once per member, and phi of correctness is an attenuated, noisy stand-in for the dependence that matters, the within-class correlation of logits. | `pooling_and_deferral.md` |
| Can untrusted text be kept from buying an act? | Yes, for gates whose subject is trusted: rule on the more cautious of a trusted-only ask and a full ask. No certificate supports the review band as an injection control. | `information_flow_security.md` |

## The engine as statistical quality control

Read as a whole, the engine is a quality-control regime for machine judgment, and nearly every
open roadmap item has a classical counterpart with known theory. Promotion is acceptance sampling.
The audit loop is a continuous sampling plan. Demotion is a control chart. Run-to-run spread and
reviewer error are gauge studies.

The continuous-sampling reading gives a kind of promise the engine does not yet print. Clear
`i` consecutive right acts in shadow, then audit a fraction `f` of acts, and return to shadow at
the first audited error: that is Dodge's CSP-1, and its outgoing error, wrong acts executed per
act-eligible decision, is `p(1-f)q^i / (f + (1-f)q^i)` at a stationary error rate `p`, with
`q = 1 - p`. Its maximum over `p` does not depend on the model at all.

| clearance | audit rate | limit on wrong executed acts per eligible decision | attained at error rate | worst case against a non-stationary process |
| --- | --- | --- | --- | --- |
| 59 | 0.2 | 1.20% | 2.85% | 6.25% |
| 149 | 0.1 | 0.73% | 1.40% | 5.66% |
| 149 | 0.2 | 0.48% | 1.14% | 2.60% |
| 149 | 0.5 | 0.19% | 0.85% | 0.66% |
| 313 | 0.2 | 0.23% | 0.55% | 1.26% |

Simulated: the closed form matched a seeded simulation of the plan to the third decimal at every
error rate tried. The bound is on harm per unit of traffic, not on the precision of automated
acts, and it has a price: at a 1% true error rate the 149 / 0.2 plan automates 47% of eligible
decisions, because it keeps returning to shadow. It assumes audit labels are correct and arrive
before the next act, and that the audit draw cannot be predicted by what is being judged.

## Architecture

The small surface is why the red team found gaps in validation and never a broken principle: an
oracle with one method, three verdict types, the `Asker` rule that nothing bypasses the ledger, a
single reader for bars and grades, and caution as a total order. The suite holds 1,523 tests.

Four structural limits hold back most of the improvements below.

- **Typed state stops at the builder.** `Oracle.decide`, `FloorRule` and the engine's `preempt`
  all receive rendered text (`src/engine.ts`, `src/floors.ts`), so the trust and provenance the
  `State` builder knows are lost before any rule can use them. Floors over entries, a trusted-only
  view and novelty features all wait on this seam.
- **Rows record the decision but not the sampling design.** There is no stratum and no record of
  the probability that a row would receive a human label: the audit draw in `Engine.settle`
  leaves only a tag. Groups exist only as a tag prefix that the acceptance plan reads and the fits
  ignore.
- **One outcome per row, and rollout state outside the ledger.** Double review and adjudication
  have nowhere to live, and a checkpoint is a trust root that the code then has to defend. A test
  whose state is a pure function of the ledger makes the checkpoint a cache.
- **Configuration identity is partly manual.** `evidenceVersion` is caller-owned because floors
  and combiners are closures, and the third wave of the evaluation found holes exactly there.
  Rules built by the library's own constructors could carry a hash, as `forQuestion` already
  carries its scope.

## Improvements, in order

1. **A second model family on every act.** The review first proposed "two keys": ask a second
   family on every request and act only when both clear the bar (pooling by the most cautious
   member, one-out-of-two voting on the hold side). Tested on the real T5 rows on the act side,
   that form was not better than the alternatives. At fixed bars of 0.7, 0.8 and 0.9, pooled
   log-odds, the shipped matrix pool, the recorded cascade and two keys all made no wrong act on
   208 held-out items, and two keys acted on less (33%, 26% and 19% against 38 to 42%); the
   cascade acted on the most, 41.8% of a possible 43.8%. Two keys did beat single models (the
   cheap model alone made 6 wrong acts at 0.7, the strong one 2 at every bar). So the gain is the
   second family, and the cascade the engine already has is the best measured way to use it;
   `concur` ships as the strictest option, for a caller who wants a rule that does not rest on the
   pool's calibration. One structural point stands: a cascade tier settles on two-sided confidence
   (`src/compound/cascade.ts`), so a cheap tier that is confidently permissive is never checked.
2. **Count evidence in groups.** Fit bars and run acceptance with the group as the unit, and print
   "N rows are about G independent observations". Replace the Wilson scan with an exact
   fixed-sequence test over about twenty preset edges, the same mathematics as acceptance, and
   mark a bar found at the edge of its power as provisional: at 500 rows and a 98% promise, 85% of
   the bars the scan finds are below the promise, against 2.9% for the fixed sequence.
3. **Sequential promotion and demotion, computed from the ledger.** The zero-error plan is
   already a valid sequential test (the likelihood ratio against a perfect gate), so it can stop
   at the first wrong act. A betting test that stays valid however often it is read promotes a
   99.5% gate 96% of the time within 1,000 acts, against 47% for the 149-act plan, and one unlucky
   error no longer freezes a configuration. A Shiryaev-Roberts detector replaces the demotion
   window; it is slower on mild drift (32 wrong acts against 7 for a fall to 95% at an audit rate
   of 0.2) and far less prone to demote a healthy gate. Trying many configurations, and
   re-promoting after a demotion, both spend the error budget again; today nothing accounts for
   it.
4. **Treat labels as measurements.** Keep every review per row and adjudicate each "wrong" label
   with a second blind reviewer: a 99% gate's pass rate recovers from about 4% to 25% for roughly
   five extra reviews per 149. Record each row's probability of being labelled. Replay known past
   errors as seeds to bound what reviewers miss: 59 of 59 caught makes a zero-error plan of 173
   acts honestly mean 98%.
5. **Correct the pool.** Subtract the base rate before pooling and add it back once: two
   independent members that each answer an 80% base rate pool to 94% today (`priorYes`, shipped;
   T5 cannot test it, its base rate being 0.49). The research also recommended weights fitted from
   the within-class correlation of logits, shrunk toward the family prior. In simulation they beat
   the phi matrix; on the real T5 rows they tied it on accuracy (202 of 208) and lost on log loss
   (0.095 against 0.087) and calibration error (0.035 against 0.016), so they were measured and
   not shipped, and only the measurements are in the library. For any-of and all-of batteries, a
   product or noisy-OR followed by a two-parameter recalibration beat the learned logistic on
   logits (AUC 0.933 against 0.863 in simulation).
6. **Chains.** Fit the frailty from the ledger and print the completion interval the data support.
   A shared attempt pool lifts completion from 50% to 85% at the same worst-case spend. A second
   verifier of another family never releases a held candidate alone: releasing raised wrong
   commits about fortyfold in simulation. Its best use is to order the held candidates for a
   person when a step runs out of attempts (94% completion at 99.96% commit precision for 0.8
   human reviews a chain, simulated), ahead of sending each disagreement to a person at once
   (87%, 1.07 reviews).
7. **Carry typed state through the engine.** Give each entry an origin and a form, let floors read
   entries, and give gates a mode in which untrusted text can cost an act but never buy one. The
   guarantee is sound and narrow: it does not cover an attack through the command itself, and the
   hook already reads no tool output. Bind an act to the full hash of the exact call; `hashState`
   keeps 64 bits, enough for grouping and too few for binding.
8. **Make "error class becomes floor" a first-class loop.** Every wrong act in T1 was one class,
   and no bar fixes a blind spot that spans a family. Label the class, cluster wrong acts by
   digest, and price a candidate floor with `replay`. This one is the review's inference, not a
   research result.

## Corrections to the record

- **T2's six-attempt arm** replayed cached verdicts for identical candidates (the fourth scored
  like the first in 76 of 76 cases), so it tested three distinct candidates. With fresh ones the
  fitted model predicts about 72% completion, not 61%.
- **Section 5 of the simulation** uses the most optimistic law consistent with the two measured
  rates; two moments cannot certify completion above about 52% there.
- **A 98% promise is not a 49:1 cost policy.** The cost formula sets the bar for the marginal act;
  the promise is an average over acts. Acting on a tail whose precision equals `a / (a + b)` costs
  exactly as much as reviewing everything, and in the simulation model the marginal act at a 98%
  average was right 92.9% of the time.
- **The review band is not an injection control.** Its evidence came from a non-adaptive attack.
  It is insurance against run-to-run noise and a filter for weak attacks.
- **`cautiousBar` skips a donor with thin tail support** (`src/ledger/profile-bins.ts`), so a
  donor that fails wherever it can be measured stops vetoing above its own support. The doc
  comment defends the choice; it is the less cautious direction.
- **`fitIsotonic` returns block means**, which are exactly 0 or 1 for a pure block
  (`src/ledger/calibration.ts`); on small samples that is common, and an exact 0 or 1 is infinite
  in log-odds pooling.
- **The demotion window, exactly:** an error among the first 29 audits demotes at audit 30; one
  error is tolerated from audit 50, two from 100, three from 150, four in the last 200.

## What stays a decision

Each of these changes what a gate does by default or reverses a recorded choice, so the review
recommends and does not presume: whether a cascade to a second model family becomes the default
strategy (two keys, tested, is not the form to default to); whether the exact
fixed-sequence bar replaces the Wilson scan in reports; whether the detector replaces the demotion
window by default; whether a rejected configuration may keep accumulating evidence under a
sequential plan; whether a hash-bound permit belongs in the library, which the idea catalogue
currently leaves to the application; and which promise the product makes, precision on acts or the
rate at which wrong requests are acted on, which does not move with the base rate.

## What was built from this review

The first build followed the review on 2026-11-12. Everything is opt-in or additive; one behaviour
changed, in the cautious direction. The changelog has the detail; `docs/roadmap.md` has what is
left.

| Improvement | Built | Not built, or measured and not shipped |
| --- | --- | --- |
| 1. Second family on every act | `concur` (two keys), as the strictest option; its real-data test, which found it no better than pooling or the cascade | No default strategy changed |
| 2. Evidence in groups | `fitExactBar` over rows or groups, `stratifiedBound`, beta calibration and a Venn-Abers predictor; `ratchet report --exact-bar [--group]` prints the exact bar beside the reported one | The reported bar is unchanged; profiles and `check` do not read the exact bar |
| 3. Sequential promotion and demotion | `src/anytime.ts`; `Rollout` takes a detector or a first-error rule for demotion, with overdue audits reported; `Rollout.progress()` gives a running lower bound valid at every look and says when a sample can no longer pass | Promotion is still the planned test: a sequential plan changes what a rejection means |
| 4. Labels as measurements | A row keeps every label; `confirm-wrong` for the acceptance test; `ratchet review --adjudicate`; the audit probability on every enforce-mode act | Demotion and grades still read the latest label; seeded known errors |
| 5. The pool | `priorYes`; the within-class correlation and the unanimity ceiling as measurements; fixes so pool options survive every compound path | Fitted weights: tied on accuracy and lost on calibration on the real T5 rows |
| 6. Chains | The frailty model and its completion interval; a shared attempt pool; fresh-candidate checks; a second opinion that orders held candidates for a person | Chain rows are still not written to a ledger by `runChain` |
| 7. Typed state | Floors and bypasses over state entries, failing closed; a bypass must match the trusted block as well as the whole text (the one behaviour change) | Origins beyond trusted and untrusted, the two-ask mode, permits, placeholders; the injection study |
| 8. Error class becomes floor | Nothing | A proposal only |

Two results went against the review's own recommendations and are recorded as such: "two keys" was
not better than the cascade or the pooled panel on real rows, and pooling weights fitted from the
within-class correlation were not better than the shipped matrix. Both were caught by testing on
the T5 ledgers before anything became a default.
