# Rollout evidence lifecycle

`Rollout` decides when a gate may act on its own and when it must go back to shadow.
Promotion runs one planned acceptance test: the first acts of a fresh shadow phase, fixed
before their labels are read, must reach the promised accuracy by an exact one-sided
(Clopper-Pearson) lower bound. Demotion reads the current enforce phase's blind audits.

This replaced a point estimate read at every evaluation. Under simulation (table 7 of
[sim-results.md](sim-results.md)) that rule promoted a gate that was really 95% accurate
against a 98% promise in 96% of runs, because it kept looking until a lucky window cleared the
bar. The planned test holds such false promotions near 0% and at most 5% at the promise
itself, by construction.

It is a sound test under stated assumptions, not a certification of future traffic. The
assumptions are listed at the end; the application still owns representative labels, the
model pin, and the decision to enforce.

## The acceptance test

| Setting | Default | Meaning |
| --- | --- | --- |
| `promisedAccuracy` | required | Accuracy promised on acts, in (0, 1). |
| `confidence` | 0.95 | One-sided confidence of the exact lower bound. |
| `maxErrors` | 0 | Wrong acts the sample may hold and still pass. |
| `group` | none | `{ tagPrefix, maxPerGroup }`: rows sharing a tag with this prefix are one group, contributing at most `maxPerGroup` acts. |

The sample size follows from these (`requiredActs`): 149 acts for 98% with no errors allowed,
236 with one, 313 with two; 59 for 95%; 299 for 99%. An act is a decision row the policy would
have acted on and an oracle actually answered. Failed-open rows and rows a floor or bypass
settled are not acts. A battery contributes its combined row.

- **Fixed before labels.** The sample is the first eligible acts in ledger order. Which rows
  are in it never depends on a label, so labelling only the easy ones or stopping on a good run
  cannot shape it.
- **Retries count once.** An act whose state was already seen in the phase is a retry.
- **Groups are capped.** Calls in one session share context and errors; counting a hundred of
  them as a hundred independent trials would overstate the evidence.
- **Sealed until complete.** While the sample fills, the status reports how many acts are in
  it and nothing about their labels. Once full, it waits until every act in it is labelled;
  an act whose label cannot be read counts as wrong.
- **Evaluated once.** A pass promotes. A failure is final for that configuration: the gate holds
  shadow until its rubric, policy, model pin, plan or evidence version changes, and the
  checkpoint carries the rejection across restarts. Retrying an unchanged configuration until it
  passes would be optional stopping by another name.

Power is the price. Table 7 shows a gate that is really 99% accurate passing a zero-error plan
at 98% only about a fifth of the time; tolerating two errors (313 acts) roughly doubles that.
Choose `maxErrors` before collecting, from how good the gate is expected to be and how fast
labelled acts arrive.

`evaluateAcceptance`, `requiredActs`, `exactLowerBound` and `resolvePlan` are exported for use
outside a controller, for example in a pilot's report.

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
    maxErrors: 2,
    group: { tagPrefix: "session:", maxPerGroup: 10 },
    minAuditRows: 30,
    window: 200,
    // checkpoint: previouslySavedCheckpoint,
  },
});

await gate.rollout.evaluate(); // first call without a checkpoint holds shadow
// Collect new asks and independent labels here.
const status = await gate.rollout.evaluate(); // status.acceptance in shadow, status.audits in enforce
const checkpoint = gate.rollout.checkpoint(); // application persists this JSON itself
```

The initial evaluation places a boundary after every row already present for this target,
including unlabelled rows. Historical labels cannot promote a newly initialized controller.
Initialize once before validation traffic; do not recreate the controller for every batch.
Without an evidence version the controller holds shadow with an explicit reason.

Every promotion, rejection and demotion places a new boundary after **all** currently existing
target rows. Labels later attached to those rows stay outside the next phase. Rows with tied,
out-of-order or vendor-supplied timestamps do not change this ordering. This is a ledger
append boundary, not a guarantee that every later append began its request after the
transition. Drain in-flight work when changing deployment configuration.

## Demotion and audits

In enforce mode the controller reads the last `window` (default 200) audited rows of the
current phase: enforce rows tagged `audit`, which the engine diverts to review at the gate's
`auditRate`. Once `minAuditRows` (default 30) exist, an observed accuracy below the promise
returns the gate to shadow, and a fresh acceptance test is needed to promote it again.

Audits are opt-in. With an audit rate of 0, nothing can demote a promoted gate, and both the
promotion reason and every later status say so. The rule errs toward caution: at 30 audits a
single error reads below 98%, so table 8 shows a gate that is really 99% accurate being demoted
about half the time within 2,000 acts. That costs review work, not safety. A sequential test
with an explicit false-alarm rate would be the refinement; it is not built.

Audits monitor allowed acts only. They cannot promote a shadow phase, and failed-open or
code-only rows cannot dilute audit errors.

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
  rubric/policy/version scope returns to shadow on the next evaluation even before it is
  labelled. This is an evidence check, not a provider-request guard: the application must
  prevent unapproved model changes before acting.
- The acceptance plan (target, confidence, errors allowed, group cap, sample size) and the
  audit limits are part of the scope, so changing any of them starts a new phase.

Model pinning is optional for local deterministic fixtures. Strategies whose combined row
does not record one model cannot satisfy a single-model pin; version their full configuration
explicitly, and do not invent a model identity for the combination.

`Gate.ask()` stamps the spec's evidence version. `Engine.ask`, `Engine.askAll` and
`Gate.askAll` honor their caller's `AskOptions`, including `evidenceVersion`; set it explicitly
there. Recipe calls do not silently borrow the gate's version or policy.

For an engine-level controller, supply `evidence: { version, model, policyHash:
hashPolicy(policy), questionHash: hashQuestion(question) }`. Unlike a gate, an engine owns
no single policy/rubric, so it cannot infer a homogeneous deployment scope. Matching rows
may span gate ids, but unrelated policies and rubrics are excluded. Gate-level use is preferred.

## Checkpoints and restart

`checkpoint()` returns `{ format: 2, scopeHash, mode, afterId, rejected }`, or `undefined`
before initialization or while configuration is invalid. Save the latest returned checkpoint
after each evaluation that changes it. Start the application in shadow, restore the checkpoint
through the constructor setting, and evaluate before admitting live traffic. The controller
restores enforce only after checking its shape, scope and ledger anchor. A format 1 checkpoint
from an earlier release still loads, as one that was never rejected.

An incompatible scope, malformed checkpoint, missing/foreign anchor, or mode change outside an
initialized controller starts a fresh shadow phase with a human-readable reason. A null anchor
can be restored only while the target ledger is still empty: in nonempty history it cannot
prove a boundary, so validation starts again. Label updates do not move the anchor. Custom
ledgers must preserve stable decision insertion order across reads, labels and reloads.

Checkpoints are trusted application state, not signed evidence or a tamper-proof journal.
Ratchet does not save them, coordinate processes, detect a deliberately rolled-back checkpoint,
or recover an unsaved mode transition after a crash. A controller started without its
checkpoint begins a new phase, so a rejection is only as durable as the checkpoint that
records it. Do not run multiple controllers for one target. Calls on one controller are
serialized.

## Migration from the point-estimate controller

- `minShadowRows` and `minActed` are gone; the plan's sample size replaces them. `window` and
  `minAuditRows` now apply to demotion only.
- `RolloutStatus.window` is replaced by `acceptance` (shadow) and `audits` (enforce). A shadow
  status no longer reports an interim accuracy.
- Promotion needs the planned sample: 149 distinct acts at 98% rather than 20. Test fixtures
  that need a small sample should state a weak plan openly (for example `confidence: 0.5`
  gives a one-act plan at a 50% promise) rather than hide it.
- Checkpoints are format 2. Changing the plan invalidates a saved checkpoint.

## Assumptions and limits

- Acts are independent trials of a fixed configuration. Retries are deduplicated and groups can
  be capped, but other correlation (one user, one codebase, one week) remains.
- Labels are correct and not chosen by outcome. The sample's composition ignores labels, but if
  the application labels selectively, unlabelled acts hold the evaluation rather than vanish.
  Whether the labels themselves are right is a separate question; blind review
  (`ratchet review`) measures it.
- The test speaks about the traffic it saw. Later drift is the audits' job, and with audits off
  nobody does it.
- One evaluation per configuration. Testing many configurations in turn and keeping the first
  that passes is multiple testing; record how many were tried.
