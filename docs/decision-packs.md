# Decision packs: teach the task, measure the model

Built 2026-11-17 at the owner's request. The intended transfer is from stronger reasoning to
an explicit task specification: a rubric, worked examples, boundary cases, typed application
facts, code-owned floors, and a rollout recipe. This does not change a model's weights. It
does not grant a cheap model the teacher's reliability, and it does not train on Jev outputs.

The implementation is `examples/decision-packs/packs.ts`. The authored evaluation curriculum
is `experiments/decision-packs/curriculum.ts`. There are 16 teaching examples and 48 separate
evaluation cases in 24 source families. Every label includes a rationale fixed before the
first model call. The assistant authored these labels; they are not independently reviewed
domain-expert judgments. Raw files stay under `experiments/out/`.

The next applications are aligned to the owner's existing projects in
[project-alignment.md](project-alignment.md): SKUby for procurement and financial exceptions,
Relly for scientific and medical literature, and Keywork/Stead for whole-artifact evaluation.
Those project integrations are planned; the generic curriculum and results below have not
been relabelled as project-specific evidence.

## Domains and the action each recipe permits

| Domain | First workflow | Candidate finding | Code-owned checks | Human boundary |
| --- | --- | --- | --- | --- |
| Enterprise | Procurement exception review | Whether a proposed invoice/PO/receipt finding is supported | Authenticated source identity; exact quantities, totals, currency and period comparisons | Payment, contract execution, bank-detail and access changes |
| Science | Claim-to-evidence annotation | Whether a proposed claim preserves the source's design, population, endpoint and uncertainty | Units, numeric comparisons, source identifiers and versions | Final interpretation, publication and consequential research decisions |
| Finance | Reconciliation exception review | Whether a proposed explanation is supported by statements, ledger references and explicit policy | Exact decimal arithmetic, signs, currency, transaction identity, verified provenance | Transfers, trades, journal postings and write-offs |
| Medicine | Medical-literature screening support | Whether a proposed eligibility annotation follows the protocol and source | Document identity, study linkage facts, supplied protocol and permitted use | Final inclusion/exclusion and all patient-care decisions |

All four actions are reversible draft annotations. Their output is not passed into the next
oracle state as evidence. Source material and candidate text are untrusted spans. Application
code supplies `sourceVerified`, `numericChecksPass`, `draftOnly`, and the explicit task policy.
Those booleans must come from real checks; copying them from an uploaded document breaks the
integration contract. Missing or false flags force review. The example library does not
authenticate documents or execute payments; the application owns those capabilities.

## What the teacher contributes

Each pack contains:

1. A narrow question and an explicit definition of a supported finding.
2. English rules for the domain's common inference errors.
3. Four worked examples with a decision and a reason. These are authored demonstrations,
   not the current case and not prior engine verdicts.
4. Separate paired positive/negative cases that differ in the claim while sharing evidence.
5. Trusted-entry floors and a registered shadow `GateSpec`.
6. A content-derived evidence version, so a rubric or demonstration change resets its identity.
7. A deployment recipe with 10% blind audits, a planned 98% act-precision target, and return to
   shadow at the first wrong audited act. Those are cautious example settings, not measured
   defaults recommended for every business.

The reusable information is the task contract and the curriculum. Numerical calibration
belongs to a particular model pin, question, rendering, policy and deployment population.
The shipped gate keeps a provisional 0.98 threshold and shadow mode. The runner writes its
exploratory fitted thresholds to its own run directory; it never silently copies them back
into the recipe.

Registration uses the existing engine API. The application must provide its verified facts
and a stable source-document group on every ask:

```ts
import { PACKS, packSpec, packState } from "../examples/decision-packs/packs.ts";

const procurement = PACKS.find((pack) => pack.id === "enterprise");
if (!procurement) throw new Error("Missing recipe");
const gate = engine.gate(packSpec(procurement));
const result = await gate.ask(packState({
  sourceVerified: documentProvenanceVerified,
  numericChecksPass: exactComparisonsPassed,
  draftOnly: true,
  policy: explicitCompanyPolicy,
  evidence: sourceExcerpt,
  candidate: proposedFinding,
}), { tags: [`document:${sourceDocumentId}`] });
// Record result. In shadow it remains review; no external action is executed here.
```

These local variables represent application-owned inputs, not values the model supplies.
A later hardening change adds an explicit nonempty-policy floor (`draft-only/2`); all pilot
cases already supplied a policy, so this does not change their replayed outcomes. Their run
directories retain the exact earlier source snapshots.

## Comparisons

The applied comparison holds sources, proposed claims, model version and policy controls fixed:

| Arm | Question | Act threshold | Purpose |
| --- | --- | --- | --- |
| Review all | None | No automatic draft | Workload baseline |
| Jev bare | One generic support question | 0.98 | What the model already knows |
| Jev rubric | Domain rules | 0.98 | Value of explicit task specification |
| Jev taught | Rules plus four worked examples | 0.98 | Incremental value of teaching examples |
| Bare/rubric/taught fitted | Same respective questions | Separate fit-only threshold per pack | Compare usefulness after equal calibration opportunity |
| Strong fitted | Stronger model, taught question | Its own fit-only threshold per pack | Whether using the expensive model alone wins |
| Cascade | Taught Jev; strong model on a hold | Both frozen thresholds | Whether escalation buys useful coverage at lower cost |

There is no majority vote over the three Jev prompts. They are alternative treatments, not
independent judges. Every source case is scored by every treatment in shadow before replay,
including those a deployed cascade would skip. This preserves an unselected paired matrix.

The primary prompt comparison uses the same 0.98 threshold. We also report answer agreement,
Brier loss and mean score on supported/unsupported findings before floors, because a fixed
bar can make every arm abstain. Fitted policy comparisons and cost savings are exploratory.
All fitting reads labelled ledger observations and only the designated fit families.

The fit set is deliberately small: four cases, from two families, per pack. The preset grid
chooses the most correct draft acts with no wrong fit acts and at least two correct ones;
ties keep the higher threshold. If no threshold qualifies, it stays unsupported and hands
off. This proposes a candidate policy; it proves no accuracy target.

No arm receives a fitted bar selected on evaluation/challenge results. The first live smoke
run exposed an inadequate response allowance for the stronger model. The corrected run uses
1024 output tokens, adds equal fitting opportunities for bare/rubric controls, and reports
provider charges separately from valid-answer ledger costs. Its protocol is `decision-packs/2`.
The smoke data were inspected, so the corrected run is an exploratory rerun, not a fresh
independent confirmation. The curriculum and teaching examples were not tuned on those results.

## The repair tournament underneath

`experiments/tournament/` separately tests selection mechanics on 54 tasks, 18 families and
216 authored candidates. The three domains are boundary logic, data transformations, and
SQLite reporting. Each family stays entirely in fit, evaluation or challenge; related
parameter variants are never split across them.

Candidates are repository-authored functions or SELECT queries. JavaScript is executed only
from that fixed source module, with bounded execution; SQL uses fresh in-memory databases.
The runner does not execute model-generated or downloaded programs. Independent check
implementations provide expected outputs. Hidden checks are never rendered into judge input.
Passing a finite hidden suite remains test evidence, not a proof of universal correctness.

Every task offers four distinct candidates in one seeded common order. One third deliberately
contain no correct candidate. Compare first candidate, first public-test pass, fixed cheap
judge, fitted cheap judge, fitted strong judge, fitted cascade, two keys, and a labelled
hindsight ceiling. Public tests are deliberately incomplete so this is a stress test of
selection, not a claim about the usual effectiveness of real repository test suites.

The same candidate budget applies to each arm. Fitting scores the first accepted **task**
outcome, not pooled precision over all candidates. Report correct completions, wrong
acceptances, handoffs, missed solvable tasks, consumed judgments and their cost. Cost sensitivity
uses wrong-acceptance costs of 5, 20 and 100 reviews. The primary difference is cascade minus
tests on correct completion; uncertainty resamples whole families within each domain.
Six families per evaluation split is too few for strong statistical conclusions.

The two-key diagnostic inherits the individually fitted cheap/strong bars. It does not fit
the conjunction separately; an unsupported single-model bar therefore disables this arm.
Do not interpret its result as evidence against a separately calibrated two-key policy.

Frozen-pool selection is only stage one. A live-generation comparison must separately price
candidate generation and retries, count distinct candidates, preserve identical task budgets,
and measure full task completion. It is not implemented by these fixed-pool pilots.

## Run it

No key is needed for the full executable checks or simulation:

```powershell
bun run tournament --offline
bun run decision-packs --offline
bun run check
```

For live calls, use `.env` through the existing helper, or the optional Windows Credential
Manager flow. The latter never prints the credential or writes it to this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\decision-pack-key.ps1 -Action Set
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\decision-pack-key.ps1 -Action Run -Experiment decision-packs -Budget 5
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\decision-pack-key.ps1 -Action Run -Experiment tournament -Budget 5
```

The credential target is `ratchet/OpenRouter`. Each launch retrieves it inside PowerShell,
passes it only through the child process environment, then clears that environment value.
The runner records request charges, not credentials. The original `.env` is not modified.

The existing `.env` alternative is `bun run decision-packs --live --budget=5` or
`bun run tournament --live --budget=5`. On this Windows environment, the secure launcher uses
Node 24 with experimental TypeScript transformation; Bun remains the normal project runner.

Each run gets its own directory, manifest, source snapshots, corpus snapshot, shadow ledgers,
frozen configuration and Markdown report. Live calls are serial per runner, use no automatic
retry, reserve a cent before each request, and stop purchasing after unknown billing. A $5
default recorded-spend cutoff and 2,000-request ceiling bound each invocation. In-flight cost
can exceed a recorded-spend cutoff; separate invocations have separate budgets. The owner
authorized broader Jev experimentation, but these defaults prevent accidental unbounded runs.
Failed response charges are included in the purchase receipts even when the engine cannot
attach their price to a valid judgment.

## Progression to a deployable recipe

1. **Review the teacher.** Have domain specialists review the specification, provisional labels,
   rationales, missing-information handling and the real application action, blind to the model.
   For disputed cases retain the disagreement; do not manufacture a unanimous label.
2. **Measure transfer.** Assemble naturally occurring cases from new documents, organizations,
   institutions and periods. Keep synthetic mutants in a separate challenge set. Preserve the
   natural base rate in the representative set. Group by document/study/entity, not row.
3. **Freeze one candidate.** Choose the recipe, exact model, representation, bar and expected
   review cost using only development evidence. Predeclare the primary deployment metric and
   the sample plan. Changing any of those creates a new version and fresh evidence phase.
4. **Run shadow on real traffic.** Measure downstream usefulness and review burden as well as
   act precision. Use independently labelled unselected cases. The authored source
   `curriculum:authored` is deliberately unregistered; it cannot earn promotion.
5. **Evaluate once under the plan.** A zero-error plan for 98% act precision at one-sided 95%
   confidence needs 149 independent correct planned acts. That is per preselected gate and
   assumes correct labels and the planned sampling conditions. It is not 149 candidate
   variants, 149 teaching examples, or a joint guarantee over four recipes.
6. **Release only the specified reversible action.** Persist scope-bound checkpoints, audit
   randomly, route unknown inputs to review and measure both false demotions and wrong acts.
   Medical final study selection remains with independent human reviewers.

More API calls help when they buy new information: source families, natural errors, shifted
populations and independent labels. Repeatedly revising a recipe against the same held-out
cases creates a development set, regardless of how cheap the calls are. Keep the failures and
declare fresh replication sets before the next revision.

## Research basis and limits

The primary-source notes are in
`research_notes/Applied decision packs 2026-11.md`. Reporting standards inform the task
contracts; this experiment is not a compliance assessment. Existing relevant mechanisms and
their limits remain documented in `vision.md`, `architecture.md`, `docs/e2e/`, and the
foundations review.
