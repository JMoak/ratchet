# Evidence grades, profiles and second opinions

*Design brief for the 0.4 milestone, settled 2026-10-30 after a five-perspective review
(statistician, regulated-industry buyer, daily hook user, human-factors reviewer, architect).
This document is binding for the work packages below. Where it is silent, `vision.md` and the
invariants in `AGENTS.md` decide. Where it conflicts with either, it is wrong.*

## Why

The engine today says nothing useful about a gate until a planned acceptance sample completes,
which at a 98% promise is 149 clean acts. On the keywork pilot that is months, and the one
published shadow deployment of a decision router in a coding agent was removed before it earned
anything. Meanwhile a fixed 0.95 bar acted on nothing because the model put routine calls at
0.72 to 0.89. The gate was honest and useless.

This milestone makes the shadow period informative without weakening what enforce means:

- every number the engine prints carries a **grade** (measured, estimated, borrowed), its
  provenance and its date, and only a measured grade can flip a gate to enforce;
- a new gate starts from a **profile** (calibration borrowed from other ledgers of the same
  model and question kind) instead of a guess, in shadow;
- a **second opinion** from a different model turns every row into a pair, so disagreement
  bounds error before any label exists and member correlation can be measured once labels do;
- **blind audits** are on whenever a gate enforces, so a promoted gate can be demoted by
  evidence;
- labels are sorted by **source trust**, so consequence signals inform without ever fitting a
  bar.

## Two hard lines

1. **Nothing but a measured grade reaches enforce.** No override flag, no provisional mode, no
   "estimated is close enough". The type system enforces it: promotion takes the measured
   variant of the grade union and nothing else.
2. **No number without its grade, its source and its date.** A bar, an accuracy or a
   disagreement rate printed anywhere (report, check, status, trail, viewer) is printed with the
   word that says what kind of evidence it is, where that evidence came from, how many rows, and
   when.

## Definitions

- **measured**: an exact one-sided Clopper-Pearson lower bound on a sample fixed before any of
  its labels were read (`src/acceptance.ts`). The only grade with a promise attached.
- **estimated**: a Wilson interval on labelled unselected rows of trusted sources, recorded under
  the gate's current configuration (its newest row's evidence version, a policy its newest
  request used, and each question at the newest policy and rubric recorded for its own id, so a
  gate asking many questions keeps them all; renaming a question makes it a new one, so bump
  `evidenceVersion` to retire the old, and keep one evidence version per gate: per question it
  retires all but the last asked, interleaved it makes the grade flip with each request),
  looked at repeatedly, so its nominal coverage is not its real coverage. It may raise a bar,
  widen a band, demote, or schedule an acceptance plan. It never enables act.
- **borrowed**: a bar or a bound from evidence that is not this gate's labels: a profile from
  other ledgers, or disagreement between two judges of different model families. Shadow only.
- **none**: fewer rows than any grade needs; the reason is stated.
- **unselected row**: a labelled row the oracle's own confidence did not choose: shadow rows
  and blind audits, with a label from a trusted source. Fitting and acceptance read only these.
  A chain's retries (`chain:attempt:<n>`, n of 2 or more) are not unselected: only a held-back
  earlier attempt sent their state back.
- **disagreement**: on rows with two members from different model families, the share whose
  leading answers differ. At least one of the two is wrong on each, so it bounds from below the
  share of rows on which at least one judge is wrong, regardless of correlation. It is not the
  gate's error rate (the gate may follow the better judge, or pool both, and be wrong far less
  often), never an upper bound on error, and never a claim of accuracy. A model's family is its
  first name token, the owner prefix and a repeated owner token dropped (`modelFamily`:
  "typesafe/jev-1.13", "jev-1.14-fp8" and "jev-router" are all "jev", Meta-Llama-3.1-70B and
  llama-3.1-8b both "llama", every Claude "claude"): two pins of one family shared 89% of their
  errors and are refused as a pair. Families are coarse on purpose: a false merge only adds
  caution, a false split removes it.
- **act bar**: the bar a gate's own labels support for its policy's `actAbove`, fitted on the
  probability that acting is right as the policy reads it, against whether acting was right, and
  conservatively (the lower end of the 95% Wilson interval of acting right above it, z 1.96, a
  one-sided 97.5% bound, reaches the promise). The
  point estimate's bar is reported beside it for reading, never as one to act at.

## Configuration philosophy

This is a tool. Every behaviour below has a lever, the lever has a documented default, and the
default is the honest one, not the convenient one. Levers live at three levels and the nearest
wins: `EngineOptions` (fleet default), `GateSpec` (per gate), and per call where a per-call
override makes sense. CLI commands expose the same levers as flags with the same names and
defaults: the report levers (promise 0.98, support 30, estimated 30) are one exported constant,
`REPORT_DEFAULTS`, read by `Gate.report()`, `Engine.report()`, `report`, `check` and `trail`. A lever that changes a gate's evidence (what counts as a label, which rows fit, the
strategy) is called out in `CHANGELOG.md` and the docs say to bump `evidenceVersion`.

Levers never hide: a report prints the effective value of every lever that shaped a number.

## Work packages

Sequenced because each depends on the one before. Each package is complete only with its
tests, its docs and its changelog entry. "Done" means `bun run check` passes, `bun run build`
passes under Node types, and the reviewer has read the diff.

### WP1. Member identity and label sources (ledger layer)

**Member identity.** `MemberRecord` gains `key: string`, a stable identity for pairing one
member across rows: the `Member.label` or `Tier.label` when given, else `${oracle}#${index}`.
It gains `settled?: true` on the member whose answer settled a cascade or sequential run, so the
trail stops inferring roles from `strategy` plus `detail.tier`. `CompoundDecision` carries
`memberKeys?: readonly string[]` parallel to `members`, set by `ensemble`, `sequential` and
`cascade`; `compoundOf` accepts it. `parseJsonlLedger`'s `upgrade()` fills `key` for rows
written before this (from oracle and index) so old ledgers read the same way.

**Member correlation from the ledger.** `calibration.ts` gains `memberCorrelation(rows)`:
pairwise phi between members' correctness by key, over labelled rows whose `members` are
present, returning per-pair and mean values with `n`. A judge member is scored against a
boolean truth, a pick or rate member by name against a string one. Battery members (rows of
their own) are paired by request and keyed by question id, each scored by its own label: the
battery's truth through `inheritOutcome`, or the member's own when the label carries
`Outcome.memberTruths` (a member a present map does not name stays unlabelled, never the
composite's truth). A pair whose members did not both vary has no phi (absent, never 0) and is
left out of `mean`; `matrix` gives the measured pairs by key for `PoolOptions.correlations`,
which pools by non-negative GLS weights, each in [0, 1], so a pool is never worth more than its
members and never more confident than the same answers at rho 0.

**Label sources.** New `src/ledger/sources.ts`. A source string is `<channel>:<kind>[:<name>]`.
A trust class per source:

| class | meaning | examples | fits a bar | feeds acceptance | feeds estimated |
| --- | --- | --- | --- | --- | --- |
| `blind` | judged before the model's answer was shown | `review:blind`, `review:blind:<name>` | yes | yes | yes |
| `census` | a person answered every ask in the moment, so the label is the population | `keywork:person`, `claude-code:person`, `codex:person` | yes | yes | yes |
| `moment` | a person answered after seeing the model's answer or suggestion | `desk:assisted` | no | no | yes |
| `consequence` | inferred from what happened next | `accepted:*`, `reverted:*`, `silence:*` | no | no | no, own column |
| `unknown` | no source, or an unregistered prefix | legacy rows | as today | as today | yes |

`unknown` keeps today's behaviour exactly, so existing ledgers, fixtures and tests do not move.
The registry is a `ReadonlyMap<string, TrustClass>` keyed by `channel:kind` prefix, with
`EngineOptions.labelTrust?: Record<string, TrustClass>` and a CLI flag `--trust prefix=class`
to extend it. `isUnselected(r, opts?)` gains an optional trust filter that defaults to
`["blind", "census", "unknown"]`; `scoredFromLedger`, `fitThreshold` callers and
`acceptanceSample` pass through a `FitOptions.sources` / `AcceptancePlan.sources` lever with the
same default. Consequence labels are counted and reported in their own column everywhere
labels are counted; they never enter `fitThreshold` or `evaluateAcceptance`.

Tests: pairing across rows by key; `upgrade()` on a pre-key ledger; correlation on a seeded
two-member ensemble against the known simulated rho; each trust class in and out of fitting;
an unregistered prefix behaving as `unknown`.

### WP2. The evidence grade (one producer, every consumer)

New `src/ledger/evidence.ts`:

```ts
export type EvidenceGrade =
  | { kind: "measured"; plan: ResolvedPlan; lowerBound: number; errors: number;
      sampleSize: number; sources: SourceCounts; at: string }
  | { kind: "estimated"; accuracy: number; lower: number; upper: number; n: number;
      confidence: number; sources: SourceCounts; at: string }
  | { kind: "borrowed"; via: BorrowedVia; at: string }
  | { kind: "none"; reason: string; labelled: number; unselected: number };

export type BorrowedVia =
  | { type: "profile"; profileHash: string; bar: number; donor: ProfileProvenance }
  | { type: "disagreement"; rate: number; pairs: number; models: readonly [string, string] };

export type MeasuredGrade = Extract<EvidenceGrade, { kind: "measured" }>;
```

`gradeOf(rows, opts)` produces the best grade the rows support, in that order of preference,
with `opts` carrying the acceptance plan (if any), `minEstimated` (default 30 labelled
unselected rows), `confidence` (default 0.95), the trust filter, and an optional profile.
`SourceCounts` is labelled rows by trust class. `wilsonInterval(p, n, confidence)` joins
`wilsonLower`.

Consumers, all through this one type:

- `Rollout.promote` and the internal promotion path take `MeasuredGrade` only. `RolloutStatus`
  gains `grade: EvidenceGrade`. The three existing classifiers (`isUnselected` use in
  `summarize`, `QuestionReport.fittedFrom`, `check`'s `eceFrom`) are unified: `fittedFrom` is
  `"unselected" | "all"` everywhere (the `"labelled"` spelling in `check` goes), and both report
  and check carry `grade`.
- `ratchet report` prints a `grade` column and a provenance line per gate; `--json` carries the
  union. `ratchet check` gains `--require <measured|estimated>` (default `measured` when
  `--promise` is given) and fails with exit 1 when the grade is weaker.
- `ratchet trail` prints the grade sentence on each gate's bar line; the viewer's gate strip
  shows it (WP6).
- `Engine.report` exposes the grade per question.

Rendering rules (the human-factors findings): the three words are never in one column with
one another's numbers; measured always prints its date and sample size; borrowed always names
the donor and prints "0 rows here"; disagreement prints as "at least N% wrong on this slice";
estimated prints its interval width and "not a planned sample". Disagreement prints as "A and B
disagree on N% of M pairs, so at least one of the two judges is wrong on at least N% of them; this is not this
gate's error rate" (it printed "at least N% wrong on this slice" until wave 2 of the end-to-end
evaluation, which a reader took for the gate's error).

Tests: a fixture ledger that yields each grade; promotion refused at the type level (a
compile-time test with `@ts-expect-error`) and at runtime on an estimated grade; `check
--require` on each grade; JSON shape stability.

### WP3. Calibration profiles

New `src/ledger/profile.ts`:

```ts
export interface CalibrationProfile {
  readonly format: 1;
  readonly key: { readonly model: string; readonly kind: QuestionKind; readonly questionHash?: string };
  readonly bins: readonly ReliabilityBin[];           // with per-bin n
  readonly bars: readonly { readonly target: number; readonly bar: number; readonly support: number }[];
  readonly from: ProfileProvenance;                   // rows, gates, ledgers, firstAt, lastAt, sources
  readonly hash: string;
}
```

`buildProfile(rows, key, opts)` reads only unselected rows of trusted sources (WP1) for the key
(exact model pin, question kind, optional rubric hash). The bar per target is the cautious end:
per gate, the lowest confidence bin the lower end of whose 95% Wilson interval (a one-sided
97.5% bound) clears the target with
`minSupport`; across gates, the maximum of those. `mergeProfiles` combines bins and provenance
and recomputes bars. `borrowedBar(profile, target)` returns the bar or `undefined` when no bin
clears it. A profile expires when the gate's model pin differs from the key; `profileAge` and
`profileMatches(profile, gate)` are explicit helpers.

Consumption keeps policy explicit and hashed: `policyFromProfile(profile, target, opts)` builds
a `GatePolicy` (with `policyWithBand` applied, default half-width 0.05) for the caller to put in
the spec, and `GateSpec.barSource?: { profileHash: string }` records where it came from. The
engine writes `barSource` into `detail` on every row of that gate so replay separates borrowed
traffic from fitted. A gate with a `barSource` whose profile no longer matches its model pin
reports `borrowed (stale)`. Rollout is unchanged: borrowed is shadow-only by construction
because enforce still needs a measured grade.

CLI: `ratchet profile build <ledger...> --model <pin> --kind <judge|pick|rate> [--question-hash]
[--target 0.98 ...] [--min-support 30] [--out profile.json]`, `ratchet profile show
<profile.json>`, `ratchet profile merge <a.json> <b.json> --out`. `ratchet report --profile
<file>` adds the borrowed bar as a grade until the gate's own labels grade it estimated. A `bun run profiles`
script regenerates `profiles/*.json` from the live ledgers under `experiments/out/` when they
exist, and `profiles/` joins the package `files` allowlist with a README naming each profile's
donor ledgers and dates.

Tests: cautious-end selection across gates; expiry on pin change; `policyFromProfile` round
trip through `hashPolicy`; merge associativity; CLI exit codes.

### WP4. Second opinions, audits by default, the band, oracle kinds

Status (2026-11-12): of this package, `disagreement(rows)` is built (in `calibration.ts`, with
`modelFamily`); `secondOpinion`, the hook's `RATCHET_SECOND_MODEL`, the disagreement line in
`report`, `check --max-disagreement`, audits on by default, the band warning and oracle kinds
are planned and not yet built. Until they are, a caller passes `disagreement(rows).via` to
`gradeOf` as `borrowed`.

**Second opinion (planned).** `EngineOptions.secondOpinion?: { oracle: Oracle; mode?: "always" |
"when-unsure"; correlation?: number }` and the same on `GateSpec`. When set and a gate declares
no strategy, the effective strategy is a two-member ensemble of the primary and the second
oracle (`always`, default) or a two-tier cascade settling at the gate's `actAbove`
(`when-unsure`). The default correlation when unmeasured is 0.5 for two different models
(documented as a guess until `memberCorrelation` returns a value, which the report prints next
to it). The second oracle must have a different `model` pin; the engine throws otherwise,
because two paraphrases of one model are not two opinions. The hook's gate spec reads
`RATCHET_SECOND_MODEL` and uses it. Defaults for existing gates do not change; the docs and
examples recommend the lever.

**Disagreement (built; its report line and `check` flag planned).** `calibration.ts` gains
`disagreement(rows, { keys? })`: over compound rows with members from two model families, the
rate of leading-answer disagreement with `pairs`, the model pair and the newest paired row's
date, ready to pass to `gradeOf` as a `borrowed` grade when nothing stronger exists. Planned:
the line in `report` and on the trail strip ("A and B disagree on N% of M pairs, so at least one
of the two judges is wrong on at least N% of them; this is not this gate's error rate"), and
`check --max-disagreement <p>`.

**Audits (planned).** `EngineOptions.auditRate` default becomes `0.05`; `0` remains allowed and explicit.
`RolloutSettings.unaudited?: true` is the opt-out, and `Rollout` refuses to promote a gate whose
effective audit rate is `0` unless it is set, with a reason that says why. Checkpoint format is
unchanged; an enforcing gate from an older checkpoint keeps enforcing and its status says
`unwatched` as today. The 2026-10-21 decision is honoured by the opt-out, not by the default.

**Review band (planned).** Policy hashes must not move, so the band is not a policy field. `report` and
`check` warn when `actAbove - (refuseBelow ?? 0) < 0.1` (lever `--min-band`, default `0.1`),
citing the hijacking result; `policyFromProfile` and `policyWithBand` default to the band; the
trail strip states the band width and whether the fit or the floor set it.

**Oracle kinds (planned).** `Oracle.kind?: "model" | "classifier" | "rule" | "heuristic"` (default
`model`) and `Oracle.trainedUntil?: string` for classifiers. The engine writes `oracleKind` on
rows only when it is not `model`. Reports skip ECE and posture for `rule` oracles (declared
confidences are not predictions) and `fitThreshold` excludes rows at or before `trainedUntil`
for `classifier` oracles (lever `FitOptions.excludeBefore`, flag `--trained-until`), because
fitting on a classifier's own training labels is leakage. The interface changes are optional
fields; no adapter or test breaks.

Tests: strategy derivation for each mode; the same-pin throw; disagreement on a seeded
two-model ensemble; promotion refused at audit rate 0 and allowed with the opt-out; the band
warning on a thin policy; leakage exclusion.

### WP5. Surfaces and documentation

`ratchet hook status` prints one line per gate in the developer's words: `allowing above 0.84
(borrowed from <profile>, 0 rows here) · 41% of prompts would be answered · 0 of 23 labelled
disagree (estimated 0.86 to 1.00, not a planned sample)`. The viewer's gate strip shows the grade
sentence and the band. `docs/cli.md`, `docs/rollout.md`, `docs/architecture.md`, `README.md`
and `CHANGELOG.md` describe every lever with its default. `docs/roadmap.md` records the
milestone.

### WP6. Research note: consequence labels (parallel, docs only)

`research_notes/Compounding decisions with Jev/consequence_labels.md`: for revert detection,
downstream acceptance and silence with decay, what each measures, the bias each introduces
into a fitted bar (direction and mechanism), what a blind audit of size n corrects and what it
cannot, prior results to borrow (positive-unlabelled learning, survival analysis, delayed
feedback in online advertising), and a proposed experiment on the hook's inferred labels.
Ends with a recommendation and the smallest `Outcome.source` vocabulary that would support it.
No code.

## Decisions log

- **WP1, accepted 2026-10-30.** Acceptance applies the trust filter at evaluation, not when
  the sample is drawn: an act whose only label is untrusted stays in the sample and holds it at
  `awaiting-labels`, because dropping it would let the route a label arrived by choose the
  sample. Default sources stay out of the plan's identity, so existing plan hashes and
  checkpoints are unchanged. `FitClass` excludes `consequence` at the type level.
  `memberCorrelation` takes `unselectedOnly` because rows chosen on pooled confidence are
  chosen on both members at once. Nit carried to WP2: `memberKey` moves from the ledger module
  to `compound.ts` so strategies do not depend on the ledger.
- **WP6, accepted 2026-10-30.** Only revert detection earns a role, and only to queue a row for
  blind review and to lower a grade. The hook's settling routes are consequence inferences;
  the source should carry the route (`<harness>:person:<route>`) so the experiment in the note
  can stratify on it. Vocabulary: `reverted:vcs` under the consequence class; nothing under
  `silence:` or `accepted:`.

- **WP2, accepted 2026-10-30.** `check` requires measured by default only for a gate that
  enforces in the checked window, estimated otherwise, and prints which applied; a shadow gate
  with no grade now fails rather than passing as "not judged". A grade's `at` is the age of its
  evidence (newest label read), never the time it was read. `unknown` renders as "unsourced".
  `CheckOptions.borrowed` takes borrowed evidence as data until WP3 and WP4 supply it.
  `memberKey` moved to `compound.ts`.

- **WP3, accepted 2026-10-30.** Profiles hold integer tallies at a stored `resolution`
  (default 100 bins, in the hash), so merges are exact in any order and refuse mixed
  resolutions. A bar is read on the cumulative tail, the same quantity `fitThreshold` keeps in
  conservative mode. The cross-gate bar is the strictest donor's: the lowest edge at which
  every donor gate with `minSupport` rows at or above it clears the target. Profiles read only
  rows the model answered alone. Default targets 0.9, 0.95, 0.98, 0.99. The three real
  profiles from the live ledgers lend a bar only at 90% (Jev judge 0.56, Haiku judge 0.60,
  Jev pick none), which agrees with the keywork finding that routine calls sit at 0.72 to 0.89:
  a 98% promise needs the gate's own evidence or a second opinion, never a profile alone.

- **Wave 2 of the end-to-end evaluation, 2026-11-12 (package C).** A gate's reported bar is an
  act bar: fitted on the probability that acting is right against whether acting was right
  (`scoredForAct`), so it is what `actAbove` takes; the leading-answer bar it replaced promised
  95% and delivered 80% acting at it in an offline repro (T2-04), and 89% against a 98% target
  live (T1-06). The reported bar is the conservative one,
  the rule a profile's bar is read with, with the point bar beside it for reading (T1-01,
  T3-03). A profile lends until the gate's own labels grade it estimated, not until they first
  fit a bar, which left gates at 20 to 29 labels graded none (T3-03). One set of report levers,
  `REPORT_DEFAULTS` (T3-04). Estimates, fitted bars and `check` read only the current
  configuration's rows, as the planned sample always did; older labels are counted, never read
  (T4-20, T1-12). Battery labels may carry `memberTruths`; `memberCorrelation` pairs battery
  members by request, scores pick and rate members, and gives no phi for a pair without
  variance (T3-07, T2-06, T5-06, T5-07). The disagreement sentence bounds "at least one judge is
  wrong", never the gate's error, and two pins of one family are not two models (T5-03). A
  judge profile's bins remain on the leading answer's confidence; moving them to the act side
  needs a profile format 2 and regenerated `profiles/`, and is backlog.
- **Wave 3 verification, 2026-11-12 (package C).** `poolWeights` solves non-negative GLS by
  active set (drop the most negative member, solve again), so no weight exceeds 1 and a pool is
  worth at most its members; a matrix pool is capped at the confidence of the same answers at
  rho 0 (a measured suppressor matrix had pooled three answers as six). The configuration rule
  is per question for policy and rubric and gate-wide for the evidence version; a renamed
  question needs an `evidenceVersion` bump. `modelFamily` cuts at the first version segment. A
  partial `memberTruths` map leaves unnamed members unlabelled. `fitLogistic` reports one class
  and unpenalised separable rows as not converged, with a reason. A profile matched to a pin is
  stale once the newest answer comes from another model. Report calibration columns read the
  current configuration beside an `older` count. The bar's bound is the lower end of a
  two-sided 95% Wilson interval, a one-sided 97.5% bound, and the docs now say so.
- **Wave 3 round 2, 2026-11-12 (package C).** A row is current only under a policy the gate's
  newest request used, so loosening a gate that asks each question once retires the old labels.
  `report` and `check` name a question a single-question gate no longer asks whose rows still
  grade it (a rename). `modelFamily` compares the first name token, with the owner and a
  repeated owner token dropped: families are deliberately coarse, since a false merge only adds
  caution and a false split removes it.

## Out of scope, deliberately

Engineered reversibility windows, learned rule and rubric splits, an MCP server, middleware,
consequence labels in the core package, a per-session audit floor (needs a session tag
convention; backlog), and any change to `hashPolicy`.

## Review standard

Each package is reviewed by the orchestrator against this document before the next begins.
The bar is the existing code: doc comments that say why and cite the result in a phrase,
conditional spreads for optional fields, seeded tests with tolerances, no runtime dependency,
no Bun API in `src/` or `bin/`, files split before they pass about 400 lines, names that match
the vocabulary above exactly. A package that needs a second round gets one. A package that
needs a third is discarded and restarted from this brief.
