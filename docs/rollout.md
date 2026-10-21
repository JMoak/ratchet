# Rollout evidence lifecycle

`Rollout` compares observed action accuracy with a target. It does not certify a population
accuracy, make repeated inspection statistically valid, or establish that supplied labels
are representative. Keep independent validation and blind audits in the application plan.

The controller now prevents two concrete failures. Ten correct shadow acts followed by one
failed audit used to promote, demote, then immediately re-promote at 10/11 without fresh
shadow evidence. A new policy/model could also inherit promotion from the old configuration
under the same gate id. Regression tests reproduce both failures before the fix.

## Initialize before collecting evidence

```ts
const gate = engine.gate({
  id: "tool.safe",
  question,
  policy,
  evidenceVersion: "tool-safe-v3",
  promisedAccuracy: 0.98,
  auditRate: 0.1,
  rollout: {
    evidence: { version: "tool-safe-v3", model: pinnedRecordedModel },
    minShadowRows: 100,
    minActed: 20,
    minAuditRows: 30,
    window: 200,
    // checkpoint: previouslySavedCheckpoint,
  },
});

await gate.rollout.evaluate(); // first call without a checkpoint holds shadow
// Collect new asks and independent labels here.
const status = await gate.rollout.evaluate();
const checkpoint = gate.rollout.checkpoint(); // application persists this JSON itself
```

The initial evaluation places a boundary after every row already present for this target,
including unlabelled rows. Historical labels cannot promote a newly initialized controller.
Initialize once before validation traffic; do not recreate the controller for every batch.
Without an evidence version the controller holds shadow with an explicit reason.

Within a phase, the window is the last eligible **labelled** rows in decision insertion order.
Promotion needs `minShadowRows` and `minActed`; demotion needs `minAuditRows`. Defaults are
100, 20, 30 and a window of 200. Audits are enforce rows tagged `audit`; they monitor allowed
acts only. They cannot promote a new shadow phase. Failed-open and code-only floor/bypass
rows cannot earn promotion or dilute audit errors. A battery contributes its combined row,
not a separate vote for each member.

Every promotion and demotion places a new boundary after **all** currently existing target
rows. Labels later attached to those rows stay outside the next phase. Rows with tied,
out-of-order or vendor-supplied timestamps do not change this ordering. This is a ledger
append boundary, not a guarantee that every later append began its request after the
transition. Drain in-flight work when changing deployment configuration.

## What the identity means

- `questionHash` is the engine's full rubric identity. Gates derive it automatically,
  including battery members and the serializable combiner description.
- `hashPolicy(policy)` canonicalizes only `actAbove`, `refuseBelow`, `goIsYes` and
  `onFailOpen`, including effective defaults. It does not fingerprint executable code.
- `evidenceVersion` is the caller's responsibility. Bump it for changed provider/model
  configuration, strategy, frames, opaque combiner or floor/bypass functions, state-building
  semantics, and changed application meaning. A function cannot be versioned by hashing its
  name. Immutable configuration and explicit releases are preferable to mutation in place.
- `evidence.model` checks the exact `DecisionRecord.model`. Use a pinned provider model
  for live deployments. A moving alias is not a version; an absent/different recorded model
  fails this check. An unexpected model on a new answered row within the current
  rubric/policy/version scope returns to shadow on the next
  evaluation even before it is labelled. This is an evidence check, not a provider-request
  guard: the application must prevent unapproved model changes before acting.

Model pinning is optional for local deterministic fixtures. Strategies whose combined row
does not record one model cannot satisfy a single-model pin; version their full configuration
explicitly, and do not invent a model identity for the combination. Neither version strings
nor hashes prove that the caller used the right deployment or that labels are independent.

`Gate.ask()` stamps the spec's evidence version. `Engine.ask`, `Engine.askAll` and
`Gate.askAll` honor their caller's `AskOptions`, including `evidenceVersion`; set it explicitly
there. Recipe calls do not silently borrow the gate's version or policy.

For an engine-level controller, supply `evidence: { version, model, policyHash:
hashPolicy(policy), questionHash: hashQuestion(question) }`. Unlike a gate, an engine owns
no single policy/rubric, so it cannot infer a homogeneous deployment scope. Matching rows
may span gate ids, but unrelated policies and rubrics are excluded. Gate-level use is preferred.

## Checkpoints and restart

`checkpoint()` returns `{ format: 1, scopeHash, mode, afterId }`, or `undefined` before
initialization or while configuration is invalid. Save the latest returned checkpoint after
each evaluation that changes it. Start the application in shadow, restore the checkpoint
through the constructor setting, and evaluate before admitting live traffic. The controller
restores enforce only after checking its shape, scope and ledger anchor.

The scope covers target gate/question filter, rubric, effective policy, caller version, model
pin, target accuracy and sample/window settings. An incompatible scope, malformed checkpoint,
missing/foreign anchor, or mode change outside an initialized controller starts a fresh shadow
phase with a human-readable reason. A null anchor can be restored only while the target ledger
is still empty: in nonempty history it cannot prove a boundary, so validation starts again.
Label updates do not move the anchor. Custom ledgers must preserve stable decision insertion
order across reads, labels and reloads.

Checkpoints are trusted application state, not signed evidence or a tamper-proof journal.
Ratchet does not save them, coordinate processes, detect a deliberately rolled-back checkpoint,
or recover an unsaved mode transition after a crash. Keep the latest checkpoint with the
matching ledger; if persistence is uncertain, omit it and collect fresh shadow evidence.
Do not run multiple controllers for one target. Calls on one controller are serialized.

## Migration and limits

Existing JSONL ledgers and reports still read normally. Historical rows without the new
policy/version metadata remain visible in reports, but cannot silently promote a current
configuration. Reports continue to describe their historical input; a report's aggregate
accuracy is not the controller's current-phase eligibility.

Add `evidenceVersion`, a live model pin where applicable, and the initial evaluation before
collecting validation labels. Persist a checkpoint if continuation across restarts matters.
Changing the policy, rubric or pin invalidates a saved checkpoint; changing hidden behavior
requires bumping the caller version. Raising/lowering a threshold needs a fresh validation phase.

Audit selection is still opt-in and samples only already-allowed acts. The controller has no
wall-clock expiry or maximum tolerated interval without audit labels. Point estimates,
selection bias, correlated examples and repeated testing remain limitations. None of these
bookkeeping changes turns the current heuristic into statistical certification.
