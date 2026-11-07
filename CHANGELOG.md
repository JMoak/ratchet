# Changelog

All notable changes to `@jmoak/ratchet`. The API is experimental until 1.0: minor versions
may change exported signatures, and every change that affects a gate's evidence (rubric,
policy, strategy, state builder or model pin) is called out so you know when to bump an
`evidenceVersion`.

## 0.3.0-alpha.1 (unreleased)

The first version released through CI: a push to `main` with a new version runs the checks, builds, and stages the
package on npm through trusted publishing, where it waits for a 2FA approval.

### Fixed

- Hook subjects derive workspace containment from the reported Windows or POSIX path syntax.
  Windows drive and UNC paths keep their containment result when replayed on Linux.

### Added

- `ratchet hook <claude-code|codex> event|install|status|replay`: shadow a coding agent's
  permission prompts. The harness's `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`
  and `SessionEnd` hooks append to a journal under `~/.ratchet/hooks/<harness>/`; `replay`
  resolves each prompt from what happened next (ran: allowed; never ran before the next turn
  or the session end: denied), asks the `agent.tool.<harness>` gate in shadow, and labels the
  row with source `<harness>:person`. Nothing is enforced; no prompt changes. Design and the
  label inference in `docs/design/agent-hook.md`.
- Public API: `hookGateSpec`, `parseHookInput`, `resolvePrompts`, `ingestPrompts`,
  `promptState`, `subjectOf`, `scrub`, `hookPaths`, `readEvents`.
- `ratchet trail <ledger> [--gate] [--request] [--last] [--json]`: how each decision was
  reached. One section per decision with every answer bought (ensemble votes, cascade tiers,
  sequential samples, battery member rows), the pooled verdict, the ruling and its floor, the
  action, provenance hashes and the label. Prints each gate's act bar as the rulings imply it.
- The decision trail viewer, `bun run trail <ledger>`: a loopback page over the same builder
  (`examples/trail/`), one evidence scale per row, filters and one opened decision in the URL,
  polling a growing file or taking a dropped `.jsonl`. No framework, no build, no dependency.
- Compound rows (ensemble, cascade, sequential) now record their `members` (each answer's
  oracle, model, verdict, cost, latency and failure) and the strategy's `detail` (settling
  tier, sample count, pooling), so the path to a verdict can be read from the ledger alone and
  member error correlation measured from it. Battery members were already rows; a battery row
  gains `detail` (member count and combiner). Single, floored and bypass rows are unchanged.
- Public API: `MemberRecord`, `parseJsonlLedger` (reads bare rows too, as an in-memory ledger
  download writes them); `src/cli`: `buildTrail`, `selectTrail`, `inferBars`, `renderTrail`.
- Member identity. Every recorded member gains `key`, its identity across rows: the `Member` or
  `Tier` label, else `<oracle>#<1-based position>` (`memberKey`), the spelling `replicate`
  already labels with; a sequential member sampled again is `<key>~<round>`. The member whose
  answer settled a cascade (its tier) or a sequential run (its last sample) gains `settled`.
  `CompoundDecision.memberKeys` carries the keys parallel to `members`, set by `ensemble`,
  `cascade` and `sequential`. `ratchet trail` reads `settled` instead of inferring the settling
  member, falling back to the strategy's `detail` for older rows, and its JSON members carry
  `key`; its text output is unchanged.
- `memberCorrelation(rows)`: member error correlation from the ledger, as pairwise phi between
  members' correctness paired by key, per pair with its `n`, and their mean (absent, not 0, when
  no pair exists).
- Label sources (`src/ledger/sources.ts`). A label's `source` is `<channel>:<kind>[:<name>]` and
  has a trust class: `blind` (`review:blind`), `census` (`keywork:person`, `claude-code:person`,
  `codex:person`), `moment` (`desk:assisted`), `consequence` (`accepted:*`, `reverted:*`,
  `silence:*`) or `unknown` (no source, or an unregistered one). Extend or override the
  registry with `EngineOptions.labelTrust` or `ratchet report|check --trust <prefix>=<class>`
  (repeatable). `isUnselected`, `scoredFromLedger` and `scoredWithTruth` take a trust filter
  defaulting to blind, census and unknown; `FitOptions.sources`, `AcceptancePlan.sources` and
  `RolloutSettings.sources` are the same lever for fitting and acceptance, and neither accepts
  consequence. `evaluateAcceptance` takes the registry; a gate's rollout reads its engine's.
- Reports count consequence-labelled rows on their own: `consequence` on `QuestionReport`,
  `Report` and the CLI's `GateReport`, and a `consequence` column in `ratchet report`.
- Public API: `memberKey`, `memberCorrelation`, `MemberCorrelation`, `MemberPairCorrelation`,
  `ScoreOptions`, and from `sources.ts` `TrustClass`, `FitClass`, `TrustRegistry`,
  `TrustFilter`, `LabelSource`, `TRUST_CLASSES`, `TRUSTED_SOURCES`, `COUNTED_SOURCES`,
  `DEFAULT_TRUST`, `parseSource`, `trustOf`, `trustRegistry`, `isTrustClass`, `admits`.
- The evidence grade (`src/ledger/evidence.ts`): `gradeOf(rows, opts)` returns the strongest
  grade the rows support, `measured` (an accepted planned sample and its exact bound),
  `estimated` (a Wilson interval on at least `minEstimated`, default 30, labelled unselected
  rows of trusted sources), `borrowed` (a profile or a disagreement the caller supplies as
  data) or `none` (with its reason as a sentence), and `describeGrade` renders the one sentence
  every surface prints. Levers: an evaluated `acceptance` or a `plan` (and `model`),
  `minEstimated`, `confidence` (0.95), the trust filter (`sources`, `trust`), `borrowed` and
  `borrowedAt`, and `now` for evidence nothing else can date. A grade's `at` is the age of its
  evidence: the label that completed the planned sample, the newest label an estimate read, or
  the date borrowed evidence came with. Text prints it as "as of <date>" and prints the
  `unknown` label class as "unsourced".
  `wilsonInterval(p, n, confidence)` joins `wilsonLower`, which is now its lower end.
- The grade on every consumer: `RolloutStatus.grade`, `QuestionReport.grade` from
  `Engine.report` and `gateReport` (with `ReportOptions.minEstimated`), `GateReport.grade`, and a
  graded bar per gate in `Trail.bars`. Rollout's promotion path takes `MeasuredGrade` only, so
  promoting on any other grade is a compile error, and it refuses one at run time too.
- `ratchet report`: a `grade` column, an Evidence line per gate saying what the grade rests on,
  and `--min-estimated <n>` (default 30); `--json` carries the grade union as `gradeOf` returns
  it. `ratchet check`: a grade requirement, measured when any row in the window enforces and
  estimated while the gate is in shadow, printed on the line with why; `--require
  <measured|estimated>` overrides it, and `--min-estimated`. `CheckResult` gains `grade`,
  `require` and `requiredBy`. `ratchet trail`: each bar line ends
  with its grade, with `--target` (default 0.98), `--min-estimated` and `--trust`.
- Public API: `gradeOf`, `describeGrade`, `atLeast`, `GRADE_KINDS`, `wilsonInterval`, and the
  types `EvidenceGrade`, `MeasuredGrade`, `GradeKind`, `GradeOptions`, `BorrowedVia`,
  `ProfileProvenance`, `SourceCounts`, `FittedFrom`; `src/cli`: `GradedBar`.
- Calibration profiles (`src/ledger/profile.ts`, `profile-bins.ts`, `borrow.ts`): what one model's
  confidence meant on other gates' labelled rows, so a new gate can start in shadow from a
  borrowed bar. `buildProfile(rows, key, opts)` reads labelled unselected rows of trusted
  sources that the key's exact model answered alone (strategy single), for one question kind and
  optionally one rubric, into equal-width confidence bins per donor gate. The bar per target is
  the cautious end: the lowest bin edge at which every donor gate with `minSupport` (30) rows in
  its tail (every row at or above the edge) clears the target on that tail by a 95% Wilson lower
  bound. On one gate that is the bar `fitThreshold` keeps in its conservative mode, so a borrowed
  bar and a fitted bar mean the same thing; across gates it is the strictest donor's bar, since a
  profile is lent to gates its donors are not. Levers: `targets` (`PROFILE_TARGETS`: 0.9, 0.95,
  0.98, 0.99), `minSupport` (30), `resolution` (100 bins, 1
  to 1000, stored on the profile and hashed), the trust filter, and `ledgers` (named in the
  donor). `mergeProfiles` adds bins exactly (commutative, associative, equal to one build over
  every row) and refuses different keys, `minSupport` or resolution, or a ledger named by both.
  `borrowedBar`, `gateBars`, `coarseBins` (bins regrouped for reading), `profileVia`,
  `profileHash` (key, levers, bars and bins), `profileMatches` (exact model, kind, and rubric
  when keyed: how a profile expires), `profileAge`, `profileFrom`, and `parseProfile`, which
  refuses a profile whose provenance, bars or hash are not what its bins give.
- `policyFromProfile(profile, target, opts)`: a hashed `GatePolicy` through `policyWithBand`,
  half-width 0.05 by default, so it acts at the band's upper edge, the borrowed bar plus 0.05;
  throws when the profile has no bar. `GateSpec.barSource?: { profileHash }` records where the
  bar came from, and the engine writes it into `detail` on every row of that gate.
- Borrowed grades from profiles: `EngineOptions.profiles`, and `--profile <file>` (repeatable) on
  `ratchet report`, `check` and `trail`, with `--min-support` (30) on `check` and `trail`. A gate
  with no fitted bar of its own is graded borrowed (when nothing stronger exists) from the first
  profile matching its model pin (a rollout's pinned model, `check --model`, else the model of
  its newest answered row), question kind and rubric; `borrowFor` decides. A gate whose rows name
  a `barSource` borrows only that profile, and once it no longer matches the key its grade
  carries `stale: true` and prints `borrowed (stale)` (`gradeWord`, `GradeOptions.stale`).
  `LedgerReport.profiles` and `Trail.profiles` list what was offered; trail sections say `bar
  borrowed from profile <hash>`.
- `ratchet profile build <ledger...> --model --kind [--question-hash] [--target ...]
  [--min-support] [--resolution 100] [--trust ...] [--out]`, `ratchet profile show <file>
  [--json]` (bins grouped into tenths in the text; the JSON keeps every one) and `ratchet
  profile merge <a> <b> ... --out`; exit 2 on a usage error, an unreadable ledger or profile, no
  rows to read, or profiles that cannot be merged.
- `bun run profiles` (`scripts/profiles.ts`) regenerates `profiles/*.json` and
  `profiles/README.md` from the live ledgers under `experiments/out/` (BoolQ and BANKING77, Jev
  and Haiku), and prints what it skipped when they are absent. `profiles` joins the package's
  `files`. The shipped profiles lend at 90% only: Jev on BoolQ (judge) 0.56, resting on 289 rows,
  and Haiku on BoolQ 0.60 on 211; nothing at 95%, 98% or 99%, because Jev's negated BoolQ frame is
  110 of 113 right at 0.95 and above (Wilson 0.925) and Haiku is 138 of 145 there (0.904). Jev on
  BANKING77 (pick) lends nothing: it is right 87 to 89% even at 0.98 and above.
- `hookGateSpec(harness, { profile })`: the agent-tool gate can start from a judge profile
  (`policyFromProfile` at its 98% promise, with `barSource`); without one it is unchanged.
- Public API: `buildProfile`, `mergeProfiles`, `borrowedBar`, `gateBars`, `coarseBins`,
  `profileVia`, `profileHash`, `profileMatches`, `profileAge`, `profileFrom`, `parseProfile`,
  `borrowFor`, `policyFromProfile`, `gradeWord`, `PROFILE_TARGETS`, and the types
  `CalibrationProfile`, `ProfileKey`, `ProfileBin`, `ProfileBar`, `ProfileOptions`, `ProfileParts`,
  `ProfileGate`, `GateBar`, `Borrowing`, `BorrowOptions`, `ProfilePolicyOptions`, `HookGateOptions`;
  `src/cli`: `profile`, `readProfile`, `renderProfile`, `OfferedProfile`.

### Evidence

- New gates `agent.tool.claude-code` and `agent.tool.codex`, evidence version `agent-tool-v1`,
  placeholder bar 0.95 until a fit phase freezes one. Same promise and plan as the keywork
  gate. No existing gate's evidence changes.
- Rows gain optional `members` and `detail` fields. Nothing reads them for calibration,
  fitting, rollout or spend, so no gate's evidence, bar or promise changes; older ledgers load
  as before and print the pooled verdict alone in `trail`.
- Rows gain `key` on every recorded member and `settled` on the member that settled the run;
  `JsonlLedger` fills `key` on members written before it. Only `memberCorrelation` and `trail`
  read them, so no bar, promise or acceptance verdict moves.
- Labels are read by the trust class of their source. Defaults for rows without a source are
  unchanged, as they are for the sources this repository already writes (`review:blind`,
  `keywork:person`, `<harness>:person`): every count, fitted bar, acceptance verdict and plan
  hash is what it was. What changes: a `moment` label (`desk:assisted`) no longer fits a bar or
  feeds acceptance, though it still counts in `labelled`, accuracy and calibration; a
  `consequence` label (`accepted:*`, `reverted:*`, `silence:*`) is read by nothing but the
  `consequence` count. A planned-sample act whose only label is untrusted stays in the sample
  and holds it at `awaiting-labels` until a trusted label arrives. Reclassifying a source with
  `labelTrust` or `--trust` changes a gate's evidence: bump its `evidenceVersion`.
- The evidence grade reads the ledger and changes nothing in it: no bar, plan hash, checkpoint,
  acceptance verdict or rollout reason moves, and every existing figure in `report`, `check`
  and the engine's reports is computed as before. The one spelling that moves: `check`'s
  `ece.from` (`CheckResult` from `checkGate`, the object behind the printed line) is `"all"`
  instead of `"labelled"` when ECE falls back to every labelled row, as `fittedFrom` already
  spelled it; the printed line still says "labelled rows".
- Calibration profiles move nothing for a gate without one: no bar, policy hash, plan,
  checkpoint or grade changes unless a profile is offered (`EngineOptions.profiles`,
  `--profile`), and then only a gate with no fitted bar and no estimated or measured grade
  reads as borrowed, which never passes `check` and never promotes. A gate built with
  `policyFromProfile` has a new policy hash, which is the intended freeze point: its rollout
  starts a fresh phase. Its rows gain `detail.barSource`, which nothing reads for calibration,
  fitting, acceptance or spend; a single row of such a gate now carries a `detail`, as only
  compound and battery rows did before.

### Changed

- `ratchet check` fails a gate whose evidence is weaker than its mode requires: an enforcing
  gate (any enforce row in the window) without a measured grade, or a shadow gate with fewer
  than `--min-estimated` (30) labelled unselected rows. Both used to pass on the window's figures
  alone, the second as "not judged". The line says which requirement applied and why;
  `--require` overrides it. `--promise 1 --require measured` is a usage error, since no finite
  sample bounds a promise of 1.
- `memberKey` lives in `compound.ts` (members are a compound concept); the ledger imports it.
  The public export is unchanged.
- The CLI prints nothing when a command's output is empty, so a hook's stdout stays clean.
- The README imports from the package.
- `ratchet report`'s fitted-bar computation moved to `fitGroup` in `src/cli/common.ts`, which
  `check` and `trail` now share to decide whether a gate has a bar of its own; its figures are
  unchanged. `scripts/` is type-checked and linted with the rest of the repository.

## 0.2.0-alpha.1 (2026-10-24)

First published prerelease. Everything below already existed in the source checkout; this
entry describes what the package ships and what it does not promise.

### Ships

- `Engine` and `Gate`: a gate is one decision point with its question, policy, floors,
  rollout contract and ledger slice.
- `State` builder keeping trusted fields, digests and untrusted spans apart.
- Policy from a probability to act, review or refuse, bounded below by floors (`refuseIf`,
  `reviewIf`, `reviewUnless`, `oneWayDoor`, `forQuestion`).
- Four compounding strategies (ensemble, sequential, cascade, chain) and learned composition.
- Ledger (`MemoryLedger`, `JsonlLedger`), labels, calibration (ECE, Brier, reliability bins),
  pairwise error correlation, and threshold fitting on unselected rows only.
- Rollout with one planned acceptance test (exact one-sided 95% bound) and blind audits.
- Oracles: System One wire format (Jev via TypeSafe or OpenRouter), an LLM-JSON adapter,
  a rules oracle and a seeded simulated oracle.
- Recipes (`screen`, `digest`, `loop`, `speculate`) that take an `Engine` or a `Gate`.
- CLI `ratchet report | check | replay | review`.

### Runtime

- ESM only. Node 22.14 or later and Bun 1.3 or later. Zero runtime dependencies.
- The library is server-side: the ledger uses `node:crypto` and `node:fs/promises`, and
  hosted oracles read `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` from the environment.
- The CLI is emitted with a Node shebang and also runs under `bunx`.

### Limitations to read before relying on it

- Rollout promotion is an empirical test under stated assumptions, not a certification of
  future traffic. With audits off nothing can demote a promoted gate.
- Observed accuracy is not a safety guarantee. Do not make this the sole basis for
  consequential decisions about people.
- Hosted backends run on your own key under your own provider agreement; see
  `docs/third-party-terms.md` in the repository.
- The arcade and the experiments are not part of the package.
