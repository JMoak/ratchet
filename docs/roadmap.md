# Roadmap

Reviewed 2026-10-21; the end-to-end evaluation and foundations review entries added 2026-11-12.
Historical milestones below describe the existing tree.

## Foundations review (2026-11-12)

An architectural and statistical review read the engine as a quality-control regime (promotion
is acceptance sampling, the audit loop a continuous sampling plan, demotion a control chart) and
backed six findings with research notes ([report](../reports/Foundations%20review%202026-11.md),
notes in `research_notes/Foundations review 2026-11/`). No test shortens the road to a 98%
promise: a 99% gate needs 969 labelled acts for 80% power in a fixed plan and about 610 on
average under the best sequential test. What shortens it is a gate much better than its promise,
evidence counted in independent units (groups, not rows: a fitted bar broke a 95% promise 17.2%
of the time at ten rows per group in simulation), and a second model family on the act path.
The demotion window is harsh on good gates (a healthy 99% gate demoted 68.5% of the time within
10,000 acts at an audit rate of 0.1), the log-odds pool counts a gate's base rate once per
member, chains stall on a per-step verifier frailty that two ledger rates predict, and if
reviewers wrongly mark 2% of right acts wrong, a 98% promise is unverifiable at any sample size.

Built so far, each tested; nothing changes what a gate does unless it opts in, except two fixes:
a text bypass on a state with untrusted spans must now match the trusted block too, and pool
options that used to throw on a sequential run or in a cascade now pool:

- The anytime-valid arithmetic (`src/anytime.ts`). `Rollout` reads part of it on request: the
  Shiryaev-Roberts detector, or a return at the first audited error with its CSP-1 figures, as
  demotion rules (`RolloutSettings.demotion`), and a running lower bound with a `cannotPass`
  notice for a sample in progress (`Rollout.progress()`). The promotion e-process and the
  futility test are read by nothing: promotion is still the planned test, and an early wrong
  label does not reject a configuration.
- Label history and adjudication: every row keeps its labels (`DecisionRecord.labels`);
  `adjudication: "confirm-wrong"` lets the acceptance test count a "wrong" only once a second
  reviewer confirms it (a perfect gate at a 1.25% false-"wrong" rate passes the 149-act plan
  95.5% of the time instead of 15.3%, for 3.7 extra reviews; section 16 of
  [sim-results.md](sim-results.md)); `ratchet review --adjudicate` is the queue; and every
  enforce-mode act records its audit probability. The default is unchanged (`latest`), and only
  the acceptance test reads the rule.
- The exact fixed-sequence act bar over rows or groups (`src/ledger/exact-bar.ts`), printed beside
  the act bar on request (`ratchet report --exact-bar [--group <tagPrefix>]`).
- Read by nothing yet: beta and Venn-Abers calibrators, and the panel measurements in
  `src/ledger/dependence.ts`.
- Floors over state entries (`floorOn`, `entryFloor`, `allowOn`), done as the T3-10 item below.
- `PoolOptions.priorYes`; a Platt fit for `any` and `all` batteries; `concur`; the chain frailty
  model with `runChain`'s candidate keys, attempt pool and second opinion. Pool options now work
  on every compound path.

Measured and not shipped: pooling weights fitted from the within-class correlation, which lost to
the phi matrix on T5's real rows. Two keys, tested on T5's act side, was no safer than the pools
or the cascade and acted on less; the cascade to a second family (the strong-default item below)
is the best measured way to use one. ([CHANGELOG](../CHANGELOG.md),
[architecture](architecture.md), [catalogue](idea-catalog.md#foundations-review-2026-11-12).)

Next: nothing from this review is queued for building. What remains of it is the two choices
still open below and the deferred list; the end-to-end evaluation's backlog items further down
that are not marked done still stand.

Decided 2026-11-12 (the owner delegated the choices the evidence settles):

- **The exact bar stays beside the scan, on request.** They answer different questions: the scan
  proposes where to freeze a bar, and the exact bar says what the rows already prove. A 98% bar
  needs 149 clean rows at or above it, so on a fit phase of about 50 rows the exact bar is always
  "none", and replacing the scan would blank the report where a candidate is needed. The planned
  test stays the judge of a frozen bar. Run `--exact-bar --group` before a freeze whenever rows
  cluster (section 13 of [sim-results.md](sim-results.md)).
- **No hash-bound permit in the library.** A permit is about executing an action, and the engine
  executes nothing; the catalogue's "won't" stands.
- **The matrix-path confidence cap stays.** It was adopted for a verified defect, and the gain
  from dropping it is a simulated 0.003 to 0.011 of log loss. Real rows showing the cap costs
  acts would reopen it.
- **The window rule reads what the other rules read** (fixed, [CHANGELOG](../CHANGELOG.md)):
  audited acts only, with a label the plan's `sources` admit, so `n` and `accuracy` count the
  same rows, and an act labelled only by another source is counted as unread.
- **The audit rate stays out of the scope hash.** A passed plan's evidence does not depend on the
  rate, so changing it must not send a gate back through its planned sample. The first-error
  figures are stated at promotion, at the rate in force then; they move when the rate does.
- **Demotion does not wait for a confirmed "wrong".** An unconfirmed "wrong" audit still returns
  a gate to shadow under the window and first-error rules, the cautious direction. Under the
  default detector one error never demotes, so the question does not arise there.
- **Shadow grades read labels as the plan does** (fixed): under `confirm-wrong` a rollout's
  shadow grade can no longer disagree with its acceptance test. Enforce grades stay on the
  latest label, which is what demotion reads. Reports, `check`, `trail` and `Engine.report`
  take no plan, so a gate the rollout rejected under a non-default plan can still pass
  `check --require measured`; `check` is a convenience and promotes nothing, so this waits for
  plan flags on the CLI.
- **`latest` keeps reading the latest label, admitted or not.** A later label from a source the
  plan does not read leaves the act unlabelled to the test, the status says how many acts are in
  that state, and a blind re-review settles it. Reading the latest admitted label instead would
  let a review stand after a revert contradicted it.
- **Not built until someone needs them:** `--trust` on `ratchet review` (no plan combines custom
  label trust with adjudication yet), decoys in the adjudication queue (the leak tells a reviewer
  a label is disputed, which biases toward confirming "wrong", the cautious side; it belongs with
  the seeded known errors), and one audit per session for the demotion rules (session
  correlation makes the detector alarm sooner than its bound says, also the cautious side).

Still open, the owner's to make:

- **The default demotion rule.** The window rule has no stated guarantee and returns a healthy
  99% gate to shadow 68.5% of the time within 10,000 acts at an audit rate of 0.1; the detector
  cuts that to 4.7% and lets about four times as many wrong acts run after a drop to 95% (70.9
  against 16.4); first-error is the most cautious and the only one with a stated outgoing-quality
  limit (sections 10 and 11 of [sim-results.md](sim-results.md)). Which is right depends on what a
  false demotion costs against a wrong act, which is a property of the deployment: on keywork's
  volume a demotion costs months of labels.
- **Which promise the product makes:** precision on acts, or the rate at which wrong requests
  are acted on, which does not move with the base rate. Precision is what a planned sample of
  acts can prove on real traffic; the other needs wrong requests in volume, which real traffic
  rarely has. A gate that removes prompts sells the first and a gate that adds caution to a
  harness that allows everything sells the second, so this follows the choice of what to build
  next.

Deferred until evidence asks for them: a novelty floor, a Venn-Abers review band, a conformal
tripwire, verdict-dependent audit rates, the injection study (its protocol is in
`research_notes/Foundations review 2026-11/information_flow_security.md`), a sequential promotion
plan (the arithmetic is built; wiring it changes what a rejection means, which is the owner's
call), one audit per session for the demotion rules, a data form of the Platt combiner in
`GateSpec` (so that a refit moves the rubric hash and `ratchet review` reads its any / all
shape), seeded known errors to measure what reviewers miss, and stratified or weighted audits
that would read `auditProbability`.

## End-to-end evaluation (2026-11-12)

Five tracks ran the real engine, ledger, review command and CLI live against Jev on new,
authored corpora, with every label fixed before the first call
([registry](e2e/findings.md), [T1](e2e/t1-toolgate.md), [T2](e2e/t2-verifier.md),
[T3](e2e/t3-triage.md), [T4](e2e/t4-redteam.md), [T5](e2e/t5-compound.md)). What held: floors
were never lowered (0 of 1,169 rows rechecked), one-way doors never acted, transport failures
always reviewed, the planned exact test refused a gate whose 98% bar delivered 91.2% on held-out
groups and kept the refusal across restarts, the CLI matched independent recomputation 20 of 20,
the daily cap survived a restart, digesting numbers and dates in code was confirmed four times
(66.7% to 99.1% on approvals), a verifier committed only correct outputs, and a cascade from Jev
to a model of a different family reached 98.5% against 85.8%. What did not: a bar fitted on 180
items did not transfer to held-out groups; the ratchet formula predicts the precision of
commits, not whether chains finish (48% to 62% against 74% to 99.8%); a log-odds battery lost to
one holistic question and inverted an any-of battery; replicas, framings and a second Jev pin
added nothing; the disagreement sentence reads as a gate's error rate when it bounds only "at
least one judge is wrong"; malformed adapter answers acted in 128 of 1,908 fault cells. Engine
fixes are wave 2's work packages in the registry. The evaluation added these to the backlog:

- **A sequential demotion test** (T1-07). At an audit rate of 0.2 and 30 audits to judge,
  nothing demotes before about 150 acts, and 10 wrong acts executed before a demotion in T1. A
  CUSUM or SPRT on audit errors with an explicit false-alarm rate, or a short recent window
  beside the long one; at least print acts-to-first-judgement with every promotion. This is the
  "guarded rollout" item under 0.4, now with a measured cost. (Done 2026-11-12, opt-in:
  `RolloutSettings.demotion` takes a Shiryaev-Roberts detector or a first-error rule, and a
  detector promotion states the fewest audited errors that can demote, in acts; see the
  foundations review entry above.)
- **Opt-in sampling of auto-mode runs for hook labels** (T1-03). In auto permission mode the
  hook journaled 41,628 events and 4 prompts, so `ratchet hook replay` has nothing to learn from.
  A seeded fraction of runs could keep a scrubbed subject for blind review.
- **Floors over state entries** (T3-10; done 2026-11-12). `floorOn` and `entryFloor` read the
  builder's entries rather than the rendering, fail closed when the entry is missing, and read
  untrusted spans only on request (T4-14); a digest can keep its raw value for them. Bypasses
  must match the trusted block as well as the whole text, and `allowOn` reads trusted entries
  only. Origins beyond trusted and untrusted, placeholders and the two-ask modes in the
  information-flow notes are not built.
- **Act-side calibration profiles** (wave 2, package C). Reported bars are now fitted on the act
  side, but judge profiles still bin leading-answer confidence, so a borrowed bar and a fitted
  bar mean the same thing only for gates whose go side is yes. Needs profile format 2 and
  regenerated `profiles/`.
- **Strong default: a cascade to a model of a different family** (T5). It connects to the
  second opinion in [design/evidence-grades.md](design/evidence-grades.md). T5 gives the shape: Jev first with a
  tier-1 bar fitted on labelled shadow rows, then a generative model of another family, with
  the tiers' error correlation measured on an unselected sample where the upper tier answered
  every item (a cascade's own rows pair tiers only when it escalated). Two pins of one family
  must not count as a second opinion, and a blanket correlation of 0.5 for different models
  raised log loss on T5's mixed panel (0.095 to 0.132), where per-pair weights did better than
  any single correlation.
- **The prompt-injection study** (T4). Planned and not run: a safety classifier stopped the
  agent authoring the payloads and the study was not rerouted. The injection figures in
  `vision.md` remain the literature's. Building the study from a published benchmark's
  payloads is the next attempt. (2026-11-12: deferred until evidence asks for it; its protocol
  is now written, in `research_notes/Foundations review 2026-11/information_flow_security.md`.)

## Current priority: prove one tool gate and verifier lifecycle

Keep one small library, no runtime dependencies, and the existing deterministic policy
boundary. The first pilot is agent tool gating, run on keywork, Jordan's coding-agent
harness: its asks are the traffic and the person's answers are the labels
([design](design/keywork-gate.md)). The promise is set (Jordan, 2026-10-21): 98% on acts, by
an exact one-sided 95% bound on a planned sample, so 149 consecutive correct acts.

The implementation review hardened repeated regex floors, failure and timeout handling for
explicit strategy backends, sequential replica correlation, malformed adapter outputs,
rollout action scoring, isotonic ties, and cost-based fitting. Regression tests cover the
counterexamples; these changes add no new primitive.

The milestone is evidence that earns enforcement, ahead of more adapters or middleware. The
first offline/live harness is in `experiments/pilot/` (`bun run pilot`, [guide](pilot.md));
its 54 authored fixtures are regression evidence, and the
[first live run](pilot-results.md) is recorded. Where the four steps stand:

1. **Done: representative labels, recorded by route.** `Outcome.source` names where a label
   came from (`keywork:person` for an answer in the moment, `review:blind` for a considered
   review), and `ratchet review` draws a seeded uniform sample for blind labels recorded
   before the model's answer is shown. In keywork, every ask a person answered is labelled,
   which is a census of the population the gate would replace, not a selection.
2. **Done: freeze, then validate once at a planned point.** `src/acceptance.ts` fixes the
   sample before labels are read (first eligible acts, retries once, a cap per session),
   keeps it sealed until complete, and evaluates once by an exact Clopper-Pearson bound.
   Rollout promotes only through it; a rejected configuration stays in shadow until it
   changes, and the checkpoint carries the rejection.
3. **Done: the seeded comparison.** Tables 7 and 8 of [sim-results.md](sim-results.md): at a
   98% promise the point estimate promoted a 95% gate in 96% of runs and a 97% gate in all of
   them; the exact test held those to 0.1% and 1.1%, at the cost of power (a 99% gate passes a
   zero-error plan about a fifth of the time). Audit-based demotion catches drift but often
   demotes a healthy gate too.
4. **In progress: one complete loop on real traffic.** keywork now journals its asks, marks
   whether each verdict answered one, and exports scrubbed decision records
   (`keywork sessions decisions`, its overlay 122); `bun run keywork` replays them through the
   `keywork.tool` gate in shadow. The loop runs end to end; what it lacks is volume. keywork's
   history here is 9 person answers over two days, and 149 acts answered by hand take months. That
   history is the smoke set (`--smoke`, a ledger of its own), and its live run on 2026-10-22
   changed the plan: Jev put routine calls at 0.72 to 0.89, so the fixed 0.95 bar acted on
   nothing, and one denial of `ls -la` judged the moment rather than the call. The experiment now
   runs in three phases, smoke, fit and evidence, each with its own ledger: the bar is fitted on
   about 50 fit rows, frozen in one commit, and validated only on rows after the freeze; keywork
   1.4 asks why on a denial, a `not-now` leaves the population, and every denial is blind-reviewed
   (`ratchet review --denied`). The success criteria were fixed before the first evidence row
   ([design](design/keywork-gate.md)). The output-verification example follows through the same
   machinery.

Open choices the evidence will force: where to freeze the bar once the fit phase has its rows,
whether to tolerate a few errors in the plan for power (313 acts at 98% for two), whether to turn
audits on before enforcing, and a sequential demotion test with an explicit false-alarm rate in
place of the eager rule. Primary sources and reasoning are in the
[learning notes](../research_notes/Jev%20novel%20patterns%20catalog/learning_and_tooling.md).

The evidence boundary is shared across calibration, CLI reports/checks, and rollout:
code-only floor/bypass rows remain operational records but cannot improve model metrics,
earn promotion, or hide failed model audits. Answered rows with a caution floor still
contribute real oracle evidence. Regression fixtures reproduce both false promotion and
masked drift from a large correct allowlist.
Threshold fitting also keeps sufficient unselected evidence even when no threshold meets
the target; confidence-selected successes cannot turn that failed fit into a passing one.

Rollout binds evidence to rubric, effective policy, acceptance plan, caller-owned
configuration version and an optional exact model pin. Ledger-order phase boundaries prevent
old successes or late labels from carrying over. Fresh controllers warm up in shadow;
caller-persisted checkpoints resume only with a matching scope and ledger anchor. The
[lifecycle guide](rollout.md) includes the test's assumptions, migration and the versioning
responsibilities.

Review followups, settled 2026-10-21: audits stay opt-in (Jordan's decision); a gate promoted
without them cannot be demoted by evidence, and Rollout says so when it promotes one and on
every later status. Spend is capped per UTC day from the ledger (`dailyBudgetUsd`), so a
restart cannot reset it, with a reservation per request in flight; it is documented as a
recorded-spend cutoff, not a prepaid budget, and provider-side limits remain the only hard
guarantee.

## Companion applications: Relly and Pebble

Relly, a local research workbench that uses Ratchet's gates for subject relevance, and
Pebble, a small virtual pet built on the engine, live in their own repositories with their
designs, research and evaluations.

Both applications use sibling Ratchet sources during local development. Ingestion, UI,
pet simulation and application persistence stay outside this engine. These experiments
do not replace the tool-gate pilot or establish a production accuracy guarantee.

## 0.1 (this tree)

- Vocabulary, policy, floors, engine facade, ledger, calibration.
- Compounding strategies: ensemble, sequential, cascade, chain.
- Simulated oracle with accuracy, calibration temperature, error correlation, position bias.
- LLM-as-oracle adapter over OpenAI-compatible endpoints (OpenRouter by default).
- `SystemOneOracle` for the Jev wire format (TypeSafe, Cloudflare Clef, Amazon Strands Decider,
  Vercel gateway), with mocked-transport tests, plus `jevViaOpenRouter()`; verified live on
  2026-10-16 against `typesafe/jev-1.13` through OpenRouter (128 ms, $0.000023 for four answers).
- `scripts/set-key.ps1` writes API keys to the gitignored `.env` from a hidden prompt.
- Live experiments (`experiments/live/`, `bun run live`): cost structure, BoolQ calibration and
  re-asking, Banking77 routing and option order, cascade correlation, weak-spot probes.
  Findings in `docs/live-findings.md`; they set the replicated-ensemble correlation default
  (0.75), the `vendor.batch` field, and the `shortlist()` helper.
- Simulation suite and a PreToolUse gate example. 60 tests.

## 0.2 (this tree, 2026-10-17): gates, state, recipes through the engine, CLI

- `Gate` as the unit of configuration, learning and rollout; batteries with combiners; request
  ids and trust-split hashes on every ledger row; recipes take an `Asker` so nothing bypasses
  the ledger or the budget; `Rollout` per gate.
- `State` builder: trusted fields, digests, untrusted spans, record pairs; refuses engine
  objects and rendered rulings so verdicts never re-enter the state.
- `ratchet report | check | replay` over a JSONL ledger; recall-target fitting and `coverageAt`.
- 186 tests. Design brief: `docs/design/gate-and-state.md`.

## 0.3: real backends and a real ledger loop

- Done: a per-instance spend cap (`budgetUsd`) that fails open into review; recipes for
  speculative flattening, relevance batteries, map-reduce screening and chunk location, with
  lead-by-k stopping in `sequential()`. Measured live in `docs/live-recipes.md`.
- Done (2026-10-21): a daily cap derived from the ledger rather than the process, so restarts
  cannot reset it (`dailyBudgetUsd`, `DailySpend`).
- Done (2026-10-28): compound rows keep their member answers and the strategy's detail;
  `ratchet trail` reads the path to each verdict back, and the viewer in `examples/trail/`
  draws it (one evidence scale per decision, the act bar inferred from the rulings). Chain
  traces (`runChain`) are still not persisted; a step's verifications reach the ledger only
  through whatever gate the verifier asks.
- Done (round two of research): soft pooling methods, learned composition, isotonic
  recalibration, cost-aware threshold fitting with held-out acceptance, negated ensemble
  members, `withFallback`, `RuleOracle`, `allowIf` bypasses, cache leases, `Hysteresis` and
  `Freshness`, `digest` helpers and the `Rollout` controller. The prioritised backlog from the
  pattern catalogue is in `docs/idea-catalog.md`.
- Finish the two-judge cascade run (`openai/gpt-6-luna` as a second upper tier) and test
  Banking77 with intent descriptions as criteria. (The luna run is done, 2026-11-12, e2e T5:
  97.7% alone and 97.7% as a cascade tier, its confidences too high to sort; Banking77 criteria
  are still open.)
- Report `posture` (underconfident / overconfident) per question from expected versus
  observed accuracy, and let a fitted bar sit below the nominal one when the ledger earns it.
- Clef and a local Strands Decider through the same adapter; an OpenAI Decisions API adapter.
- A `ratchet` CLI: `report` (calibration and fitted bars per question from a JSONL ledger),
  `label` (attach outcomes), `shadow-diff` (agreement between soft and actual).
- Error-correlation estimation from paired member correctness in the ledger; feed it into
  ensemble pooling automatically with a pessimistic prior when unmeasured. (e2e T5: one scalar
  is right for replicas and framings of one model and wrong for a mixed panel, where per-pair
  weights from the measured matrix beat every scalar; explicit members of one model defaulted
  to the optimistic 0.)
- Live calibration run: the demo corpus against Jev and against a generative model, with
  reliability diagrams side by side.

## 0.3: where the decisions are made

- Claude Code hook package: `PreToolUse` gate with floors, shadow mode by default, ledger
  under `.claude/`, `report` surfaced as a slash command.
- Middleware shape for LangChain / LangGraph and a Vercel AI SDK provider.
- MCP server exposing `ask`, `askAll`, `label`, `report` so any connected agent can use the
  engine.
- Context compaction decision: per-item keep / drop judged on tool-call metadata, never on
  untrusted outputs.

## 0.4: learning that stays honest

- Threshold re-fit with held-out folds and a minimum-sample rule; accept a new bar only when
  it improves on the unselected slice and holds out of sample (the ReAnchor idea applied to a
  live ledger instead of an offline program).
- Guarded rollout: a sequential test that auto-reverts enforce to shadow when the audited
  error rate exceeds the promised one. (Measured need, 2026-11-12: see the end-to-end entry at
  the top. Built 2026-11-12 as an opt-in demotion rule, `RolloutSettings.demotion`; see the
  foundations review entry.)
- Drift monitoring: expected accuracy (mean confidence) versus audited accuracy over time,
  per question and per backend.
- Conformal abstention sets as an alternative to a single bar when costs are hard to state.
- Reviewer surface: blind-audit queue that records the human judgment before revealing the
  model's answer.

## Open questions

- Settled: the name is `@jmoak/ratchet`, one package with no runtime dependencies (split only
  when an adapter needs one), and the research stays in the repository while the package ships
  `dist`, `NOTICE` and `CHANGELOG.md`.
- Legal: the code is Apache-2.0, and [third-party terms](third-party-terms.md) records how
  provider terms apply. An open library that users run with their own key fits TypeSafe's
  Master Customer Agreement; a hosted engine reselling Jev does not, and nothing may train a
  model to imitate Jev from ledger rows. Fitting targets human outcome labels. Before
  release, confirm that the published per-call cost figures are compatible with the MCA's
  pricing-confidentiality clause (§14.1).
