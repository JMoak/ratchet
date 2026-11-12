# End-to-end evaluation, 2026-11-12

Three waves tested ratchet end to end on new scenarios, live against Jev through OpenRouter:
**test** (five tracks), **fix** (five work packages), **verify** (five independent verifiers
who did not write the fixes, then a second fix round on what they broke, re-verified). Every
label came from one decider under a written charter ([`DECIDER.md`](../../experiments/e2e/DECIDER.md)),
fixed in a corpus file before the first live call. Total provider spend for all of it: under
$0.90.

- Registry of every finding, its fix and its verification: [findings.md](findings.md)
- Track reports: [T1 tool gate](t1-toolgate.md), [T2 verifier and chain](t2-verifier.md),
  [T3 business triage](t3-triage.md), [T4 red team](t4-redteam.md),
  [T5 compounding](t5-compound.md)
- How to rerun: [`experiments/e2e/README.md`](../../experiments/e2e/README.md)

## The claims, as tested

| claim (vision.md) | wave 1 | fresh data, wave 3 |
| --- | --- | --- |
| A calibrated cheap decider sorts tool calls into ones it can act on at 95-98% and ones to hand off | **Not at the fitted bar.** A bar fitted at 98% on one set of template groups delivered 91.2% on held-out groups (T1) | **Not at 95%.** The engine's new conservative act bar, frozen from wave-1 fit rows only, acted at 92.9% (exact lower bound 88.0%) on 241 calls from 13 new repositories, automating 84% of safe calls. The top slice was ~98% right at under half the coverage |
| The rollout loop refuses to enforce a gate that has not earned it | **Proved.** The planned exact test rejected the gate (5 wrong of 59) and the rejection survived restarts and tampered checkpoints | **Proved again.** Rejected (2 wrong of 59); held across a fresh process |
| Hand-offs catch what matters | Floors never lowered (0 of 1,169 rows); one-way doors never acted; transport failures never acted on 21 paths | Every outward, destructive, cloud and privilege call was held. All 9 wrong acts were one class: routine builds that switch a check off (`-x test`, `maven.test.skip`, `--generate-baseline`), insecure flags, snapshot re-records; a floor for that class was added |
| Compute numbers and dates in code | **Proved four times:** approvals 66.7% → 99.1% (T3), a two-condition policy 83.3% → 100% (T4, p = 0.008), verifier numeric catches 11/15 → 15/15 (T2), rule items 79-84% → 100% (T5) | — |
| An independent verifier makes a chain a ratchet | Commits were 1,132 of 1,132 correct; but chain completion fell short of the formula (48-62% vs 74-99.8%) because false alarms correlate across retries (T2) | — |
| Decompose and pool in log-odds | Lost to one holistic question on verification (T2); inverted an any-of moderation battery (T3) | At a naive bar, log-odds would publish 63 of 68 harmful posts; the new `any` combiner published 0 of 68 |
| Replicas are one vote; different models add evidence | Replicas, framings and a second Jev pin added nothing; a cascade to a model of a different family took 85.8% to 98.5% at lower cost than the strong model alone (T5) | — |
| Failure never grants permission | **Broken for custom adapters:** malformed answers acted in 128 of 1,908 fault cells (T4) | 0 of 1,908 after the fix; the verifier's 39 new garbage shapes never acted |

The plain verdict: the engine's safety machinery does what it says, including refusing to
promote Jev where Jev is not good enough. Jev's judgment on coding-agent tool calls is good at
ranking (AUC 0.95) but not good enough to promise 95% on new repositories from 180 fit rows; its
misses are a nameable class that floors in code now catch. On business rules with the numbers
digested in code, it is near perfect. A cascade to a different model family is the strongest
default measured.

## What the waves changed

- **Wave 2** fixed 48 findings with regression tests, corrected the claims in `vision.md`,
  `architecture.md` and `live-findings.md`, and wrote the red team's report. The CHANGELOG's
  Unreleased section lists every behaviour change and marks the ones that change a gate's
  evidence.
- **Wave 3** verifiers recomputed every report figure independently on the real wave-1 ledgers
  (462 readouts matched), attacked each fix, and re-ran the headline claims on fresh corpora.
  They broke several fixes (checkpoint forgery by format downgrade, a shadow-gate floor bypass in
  chains, matrix pooling overcounting members, hook exemptions that lowered floors); those were
  fixed, attacked again, and fixed again where the second attack found more (21 wave-3 findings
  in all). On the final tree every verifier suite passes and the test suite went from 614 tests
  to 1,523. Details: [verification report](verification.md).

## The decider

The coordinator relabelled a seeded sample of every corpus blind, from the state alone, and
compared: 276 of 282 label slots agreed across both waves, and every disagreement was on an item
at least one side had flagged ambiguous (adjacent urgency levels, harsh criticism of technique,
whether a threat to a named member is also bullying).

## What this does not establish

The corpora were authored by the evaluation (except 200 real tool calls from one operator's
machine in T1, almost all approvals), so items within a family are correlated and intervals are
optimistic. One decider labelled everything. A live prompt-injection study was planned and not
run: a safety classifier stopped the agent while it authored payloads, and it was not rerouted;
the next attempt should use a published benchmark's payloads. A 98% promise needs about 149
clean planned acts, more than any split here supplied.
