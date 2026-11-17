# Decision recipes aligned to the project portfolio

2026-11-17. Direction requested by the owner: make the applied domains serve existing
projects, starting with SKUby. This plan is grounded in the sibling repositories inspected
below. It defines the next integrations and evaluations; it does not claim they are built.
The generic [decision packs](decision-packs.md) and their live results remain unchanged.

The proposed [recipe forge](design/recipe-forge.md) describes how ordinary application use,
independent reviews and flagship-authored teaching material can produce new recipe versions.
Its explicit [capture-to-teacher comparison command](recipe-forge.md) is built; automatic
application collection and production integrations remain planned.

## Where the overlap is strongest

| Priority | Project and domain | Concrete decision | Useful result | Why this project fits |
| --- | --- | --- | --- | --- |
| 1 | SKUby: procurement and supplier operations | Does this supplier reply support this exact proposed fact about the sent order? | A supported draft annotation or a precise request for review | Existing order snapshots, reply readers, deterministic verification, second look, and simulated suppliers |
| 2 | SKUby: inventory and financial exceptions | Does the evidence support the proposed shortage, price discrepancy, or receipt exception? | An explainable exception card for the owner | Existing quantities, pack sizes, offers, receipts and purchasing policy provide checkable constraints |
| 3 | Relly: scientific evidence selection | Which passages help answer the question, and which supply counterevidence that must remain visible? | A better evidence pack within the same reading budget | Existing retrieval baselines, two Ratchet gates, blind labels and omission explanations |
| 4 | Relly: medical literature review | Does a study match a supplied research protocol, and does an annotation preserve its population, design and endpoint? | A traceable screening annotation for a researcher | Reuses source identity and evidence selection, with a distinct task contract and labels |
| Shared evaluation track | Keywork / Stead: agent deliverables | Does the artifact satisfy the declared acceptance criteria, with evidence for each completion claim? | Verified delivery or a specific unresolved requirement | Existing refinement campaigns, artifact snapshots, execution controls and review surfaces |

The enterprise and finance work therefore starts inside SKUby. Science and medical research
start inside Relly. Keywork and Stead provide a place to execute and review longer tasks;
Ratchet supplies narrow judgments and their evidence record. Applications retain their
existing permission, persistence and action ownership.

These priorities reflect available integration points and observable outcomes, not measured
commercial demand or a claim that one domain is easier for a model.

## First pilot: SKUby supplier-reply verification

**Question:** Does the reply's current text support the exact proposed fact about the
matched sent order, preserving its conditions, uncertainty, quantities and dates?

Examples: "We expect Friday, subject to stock" must not become an unconditional confirmation;
"six cartons now, six next week" must not become twelve cartons arriving now; an old quoted
delivery date must not override a newer sentence. Arithmetic, identity and permitted actions
remain code checks. The model's contribution is interpreting what the language supports.

### Integration contract

SKUby already separates the reply reader from the verifier in
[`verify.ts`](../../skuby-mcp/src/mailbox/reader/verify.ts). Verification checks the proposed
reading against the sent order and requires its supporting sentence to occur in the reply.
Its independent second look already accepts structured evidence through
[`SecondLookProvider`](../../skuby-mcp/src/second-look/types.ts).

The first addition should be a **shadow observer** beside those existing paths:

1. Capture one immutable evidence snapshot: the sent order, matched reply, original source
   text, proposed fact, existing check results, application time and relevant policy version.
2. Preserve the distinction between application-verified fields and model-extracted claims.
   A reader's confidence or proposed date is not a trusted fact merely because it is typed.
   Supplier text is an untrusted span; model verdicts and their explanations are excluded.
3. Ask a registered Ratchet gate through `Engine` / `Gate`, retaining source identifiers and
   the snapshot fingerprint. A candidate gate ID is `skuby.reply-fact-supported.v1`; this
   name is proposed, not registered in the current tree.
4. Record the recommendation alongside SKUby's actual outcome. Shadow adds no hold and
   changes no order, date, stock, price or purchasing setting. Label source support separately
   from whether the eventual delivery arrived on time.
5. Only after a frozen evaluation succeeds, consider presenting draft annotations or adding
   a hold through SKUby's existing authority controls. A Ratchet approval cannot make an
   otherwise ineligible SKUby action eligible. Failures in an enabled hold path require review.

The adapter belongs in SKUby, uses Ratchet's existing public primitives, and preserves its
`note` / `hold` contract. There is no new purchasing executor or permission system. Actual
receipts continue to come from the person-recorded receipt path; a supplier message cannot
create inventory or resolve an uncertain send.

### Teaching material

Author the rubric from SKUby's actual decision contract, then teach contrasting examples:

| Boundary | Positive example | Counterexample |
| --- | --- | --- |
| Commitment | Explicit confirmation of the matched order | Estimate, conditional promise, or request for clarification |
| Current evidence | New text changes the delivery date | An older quoted message contains a different date |
| Partial supply | Stated quantity and delivery split are preserved | One shipment is represented as the whole order |
| Identity | The reply supports the matched supplier, order and line | Similar item name, ambiguous line, or another order |
| Units and money | Verified pack conversion and exact price comparison | Pack/each confusion, missing currency, or invented arithmetic |
| Authority | Message is interpreted only as evidence | Instructions in mail ask the agent to approve, send or change settings |

Include missing evidence, contradictory sentences, cancelled orders, uncertain sends and
unavailable judges. Some are hard-rule regressions, not opportunities for a model to earn
credit. The teacher writes the task rules and examples; independent reviewers establish the
evaluation labels. Repeated model agreement is never a substitute for those labels.

### Comparisons and success criteria

Keep the same reader output and evidence snapshot while comparing verifiers. Test changes
to the reader in a separate experiment so extraction gains cannot be misattributed.

| Arm | What it isolates |
| --- | --- |
| Current deterministic verification | What SKUby already catches without an extra model |
| Current configured SKUby second look | Whether Ratchet improves the real product baseline |
| Jev with a bare support question | The cheap model's starting ability |
| Jev with project rubric | Value of specifying the actual task |
| Jev with rubric and worked examples | Additional value of teaching |
| Strong model alone | Whether the stronger model is the better whole solution |
| Jev with escalation to another model family | Whether selective escalation preserves useful coverage at lower total cost |

The extra-model arms retain the same hard checks. Pin model versions and budgets before the
run. Fit each learned arm only on its own fit slice, then freeze. During evaluation acquire
paired judgments across the whole candidate set; replay the cascade to report consumed cost
separately from full experimental acquisition cost. Measure paired errors before making any
claim about independence. Multiple Jev prompts are treatments, not independent voters.

Report unsupported facts accepted, supported facts held, usable coverage, review time, latency
and cost per correct usable annotation. Also report the subset that passed deterministic
checks, plus end-to-end results including all hard holds. This prevents easy rule failures
from making the model appear better than it is. In shadow, a proposed wrong date is a
**would-be** bad update; it is not an actual operational incident or a prevented incident.

Start with SKUby's existing fixtures in
[`reply-fixture.ts`](../../skuby-mcp/tests/unit/reply-fixture.ts) and second-look tests for
mechanism checks. Add independently labelled, naturally occurring cases for usefulness and
calibration. Keep all messages, variants and outcomes from one order thread in one split;
keep authored template families together too. Reviewers see source evidence before model
scores. Ambiguous cases receive adjudication or remain unresolved, not forced binary labels.

A fixture pass earns a working observer. A model earns adoption only by improving the
review workload at the predeclared error target on fresh cases. A gate earns enforcement
only through Ratchet's planned acceptance test and an explicit SKUby authority setting.
The tiny generic pack results supply no transferable threshold or accuracy guarantee.

## Extend within SKUby, then into Relly

SKUby's second recipe should explain inventory and financial exceptions using the same
source discipline: order versus receipt quantity, pack conversion, supplier price change,
and invoice/credit mismatches when those documents are available. Document availability is
an integration prerequisite, not assumed current functionality. The action remains a draft
finding. Journal posting, payment, price changes and purchasing authority stay with existing
application controls. Exact arithmetic needs no model vote.

Relly already registers `relly.passage-usefulness.v1` and
`relly.passage-counterevidence.v1` in [`gates.ts`](../../relly/src/gates.ts). Improve those
existing gates first. They answer different questions and retain separate labels; usefulness
is not truth, and counterevidence is not proof that a conclusion is false.

Compare keyword retrieval, the existing reranker, and rubric/taught/cascade variants using
identical candidate sets and reading budgets. Measure critical omissions, useful evidence
retained, distinct source coverage and reviewer time. The existing
[SciFact evaluator](../../relly/docs/evaluation.md) provides a retrieval baseline; its document
relevance labels cannot certify passage truth, protocol eligibility or claim support.
Measure omission from candidate retrieval separately from rejection by a gate.

Add claim-to-source fidelity and medical protocol applicability as separate gates only when
their labels and source material exist. Group by document or study, including linked reports,
instead of treating passages as independent evidence. Medical screening stays research
support: no final automatic exclusions or patient-care actions. Continue to enforce Relly's
current source exposure permissions before any provider call.

## Reuse Keywork and Stead for longer tasks

The existing [refinement campaign plan](../../keywork/docs/backlog/123-refinement-campaigns.md)
already defines artifact snapshots, evidence, usage accounting, recovery and a desktop
monitor. Ratchet should participate through a narrow evaluation adapter; it should not
introduce another campaign runner.

Start with completed artifacts whose important requirements can be checked: a procurement
exception report, a cited research brief, or a code repair with executable acceptance checks.
Keep model judgment distinct from verified completion. Existing permissions decide what an
agent may execute. Objective observations such as failed tests or missing source evidence
can inform a later attempt; Ratchet verdicts do not become model-visible evidence.

Compare a strong single pass, the existing simple builder-critic baseline, and a campaign
with Ratchet evaluation. Hold starting materials, primary model and total budget fixed;
separately report actual spend, retries and elapsed time. The outcome is independently
verified completion and reduced review effort, including wrong declarations of "done" and
regressions. More iterations or a higher judge score are not success metrics. Qualify the
existing campaign workflow before adding this experiment, following its canonical plan.

## Build order and evidence to keep

1. **SKUby observer:** specify the export boundary, replay existing fixtures without mail or
   purchasing side effects, and verify the shadow ledger matches its immutable snapshots.
2. **SKUby comparison:** author the task curriculum, obtain independent labels, freeze the
   split and comparison plan, then run the arms above on new order families.
3. **SKUby product trial:** present draft findings in the existing review flow and measure
   actual review effort; consider a hold integration only after the evidence and owner setting
   support it. Record false holds as well as unsupported acceptances.
4. **Relly comparison:** reuse its evaluation and blind review surfaces, add omission and
   source-fidelity labels, then introduce a separate medical-literature task if useful.
5. **Campaign comparison:** reuse qualified Keywork/Stead campaigns to measure whole-artifact
   outcomes, including generation cost. Keep this distinct from fixed-candidate selection.

Every recipe keeps its own question, action definition, rubric/examples version, source
renderer, model pin, hard checks, grouped split, independent labels, frozen policy, rollout
plan and rollback condition. Rubric patterns can transfer across projects. Confidence bars,
precision claims and permissions cannot.

Local inspection anchors: [SKUby instructions](../../skuby-mcp/AGENTS.md),
[second-look specification](../../skuby-mcp/docs/WAVE-7-SPEC.md),
[supplier-reply specification](../../skuby-mcp/docs/WAVE-8-SPEC.md),
[Relly counterevidence](../../relly/docs/counterevidence.md),
[Relly blind labels](../../relly/docs/labels.md), and the campaign plan linked above.
