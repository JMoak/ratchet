# Idea catalogue: every pattern pushed for Jev, mapped to the engine

Built from two research rounds (eleven note files, roughly 1,000 citations, window 15 September
to 16 October 2026) plus our own live runs. The synthesized reports are in `reports/`. This
file is the engineering view: each pattern, the best evidence for it, what the engine has, and
what to do. Status legend: **have**, **partial**, **missing**, **won't**.

Numbers are as reported by their sources; most are builder-reported on small sets. Where a
pattern was tried and removed, that is recorded too, because removals teach more than launches.

## A. Interception points inside agent loops

| # | Pattern | Evidence | Status | Engine |
| --- | --- | --- | --- | --- |
| 1 | Pre-execution tool gate | construct-auto-classifier: 12-question gate, 0 dangerous actions allowed over 1,300 decisions; pi-warden: 1,168 sessions, ask-gate cut asks 48.9% while keeping 96.7% of outcome-changing asks; Vercel 5 to 18x faster than its LLM classifier | have | `Engine` + floors + policy; `examples/tool-gate.ts`. Add a 12-question battery variant with learned pooling. |
| 2 | Stop-hook "done" verifier | jev-belay: AUROC 0.976 on 100 stops with a four-question design; limpet: 0.60 to 0.62 on 2,645 stops, "a nudge not a wall" | have | a `Gate` with a four-judge battery and a `LogisticModel` combiner; add the worked example. |
| 3 | Multi-ask pacing | jev-unpack-hook: two Choice questions, 0.80 / 0.50 bands | have | policy bands |
| 4 | Loop abort and trajectory monitors | Edward: StepShield 59.3% recall at 10.2% false positives; jev-harness abort at 0.70 | partial | chain stops on refuse; `Hysteresis` for flapping; add a trajectory-window recipe. |
| 5 | Flaky-test triage, diff-based test selection | jev-test-filter: 107 of 110 tests skipped for $0.001 | have | `screenMany`, `relevance` |
| 6 | Plan and scope drift | stepwarden: five parallel questions, allow below 0.6, ask at 0.6, block at 0.9 | have | `askAll` + policy; add example |
| 7 | Sub-agent dispatch and handoff acceptance | Foreman 0.65 to 0.80 predicates; hermes removed Jev from handoffs because digest recall was 58.7%, below the raw transcript | partial | chain verify is acceptance; rule: judge the raw artefact, never a digest of it. |
| 8 | Inter-agent message screening | mu hive: 117 to 27 to 16 messages | have | `relevance` battery |
| 9 | Memory write and read gating | Jev-Mem: LoCoMo 0.777 vs 0.700; mu retires lessons never applied | partial | `relevance`; add a memory example |
| 10 | Reversible compaction | pi-jev-context keeps above 0.8 with an undo command; mu cut 40 to 46% with zero required lines lost; pi-warden disabled its relevance compaction | have | `relevance` + `prune`; keep dropped ids so compaction can be reversed. Our live test: precision 100%, recall 70% at 0.3. |
| 11 | File and passage selection | jevcrawl: 40% vs 30% correct at an eighth of the cost; OMP find at 0.20 | have | `locate`: 100 of 100 on eight chunks live, 100% `none` when absent |
| 12 | Speculative fan-out | r6i taxonomy descent: 86% lower latency; its geometric-mean path score did not separate good from bad paths | have | `speculate`: 12 of 12 live, 138 ms vs 239 ms, cheaper than two round trips |
| 13 | Self-termination | JevLoop isDone / canDeliver; lost on latency and tokens | won't | an agent loop runner is out of scope; `runChain` covers verified steps |
| 14 | Budget and effort routing with leases | Astra-Ares 307 stars; reasoning-router 14% fewer output tokens at 44 of 44; Kilo Code production PR 0.93 vs 0.785 | partial | `cascade` + `cached` with `ttlMs` / `maxUses`; add an effort-routing example |
| 15 | Wake gating | wakegate 21 of 21, unsure band 0.2 to 0.5 | have | policy bands |
| 16 | "Does this need an LLM at all" | jev-architect | have | `allowIf` bypass + `cascade` |
| 17 | Mid-stream token gating | jev-model-tokengate: 0 leaked tokens, +0.11 s | missing | streaming hook; later |
| 18 | Permission tiers and scoped authority | Tenuo, PermitMCP one-use permits, jev-auto-approve never-deny at 0.95, r2r-jev "evidence not authority", siege learns from breaches | partial | floors + bypass + `Ruling.reason`; one-use permits belong to the application |
| 19 | Advice-only adversarial review | omp-typesafe | have | shadow mode |
| 20 | Engine infrastructure | metajev distribution ledger; jevcal CI threshold lock; stuntd 24 h shadow, 0.99 rolling-agreement auto-demotion, 2% continuous audit, novelty gate; decision-gate spend caps; Hev human-answered API | partial | ledger, audits, `budgetUsd`, `Rollout` (promote on shadow evidence, demote on audited drift); **missing**: novelty gate and a `check` CI gate |

## B. Question and state design

| Pattern | Evidence | Status | Engine |
| --- | --- | --- | --- |
| Decompose, then pool softly | Thresholded-AND lost on 9 of 10 benchmarks (median -0.137 AUROC); max, product, difference and ratio pools tied or won; TypeSafe cookbooks use min (function calls, dates), any-fires at 0.7, geometric mean (beam search) | have | `pool` methods: logodds, majority, mean, max, min, geomean |
| Questions as features, learned composition | Phishing single verdict 62.6% to 95% with five signal questions plus logistic regression; wine RMSE 2.47 to 1.77; AutoResearch 18 questions with a tree model beat a direct score | have | `fitLogistic`, `batteryFeatures`, `poolLearned` |
| Listwise choice over the pool | Hindsight: recall at 1 of 0.94 vs 0.87 pointwise at a thirtieth of the calls; escape options inside ranked lists emptied results | have | `locate`, `pick`; keep `none` for absence detection, not inside rankings |
| Lines as options, paired exists question; two-stage above 255 | TypeSafe two-stage "score independently then choose"; beam K=3; coarse fallback 65% to 80% | partial | `locate`; **missing**: a `twoStage` helper for more than 255 options |
| State engineering | jev-state band / count / time / prune: 74.3% to 100% with 43% fewer tokens; label-defining fields move AUROC +0.16 to +0.36 while wording moves +0.006; a distilled reference cut tokens 71% at no loss | have | `recipes/digest.ts`: `band`, `compare`, `relativeTime`, `daysBetween`, `count`, `pruneFields`, `lines` |
| Criteria craft | Numeric-only levels 0.55 at 0.33 confidence vs 0.0 at 1.0 with descriptions; matching examples help, unrelated ones do nothing; forced pick without `other` chose "sales" at 0.31; When2Call: 76% hallucinated tool calls without a no-tool option | partial | `locate` offers `none`; document "always offer other"; `pick()` could warn |
| Soft readouts over argmax | Argmax lost on 28 of 30 and 24 of 31 benchmarks; code-side `uncertain` at top-p 0.60 raised agreement from 90.8% to 99.2% at 74.2% coverage | have | verdicts carry full distributions; policy bands |
| Option order | Hosted 1.13 label-stable under rotation (37 datasets, 346k requests) but confidence drifts 0.13 to 0.16 | have | canonical order by default; shuffled replicas only to steady confidence, correlation 0.75 |
| Rerank and fusion | RRF of embeddings and Jev +0.090 NDCG at 10 where Jev alone was +0.012; relevance filtering beat reranking, 0.833 to 0.975 with 92% removed | partial | `relevance`; **missing**: a small `rrf()` helper |
| Confidence engineering | Isotonic ECE 0.117 to 0.008 vs Platt 0.052 on 8,801 labels; ten labels lift F1 0.706 to 0.793; label-free base-rate correction failed | have | `fitIsotonic`, `fitThreshold`, `fitThresholdByCost`; no label-free correction |
| Jev 1.14 Box and images | Box always answers (absent object boxed at 0.03); per-edge yes/no beat one; thresholds need refitting across versions | missing | adapter lacks images and box; ledger already pins model version |
| Quirks | 0.01 quantisation; sums of 0.99 or 1.01; vendor `choice` 0.01 below the top on near-ties; identical requests move up to 0.08; exact 0.0 is normal | have | adapters normalise distributions and recompute argmax; log-odds clamp at 1e-6 |
| Multilingual | Keep the rubric in English; translated questions cost 13 points on toxicity | docs | note in AGENTS.md |

## C. Real-time and interface loops

| Pattern | Evidence | Status | Engine |
| --- | --- | --- | --- |
| Latency budget | 80 to 125 ms p50 direct at 1 to 2k tokens; gateways add 75 to 500 ms; p95 is 2 to 3x p50; 6 to 10 Hz only by overlapping requests (concurrency 3 cut decision age 196 to 111 ms) | have | `mapLimit` pattern; `Freshness` tickets for overlapped requests |
| Flapping and oscillation | Doom re-creations: target flipping every tick, orbiting from a sign bug, 229 wasted shots | have | `Hysteresis` on probability or margin with a minimum dwell |
| Stale answers | keystroke, voice and canvas loops all converge on cancel-superseded, reject-stale, probability bands | have | `Freshness.accept` by sequence or by fingerprint |
| Re-ask only on change; scene-fingerprint cache | jev-drone 500 / 50 / 15 / 2.5 Hz layering, fingerprint cache | have | `cached` with leases; `Freshness.ticket().changed` |
| Scripted baselines | Pick-and-place identical to rules in 20 of 20; RuneScape random 235 vs Jev 197; NetHack first-option baseline reaches the same depth | have | `RuleOracle` as the baseline, shadow mode to compare |
| Load shedding | jev-firehose: 300 messages per second at p95 367 ms, collapse at 400 with 2,351 throttles, 12.6% shed to regex | have | `withFallback(jev, new RuleOracle(...))` |
| Speculative heads over element tables | jev-ultrafast, jev-ax-pilot p50 82 to 126 ms at $0.0002 to $0.0006 per run; nobody shuffles element order | have | `speculate` + `shuffleOptions` |
| Interface generation | Very Good Ventures 29 s to 3.8 s with below-0.5 confidence routed to an LLM; Workday Sana | have | `cascade` with an LLM upper tier |
| Code-owned limits | jev-drone refuses `climb` outside the measured ceiling | have | floors |
| Hao AI Lab 24 ms Minecraft | Self-hosted diffusion model on B200s, not hosted Jev | n/a | sets expectations: hosted loops are 100 ms class |

## D. Learning, reliability and deployment

| Pattern | Evidence | Status | Engine |
| --- | --- | --- | --- |
| ReAnchor-style threshold fitting with held-out acceptance | DSPy calibrate.py: midpoint candidates, 5-fold round-robin, accept only if better on train and on held-out sum; 0.649 to 0.816 on email triage | partial | `fitThresholdByCost` uses the same acceptance rule for the act bar; **missing**: Score cuts and Choice weights |
| Isotonic recalibration | 8,801 labels: ECE 0.117 to 0.008; n=20 gives 0.089, n=100 0.048, n=500 0.026 | have | `fitIsotonic` with `minSupport` 30 |
| Per-question thresholds from tiny label sets | ten labels lift F1 0.706 to 0.793; optimal bar near 0.35 | have | `fitThreshold`, `report()` per question |
| CI threshold lock and drift gate | jevcal `check` exits 1 on accuracy, coverage or model-version drift | have | `ratchet check` (exit 1 on broken promise, ECE bound or foreign model) and `ratchet replay` |
| Shadow-to-live state machine | stuntd: 24 h shadow, auto-demotion when rolling agreement drops below 0.99, 2% continuous audit, novelty gate | partial | `Rollout`: minimum shadow rows, promote when the would-be acted slice meets the promise, demote when audited acts fall below it; novelty gate still missing |
| Heterogeneous voting | flock: majority, unanimous and mean across different decision models; a refusal is no vote | have | `ensemble` with members on different oracles; failed-open members are dropped |
| Rotation budget early stop | AnyJev: 7.2 of 18 rotations at a 1% target | have | `sequential` with `settleLead` |
| Outcome-joined ledger, signed receipts | jev-trust: outcome-joined JSONL, 10-bin ECE, ed25519-signed logs | partial | ledger joins outcomes; signatures later |
| Feedback-loop hygiene | Arcjet: exclude engine outputs from model-visible state | docs | principle in vision.md; never feed a verdict back into the next state |
| Provider fallback | Jev returned HTTP 402 to everyone for part of 10 October; harnesses with a second backend kept working | have | `withFallback` |
| Local and open backends | Ollama 0.35.1 serves `/v1/systemone` (26-option cap); llama.cpp merged; Clef-flash hosted at $0.038 per million | have | `SystemOneOracle` with a `baseUrl`; untested live |
| Unified gateways | LiteLLM proxies `/v1/systemone` and `/v1/decisions` across vendors with a neutral `refusal` entry | partial | map `refusal` to failed-open in the adapter |
| Caches | jevcache and gotorque: never cache errors or partials; redact before hashing; no request coalescing exists anywhere | partial | `cached` skips failed-open; **missing**: coalesce identical in-flight states |
| Distillation | JEV-9B trained on 498,010 Jev-labelled rows despite the customer agreement; Strands domain fine-tune 0.49 to 0.98 | won't | training on Jev outputs is restricted by the MCA; open-weight fine-tuning is the application's business |
| Benchmarks | Abstention scores as wrong on leaderboards; open models collapse on negated wording; Jev gives exactly zero probability to the true label 16% of the time on an emotion set | docs | clamp in log-odds; report abstention separately |

## E. Domains with evidence

| Domain | Evidence | Engine fit |
| --- | --- | --- |
| Systematic-review screening | 169,982 records: AUC 0.966 vs 0.831 for an embedding baseline; work saved at 95% recall 0.806; $0.02 per 1,000; observed-to-expected calibration 0.13, so a safe stop still needs labels | `screenMany` + `fitThreshold` with a recall target |
| Entity resolution | jlink F1 0.66 to 0.996 on five DeepMatcher sets for under $1 each; identity resolution 0.948 vs Fellegi-Sunter 0.909 | judge with a structured pair state |
| Invoice coding | 2,069 real bills: ties Sonnet 5; gated at 0.8, 71% of bills auto-applied with zero errors | selective prediction is the product; `report().fitted` |
| Search | Relevance filtering beat reranking; Unblocked ships fan-out over a cross-encoder; Sayora's page picker abstains 38 of 40 vs 9 of 40 | `relevance`, `locate` with `none` |
| Ops | CI triage 5 of 6; SREGym 76.2% at 200x lower cost; turn detection interruptions 52% to 11%; the shared contract is "Jev classifies, never reruns, masks or pages" | model proposes, code decides |
| Counter-evidence | Red Hat: within a point of a 200M DeBERTa on moderation, "not faster, cheaper, or better"; Casco: 20.9% false critical CVSS promotions; Cribl: 2 to 3x the errors on 28 log types; hidden-die test: 83% stated vs 19% actual | per-task calibration; always run the `RuleOracle` baseline |
| People-facing | The acceptable-use policy has no high-risk or human-oversight clause; healthcare builds refuse PHI for lack of a BAA; a resume "knockout engine" issues rejections | `oneWayDoor` for consequential decisions about people; never automate them |

## Prioritised backlog

**P0, next.**

1. Done: `Rollout` controller (promote on shadow evidence, demote on audited drift) and the
   `digest` state helpers. Still to add: a novelty gate on unseen state hashes.
2. Done from the report's P0 list: question hash, batch size and error class on every ledger
   row; floored asks that skip the oracle when a floor fixes the outcome; `policyWithBand` for
   drift-sized review bands; `fitThreshold(..., { conservative: true })` on a Wilson lower bound.
3. Done: `ratchet report | check | replay`; `Gate`, `State`, recipes through the engine.
4. Examples: Stop-hook verifier with the four-question battery and learned pooling; the 12-question tool gate; a loop example with `Hysteresis` and `Freshness`.

**P1.** `twoStage` pick for more than 255 options; `rrf()` fusion; Score-cut and Choice-weight fitting with held-out acceptance; request coalescing for identical in-flight states; LiteLLM `refusal` mapping; a live run against Ollama and Clef through the same adapter.

**P2.** Images and Box in the adapter; streaming token gates; signed receipts.

**Won't.** A loop runner or agent framework; distillation on Jev outputs; automated consequential decisions about people; prompt-only injection defences (typed markers and warnings did nothing in three independent studies; only controls outside the model helped).
