# Subject relevance as a decision system

Research and proposal, 2026-10-20. This is a design investigation, not a claim that the
proposed system works. No production implementation or new live experiment accompanies it.
The binding constraints remain [the vision](../docs/vision.md).

## Recommendation

This is worth pursuing as an application built on Ratchet. Its coherent product is a
project research workspace that turns a subject, a current goal, and source material into:

1. A useful evidence set within a reading or context budget.
2. A navigable subject map whose concepts and relationships link to original evidence.
3. An explicit, editable understanding of what matters to this person and project over time.

These are connected layers with different truth conditions. A document can concern the
subject, fail to help the current goal, and still be valuable for another project. A
contradictory source can be more useful than a supporting one. Familiarity, popularity and
agreement are not definitions of relevance.

Ratchet should own typed judgments, deterministic policy, failure behavior, ledger,
calibration and rollout. The application should own ingestion, retrieval, source storage,
subject maps, set selection, personal preferences and the review interface. Begin the proof
inside `experiments/relevance/`; extract a separate application/package when the evidence
and recurring workflow justify maintaining it. A second engine or a general agent framework
is unnecessary.

The distinctive opportunity is an accountable explanation of *why this evidence belongs
here, what remains missing, and how this choice has performed*. A generic embedding search
interface or an automatically drawn knowledge graph would not establish that value.

## The three questions must stay separate

Let a need consist of subject `S`, explicit goal `G`, project constraints `C`, current time
`T`, and an approved preference snapshot `P`. For source item `d`, separate:

- **Subject membership:** Does `d` discuss a concept or relationship in `S`?
- **Task utility:** Does the actual evidence in `d` help answer `G` under `C`, `T`, and `P`?
- **Marginal contribution:** Does `d` add an important facet, counterexample, prerequisite,
  independent source, or useful detail beyond the current selected set?

The first two can be pointwise questions. The third is about a set. None is equivalent to
cosine similarity, and none is generally transitive. If a paper is related to a concept and
that concept is related to a project, the paper is only a candidate for the project.

An operational first target is: *Would a domain-competent reviewer retain this original
passage as evidence for this stated goal?* Labels should also record whether it supplies
support, counterevidence, a limitation, a prerequisite, or background. Usefulness is not
the same target as whether the passage's factual assertions are ultimately true.

If the user supplies only a subject, make the initial goal explicit as exploration:
representative concepts, differing perspectives and open questions. Do not imply that this
exploration pack is optimal for an unstated downstream decision. The user can turn a
discovered question into a narrower, versioned need.

Example: for “choose a local search architecture for a TypeScript desktop application,” a
general article about vector databases is on topic. A benchmark under the actual memory
limit is useful. A supported limitation that rules out the preferred architecture can be
essential. A second retelling of the same benchmark may add almost nothing.

## What the primary evidence supports

The following are findings of the cited work, with the proposed engineering implication
and evidence limit stated separately. Results on those systems do not establish Jev's
performance on this application.

| Evidence | Finding relevant here | Implication and limit |
| --- | --- | --- |
| [BEIR, 2021](https://arxiv.org/abs/2104.08663), [maintained benchmark](https://github.com/beir-cellar/beir) | Evaluation across heterogeneous retrieval tasks found BM25 a robust baseline and showed different effectiveness/cost tradeoffs for retrieval and reranking approaches. | Compare lexical, dense and hybrid retrieval. Do not infer that semantic embeddings dominate on a new domain. |
| [BRIGHT, ICLR 2025](https://github.com/xlang-ai/BRIGHT), [paper](https://arxiv.org/abs/2407.12883) | The benchmark targets retrieval that needs reasoning beyond straightforward semantic matching, using queries from several real human activity domains. | Include items that are lexically distant but useful and items that sound similar but fail the goal. BRIGHT tests retrieval, not long-term personal usefulness. |
| [Pairwise Ranking Prompting, 2024](https://arxiv.org/abs/2306.17563) | Pairwise comparisons produced strong zero-shot ranking results in the evaluated settings; efficient variants reduce the burden of full pair enumeration. | Test pairwise comparisons near a cutoff. Their preference probabilities are not probabilities of absolute usefulness. |
| [Consolidating Ranking and Relevance Predictions, EMNLP 2024](https://aclanthology.org/2024.emnlp-main.25/) | Ranking skill and the quality of relevance labels can differ; combining the two through post-processing improved their tradeoff in the experiments. | Report ranking and calibrated binary decisions separately. Better ordering does not establish a safe exclusion threshold. |
| [Found in the Middle, NAACL 2024](https://aclanthology.org/2024.naacl-long.129/), [position consistency, RecSys 2026](https://arxiv.org/abs/2608.03091) | Candidate ordering can change listwise results; the newer work finds that relevance effectiveness and preference consistency need not improve together. | Test permutations and batch composition. Repeated permutations are robustness checks, not independent votes. |
| [HiExpan, KDD 2018](https://hanj.cs.illinois.edu/pdf/kdd18_jshen.pdf), [code](https://github.com/mickeysjm/HiExpan) | A seed taxonomy can guide corpus-based expansion; the task may require relations beyond an “is-a” hierarchy. | Seed a subject with user-owned scope and grow proposed concepts from sources. Do not assume one universal taxonomy is correct. |
| [STORM, NAACL 2024](https://arxiv.org/abs/2402.14207), [code](https://github.com/stanford-oval/storm) | Perspective-guided research helped article organization and breadth in the evaluation; editors also identified source-bias transfer and association of unrelated facts. | Use diverse perspectives to propose facets and missing questions. A proposed outline is neither ground truth nor proof of source relevance. |
| [GraphRAG, revised 2025](https://arxiv.org/html/2404.16130v2), [code](https://github.com/microsoft/graphrag) | The system uses extracted entities, graph communities and summaries for global corpus questions; its evaluation includes generated questions and LLM comparative judgments. | Graph structure may help broad exploration. This evidence does not demonstrate calibrated edges, reliable personal relevance, or superiority on every retrieval task. |
| [SciFact, EMNLP 2020](https://aclanthology.org/2020.emnlp-main.609/), [code/data](https://github.com/allenai/scifact) | Scientific claims are paired with supporting/refuting abstracts and rationale spans. | Useful diagnostic for evidence relations and counterevidence. Its domain and claim construction do not represent the entire proposed product. |
| [SciFact-Open, EMNLP 2022](https://aclanthology.org/2022.findings-emnlp.347/) | Pooled systems expose a larger evidence space, including sources that only support a special case of a claim. | Preserve scope qualifiers. “Relevant evidence” must not silently become “unqualified proof.” |
| [Submodular document selection, ACL 2011](https://aclanthology.org/P11-1052/) | Coverage and diversity can be encoded in set objectives with diminishing returns; optimization guarantees apply to the specified mathematical objective. | Select a set in code. A guarantee about that objective does not guarantee that the model's facet scores or the objective reflect human utility. |
| [Reciprocal Rank Fusion, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) | Combining ranks from retrieval systems improved the evaluated results without supervised rank fitting. | RRF is a good hybrid baseline. It produces a ranking score, not a relevance probability or proof of independent evidence. |
| [LaMP, ACL 2024](https://aclanthology.org/2024.acl-long.399/) | Retrieval from user profiles can improve personalized classification and generation across its benchmark tasks. | Personal context can matter. It does not show that clicks reveal stable goals, nor that personal relevance equals objective truth. |
| [Unbiased Learning-to-Rank, WSDM 2017](https://arxiv.org/abs/1608.04468), [Recommendations as Treatments, 2016](https://arxiv.org/abs/1602.05352) | Exposure and self-selection bias distort observed feedback; counterfactual methods require an explicit observation model. | Log exposure and selection. “Not clicked” is not a negative label. Random feedback collection is simpler than premature propensity correction. |
| [LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813), [maintained repository](https://github.com/xiaowu0162/LongMemEval) | Memory evaluation distinguishes extraction, temporal reasoning, updates, multi-session reasoning and abstention. | Test preference updates and stale context separately from ordinary retrieval. Answer correctness is not a measure of long-term user benefit. |
| [LongMemEval-V2, May 2026](https://arxiv.org/abs/2605.12493) | This work-in-progress benchmark asks systems to gather compact context from long histories of web-agent experience. | A relevant newer diagnostic for project experience; its environment and maturity limit generalization to a research workspace. |
| [NIST, Bias and the Limits of Pooling, 2007](https://www.nist.gov/publications/bias-and-limits-pooling-large-collections) | Incomplete pooled judgments can bias evaluation of retrieval systems. | Unjudged is not irrelevant. Measure the retrieval blind spot with independent sampling or a small exhaustively judged corpus. |

## A source-first architecture

The following is a proposal, not a system copied from any one paper.

```text
original sources + user goals/preferences
                 |
      normalize, snapshot, segment, index
                 |
       broad candidate retrieval
                 |
    source-grounded concept/facet proposals
                 |
       Ratchet judgments and policy
                 |
 deterministic budgeted evidence selection
                 |
 evidence pack + subject map + unresolved queue
                 |
 explicit feedback / independent blind labels
                 |
 versioned fitting and held-out validation
```

The graph is an index and a review surface. It must not be the sole evidential memory.
Future judgments inspect original passages, not previous verdicts, confidence numbers or
phrases such as “the system already established this.” A graph edge can retrieve source
IDs without being asserted as a fact in the next model state.

### Source contract

Each admitted source needs an immutable `sourceId`, canonical URI or local locator, content
hash, collection timestamp, original publication/update timestamp when known, parser
version, content type, access scope, and source-family identifier. Preserve source version
and offsets for every passage. A checksum proves identity, not truth.

Keep original text, extracted text and any generated summary distinct. Generated summaries
are lossy artifacts with producer/model/version and source spans; they are not trusted
metadata. They may aid candidate retrieval but cannot be the only material behind a
decision to discard evidence. Metadata-only retrieval is a cost-saving tier whose recall
must be tested against original bodies.

The application validates UTF-8/JSON structure, IDs, spans, token/size budgets, file scope and
source links in code. Retrieved text is always evidence, not authority over the workflow.
The same applies to text from otherwise reputable publishers.

### Subject induction and incremental maps

Start with a user-approved subject description, exclusions, goal, time horizon and a small
facet list. “What the corpus contains” and “what the task needs” are separate maps; absence
from the former can expose a gap in the latter.

Propose new concepts from headings, explicit entities, keyphrases, lexical/dense clusters,
and a bounded generative extraction step. Require source spans for any proposed relation.
The proposal generator is an application component; Ratchet's `Oracle` remains a typed
decision interface.

Use a small relation vocabulary first: `discusses`, `supports`, `contradicts`, `qualifies`,
and `prerequisite-for`. Each has a different rubric. A claimed causal relation needs a
separate evidence standard and should be out of the initial release. Do not force all
relations into a tree or interpret co-occurrence as a relationship.

Model provenance as first-class data:

- `Concept`: stable ID, aliases, scope, source references, proposal status, version.
- `RelationProposal`: subject/object IDs, relation type, original passage references,
  applicability qualifiers, proposer and proposal version.
- `RelationAssessment`: proposal ID and Ratchet record IDs, preserved separately from facts.
- `SubjectVersion`: approved scope/facets, revisions and supersession links.

Distinguish “the source states this relation,” “the source provides evidence for it,” and
“the relation is true in the world.” The first is an extraction target; the others require
stronger standards. Store disagreements rather than averaging them into an invented fact.

On new sources, update only affected candidates and source-linked materializations.
Retractions, superseding sources, changed scope and removed permissions invalidate dependent
views and trigger review. Missing sources do not become negative evidence. Never multiply
edge confidence along a path or promote a relationship through transitive relevance.

Track novelty independently of current labels so new concepts can enter an “unmapped”
queue. Otherwise an early incomplete map becomes a self-reinforcing filter. Review merges
and aliases: two strings may name one concept; one string may name several.

### Retrieval and judgment

Use lexical search and a dense retriever as candidate generators; include explicit seed
sources and optional citation neighbors. RRF is a simple comparison baseline. Enforce source
permissions before retrieval. Log candidate origin, rank, index version and complete
candidate-set identity. Source duplication and syndicated copies belong to one source family.

Candidate recall is a hard upstream limit: a perfect reranker cannot recover a useful source
that never enters its candidate set. Report candidate recall separately from conditional
reranker recall and final selected-set coverage. Do not call “none of the top 50 was useful”
evidence that no useful source exists.

For the first Ratchet path, assess one item against a stable need and ask all questions
sharing that state in one request. Useful diagnostic questions include:

- Does the original passage bear directly on the stated goal or a declared prerequisite?
- Is its evidence applicable to the specified environment, population, version and time?
- Does it supply support, counterevidence, limitations or background?
- Would a competent reviewer retain it as evidence for this task?

These are features with differing semantics, not independent votes on one fact. Begin with
a direct utility judgment plus diagnostic questions. Compare it with a learned composite
only after enough independent labels exist. Do not multiply feature probabilities, use
unmeasured log-odds pooling, or threshold every feature and AND the results. Correlation
between judge errors is distinct from dependence among source publications.

Keep stable question and gate IDs for the semantic decision. Item IDs belong in application
records/tags, not unique question IDs that fragment calibration by document. Fit against
the particular subject/goal population and monitor meaningful strata without fitting tiny
separate models for every facet.

| Formulation | Suitable role | Main limitation |
| --- | --- | --- |
| Pointwise utility | Primary auditable gate; calibrated absolute decision and abstention | Cross-query score drift; may miss complementarity |
| Pairwise preference | Resolve a small near-cutoff shortlist; compare alternatives | Cycles/order effects; no absolute sufficiency; exhaustive comparisons cost quadratically |
| Listwise selection/ranking | Optional experiment when comparison context is valuable | Context/batch/order dependence; forced ordering can rank an all-bad set |
| Code-side set selector | Budget, coverage, duplicates, provenance constraints | Optimizes only the specified surrogate; depends on useful input assessments |

Pairwise choices should permit equivalence and neither being useful. A ranked list must have
a separate absence/insufficiency decision. A pairwise winner among two useless sources is
still useless. Swapping order is a diagnostic; it does not manufacture independent evidence.

### Selection under a real budget

Do not take the first `k` items above a threshold and call the result a complete evidence
set. Select within token, reading-time, latency and spend budgets, keeping all original items
recoverable. Separate:

1. Candidate eligibility and unresolved review status.
2. The final pack chosen under the actual budget.
3. Why each other candidate was excluded, deferred, duplicated or not assessed.

A sensible first selector uses deterministic coverage with diminishing returns:

`F(A) = sum_f w_f * max_{d in A} coverage(d,f)`

Here `coverage(d,f)` is a bounded suitability score for an item/facet pair, **not** an
independent probability; `w_f` comes from the approved goal. This max construction does not
assume independent sources. Add facets for counterevidence and known limitations. Apply
code-owned source-family and per-document caps to reduce repetition.

A greedy marginal-gain-per-token implementation is a practical baseline. Do not claim a
particular approximation factor under arbitrary costs, constraints or penalties without
implementing the algorithm whose theorem applies. Compare against a simple top-k and a
diversity baseline. For multi-hop prerequisites, single-item coverage can miss complementary
pairs: include explicit bundles or report an unresolved dependency instead of pretending the
initial objective captures every utility.

The output should expose covered facets, uncovered facets, source families, unresolved
items and the imposed budget. Selection is not a completeness certificate. An inaccessible
critical source or unfilled mandatory facet produces “incomplete evidence,” even if every
selected source scored highly.

### Personal and project relevance over time

Begin with user-owned preferences: project scope, desired depth, known material, excluded
sources, current constraints and expiration dates. Store provenance and scope for each
preference; “for this project” must not silently become “for this person everywhere.”
Explicit edits take precedence and should be reversible.

Collect feedback with distinct meanings: useful for this task, already known, wrong scope,
incorrect evidence, too much detail, saved for later, and not enough time. A click or save
is an observation of behavior, not a truth label. No response is missing data.

Log an exposure event before interpreting feedback: need/profile versions, eligible
candidate set, displayed set, positions, selection policy, selection probabilities where
randomization is used, and feedback time. Include reasons a candidate was never exposed.
Without overlap in what policies can show, historical logs cannot identify performance for
unseen alternatives.

Initially learn only from explicit feedback plus a confidence-independent sample of
candidates reviewed for relevance, including outside the selected pack. Keep active learning
for annotation efficiency separate from calibration/acceptance samples. Counterfactual
estimators or contextual bandits are later options, requiring adequate support and a
defensible propensity model; they are not a shortcut around collecting representative data.

Fit small preference weights in code from the event ledger. Validate on later sessions,
with user/project grouping. Never learn preferences from prior model endorsements, and do
not turn accepted graph edges into user preferences. Personalization can change selection
weights; it cannot lower source-access floors, erase relevant counterevidence, or rewrite
factual assessment.

## Ratchet integration: what is present and what needs care

The current tree already supplies `Engine`, registered gates, `State`, typed questions,
`screenMany`, budgets, failure handling, JSONL ledgers, isotonic fitting, logistic feature
composition, per-gate reports and rollout. A subject application should first consume these.

Important limits of the current implementation:

- `relevance()` is a context-compaction helper. Its summaries are appended to the trusted
  state rendering; imported snippets must not pass through this path unchanged.
- `prune()` thresholds the raw score map. It does not enforce `AskResult.action`, shadow
  behavior or review handling. A failed-open score is `0.5`, and a threshold above that puts
  the item in `drop`. This is a score-only helper, not an enforcement boundary.
- Current `relevance()` uses item IDs as question IDs. Anonymous engine calls consequently
  fragment the decision identity; passing a registered `Gate` preserves its gate ID.
  Prefer stable semantic gates and explicit item metadata in the new application adapter.
- A battery's label propagates its combined target truth to members. This is suitable when
  members are features predicting that target; inherited outcomes are not ground truth for
  semantically distinct facet/relationship questions. Label independent gates separately.
- Gate approval is not actual pack inclusion. A set-selection event must record the final
  chosen IDs and omission reasons; it must not claim every gate `act` entered the pack.
- `Outcome` currently has correctness/truth/note, not a structured label-selection or
  exposure schema. `mode === "shadow"` does not prove its supplied labels are representative,
  and audits of acts do not cover the whole candidate population.
- `Rollout` uses point estimates. It is not independent statistical acceptance of a fitted
  policy. A model/rubric/corpus/candidate-generation change requires evidence scoped to the
  new configuration.

For a first application, let a positive relevance gate's `act` mean “eligible for the
recommended evidence set.” `review` remains unresolved and visible; `refuse` means “not
recommended by this gate,” not “delete the source.” In shadow, display the chosen baseline
set as the actual result and store the candidate pack as a shadow proposal.

If a future context-compaction gate automates exclusion, define a separate exclusion action
with explicit polarity and a much stronger recall requirement. It must retain failure and
review cases. Polarity belongs in the policy contract, never in a helper's guess about a
score. Irreversible deletion stays out of this application.

A minimal application schema can be independent of engine internals:

| Record | Essential fields |
| --- | --- |
| `NeedSpec` | goal, scope/exclusions, facets, constraints, budgets, time horizon, profile version |
| `SourceArtifact` / `EvidenceSpan` | immutable source/version/hash, source family, original locator, text offsets, access scope |
| `SubjectVersion` / `RelationProposal` | concepts/aliases, typed source-grounded relations, proposal/approval provenance |
| `AssessmentLink` | need/item IDs, gate record IDs, decision contract version |
| `SelectionEvent` | candidate origins, eligible/review IDs, selected IDs/order, omitted IDs/reasons, budget used, baseline/proposal distinction |
| `LabelEvent` | independently assigned truth/utility, assessor, blinded status, selection mechanism, sampling probability, rubric version |
| `FeedbackEvent` / `PreferenceVersion` | exposure link, explicit feedback kind, scope, creation/update/expiration and supersession |
| `EvaluationManifest` | split IDs, hashes of all versions, frozen thresholds, endpoints, sampling/stopping plan |

Engine calibration continues to read labelled decision rows. The application attaches
eligible human labels through `Engine.label` and restricts fit input using its sampling
manifest. Personal preference fitting reads only its own append-only application event
ledger. Avoid overloading a prose `note` as a schema.

Do not extend core with a graph database, crawler, embedding stack, personal-profile service,
or a universal relevance score. An eventual general-purpose recipe should have at least two
working application callers before it graduates from the experiment.

## The staged proof

### Phase 0: define the target and audit the corpus

First use case: a developer researching implementation choices for a local-first TypeScript
application. Produce a source-linked evidence pack, a simple facet view, and a review list.
Use official technical documents, primary papers, project requirements and explicit human
notes as a frozen corpus. No automatic action follows from the research recommendation.

Start with 30-50 independently authored tasks across several technical subject families and
roughly 100-200 source documents. These are pilot sizing ranges, not a statistical
certificate. Include routine facts, ambiguous requirements, same-topic hard negatives,
counterevidence, version mismatches, paraphrases, multi-source dependencies, no-answer cases,
near duplicates and malicious instruction-like source text.

Choose a smaller subset with exhaustive source-level judgments so candidate recall has a
known denominator. On the larger pool, combine multiple retrievers plus an independent
random sample; leave unjudged pairs unknown. Record sampling probabilities if weighted
estimation is needed. Judge source-level relevance before multiplying correlated chunks
into apparent sample size.

Have assessors label original passages with the task visible and model scores hidden.
Use a written graded utility rubric, evidence spans, facet coverage and a separate
must-retain flag. Double-label a material subset; adjudicate disagreements while preserving
the original labels. Human subjectivity is part of the measurement, not something to hide.
Retain indeterminate labels as a separate coverage stratum. Binary calibration on the
determinate subset must not be reported as calibration of the entire task population.

### Phase 1: static utility and evidence packs

Freeze hand-authored subject facets and explicit preferences. Compare, at equal candidate
and context budgets:

1. Lexical retrieval.
2. Dense retrieval.
3. Hybrid retrieval using rank fusion.
4. A conventional cross-encoder reranker over the same candidates.
5. Hybrid retrieval plus a direct Ratchet relevance gate.
6. Hybrid retrieval plus Ratchet features and deterministic coverage selection.

Fit/calibrate only the variants with enough labels. Keep the best baseline chosen on
development data fixed for final comparison. Compare equal dollar/latency budgets as a
second view; report all embedding, indexing, extraction and downstream reading costs.
Historical Jev costs in this repository are observations from one date/model, not a current
price promise.

Split by task/subject family and source family, not random passages. Put paraphrases,
duplicates, versions and repeated judgments in the same split. Use development, calibration
and untouched test sets. If the test corpus is indexed without labels, declare that
transductive setting; do not expose test goals, labels or answers to facet discovery/fitting.
Add a future-time source snapshot for temporal generalization.

Use public benchmarks as diagnostics, not substitute product evidence: BEIR for retrieval
heterogeneity, BRIGHT for reasoning-heavy retrieval, and SciFact for support/refutation with
rationales. Pin dataset versions, native splits and licenses. Public qrels can be incomplete
and public tests can be contaminated; don't tune prompts on their test labels.

Report a metric stack rather than one attractive accuracy:

- Candidate recall and the unjudged fraction.
- Conditional gate recall/precision, Brier, reliability bins and risk/coverage.
- Final evidence-set facet coverage, must-retain and counterevidence recall, redundancy and
  source-family coverage at fixed token budgets.
- Blinded human utility and time needed to reach a supported conclusion.
- Cost and latency including retrieval, extraction, reranking and reading.
- Failure/timeout/budget behavior and sensitivity to item order and batch composition.

Do not conflate ordinal utility scores with probabilities. Calibrate the specific binary
event used by a gate and report support in each reliability bin.

Provisional acceptance targets to preregister before seeing test results:

- All deterministic trust, scope, reversibility, shadow and failure contracts pass.
- On the fully judged subset, retain at least 95% of must-retain evidence at the chosen
  candidate budget; report a task-clustered interval and subgroup misses.
- At the same final context budget, improve blinded evidence utility over the frozen best
  baseline, with a prespecified minimum useful effect and a task-clustered confidence
  interval excluding no improvement.
- Counterevidence and must-retain recall must not decline beyond a prespecified small
  noninferiority margin; cost/latency must remain within the application budget.

The 95% recall target is a proposed research-screening target, not a safety promise. The
minimum utility effect, noninferiority margin and budgets must be chosen from the user's
workflow before evaluation. If the pilot cannot resolve the intervals, the outcome is
“insufficient evidence,” followed by a sample-size plan, not a relaxed criterion.

Use one frozen confirmatory evaluation or a valid sequential design. Report cluster-aware
uncertainty because many source pairs share one task. Do not treat 500 chunks of one paper
as 500 independent confirmations. Select one primary endpoint before the test and account
for multiple comparisons if several claims will be tested.

### Phase 2: discover and maintain the subject

Add facet/concept proposals and source-linked relation review. Compare manual facets,
retrieval-only clusters and source-grounded generated facets. Evaluate relation precision,
span validity, new-facet discovery, inappropriate merges, persistence of contradicted or
superseded relations, reviewer correction time, and the change in phase-1 evidence utility.

A better-looking graph is not a success criterion. The generated map must improve evidence
coverage or reduce review effort without losing source traceability. Include held-out
subject families and sources introduced after the initial map was frozen. Human approval of
a revised scope creates a new configuration version; it is not secretly a training label
for every attached document.

### Phase 3: learn project and person preferences

Start with explicit preferences and corrections; compare against the same system with no
personalization. Collect independent candidate feedback in addition to ordinary selected-set
feedback. Validate chronologically on later sessions and hold out projects/users when
claiming generalization beyond a single person.

Measure usefulness, correction effort, preference-update latency, stale-preference errors,
counterevidence retention and ability to recover unseen topics. Add tests for “I changed my
mind,” project-scoped preferences, expired constraints and deletion. Reset/undo must remove
the preference's influence from derived views and future selection.

LaMP and memory benchmarks are supplementary diagnostics. Actual value requires prospective
user evidence. A small consenting pilot with a counterbalanced baseline comparison can
estimate whether the system saves research time; it cannot establish universal preference
learning. Delay bandit optimization until feedback volume and logging support it.

### Phase 4: establish the application boundary

Move into a separate product/package when all of the following hold:

- The evidence-set workflow has repeat users and a measurable advantage over the best simple
  retrieval/reranking baseline.
- Subject maps improve the workflow enough to justify their extraction and review cost.
- Preferences improve later tasks without hiding counterevidence or creating unexplained drift.
- The product needs persistent corpora, profile controls, ingestion and review surfaces that
  evolve independently from the small engine.

Until then, a bounded experiment and example in Ratchet keep the hypothesis falsifiable.
If the direct reranker plus diversity baseline matches the proposed system, simplify to that
path rather than protecting an elaborate architecture.

## Concrete implementation slices after approval

These are proposed modules, not new code created by this investigation:

| Slice | Application modules | Ratchet use | Exit condition |
| --- | --- | --- | --- |
| Corpus and protocol | `experiments/relevance/schema.ts`, `sources.ts`, `fixtures/`, `protocol.ts` | Existing state/ledger types | Reproducible snapshots, valid source spans, frozen splits |
| Candidate pipeline | `retrieve.ts`, `baselines.ts` | No oracle needed for basic retrieval | Measured candidate recall; hybrid baseline reproducible |
| Utility adapter | `assess.ts`, `rubrics.ts` | Stable gates, untrusted spans, batches, `Engine.label` | Correct shadow/failure/polarity and per-contract records |
| Set selection | `select.ts`, `selection-ledger.ts` | Consume ruled results without exposing verdicts as evidence | Budget and duplicate constraints; selected-set replay |
| Evaluation | `evaluate.ts`, `report.ts` | Ledger-only calibration; external sampling manifest | Frozen comparison, uncertainty and honest inconclusive result |
| Subject development | `concepts.ts`, `relations.ts`, `subject-store.ts` | Independent typed relation gates | Provenance-valid proposals with measured usefulness |
| Preference development | `feedback.ts`, `preferences.ts` | Audited feature/utility decisions | Explicit exposure, time-split validation, undo/deletion |
| User surface | Evidence pack, original-source drilldown, unresolved queue, editable scope | Show policy/history as explanation | A person can inspect and correct a concrete recommendation |

Do not require a large graph store or vector database for the initial corpus. Source records,
JSONL events and a replaceable retrieval interface are sufficient to test the idea. Keep
external baseline tooling out of Ratchet runtime dependencies.

Before implementation, the remaining product choices are the initial user/task population,
source corpus and permissions, acceptable reading/context/latency budgets, and what a missed
essential source costs. All three layers can be planned now; those choices determine the
first measurable contract and the volume of independent annotation it needs.
