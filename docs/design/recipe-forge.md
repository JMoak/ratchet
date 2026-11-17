# Recipe forge: learn a task from ordinary use

2026-11-17. The [offline/live command slice](../recipe-forge.md) is implemented. The broader
collection, inbox and release lifecycle below remain proposed; no collector is installed.
Extends [project alignment](../project-alignment.md) and the existing
[decision packs](../decision-packs.md). Start with SKUby supplier-reply findings.

## Product behavior

The owner uses their applications normally. Selected application events preserve a small,
replayable case: the question, evidence available at the time, candidate artifact, hard checks,
human response and subsequent observations. A flagship model periodically proposes a better
task rubric and worked examples. Ratchet evaluates that recipe on independent cases before
it can affect the application.

The reusable asset is an explicit task procedure: what to inspect, what distinctions matter,
what must be checked in code, when to ask, and examples of the boundaries. Initial releases
change recipes, not model weights. No automatic fine-tuning or provider-output imitation is
part of this design. The teacher's capability is a source of hypotheses, not an accuracy claim
for the deployed model.

The owner's visible surface is small: a review inbox for ambiguous cases and a recipe card
showing its scope, examples, current status, measured mistakes, review workload and cost.
Statuses distinguish draft, shadow, eligible for a specified action, active and retired.
Learning runs produce candidates; they do not rewrite the active recipe after every click.

## Capture cases at the application boundary

| Source | Capture point | What it can teach |
| --- | --- | --- |
| SKUby | Verified supplier reading and the owner's correction or review | Source support, quantities, commitment versus estimate, and exception presentation |
| Relly | Saved research question, source snapshot and blind passage review | Usefulness and counterevidence as separate predicates; later source fidelity |
| Keywork / Stead | Artifact revision, declared acceptance criteria, checks and human review | Completion, regressions, presentation preferences and unresolved requirements |

Use explicit application exports/observers, not a general screen recorder. The existing
[agent hook](agent-hook.md) captures prompted permission choices; it does not provide a full
work-quality dataset. Its documented auto-mode journal had many events but almost no prompts.
The [Keywork export](keywork-gate.md) is useful for the permission task, not a substitute for
artifact evidence. Neither a grant nor a completed process establishes task correctness.

Proposed case envelope, stored as append-only, validated JSON events:

| Field group | Required contents |
| --- | --- |
| Identity | Schema, event ID, project, task predicate, episode/order/study ID, source-family ID, timestamp and revision |
| Inputs | Exact question and policy version, candidate, source snapshot references and hashes, trusted checks, untrusted text, application time |
| Human signal | Explicit answer/edit and reason if given; whether the person had seen a model suggestion; preference versus factual claim |
| Observations | Test result, receipt, later correction or other evidence, with its own time and source |
| Sampling | Why captured/reviewed, population definition, selection probability where applicable, and grouped split assignment |
| Exposure | Fields permitted for this provider, redactions, source permission/version and retention scope |
| Lineage | Linked Ratchet decision IDs, recipe versions, review events and teacher jobs; model answers remain separate from input evidence |

Capture preserves evidence as it existed at decision time. Later outcomes can inform labels
but cannot leak into the inputs of a replay. Raw text lives in a project-local snapshot store;
the ledger references its identity. Current source permissions apply again when preparing any
provider request. A revoked/deleted source invalidates derived case use and dependent recipe
versions as appropriate; an old snapshot is not permission to expose it again.

## Keep preference, observation and truth separate

An approval can mean "I want this," "good enough for today," or "this claim is correct."
The application must identify which question was answered. Silence and lack of a revert
remain weak signals, never automatic success labels. A test pass establishes only the tested
property. A supplier delivering late does not prove its earlier confirmation was misread.

Use corrections and observed failures to find cases worth reviewing. For the deployed
predicate, attach an explicit outcome to its Ratchet ledger row after independent verification.
Retain uncertainty and conflicting reviews; do not force a label from every interaction.
Personal preference labels can train a personal preference recipe but cannot certify factual
correctness. The owner's dataset supports claims about their workload until other populations
are separately evaluated.

Ratchet already stores label history and distinguishes `blind`, `census`, `moment` and
`consequence` sources in `src/ledger/sources.ts`. The forge must preserve these meanings.
Teacher assessments and synthetic examples use explicitly unregistered sources and cannot
fit thresholds or promote a gate. A future machine-check label needs an explicit, reviewed
source contract for the precise property it measures; it must not masquerade as blind review.
Forge acceptance plans admit only the independently established sources named in the plan.

## The offline learning cycle

1. **Find repeated tasks.** Group ledger-backed cases by a shared predicate, input contract,
   action and project scope. Frequent occurrence, avoidable review work, observable outcomes
   and a reversible action make a good candidate. Similar wording across unrelated tasks does
   not justify a common recipe. Rank opportunities; do not autonomously expand authority.
2. **Select teaching cases.** Draw diverse, resolved examples from development groups. Add
   difficult and disputed cases to a targeted review queue. Maintain a separate uniform sample
   to expose mistakes nobody noticed. The targeted queue is useful for discovery, not an
   unbiased estimate of accuracy or a confidence-fitting population.
3. **Ask the flagship teacher.** Supply the task contract, original evidence and independently
   established development labels. Request a concise rubric, prerequisite facts, examples with
   source references, counterexamples, missing-information rules and a short reason for each
   rule. Exclude prior Ratchet verdicts and explanations. Teacher-created variations remain
   synthetic and retain their parent family. A second model family can critique ambiguity and
   missing cases independently; agreement between models does not establish a label.
4. **Compile a candidate.** Validate structured output and emit a versioned recipe manifest.
   Permit English criteria and examples plus references to reviewed, application-owned checks.
   Generated text cannot install code, invent trusted facts, modify floors, broaden permissions,
   or choose its own evidence grade. Unit conversions and exact arithmetic stay in code.
5. **Replay and select.** Compare a small, budgeted set of candidates against the application
   baseline, bare cheap model, flagship alone and selective escalation. Candidate selection
   uses development evidence. Threshold fitting reads only eligible, unselected shadow or
   blind-audit ledger rows. Log all candidates, rejected versions and full acquisition cost.
6. **Freeze and qualify.** Lock the selected recipe, model pin, renderer, policy and action.
   Evaluate the frozen configuration on fresh, grouped cases under a predeclared plan.
   Teachers and recipe selection never see those cases or their labels. A failed evaluation
   may later inform development, but the next qualification uses fresh evidence and retains
   the earlier failure in its history.
7. **Use and audit.** Start in shadow, then expose only the action the evidence and application
   settings authorize. Random audits continue; unknown inputs and unavailable judges require
   review. Errors can return the gate to shadow and seed a later development batch. The current
   recipe stays immutable until a replacement independently qualifies.

All fitting and recipe learning read an explicit ledger-derived manifest. The forge is an
offline authoring/release process, not a feedback path from engine verdicts into the next
model state. Objective evidence and independently reviewed task examples can become a new
curriculum version; model answers never become evidence of their own correctness.

## What a forged recipe contains

The manifest binds the task and action definitions, owner/project scope, input schema, source
renderer, English rubric, approved examples, hard-check identifiers, abstention conditions,
student/teacher model pins, provenance, development groups, frozen evaluation plan, policy,
audit settings, measured results and rollback version. Teacher proposals and measured results
are separate fields. Policy settings are code-owned and gain evidence only through evaluation.

Retrieval of examples is optional later. Start with a small fixed set so the evaluated prompt
is reproducible. If example retrieval is introduced, version and evaluate the retrieval policy
too, and exclude the current case's family and all qualification families. A good example
library does not excuse leakage or an ever-growing prompt.

## A SKUby episode becoming a recipe

An illustrative reply says, "We expect six cartons Friday, subject to stock; the rest next
week." A candidate incorrectly reports the full order as confirmed for Friday. The owner
corrects it. That edit nominates a case; a source review establishes the supported claim.

The teacher can extract two reusable distinctions: preserve conditional commitment, and
preserve the quantity/date split. It proposes examples that separate those errors. Code checks
the ordered quantity and units. A cheaper model then uses the approved rubric on new replies.
The resulting recipe earns value if it catches unsupported findings while avoiding unnecessary
holds. Repeating the original episode proves recall of an example, not transfer.

The shared pattern can later help Relly preserve study populations and endpoints, but its
domain rules, labels, action and calibration remain separate. Transfer the procedure for
building a recipe, then measure each recipe on its own task.

## Feasible first delivery

Built: an explicit offline/live vertical slice before an automatic service. It ingests
reviewed SKUby case exports, preserves snapshot and label lineage, produces a structured
teacher draft, validates it, and
compares a candidate through the existing pack gates and ledger. Next connect the SKUby observer
and a small review queue in that application. Existing fixtures establish mechanics; only real
reviewed cases establish usefulness. If natural reply volume is low, keep shadow collecting
and test the same mechanism on an actively used Keywork artifact workflow with separate labels.

A starting batch of 20-30 diverse reviewed episodes is an engineering target for drafting the
first useful recipe, not an accuracy sample or a promotion promise. Review cards can be a small
batch, for example five at a time, with both targeted questions and a labelled random component.
The independent acceptance sample follows its own statistical plan and may take much longer.

The first visible success is one recipe with traceable examples, held-out comparison results
and a measured reduction in the owner's review effort. Track total teacher, student and human
review cost. More spend is useful when it buys new cases, a stronger task specification or
independent checks; repeated calls and repeatedly inspected holdouts cannot establish perfection.

## Existing building blocks and open work

| Already available | New work |
| --- | --- |
| Engine/Gate, trust-separated state and ledger label history | Application case exports and snapshot/permission lineage |
| Blind review, threshold fitting and planned rollout | Small project-native review inbox and discovery queue |
| Authored decision packs and comparison harness | Flagship teacher job, structured draft validator and manifest compiler |
| Model adapters, spending records and source snapshots | Forge batch accounting, grouped manifests and candidate release history |

No new runtime dependency or second campaign engine is implied. Teacher jobs can later run
inside qualified Keywork campaigns. Start with an explicit invocation; this document does
not schedule a recurring job or enable background collection.

## Method and provider boundaries

This proposal is related to reflective prompt optimization: DSPy's GEPA uses evaluation
feedback to propose textual instruction changes. We can borrow that experiment structure
without adding DSPy to Ratchet's runtime. Its effectiveness on this portfolio is unmeasured.
See the [primary GEPA documentation](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md).

Select a teacher by its measured contribution on development cases and pin its actual version;
there is no permanently best flagship. Use the API/provider route authorized for the source
material. An optional future weight-training project would need its own dataset and provider
rights review: [OpenAI's agreement](https://openai.com/policies/services-agreement/) and
[Anthropic's terms](https://www.anthropic.com/legal/commercial-terms) contain restrictions on
competing model development. The current [third-party terms notes](../third-party-terms.md)
also prohibit treating Jev verdicts as imitation-training targets. This recipe proposal does
not assert blanket permission for cross-provider distillation.
