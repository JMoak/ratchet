# Roadmap

Status as of 2026-10-17.

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
- A daily cap derived from the ledger rather than the process, so restarts cannot reset it.
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
- Legal: TypeSafe's Master Customer Agreement forbids offering the service as a standalone
  service and using Output to train an imitating or competing model. An open library that
  users run with their own key is fine; a hosted engine reselling Jev is not, and fitting
  thresholds on ledger outcomes should be reviewed against the Output clause before anything
  trains on Jev probabilities.
