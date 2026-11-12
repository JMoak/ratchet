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

## Fitting a bar the test will accept

*Added 2026-11-12 from the end-to-end evaluation (e2e T1, [report](e2e/t1-toolgate.md)), run on
authored tool calls.* The test did its job there and the bar did not earn its promise. A bar
fitted at 98% act precision on 180 fit items (71 template groups) was right on 99 of 100 fit
acts and on 93 of 102 acts from held-out groups of the same families (91.2%, exact lower bound
85.1%). The planned sample of 59 acts at a 95% promise held 5 wrong; the rollout rejected it
(lower bound 83.0%) and kept the rejection across a fresh process. All nine held-out wrong acts
were "routine-looking, not routine" commands at pYes 0.62 to 0.89, a band the fit split had
few denials in, so the point-estimate fit placed the bar inside it. Post hoc a bar of 0.8 was
right on 79 of 80, 31 of 31 and 12 of 12 acts across three held-out slices at 70% to 78% of
approvals, so the sort existed; the fit procedure did not find it. What to do instead:

- **Fit on rows from many groups.** Sessions, templates, projects or customers share errors, so
  a hundred rows from ten groups are closer to ten observations than to a hundred. Spread the fit
  rows over as many groups as you can, and read how many distinct groups sit above a candidate
  bar, not just how many rows.
- **Prefer the conservative bar.** `fitThreshold(rows, target, minSupport, { conservative:
  true })` accepts a bar only when the lower end of a 95% Wilson interval (a one-sided 97.5%
  bound) of the precision above it clears the target; a gate's reported act bar is fitted this
  way. When it returns no bar, that is the answer: too few rows for that target. On T1's 180
  fit items it returned none at 98%, and on T5's 200 fit items no strategy got one at 98%. A
  point-estimate bar on a small fit set is the one that failed here.
- **Fit the act side.** For a judge gate, fit on whether acting was right (the go probability
  against the truth), which is what the acceptance test scores, not on the leading answer's
  confidence; a leading-answer bar counts confident denials as successes (e2e T1-06, T2-04).
- **Validate on groups the fit never saw**, once, before spending the planned sample: deal whole
  groups to fit and validation, never items of one group to both. T1's evidence split was built
  that way, which is why it exposed the gap the fit split hid.
- **Plan for the sample size.** A zero-error plan needs 149 clean acts for a 98% promise and 59
  for 95%. T1's 158-item evidence split produced 102 acts, 87 after the group cap, so 98% could
  not be tested at all. Know where 149 acts will come from before promising 98%.
- **Size the review band from measured spread.** The act bar plus a band wide enough to cover
  the pinned model's run-to-run movement (jev-1.13: median 0.01, max 0.11; jev-1.14: 11.4% of
  repeated requests moved more than 0.12; see [live findings](live-findings.md)).

## The grade, and why only measured promotes

Every `RolloutStatus` carries `grade`, the kind of evidence the current phase supports
(`gradeOf` in `src/ledger/evidence.ts`, rendered the same way by `ratchet report`, `check` and
`trail`; see [the CLI's evidence grades](cli.md#evidence-grades)):

| grade | in a status | promotes |
| --- | --- | --- |
| `measured` | the planned sample was accepted: its exact lower bound, errors, sample size, labels by trust class, and the date of the label that completed the sample | yes, and nothing else does |
| `estimated` | at least 30 labelled shadow rows (or, in enforce, blind audits) of trusted sources: accuracy and a 95% Wilson interval | no |
| `borrowed` | evidence that is not this gate's labels | no; a rollout never builds one |
| `none` | too few rows, with the reason; every phase starts here | no |

Promotion is decided by the grade, not by reading the acceptance status: the controller's one
way into enforce takes the measured variant of the grade (`MeasuredGrade`) and nothing wider, so
promoting on an estimated, borrowed or absent grade is a compile error, and it refuses any other
variant at run time, for a caller that casts past the type. There is no override flag and no
provisional mode. An estimate is looked at again with every new label, so its nominal 95% is
not its real coverage; that is exactly the optional stopping the planned test exists to avoid.
A shadow gate whose estimate looks excellent while its planned acts await labels holds shadow,
with `acceptance.status` `awaiting-labels` and `grade.kind` `estimated`.

A grade is dated by its evidence, never by the evaluation: a promotion status read in October
for a sample whose last label arrived in July says July, because a measured grade decays and
is read as permanent unless its date says otherwise.

In enforce the grade reads the phase's blind audits: it can say an enforcing gate's evidence is
`none` or `estimated` (and the audits can demote it), but it never re-promotes anything. The
grade adds a field to the status only: checkpoints, plan hashes and the controller's reason
strings are unchanged.

## Starting from a borrowed bar

A new gate has no labels, so the lifecycle's first phase has no bar of its own to rule with,
and a guessed one acts on nothing or on too much. A calibration profile
([`ratchet profile`](cli.md#profile)) lends one: what the same model's confidence was worth on
other gates' labelled rows, at the cautious end across them.

```ts
const profile = parseProfile(JSON.parse(await readFile("profiles/model.judge.json", "utf8")));
const gate = engine.gate({
  id: "tool.safe",
  question,
  policy: policyFromProfile(profile, 0.98), // the borrowed bar plus 0.05: act at the band's upper edge
  barSource: { profileHash: profile.hash }, // written into every row's detail
  evidenceVersion: "tool-safe-v1",
  promisedAccuracy: 0.98,
  mode: "shadow",
});
```

Where it fits:

- **Shadow only.** The borrowed bar decides what the gate *would* act on while it shadows; it
  never enables act. `Rollout` is unchanged and never builds a borrowed grade, and promotion
  still takes a measured grade and nothing else. Reports grade the gate `borrowed` (given the
  profile) until its own labels estimate or measure anything.
- **Measured still promotes.** The planned sample is the first acts of the shadow phase under the
  gate's policy, so a borrowed bar chooses which rows are acts, never which labels count: the
  sample is still fixed before any label is read, and the exact bound means what it always did.
- **A new phase.** `policyFromProfile` returns an ordinary policy and the policy hash is part of the
  rollout's scope, so a gate moved onto a borrowed bar, or onto another one, starts a fresh
  phase; initialize the rollout before collecting, as for any configuration change. The bar's
  source is not part of the scope: two profiles that lend the same bar give the same policy.
- **Expiry.** A profile is keyed to an exact model pin and question kind. Once the gate's newest
  answers come from another model, reports read it as `borrowed (stale)`; a pinned rollout
  already holds shadow on that mismatch. Rebuild a profile for the new model (or let the gate's
  own labels take over) and bump the evidence version.
- **When the profile has no bar.** `policyFromProfile` throws rather than invent one: no donor
  gate's confidence kept the promise, so there is nothing to borrow, and the gate starts from a
  bar you choose and label its shadow rows as before.

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

The other side is speed, measured live in e2e T1. At an audit rate of 0.2 with 30 audits to
judge, nothing can demote before about 150 acts, and the window covers the whole enforce phase
up to 200 audits, so early clean audits dilute later errors. A gate promoted on an openly weak
plan was demoted after 420 enforce asks and 53 audits (94.3% against a 95% promise), and 10
wrong acts executed first. The sequential test is on the roadmap for both reasons.

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

`checkpoint()` returns `{ format: 3, scopeHash, mode, afterId, rejected }`, plus
`accepted: { from, sample }` on an enforce checkpoint, or `undefined` before initialization or
while configuration is invalid. `accepted` is the planned sample that promoted the gate: the
ids of its acts, and `from`, the row its phase began after (`null`: the target's first row);
the phase ends at `afterId`. Save the latest returned checkpoint after each evaluation that
changes it. Start the application in shadow, restore the checkpoint through the constructor
setting, and evaluate before admitting live traffic. The controller restores enforce only after
checking its shape, scope and ledger anchor, and, for a format 3 checkpoint, after re-deriving
the planned sample from that phase of the ledger and evaluating it again: the ledger must still
hold the same acts, labelled by sources the plan reads, and they must still pass. Otherwise it
holds shadow and says why (no accepted sample, the phase is gone, the sample changed, or its
labels no longer pass), so editing a saved checkpoint's `mode` to `enforce` promotes nothing.

A rejection outlasts its checkpoint. Whatever phase start a checkpoint claims, enforce is
honoured, and a promotion made, only if no complete planned sample of the configuration up to
the anchor has already failed on the ledger, before the accepted one or after it. The
candidates are the configuration's shadow rows since its last enforce row, each act taken as a
possible phase start. A controller that lost its checkpoint after a rejection therefore holds
the configuration rejected on its next test instead of promoting on a luckier sample.

The cost is conservative, and deliberate:
- Labelled shadow rows of the same configuration written before the controller was initialized
  count too, so a planned-size stretch of them with a wrong act keeps the configuration
  rejected.
- Acts collected while the planned sample awaited its last labels count too. If one of them is
  labelled wrong and completes a failed window, the gate does not promote even though its
  planned sample passed. A label that arrives later on such an act can also make an honest
  enforce checkpoint hold shadow on restore.

Initialize before collecting evidence, as above, or bump `evidenceVersion` to start clean.

Older checkpoints (migration). A format 1 checkpoint loads as one that was never rejected. A
format 1 or 2 checkpoint in shadow loads as before. A format 1 or 2 checkpoint in enforce names
no sample, so the restore looks for one: the earliest planned sample, drawn from an act of the
configuration's shadow rows before the anchor, that the ledger accepts. It applies the same
failed-sample check and, if both pass, restores enforce and writes the checkpoint back as format
3 with that sample. Otherwise it holds shadow and says why. A gate promoted honestly under an
older release restores to enforce. A gate whose ledger no longer passes, or which was rejected,
does not. (Before e2e V1, older enforce checkpoints were honoured unverified, so rewriting a
checkpoint as format 2 restored a rejected configuration.)

An incompatible scope, malformed checkpoint, missing/foreign anchor, or mode change outside an
initialized controller starts a fresh shadow phase with a human-readable reason. A null anchor
can be restored only while the target ledger is still empty: in nonempty history it cannot
prove a boundary, so validation starts again. Label updates do not move the anchor. Custom
ledgers must preserve stable decision insertion order across reads, labels and reloads.

Checkpoints are trusted application state, not signed evidence or a tamper-proof journal.
Ratchet does not save them, coordinate processes, detect a deliberately rolled-back checkpoint,
or recover an unsaved mode transition after a crash. A controller started without its
checkpoint begins a new phase, though a configuration whose planned sample failed on the ledger
stays rejected (above). Do not run multiple controllers for one target. Calls on one controller are
serialized.

The red team measured both edges of this (e2e T4). Six kinds of damaged or stale checkpoint (a
wrong scope hash, a foreign or missing anchor, an extra key, an unknown format, a mangled mode,
a null anchor in a nonempty ledger) all held shadow, and policy, rubric and evidence-version
changes after a promotion returned shadow. A saved shadow checkpoint whose `mode` was edited to
`enforce` restored enforce with no accepted sample behind it (T4-10); a format 3 checkpoint now
holds shadow in that case, because enforce is honoured only with a sample the ledger still
accepts. Wave 3 (V1) then restored a rejected configuration by rewriting the checkpoint as format 2,
or by moving `accepted.from` past the failed act. Both now hold shadow: older formats are
verified too, and a failed planned sample before the claimed one keeps the configuration
rejected. What a forged checkpoint can still do is name which complete, fully labelled, passing
planned sample of an unrejected configuration it rests on (skipping an act whose label is still
missing, say). Flipping `rejected` to false re-opens a configuration only while its ledger
holds no failed planned sample. Store checkpoints where only the deployment can write them.

## Migration from the point-estimate controller

- `minShadowRows` and `minActed` are gone; the plan's sample size replaces them. `window` and
  `minAuditRows` now apply to demotion only.
- `RolloutStatus.window` is replaced by `acceptance` (shadow) and `audits` (enforce). A shadow
  status no longer reports an interim accuracy.
- Promotion needs the planned sample: 149 distinct acts at 98% rather than 20. Test fixtures
  that need a small sample should state a weak plan openly (for example `confidence: 0.5`
  gives a one-act plan at a 50% promise) rather than hide it.
- Checkpoints were format 2 at that change; they are format 3 now (see Checkpoints and restart).
  Changing the plan invalidates a saved checkpoint.

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
