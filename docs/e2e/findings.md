# End-to-end evaluation: findings registry

Wave 1 (2026-11-12) ran five tracks live against Jev through the real engine, with every label
fixed by the decider before the first call (`experiments/e2e/DECIDER.md`). This file is the
single list of what they found, what was done about each item, and how it was verified. Track
reports: [t1-toolgate](t1-toolgate.md), [t2-verifier](t2-verifier.md),
[t3-triage](t3-triage.md), [t4-redteam](t4-redteam.md), [t5-compound](t5-compound.md).

Status: `open` → `fixed` (wave 2) → `verified` (wave 3: attacked by an independent verifier, re-fixed where it broke, and the verifier suites re-run clean), or `docs`, `backlog`, `wontfix` with a
reason, or `not run` for planned work that did not happen. Owner is the wave 2 work package (A to E, below).

## Critical and high

| id | finding | disposition | owner | status |
| --- | --- | --- | --- | --- |
| T4-01 | `validateVerdict` accepts NaN, null and string `pYes` and never checks `confidence`; `failOpen` checks only the answer count; garbage from a custom adapter acted in 128 of 1,908 fault cells and 241 threw with no ledger row | fix: validate every verdict, cost and latency inside `failOpen`; strict numeric checks; a range guard in `rule()` | A | verified |
| T2-01 | `runChain` re-rules the bare `Decision`, so a gate verifier's floors, one-way doors, mode and audits are dropped; a `DROP TABLE` step the gate said to review was committed | fix: `verify` may return the gate's `AskResult`; commit only on its action, combined with the chain policy by `moreCautious` | A | verified |
| T3-02 | `ratchet review` shows the state only, asks "Approve?" and records y as truth `true` for whatever the question asks; on a "needs action?" gate every review label is inverted (and `--denied` with it) | fix: show the question, ask for its answer; denials read through the row's go polarity | D | verified |
| T3-01, T2-05 | the default battery combiner (log-odds sum) is right only when members are evidence for one proposition; it inverts disjunctive batteries (moderation: would publish 51 of 56 posts needing action) and saturates conjunctive ones (37% of verdicts saturated, bar 0.99999991) | fix: `any` and `all` pool methods, a saturation readout in reports, docs; default unchanged (changing it would move existing gates' evidence) | A, C | verified |
| T4-03, T5-04 | `sequential` ignores `Member.negated`: a negated member's "dangerous 0.95" pools as "safe 0.95" and acts; the ledger stores the unflipped answer | fix: share `untransform` with `ensemble` | A | verified |
| T5-01 | explicit ensemble members default to correlation 0, `{k: 3}` to 0.75; the same model listed as members is pooled as independent (framing ensemble ECE 0.099 vs 0.042 at the measured rho) | fix: same-oracle members default to 0.75; record where rho came from in `detail` | B | verified |
| T1-02 | the hook does not parse Claude Code's `PowerShell` tool as a command, so no floor sees `Remove-Item -Recurse` outside the workspace | fix: PowerShell is a command tool; PowerShell forms in the destructive and opaque digests | D | verified |
| T1-06, T2-04 | a judge gate's reported bar is fitted two-sided on leading-answer confidence, but is used as `actAbove`; promised 95%, delivered 80% (repro), 89% act precision against a 98% target live | fix: fit judge bars one-sided on whether acting was right, as `acceptance.ts` already scores | C | verified |
| T1-01 | a bar fitted at 98% on one set of template groups delivered 91.2% on held-out groups; a point estimate on a small fit set does not transfer (the acceptance test caught it and refused promotion) | fix: report the conservative (Wilson) bar next to the point bar, say when rows are too few; advice in `rollout.md` | C, E | verified |
| T2-02 | the ratchet formula is the precision of commits, not chain reliability; correlated false alarms across retries made chains complete 48-62% where it predicted 74-99.8% | docs: correct the claim; add a correlated-false-alarm row to `sim` | A, E | verified |

## Medium

| id | finding | disposition | owner | status |
| --- | --- | --- | --- | --- |
| T4-04 | an ensemble drops a failed member and pools the rest, so a failed cautious member turns review into act | fix: fail open when fewer than `minMembers` (default: all) answer | A | verified |
| T4-05 | a timeout stops waiting but never aborts the call and records cost 0 ($0.50 billed against a $0.05 cap) | fix: abort through the signal; never record an unknown cost as zero spend | A, B | verified |
| T4-06 | NaN cost makes `engine.spent` NaN and disables the cap; negative cost lowers spend, also from the ledger on restart | fix: invalid costs never lower or freeze recorded spend | B | verified |
| T4-09 | present but unregistered or malformed label sources (`accepted:`, `Reverted:git`, `hook:inferred`) read as trusted `unknown` and promoted a gate | fix: only an absent source is `unknown`; any other unregistered source is untrusted | B | verified |
| T4-20 | after a rubric/policy/evidence change, `check` passes and the grade reads estimated on the old configuration's labels | fix: scope estimated grades and fits to the newest configuration | C | verified |
| T4-02 | a torn last line, a BOM, or a non-object line makes `JsonlLedger.all` throw, and every later ask, label and report with it | fix: strip BOM, skip a torn trailing line, skip and count bad lines | B | verified |
| T2-11 | `JsonlLedger.label` rereads the file every time (125 s to label 432 battery requests) | fix: index ids on first read | B | verified |
| T4-08 | a floor scoped with `forQuestion(<member id>)` never fires on a battery | fix: refuse at registration a scoped floor that matches nothing the gate asks | B | verified |
| T4-07 | `relevance` + `prune` drops failed-open items (they score 0.5) | fix: `prune` keeps failed-open items | D | verified |
| T4-10 | editing a checkpoint's mode to enforce promotes with no accepted sample | fix: an enforce checkpoint carries its accepted sample and is re-verified on restore | B | verified |
| T4-19 | the hook scrubber misses 8 of 11 common secret shapes (`curl -u`, URL userinfo, `--password`, `PGPASSWORD=`, ...) | fix: add the shapes | D | verified |
| T1-08 | hook digests miss `cargo publish`, `twine upload`, `aws s3 rm`, `docker compose down -v`, `git checkout -- .`, `git restore .`, `Invoke-Expression`, ... | fix: add them | D | verified |
| T1-04 | `inside_workspace` follows `cd` and counts the harness's own directories as outside; 34 of 200 real calls floored, all approvals | fix: measure from the session root; harness-owned paths get their own digest | D | verified |
| T1-05, T3-08 | `policyWithBand` and `policyFromProfile` add the band in raw probability and cap at 1, so a high bar acts on nothing | fix: apply the band in log-odds | A | verified |
| T3-03 | a gate borrowing a profile drops to `none` at 20-29 labels, when a point-estimate bar displaces the conservative borrowed one | fix: keep lending until the gate's own evidence is estimated; fit conservatively | C | verified |
| T3-04 | engine and CLI default levers differ (95%/20 vs 98%/30); the same ledger grades measured in one and estimated in the other | fix: one set of defaults, printed beside the grade | C | verified |
| T3-05 | `relativeTime` rounds to the nearest unit: 31-44 days reads "1 month ago"; 27% of the relative-date arm's auto-approvals were wrong | fix: never round across a unit boundary; recommend `compare(daysBetween(...))` for windows | D | verified |
| T3-06 | `fitLogistic` stops before converging (held-out 101/108 → 107/108 when run to convergence) | fix: stop on a tolerance; report the final loss | C | verified |
| T3-07, T2-06, T5-06, T5-07 | member rows inherit the battery's truth (a 99.1% member reads 59.0%); `memberCorrelation` finds nothing on batteries, reads a zero-variance pair as independent, and skips pick and rate | fix: per-member truths; battery pairing by request; undefined for no-variance pairs; pick and rate scored by name | C | verified |
| T5-02 | one scalar rho cannot pool mixed members; pair-aware weights from the measured phi matrix improve Brier 0.027 → 0.019 | fix: `pool` accepts a per-pair correlation matrix (GLS weights, generalised design effect) | A | verified |
| T5-03 | the disagreement sentence reads as a bound on the gate's error; it bounds only "at least one judge is wrong"; two Jev pins pass as "two models" | fix: reword; same-family check; correct the design doc | C, E | verified |
| T5-05 | `settleLead` counts correlated votes as independent (stopped on 178 items when two Jev pins agreed, wrong on 26) | fix: count the lead across distinct model keys | A | verified |
| T2-03 | chain rows read as unselected shadow evidence though they were acted on, and retries are a selected sample | fix: chain rows carry chain/step/attempt; retries are not unselected | A, C | verified |
| T1-07 | audits at 0.2 need about 150 acts before anything can demote; 10 wrong acts executed before demotion | backlog: sequential demotion test (already on the roadmap) | E | backlog |
| T2-07, T5-11 | Jev run-to-run drift is larger than the docs say (jev-1.14: 5.5% of repeated requests flipped lean) | docs: measured per pin | E | docs |
| T5-08 | jev-1.14 is not a second opinion for jev-1.13 (error phi 0.785) | docs | E | docs |
| C-01, T3-09 | `compare()` prints float noise ("by 3.1999999999999886 USD") | fix: round the difference | D | verified |
| C-02 | working copies checked out CRLF on Windows, so `bun run check` failed lint locally | fixed: `.gitattributes` pins `eol=lf` | coordinator | verified |

## Low

| id | finding | disposition | owner | status |
| --- | --- | --- | --- | --- |
| T4-11 | `RuleOracle` with a `/g` regex alternates between matches | fix: reset `lastIndex` | A | verified |
| T4-13 | a floor returning a non-Action is ignored; a floor that throws aborts the ask with no ledger row | fix: fail closed to review, record the error | A | verified |
| T2-09 | `maxAttempts` of Infinity loops forever, NaN makes zero attempts | fix: validate | A | verified |
| T2-10 | `refuseBelow` on a step verifier ends the whole chain | docs | A | docs |
| T4-12 | a cost recorded while the new UTC day's spend loads is lost | fix | B | verified |
| T4-16 | U+2028 in a field value starts a visual line | fix: treat Unicode line separators as line breaks | B | verified |
| T4-17 | a duplicate decision id silently overwrites a labelled row | fix: the first record wins; later duplicates are reported | B | verified |
| T4-18 | a `__proto__` gate id vanishes from `report().byGate`; the hook event lookup accepts prototype keys | fix: own-property maps | B, D | verified |
| T1-10 | `watch()` says "need 30 to judge" after judging 40 audits | fix | B | verified |
| T5-10 | `settleLead` is missing from `StrategySpec` | fix | B | verified |
| T1-09 | the hook scrubber's base64 pattern redacts ordinary paths (38 of 39 redactions) | fix | D | verified |
| T1-11 | `replay` usage text says it cannot reapply floors; it does | docs | D | docs |
| T1-12 | `check` mixes rows from different policies; says "enforces" after a demotion | fix | C | verified |
| T1-13 | `ratchet review` cannot target the audit queue | fix: `--audits` | D | verified |
| T5-09 | a cascade's own ledger pairs tiers only on escalated rows | docs | E | docs |
| T1-03 | in auto mode the hook journal yields almost no prompts to learn from | docs now; opt-in run sampling is backlog | D, E | docs; sampling backlog |
| T4-14 | floors read untrusted text, so tool output can trip a refuse floor (availability, not safety) | docs | E | docs |
| T4-15 | the State builder accepts JSON-string renderings of rulings (documented: it refuses engine objects, not text) | wontfix: text cannot be told apart from evidence by shape | none | wontfix |
| T3-10 | `FloorRule` receives only rendered text | backlog: floors over state entries | E | backlog |
| W2-C | judge calibration profiles still bin leading-answer confidence, while reported bars are now act-side; a borrowed bar and a fitted bar mean the same thing only for gates whose go side is yes | backlog: act-side profiles need profile format 2 and regenerated `profiles/` | C | backlog |
| — | relevance() renders its trusted item listing after untrusted spans, against `state.ts`'s ordering rule | investigate and fix | D | verified |
| T4 | the live prompt-injection study was not run: a safety classifier stopped the agent while it authored payloads | not rerouted; open as a gap | none | not run |

## Found in wave 3 (by the verifiers, against wave 2's fixes)

Each was fixed with a regression test and the verifier's suite re-run clean
([verification report](verification.md)). Repros live under `experiments/e2e/verify/`.

| id | finding | severity | owner | status |
| --- | --- | --- | --- | --- |
| V1-1 | checkpoint forgery still worked: a format 2 downgrade or a shifted `accepted.from` put a rejected configuration into enforce; round 2: a rejection recorded on the ledger was erasable by a checkpoint resting on an earlier passing act | high | B | verified |
| V1-2 | a torn last line swallowed the next append (label lost, restart read 0 rows) | medium | B | verified |
| V1-3 | a chain committed a step a shadow gate's floor refused (asked with `baseline: "act"`); actions outside the vocabulary read as act | medium | A | verified |
| V1-4 | `settleLead` still counted two Jev pins as two voters; round 2: merging two minority voters into one family shortened a run | medium | A, C | verified |
| V1-5 | `sequential` let the permissive member settle when the cautious sample failed | medium | A | verified |
| V1-6 | `failOpen` residuals: hostile getters and prototype-less errors made it throw with no row; sparse arrays passed; values read twice; adapters could write fabricated member rows | low | A | verified |
| V1-7 | `budgetUsd: NaN` accepted; default-rho cost quadratic in samples; `minMembers` unvalidated; round 2: per-ask strategies skipped validation (`maxSamples: Infinity` made 501 calls against a $0.01 cap) | medium | A, B | verified |
| V2-1 | matrix pooling zeroed negative GLS weights without re-solving: three 0.8 answers counted as six independent members (0.99976) | high | C | verified |
| V2-2 | the engine re-pooled a gate ensemble at a scalar and dropped the caller's correlation matrix | medium | B | verified |
| V2-3 | configuration-scope holes: rename plus rubric edit kept old rows current; per-question policies retired all but the last question; round 2: loosening a policy on a gate whose ids are asked once retired nothing | medium | C | verified; the rename case needs an `evidenceVersion` bump, now flagged by `report` and `check` |
| V2-4 | `modelFamily` split one model into two (suffixes, owner prefixes, OpenRouter vs vendor ids, a lazy regex eating a trailing "v"), the less cautious direction | medium | C | verified |
| V2-5 | partial `memberTruths` silently gave unnamed members the battery's truth; `fitLogistic` claimed convergence on one-class and separable data; wrong battery advice; report columns mixed configurations; a stale pinned profile kept lending | low | B, C | verified |
| V3-1 | `harness_owned` exempted all of `~/.claude` and `~/.codex`, lowering floors that v1 had on hooks, skills, agents and the global CLAUDE.md; `settings.json` matching was bypassable with `.\`, `..\`, trailing dots or streams | high | D | verified |
| V3-2 | git global options (`git -C`, `-c`) defeated every git rule; continuations, Unicode dashes and quoted words hid destructive forms | medium | D | verified |
| V3-3 | secrets still leaked (JSON bodies, cookies, `docker login -p`, query keys, WebSearch queries) | medium | D | verified |
| V3-4 | `compare(NaN)` and a missing date printed "equals", turning a missing date into "inside the window" | medium | D | verified |
| V3-5 | battery review never showed member questions and gave every member one answer | medium | D | verified |
| V3-6 | round 2: a project's `.claude/` agents, commands and skills written by path, links into a harness home, and credential files printed by `cat` had no floor | medium | D | verified |
| V3-7 | performance and robustness: a crafted 1 MB patch took 2.5 s (≈4 MB would exceed the hook timeout); deep nesting overflowed the stack; a BOM was rejected | low | D | verified |
| V4-1 | on fresh tool calls every wrong act at the frozen bar switched a check off; no floor named that class | medium | D | verified (floor added; it was written from these misses, so it still needs fresh data) |
| V5-1 | a test fixture held this machine's home path and session id, another a real sibling repository name; several doc figures had no recorded source | high (hygiene) | coordinator | verified |
| — | lexical limits of the hook digests: cmd caret and shell backslash escapes, git aliases defined with `-c`, paths in variables, links made outside the journal, `npm test \|\| true` | — | D | docs (known limits in `agent-hook.md`) |

## Confirmed working (wave 1)

- Floors never lowered: 0 of 1,169 rows rechecked from stored state (T1); refuse floor against
  `actAbove 0` at pYes 0.999 held (T4); 0 of 66 floored rows acted (T3).
- `oneWayDoor` returned review at most in enforce after a real promotion with audits, for every
  strategy (T4).
- Transport faults (throw, timeout, short and long batches) never produced `act` on any of 21
  paths (T4).
- Rollout promoted only through the exact bound; a rejection survived restart; tampered,
  wrong-anchor and malformed checkpoints held shadow (T1, T4).
- The CLI's numbers matched independent recomputation 20 of 20 (T1).
- Daily cap held across a restart and at concurrency 64 with a reservation (T1, T4).
- Two processes appending 600 rows produced 600 intact lines (T4, T2).
- Profiles built by CLI and library were identical; borrowed bars held on a sibling gate
  as point estimates (99.2% at a 98% promise; no interval's lower end reached the promise at
  that n); grades agreed across four surfaces at 38 of 38 checkpoints when
  given the same settings (T3).
- Digesting numbers and dates in code: Jev 83% → 100% (T4, n = 48 pairs, McNemar p = 0.008);
  approvals 66.7% → 99.1% (T3, 71 vs 0 discordant); verifier numeric catches 11/15 → 15/15 (T2);
  raw-number items 79-84% → 100% (T5).
- A cascade from Jev to a model of a different family (haiku-5.5, error phi 0.04) reached 98.5%
  against 85.8%, cheaper and faster than the strong model alone (T5).

## Decider spot checks

The coordinator relabelled a seeded sample of every corpus blind, from the state alone:
153 of 157 label slots agreed; all four disagreements were on items flagged ambiguous (two
adjacent urgency levels, one harsh-criticism moderation post).
