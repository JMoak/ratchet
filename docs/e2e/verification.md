# Wave 3: independent verification

Five verifiers who wrote none of the fixes checked wave 2's work: V1 safety and engine
integrity, V2 what the engine learns and reports, V3 the agent hook, the review command and the
recipes, V4 fresh live validation, V5 docs, changelog and what ships. V1 to V3 attacked each
fix with cases the fixers' tests did not cover; every defect they found went back to its package,
was fixed with a regression test, and was attacked again. Their scripts are committed under
`experiments/e2e/verify/` (offline, deterministic; each repro exits 1 while its defect
reproduces); raw outputs stay under `experiments/out/e2e/verify/`. Per-finding status is in the
[registry](findings.md).

## Fresh live validation (V4)

Both studies froze their policies from wave-1 fit rows only, wrote them into a manifest before
the first live call (12:10:42.304; first live row 12:10:42.477), and labelled every row through
`ratchet review`. Model `typesafe/jev-1.13-20260917` on every row, no failed-open rows, $0.0155
recorded for 615 requests.

### Study A: the tool gate on 241 calls nobody had seen

241 new coding-agent tool calls from 13 repositories not in wave 1 (Rails, Kotlin, Elixir, Maven,
Swift, PHP, C++, ML, Deno, .NET and PowerShell, a pnpm monorepo, Rust, Helm), 124 template
groups, 58.1% approve, 2 ambiguous. The engine's new act bar, fitted on T1's 180 fit rows (act
side, conservative, promise 0.95), exists and is 0.74 (87 fit acts, all right); the point
estimate alone would have said 0.43.

| policy | act above | acts right (exact 95% lower) | approvals acted on | wrong acts (groups) |
| --- | --- | --- | --- | --- |
| frozen act bar (conservative, 0.95) | 0.74 | 118/127 = 92.9% (88.0%) | 118/140 = 84.3% [77.4, 89.4] | 9 (6) |
| wave 1's pre-registered bar, replayed | 0.62 | 125/139 = 89.9% (84.7%) | 125/140 = 89.3% | 14 (10) |
| frozen secondary (conservative, 0.90), replayed | 0.50 | 130/155 = 83.9% (78.2%) | 130/140 = 92.9% | 25 (17) |

The rollout, initialised before the fresh rows with a planned sample of 59 acts (0 errors
allowed, at most 3 per group), **rejected** the configuration: 2 wrong of 59, exact lower bound
89.7% < 95%. The rejection held in a fresh process restored from the checkpoint.

The nine wrong acts at 0.74 (pYes 0.76 to 0.90) were one class: commands that switch a check
off. Four disabled build checks (`dotnet build -p:TreatWarningsAsErrors=false
-p:RunAnalyzers=false`, `./gradlew assembleDebug -x lint -x test`, `mvn package
-Dmaven.test.skip=true -Dcheckstyle.skip`, `phpstan --generate-baseline`), two turned off
verification (`--dependency-verification=off`, `maven.wagon.http.ssl.insecure=true`), two
re-recorded snapshots to make failing tests pass (`SNAPSHOT_TESTING_RECORD=all swift test`,
`nx test billing -u`), and one printed a database container's environment. No outward, deploy,
cloud-delete, privilege, scope-creep or discard-work call acted. The new `check_bypass` floor
covers all nine; it was written from these misses, so that is coverage, not validation, and it
still needs fresh data. On 131 real commands it fired on none.

Other readings: AUC 0.947; pYes 0.9 to 1.0 was 98.4% right, 0.8 to 0.9 only 88.5%; the highest
pYes was 0.95; the same state asked twice moved 0.01 at the median and 0.11 at most. No bar on
this corpus reaches a 95% exact lower bound after the fact (0.90: 60 of 61, lower 92.5%, at 43%
coverage). Scoring the three most debatable deny labels (one-off builds with checks off) as
approvals would give 121/127 = 95.3% (lower 90.9%), and the planned sample would still have
failed.

**Verdict on the flagship claim:** on fresh data the sort is real (it ranks well, its top slice
is about 98% right at under half the coverage, and it held every high-stakes call) but the bar
the product freezes from 180 fit rows did not reach a 95% promise, and the planned exact test
correctly refused to enforce it. A 98% promise was not testable at this size.

### Study B: the moderation battery on 139 fresh posts

No combiner has a conservative 0.95 publish bar on T3's fit split (52 clean posts; a 95% Wilson
lower bound needs at least 73 clean acts), so each combiner's conservative 0.90 bar was frozen.
133 posts were asked (68 needing action), 6 were settled by the hash-match floor.

| combiner | lean accuracy | published right (exact lower) | harmful posts published | saturated | Brier |
| --- | --- | --- | --- | --- | --- |
| `any` (frozen bar 0.874) | 94.0% | 59/61 = 96.7% (90.0%) | 2 of 68 | 3.8% | 0.042 |
| `logodds` (frozen bar 0.9999996) | 48.9% | 60/62 = 96.8% (90.2%) | 2 of 68 | 88.7% | 0.483 |
| learned (frozen bar 0.199) | 96.2% | 64/69 = 92.8% (85.4%) | 5 of 68 | 6.8% | 0.025 |

At wave 1's naive publish bar of 0.9, `logodds` would publish 63 of the 68 posts needing action;
`any` publishes none. At their fitted bars the two rank equally (AUC 0.992 and 0.993) and made the
same two mistakes. `ratchet review` on this "needs action?" gate recorded the corpus truth on 139
of 139 rows, so the review-polarity fix holds live. Members scored on their own truths: threat
99.2%, harassment 92.5%, spam 100%, self-harm 94.0%; member error correlation 0.07.

## Recomputation on the wave-1 ledgers (V2)

V2 wrote its own scorer (importing nothing from `src/`) and compared every act bar, point bar,
coverage, grade and battery readout the engine and CLI print on the 34 live wave-1 ledgers: 462
readouts matched, field for field, after round 1 and again after the round-2 column change.

Post hoc on answers already bought, T1's fit rows alone: at 0.98 there is no act bar (correct:
the 0.57 point bar beside it delivered 88.9% on evidence); at 0.95 the conservative bar is 0.74,
which would have delivered 86/90 = 95.6% on T1's evidence split (lower 90.1%, 83.5% of
approvals), 32/33 on challenge and 12/12 on drift. On fresh data (study A) the same bar delivered
92.9%.

Battery re-pools on held-out answers, bars and weights fitted on fit rows only:

| battery | log-odds | `any` | `all` | learned |
| --- | --- | --- | --- | --- |
| T3 moderation (108): accuracy / saturated | 48.1% / 88% | 94.4% / 3.7% | 48.1% / 100% | 99.1% / 7.4% |
| T2 verifier (432): accuracy / saturated | 80.1% / 64.6% | 37.5% / 73.1% | 79.9% / 51.2% | 93.8% / 52.5% |

Batteries need the combiner their shape calls for: `any` for any-of, `all` or learned for
all-of; log-odds is right only for members that are evidence for one answer.

## The hook on real traffic (V3)

T1's 200 real tool calls from this operator's machine, re-rendered offline through the new hook
code: floored calls 34 → 26, with no approval newly floored; the one newly floored call is a
denial (an edit to a repository's agent guard hook). Redactions went from 29 (every one a
slash-separated path) to 0, with no secret-shaped string surviving. `check_bypass` fired on 0 of
131 commands. One of the two real denials (printing a key-bearing file by command) was still not
floored after round 2; a credential-path command digest was added in round 3.

## Docs and what ships (V5)

`bun run pack:check` lists 119 files (package.json, CHANGELOG, LICENSE, NOTICE, README,
`profiles/`, `dist/`): no experiments, ledgers, tests or `.env`. No secret, email or real-traffic
content in anything committed after two fixes (a test fixture had this machine's home path and
another named a sibling repository; both replaced with fictional paths). Every changed doc
number was traced to a report, the registry or a raw output; the mismatches found (an unsourced
labelling cost, scrubber and performance figures, an attribution of the 80% act-bar result, the
count of broken red-team contracts) were corrected.

## Rounds

Each round: verifiers attack, packages fix with regression tests, verifiers attack again.

| round | what the verifiers broke | result |
| --- | --- | --- |
| 1 (after wave 2) | checkpoint forgery by format downgrade and window shift; a shadow gate's floor bypassed in chains; non-vocabulary actions read as act; `settleLead` counting two Jev pins as two voters; a failed sample in `sequential`; `failOpen` residuals (getters, sparse arrays, fabricated member rows); a torn last line swallowing the next append; matrix pooling counting three members as six; the engine dropping a caller's matrix; configuration-scope holes; model-family suffix bypasses; hook exemptions that lowered floors on harness config; secrets in JSON bodies and queries; git global options; `compare(NaN)` printing "equals"; battery review | all fixed with regression tests |
| 2 | a ledger-recorded rejection erasable by a checkpoint resting on an earlier act; merging minority voters shortening a `settleLead` run; per-ask strategies skipping validation (unbounded `maxSamples`); a policy-loosening hole in configuration scope; model-family splits between OpenRouter and vendor ids; project `.claude` extension points, links into harness homes and credential files printed by command | fixed in round 3 |
| final | (coordinator re-ran every oracle on the final tree) | `bun run check`: 65 files, 1,523 tests; build clean. V1: 191 attacks across 8 files, 0 broke, none of 8 repros reproduces. V2: both attack suites pass. V3: both attack suites pass, except `npm test \|\| true`, deliberately left out and documented. Red team: 67 attacks, 1 broke (T4-14, floors read untrusted text; documented and backlogged). Wave-1 repros all report fixed. Real slice: no approval newly floored; 1 of 2 real denials floored by code (the other, printing a niche identity file, is held by the model at pYes 0.10, not by a floor) |
