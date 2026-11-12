# Changelog

All notable changes to `@jmoak/ratchet`. The API is experimental until 1.0: minor versions
may change exported signatures, and every change that affects a gate's evidence (rubric,
policy, strategy, state builder or model pin) is called out so you know when to bump an
`evidenceVersion`.

## Unreleased

Fixes and changes from an end-to-end evaluation: five tracks ran the engine live against Jev
on new scenarios with every label fixed before the first call, a red team attacked every
path, each defect found was fixed with a regression test, and independent verifiers attacked
the fixes (a second round fixed what they broke). Findings, evidence and status:
`docs/e2e/findings.md`; reports: `docs/e2e/`.

**Evidence changes.** Items marked **(evidence)** change what a gate records, pools, fits or
reports for the same traffic. Bump the gate's `evidenceVersion` after upgrading if it uses an
affected feature; the rollout reads a new phase either way when a policy hash changes.

### Fixed: failure never grants permission

- Malformed oracle answers fail open instead of acting **(evidence)**. `failOpen()` reads each
  answer once, by index, into a plain copy of the fields a decision has, and validates the copy:
  non-finite, null or out-of-range probabilities, a confidence that does not match the
  distribution, unnormalised pick or rate distributions, wrong, swapped, duplicated or missing
  answers, and an invalid cost or latency fail the batch open. Adapter-supplied `strategy`,
  `members`, `detail` and `agreement` are dropped, and no adapter can make `failOpen` itself
  throw. `validateVerdict` checks types strictly, and `rule()` treats a go value that is not a
  probability as failed open. In the red team's fault matrix, garbage had acted in 128 of 1,908
  cells and thrown with no ledger row in 241; both are now 0. Custom adapters were the
  exposure; the shipped Jev and LLM-JSON adapters already validated.
- `runChain` honours a gate verifier: `verify` may return the gate's `AskResult`, and the chain
  commits only when the gate acts and the chain's own policy agrees; the gate's floors bind the
  chain in every mode, including a shadow gate asked with `baseline: "act"` **(evidence for
  chains)**. Before, the chain re-ruled the bare decision, so a gate's floors, one-way doors,
  mode and audits were skipped.
- Actions outside the vocabulary (`"REFUSE"`, `"deny"`, `undefined`) are read cautiously
  everywhere they can arrive (floors, `onFailOpen`, gate actions in chains): a refuse-shaped
  word as refuse, anything else as review, never as act (`isAction`, `readAction`).
- `sequential` un-negates `negated` members, as `ensemble` does, and fails open when a sample
  fails (`maxFailedSamples`, default 0) **(evidence)**. A negated member's "dangerous 0.95" had
  pooled as "safe 0.95", and a failed cautious sample had let the permissive member settle.
- An ensemble with fewer than `minMembers` answers fails open; the default is every member, as
  for batteries **(evidence)**. A failed cautious member had turned review into act.
- A floor that throws or returns something other than an action yields review, with the error
  on the row; a battery combiner that throws or returns a p(yes) outside [0, 1] fails open
  **(evidence)**.
- A timeout aborts the underlying call, and its cost is marked `costUnknown`. Budgets charge
  unknown or invalid costs conservatively (the larger of `reserveUsd` and the costliest priced
  request, noted in `costEstimate`) and stop buying when no price is known. A NaN cost had
  disabled `budgetUsd` for the life of the process, and a negative cost lowered recorded spend.
  `budgetUsd` itself must be finite and positive. Sequential runs and cascades stop buying once
  the instance cap is spent partway through a request (ensemble members, started in parallel,
  can exceed it by their own combined cost).
- Label sources: a present source that is malformed or not registered (`accepted:`,
  `Reverted:git`, `hook:inferred`, `Review:blind`) is the new trust class `unregistered`, which
  fits, grades, promotes and counts in `labelled` nothing **(evidence)**. Only an absent source
  reads as `unknown`. Reports count and name such labels so a typo cannot make them vanish.
- Strategies passed on a single ask are validated like a gate's: an invalid one (for example
  `maxSamples: Infinity`, which had made 501 calls against a $0.01 cap) fails that question open
  with no call, and `sequential()` itself refuses non-integer or unbounded counts.
- Rollout checkpoints cannot be edited into enforce **(evidence)**. An enforce checkpoint
  (format 3) carries its accepted sample, and every restore re-derives a passing planned sample
  from the ledger; a format 1 or 2 enforce checkpoint is verified the same way and written back
  as format 3, else held in shadow. Any complete planned sample of the configuration that failed
  on the ledger blocks enforce, whichever sample a checkpoint rests on, so a configuration whose
  planned sample has failed stays rejected even if its checkpoint is lost or edited. Honest
  checkpoints of every format still restore; the cost, documented in `docs/rollout.md`, is that
  a wrong act collected while a sample awaited its labels can hold an honest promotion in shadow.
- `ratchet review` shows the gate's question and records the answer to it. It had asked
  "Approve?" and recorded yes as `truth: true` for whatever the question asked, inverting every
  label on a gate where yes is the bad outcome ("needs moderator action?"). On a battery it asks
  each member's question and records `memberTruths` (the battery's truth is their OR for `any`,
  their AND for `all`, else one more overall question). `--denied` reads each row's own go
  polarity.
- `relevance` renders its trusted item listing before the first untrusted span, as the state
  builder's rule requires **(evidence: the rendered state and its hash change)**; `prune` keeps
  items with no bought answer instead of dropping them.
- `RuleOracle` and `judgeIf` with a global (`/g`) regex no longer alternate between matching and
  not matching the same state **(evidence)**; `judgeIf` throws when built with a p(yes) outside
  [0, 1].
- `JsonlLedger`: an append after a torn final line starts on a new line instead of being lost
  inside the fragment.
- A cost recorded while a new UTC day's spend is loading is applied after the load instead of
  being lost.
- A gate id such as `__proto__` keeps its entry in `report().byGate` and `byQuestion`.
- `Rollout.watch()` prints the audited accuracy once enough audits exist, instead of "need N to
  judge" after judging them.

### Fixed: the agent-harness hook

All change the hook gate's evidence; `HOOK_EVIDENCE` is now `agent-tool-v2`.

- Claude Code's `PowerShell` tool is a command tool, so floors and digests see it
  (`Remove-Item -Recurse` outside the workspace had passed every floor). Codex `shell` argv is
  joined into one command.
- Commands are normalised before digesting (line continuations, Unicode dashes, quoted command
  words), and the destructive, opaque and upload digests are named, tested rule lists
  (`DESTRUCTIVE_COMMANDS`, `OPAQUE_COMMANDS`, `UPLOAD_COMMANDS`) that now catch package
  publishing (`cargo`, `twine`, `uv`, `npm`, `pnpm`, `bun`), `mkdocs gh-deploy`, `aws s3 rm`,
  `docker compose down -v`, `git checkout -- .`, `git restore .`, `git stash drop`,
  `vercel --prod`, `kubectl delete`, `terraform destroy`, `rimraf`, `[IO.Directory]::Delete`,
  PowerShell splatting, `Invoke-Expression`, encoded PowerShell, and git with global options
  before the verb (`git -C ../x push --force`).
- A new `credential` digest on commands and paths, floored to review (`CREDENTIAL_COMMANDS`):
  printing, copying or packing SSH keys, key stores, `.aws/credentials`, `.netrc`, `.npmrc`,
  `.git-credentials`, `.docker/config.json`, `.kube/config`, the harnesses' own tokens and `.env`
  files outside the workspace, whether by the Read tool or by `cat`.
- A new `check_bypass` digest, floored to review (`CHECK_BYPASS_COMMANDS`): commands that switch
  a check off, such as `--no-verify`, `HUSKY=0`, `LEFTHOOK=0`, `core.hooksPath`, `gradle -x test`, Maven `-DskipTests` and
  `-Dmaven.test.skip`, analyzers off, PHPStan and Psalm baselines, snapshot updates (`-u`,
  `--updateSnapshot`), TLS off (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, `GOFLAGS=-insecure`,
  `--trusted-host`, `-SkipCertificateCheck`), `--dependency-verification=off`, any Maven
  `-D…skip`, and environment dumps; quoted commit messages and filtered `env | grep` reads do
  not trip it. On fresh tool calls every wrong act Jev made was of this class.
- The secret scrubber removes `curl -u`, URL userinfo, `mysql -p`, values after `--password` /
  `--token` / `--secret` / `--api-key`, `PGPASSWORD=` and `*_PASS=` assignments, JSON secret
  keys, cookies, `sshpass -p`, `docker login -p`, URL query keys and more vendor prefixes, and
  scrubs WebSearch queries. It no longer redacts ordinary paths, commit hashes or `sk-` branch
  names (on T1's real slice, 38 of 39 redactions had been paths).
- `inside_workspace` is measured from the session's root (`CLAUDE_PROJECT_DIR`, else the first
  cwd). Under the harness's own homes (`~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`), only the scratch space and memory notes are `harness_owned` (never a path with a
  data-stream suffix); everything else there, a project's `.claude/` and `.codex/` extension
  points (agents, commands, skills, plugins, settings), `.mcp.json`, commands that write onto
  those files, and links created to a harness home are `harness_config`, floored to review,
  matched on the resolved path. Replay re-places paths journalled earlier and can only raise a
  journalled flag. A digest rule matches if it matches the raw or the normalised command. The
  digests are lexical; their known limits are listed in `docs/design/agent-hook.md`.
- Prototype keys (`__proto__`, `toString`) are not hook event names; a UTF-8 BOM on stdin is
  stripped; deeply nested input no longer overflows the stack. Digests and scrubbing are bounded
  per segment and per call, so a hostile megabyte is read in well under a second.

### Changed: what the engine learns and reports

- The reported bar is an act bar **(evidence)**: fitted on the probability that acting is right
  against whether acting was right, and conservatively (the lower end of a 95% Wilson interval,
  a one-sided 97.5% bound, at the promise), with the point bar beside it. A judge gate's bar had
  been fitted two-sided on the leading answer: used as `actAbove`, it delivered 80% against a
  95% promise in an offline repro, and 89% against 98% live. New report sections: "Act bars",
  "Batteries" and "Unregistered label sources".
- One set of report defaults, `REPORT_DEFAULTS` (promise 0.98, support 30, estimated 30), for
  `Gate.report()`, `Engine.report()` and the CLI **(evidence)**. The engine had used 0.95 and 20.
- Grades, bars, `check` and the calibration columns read only the current configuration
  **(evidence)**: rows whose evidence version matches the gate's newest, whose policy is one the
  gate's newest request used, and whose policy and rubric hashes are the newest recorded for
  their own question id. Older rows are counted in a new `older` column. `check` had passed a
  gate on a previous rubric's labels. Renaming a question is a new rubric: bump
  `evidenceVersion` (one per gate) to retire the old question's rows; `report` and `check` flag
  a question with current labels that the newest request did not ask (`strayQuestions`).
- A profile lends its bar until the gate's own evidence grades estimated **(evidence)**; a gate
  had dropped from borrowed to none at 20 to 29 labels. A borrowing is stale once the gate's
  newest answered row comes from a model other than the pin.
- Rows tagged `chain:attempt:<n>` with n ≥ 2 are not unselected evidence **(evidence)**.
- Ensemble and sequential correlation defaults follow voter identity **(evidence)**: members
  that share an oracle id or a model family (two pins of one model, such as jev-1.13 and
  jev-1.14) pool as replicas at 0.75, mixed panels in proportion. They had defaulted to 0,
  overconfident by the measured correlation. A caller's stated correlation or matrix always
  wins. `detail.rhoSource` records the choice.
- `settleLead` counts the leading answer's votes by model family and every other answer's by
  distinct model, so replicas and pins of one model never settle a lead and merging models into
  a family can only delay a stop **(evidence)**. A blank model name falls back to the oracle id
  (`voterModel`).
- `modelFamily` is deliberately coarse: the first name token after the owner prefix
  (`typesafe/jev-1.13` and `jev-1.14` are `jev`; `claude-haiku` and `claude-sonnet` are both
  `claude`) **(evidence)**. A false merge only adds caution (a higher default correlation, one
  vote in a lead, a refused second opinion); a false split would remove it.
- `policyWithBand` and `policyFromProfile` apply the band in log-odds past bar
  1 − 2 × halfWidth, so a high bar never becomes "act above 1" (acting on nothing)
  **(evidence: policy hashes change for those bars, including borrowed bars above 0.9)**.
- `fitLogistic` is Newton's method with a line search, stops on convergence and returns `loss`,
  `converged`, `iterations` and, when it did not converge, a `reason` (one class, separable,
  iteration cap, no descent); refits give new weights **(evidence)**. `learningRate` is ignored.
- The disagreement sentence says what it bounds ("at least one of the two judges is wrong on at
  least N%"), and two pins of one model family are refused as a second opinion.
- `check --min-support` sets the support of the act bar `check` now prints; `check` requires
  measured evidence only when the newest row enforces, and says so after a demotion.
- `relativeTime` never rounds up: days below 120 days, then whole months **(evidence for states
  that render it)**. Use `compare(daysBetween(...), window)` for policy windows. `compare`
  rounds the printed difference to the inputs' precision and says "equals" only for equal
  inputs; `compare`, `daysBetween` and `relativeTime` throw on a non-finite number or an invalid
  date instead of printing a comparison.
- State text: VT, FF, U+0085, U+2028 and U+2029 are line breaks **(evidence for states that
  contain them)**.
- A rule scoped with `forQuestion` to a battery member, which floors never see, is refused at
  gate registration; strategy parameters (`members`, `k`, `minMembers`, `maxSamples`,
  `maxFailedSamples`) are validated there (`checkStrategy`).
- `maxAttempts` of 0, NaN or Infinity throws.
- The CLI skips and counts ledger rows whose verdict numbers are not numbers, and names on
  stderr what any read left out.

### Added

- Battery pool methods `any` (noisy-OR) and `all` (noisy-AND) for disjunctive and conjunctive
  batteries; log-odds, still the default, is for members that are evidence for one answer.
  Reports flag a battery whose combined verdicts saturate.
- `Outcome.memberTruths` for per-member battery labels (a member a present map leaves out stays
  unlabelled); `memberCorrelation` pairs battery members by request, reads pick and rate
  members, leaves no-variance pairs undefined, and returns a per-pair `matrix`; `pool` takes
  per-pair `correlations` (non-negative GLS weights, never more confident than independent
  members) and the strategies pass member keys.
- `disagreement(rows)`, `modelFamily`, `scoredForAct`, `currentConfiguration`, `strayQuestions`,
  `describeStray`, `REPORT_DEFAULTS`
  and `src/ledger/bars.ts` (`gateEvidence`, `fitActBar`, `describeActBar`, `batteryReadout`).
- `chainTags(step, attempt)`; `EnsembleOptions.minMembers`; `SequentialOptions.maxFailedSamples`;
  `StrategySpec.settleLead`, `minMembers` and `maxFailedSamples`; `checkStrategy`; `isAction`,
  `readAction`; `voterModel`; `Decision.costUnknown`; `ratchet review --audits`;
  `CHECK_BYPASS_COMMANDS`, `CREDENTIAL_COMMANDS`, `HARNESS_CONFIG_COMMANDS`, `normaliseCommand`,
  `placePath`.
- `JsonlLedger` reads past damage: strips a BOM, ignores a torn final line until it is complete,
  skips and counts damaged lines (`health`, named by the CLI on stderr), keeps the first record
  of a duplicate id **(evidence: what reports read)**, and indexes ids so labelling no longer
  rereads the file (under 1 ms a label, flat, against 213 ms a label at 400 requests and
  growing). `scanJsonlLedger` is the tolerant reader.
- `experiments/e2e/`: the five evaluation tracks, the verification scripts, the decider's
  charter and a shared harness; `docs/e2e/` holds the reports and the findings registry.

## 0.3.0 (2026-11-09)

Promote the functionality in `0.3.0-alpha.1` to the default npm `latest` channel.
Update installation guidance and package status documentation for the release. Gate,
policy and evidence behavior is unchanged from the alpha; no `evidenceVersion` bump is
needed for this promotion. The API remains experimental until 1.0.

## 0.3.0-alpha.1 (2026-11-07)

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
