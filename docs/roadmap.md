# Roadmap

Reviewed 2026-10-21. Historical milestones below describe the existing tree.

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
- Done (round two of research): soft pooling methods, learned composition, isotonic
  recalibration, cost-aware threshold fitting with held-out acceptance, negated ensemble
  members, `withFallback`, `RuleOracle`, `allowIf` bypasses, cache leases, `Hysteresis` and
  `Freshness`, `digest` helpers and the `Rollout` controller. The prioritised backlog from the
  pattern catalogue is in `docs/idea-catalog.md`.
- Finish the two-judge cascade run (`openai/gpt-6-luna` as a second upper tier) and test
  Banking77 with intent descriptions as criteria.
- Report `posture` (underconfident / overconfident) per question from expected versus
  observed accuracy, and let a fitted bar sit below the nominal one when the ledger earns it.
- Clef and a local Strands Decider through the same adapter; an OpenAI Decisions API adapter.
- A `ratchet` CLI: `report` (calibration and fitted bars per question from a JSONL ledger),
  `label` (attach outcomes), `shadow-diff` (agreement between soft and actual).
- Error-correlation estimation from paired member correctness in the ledger; feed it into
  ensemble pooling automatically with a pessimistic prior when unmeasured.
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
  error rate exceeds the promised one.
- Drift monitoring: expected accuracy (mean confidence) versus audited accuracy over time,
  per question and per backend.
- Conformal abstention sets as an alternative to a single bar when costs are hard to state.
- Reviewer surface: blind-audit queue that records the human judgment before revealing the
  model's answer.

## Open questions

- Name. `ratchet` says what the chain runner does; `quorum`, `jury`, `tally` and `accrue`
  say what the ensembles do. Decide before publishing.
- Package boundary: one package, or core + adapters + integrations?
- How much of the research corpus ships in the repo versus a linked report.
- Legal: the code is Apache-2.0, and [third-party terms](third-party-terms.md) records how
  provider terms apply. An open library that users run with their own key fits TypeSafe's
  Master Customer Agreement; a hosted engine reselling Jev does not, and nothing may train a
  model to imitate Jev from ledger rows. Fitting targets human outcome labels. Before
  release, confirm that the published per-call cost figures are compatible with the MCA's
  pricing-confidentiality clause (§14.1).
