# Architecture

Bun + TypeScript, strict, no runtime dependencies. One package. Everything is importable from
`src/index.ts`. The design of gates, states and recipes-through-the-engine is in
`docs/design/gate-and-state.md`; this file maps the code as built. Figures cited as "e2e T<n>"
come from the end-to-end evaluation of 2026-11-12 (`docs/e2e/`), run live on authored corpora (and, in T1, 200 real tool calls).

```
src/
  types.ts            Question / Verdict / Decision / Oracle / Action vocabulary; StateLike
  questions.ts        pick(), rate(), judge() constructors; verdict builders; validation
  policy.ts           GatePolicy, policyFromCosts(), policyWithBand(), rule(): verdict -> act | review | refuse
  floors.ts           Hard rules: refuseIf, reviewIf, reviewUnless, oneWayDoor, forQuestion; allowIf bypasses
  state.ts            State builder: trusted fields, digests, untrusted spans, pairs; hash and trustedHash
  gate.ts             Gate and GateSpec: one decision point (question or battery, policy, floors, mode, promise)
  engine.ts           Engine: gate registry and shared machinery (oracle, ledger, budget, audits);
                      ask / askAll / label / report; the Asker interface
  rollout.ts          Rollout: shadow -> enforce on evidence, back to shadow on audited drift, per gate
  acceptance.ts       the planned exact test promotion runs: sample size, sample, one evaluation
  spend.ts            DailySpend: a per-UTC-day spend cap read from the ledger, with reservations
  math.ts             logit, Condorcet, design effect, cost thresholds, seeded RNG, Beta
  oracles/
    oracle.ts         failOpen(), cached(), withFallback(), timeouts, cost and latency helpers
    sim.ts            SimOracle: known accuracy, calibration temperature, error correlation
    llm-json.ts       LlmJsonOracle: any OpenAI-compatible chat model, strict JSON output
    rules.ts          RuleOracle: deterministic verdicts for baselines and load shedding
    systemone.ts      SystemOneOracle, jev(), jevViaOpenRouter(): the Jev wire format
  compound/
    aggregate.ts      pool(): logodds / majority / mean / max / min / geomean / any / all; agreement()
    learned.ts        fitLogistic, poolLearned: a battery's answers as features, weights from labels
    compound.ts       CompoundDecision shape shared by all strategies; the Strategy names
    ensemble.ts       parallel members, transforms that manufacture independence
    sequential.ts     sample until pooled confidence clears a bar (SPRT-shaped)
    cascade.ts        escalate the unsure cases to a stronger tier
    chain.ts          runChain(): verify-then-commit ratchet for multi-step tasks
  ledger/
    ledger.ts         DecisionRecord, Ledger, MemoryLedger, JsonlLedger; decisionRows, inheritOutcome
    calibration.ts    brier, ece, reliability, riskCoverage, fitThreshold (accuracy and recall modes),
                      coverageAt, fitThresholdByCost, fitIsotonic, correlation, memberCorrelation
    sources.ts        label sources and their trust classes: parseSource, trustOf, DEFAULT_TRUST
    evidence.ts       the evidence grade (measured, estimated, borrowed, none): gradeOf, describeGrade
    bars.ts           a gate's act bar, grade and battery saturation, one reading for every surface
    profile.ts        calibration profiles: buildProfile, mergeProfiles, borrowedBar, profileMatches
    profile-bins.ts   a profile's per-gate bins as integers, and the cautious-end bar they support
    borrow.ts         parseProfile (a profile as untrusted data) and borrowFor (what a gate borrows)
  recipes/
    speculate.ts      decision-tree flattening: root pick plus every branch follow-up in one request
    screen.ts         relevance() for compaction, screenMany() map-reduce, locate() / locateWith() chunks
    loop.ts           Hysteresis and Freshness for decision models inside control loops
    digest.ts         band, compare, relativeTime, count, pruneFields, lines: arithmetic in code
  cli/                ratchet report / check / replay / review / trail / profile over a JSONL ledger (see bin/ratchet.ts)
bin/ratchet.ts        The CLI entry point
sim/                  The thesis as runnable tables (bun run sim -> docs/sim-results.md)
examples/tool-gate.ts PreToolUse gate: shadow -> label -> fit -> enforce -> audit, as registered gates
examples/quickstart.ts Live triage of one message through Jev via OpenRouter
examples/arcade/      Four browser games with agent turns; loopback server, optional capped live oracle
examples/trail/       The decision trail viewer: a loopback server over src/cli/trail.ts and one static page
experiments/pilot/    Sourced shadow fixtures, frozen-policy evidence experiment, static chart report
scripts/set-key.ps1   Hidden-input prompt that writes API keys to the gitignored .env
scripts/profiles.ts   bun run profiles: profiles/*.json from the live ledgers, with profiles/README.md
profiles/             Calibration profiles shipped with the package, one per model pin and kind
tests/                Vitest; statistical tests are seeded and tolerance-bounded
```

## API tiers

- **core**: types, questions, policy, floors, state, engine, gate, ledger, calibration, rollout.
- **compounding**: aggregate, learned, ensemble, sequential, cascade, chain.
- **adapters**: systemone, llm-json, rules, sim.
- **recipes**: speculate, screen, digest, loop.
- **utilities**: math.

Core and adapters are the stable surface. Recipes are expected to change.

## Data flow

```
string | State (text, hash, trustedHash, untrusted)
        |
        v
   Gate (registered, or anonymous "adhoc:<questionId>")
     floors (engine + gate)  -> a floor that fixes the action settles it: no call ("floored")
     bypass (engine + gate)  -> a known-safe judge state is answered yes: no call ("bypass")
        |
        v
   Strategy  ---- single ------------> Oracle.decide(text, questions)   (one batched call)
             ---- battery -----------> Oracle.decide(text, members) -> combine -> one judge verdict
             ---- ensemble ----------> k members (transforms) -> pool()  (parallel)
             ---- sequential --------> sample, pool, stop at bar          (serial)
             ---- cascade -----------> tier 1 ... escalate on low confidence
        |
        v
  CompoundDecision { verdict, members, agreement, cost, latencyMs, failedOpen? }
        |
        v
  rule(decision, GatePolicy, floor)  -> Ruling { action, go, soft, floor, reason }
        |
        v
  gate.mode shadow -> action = baseline ; gate.mode enforce -> action = ruling.action
          (+ blind audit at gate.auditRate: some acts -> review, tagged "audit")
        |
        v
  Ledger.append(DecisionRecord)   every row of one request shares a requestId
        ...later...
  Engine.label(id, Outcome)       on a battery's combined row, members inherit the outcome
                                  (or take their own from memberTruths)
        |
        v
  report() / gate.report(): ECE, Brier, reliability, expected vs observed accuracy, and a
                            conservative act bar on the current configuration's unselected rows
                            (shadow + audit, never a chain's retries), per question and per gate
  gate.rollout.evaluate():  promote the gate on shadow evidence, demote it on audited drift
```

## The contracts

### Oracle

```ts
interface Oracle {
  readonly id: string;
  decide(state: string, questions: readonly Question[], opts?: DecideOptions): Promise<Decision[]>;
}
```

One method. Answer every question, in order, from as few underlying calls as the backend
allows (decision models want every question that shares a state in one request). Throw on
anything malformed; `failOpen()` turns throws and timeouts into neutral decisions flagged
`failedOpen`. It also checks every batch it is handed. It reads each answer once, by index,
into a plain copy of the fields a decision has, and validates the copy: a NaN, string, null or
out-of-range probability, a confidence the distribution does not support, an unnormalised
distribution, a wrong id or kind, swapped, repeated or missing answers, a short, long or sparse
batch, or an invalid cost or latency fails the whole batch open, because one bad answer means
the adapter is broken and its others are not trusted either. An adapter's own `strategy`,
`members`, `detail` and `agreement` are dropped, and nothing an adapter throws or returns makes
`failOpen` itself throw. Before this check, malformed answers from a custom adapter acted in
128 of 1,908 fault cells and threw with no ledger row in 241 (e2e T4-01); `rule()` also reads
a go value that is not a probability as a failed answer, for verdicts that reach it another
way. Each call gets an `AbortSignal`
(`DecideOptions.signal`, linked to the caller's): a timeout or an abort cancels the request
instead of only no longer waiting for it, and the decision records cost 0 with `costUnknown`,
which budgets never read as free (e2e T4-05). The engine applies this wrapper and its
`timeoutMs` to explicit ensemble and sequential members and cascade tiers as well as its
default oracle. Direct strategy calls take caller-provided oracles; wrap those with
`failOpen()` when that behavior is needed. Pass the signal to `fetch`. Report `model` so
versions are pinned in the ledger. Report `cost` in USD per question (split a batched call's
cost evenly). Oracles see only text: the engine passes a State's `text`, never the object.

### Verdicts

- `pick`: `choice`, full `probabilities` keyed by option name, `confidence` = mass on choice.
- `rate`: `score` (probability-weighted position), `level`, `probabilities` in rubric order.
- `judge`: `pYes` and `confidence = max(pYes, 1 - pYes)`.

Option names, not positions, are the identity of a pick answer. That is what lets ensemble
members see shuffled orders and still pool.

### Policy

`GatePolicy { actAbove, refuseBelow?, goIsYes?, onFailOpen? }`. The policy reads one number
from a verdict, the probability that acting is right (`pYes` or `1 - pYes` for judge;
`confidence` for pick and rate), and compares it to bars. `policyFromCosts(a, b)` derives
`actAbove = a / (a + b)`; `policyWithBand(bar, halfWidth)` sizes the review band to measured
drift. Measure that drift per model pin from repeated asks in the ledger (rows sharing a
`stateHash` and question hash); it is not small or uniform. Over 414 repeated pairs jev-1.13
moved a median 0.01, 0.04 at the 90th percentile and 0.11 at most (e2e T1); on jev-1.14, 11.4%
of 924 repeated requests moved more than 0.12 and 5.5% flipped their lean (e2e T2).

The band is added in probability while the bar leaves room for it (bar at most
1 - 2 * halfWidth). Above that knee it keeps the log-odds width it has at the knee, so the act
edge approaches 1 without reaching it: a bar of 0.95 with a half-width of 0.05 acts above
0.9757, where the plain sum capped at 1 and a high bar acted on nothing (e2e T1-05, T3-08).
`policyFromProfile` builds its band the same way.

### Floors and bypasses

`FloorRule = (state, question) => Action | undefined`. The most cautious matching floor is
combined with the soft action by `moreCautious`. Floors are evaluated by code in the harness,
never by the oracle, and they apply in enforce mode and in the recorded recommendation alike.
They read the State's text. A gate's floors and bypasses are added to the engine's; a floor
that fixes the action (refuse, or review under a policy with no refuse bar) settles the
question without buying an answer. Bypasses answer judge questions yes without a call and
never override a floor.

Floors fail closed. `evaluateFloors` runs every rule; one that throws, or answers anything but
an Action or silence (a typo such as `"deny"`), imposes review and leaves its error on the row,
where it used to be ignored or abort the ask with no row (e2e T4-13). Wherever else an action
arrives from outside the engine (a policy's `onFailOpen`, a chain's floor, a gate's action
handed to a chain), one outside the vocabulary is read cautiously by `readAction`: a
refuse-shaped word (`"REFUSE"`, `"deny"`) as refuse, anything else as review, never as act,
since `moreCautious` orders only the three actions. Regex rules, scoped or
not, test from the start every time, so a `/g` pattern answers one state the same way twice
(T4-11; `RuleOracle`'s `judgeIf` does the same). `forQuestion` records its scope on the rule, and
a gate refuses at registration a floor or bypass scoped to one of its battery's members, which
floors never see, since they see the combined question under the gate's id (T4-08). Any other
unmatched scope is allowed: an engine rule may be meant for another gate, and a gate's own rule
may serve questions asked through it as an `Asker`.

A floor reads the whole rendered state, untrusted spans included, so a pattern meant for the
command can fire on tool output that only mentions one: in e2e T4 `refuseIf(/rm -rf/)` refused
`bun test` because its output did (T4-14). That costs availability, a review or refusal the
action did not deserve, never safety. Cutting the text at the first line that starts with
`[untrusted ` is safe only for reading something that lowers caution, such as the hook's
exemption for the harness's own directories: a cut that comes early can only remove the
exemption. A floor that raises caution should read everything, because a trusted line that
merely looks like the marker would hide the rest from it. Floors over the builder's typed
entries, rather than rendered text, are on the roadmap (e2e T3-10).

### State

`StateLike { text, hash, trustedHash, untrusted }` in `types.ts` is what the engine needs;
`State` in `state.ts` builds one. Every entry point (`Engine.ask`, `Engine.askAll`,
`Gate.ask`, `Gate.askMany`, the recipes) takes `string | StateLike`. A string is wrapped as
one trusted field (`asStateLike`): the text is the string, both hashes are `hashState(text)`,
nothing is untrusted, so existing callers and their ledger hashes are unchanged.

The builder (`State.create().field(...).digest(...).untrusted(...).pair(...).build()`)
renders trusted fields first and untrusted spans after them under a marker, refuses engine
objects and rendered rulings as field values (invariant 8, made mechanical), and keeps
untrusted text out of `trustedHash` so the same command with different tool output groups
together for replay. The marker is for the ledger and the auditor, not a defence: floors on
untrusted content stay in code. The full rules are in the doc comment at the top of
`state.ts`.

### Gate

A gate is one decision point: the unit of configuration, learning and rollout.

```ts
interface GateSpec<Q extends Question | readonly JudgeQuestion[]> {
  readonly id: string;                    // "bash.safe"; "adhoc:" is reserved
  readonly question: Q;                   // one question, or a battery of judge questions
  readonly combine?: Combiner;            // batteries: PoolMethod | PoolOptions | LogisticModel | fn
  readonly policy: GatePolicy;
  readonly barSource?: { profileHash: string }; // a bar borrowed from a profile (policyFromProfile)
  readonly floors?: readonly FloorRule[];
  readonly bypass?: readonly BypassRule[];
  readonly strategy?: StrategySpec;       // single questions only
  readonly promisedAccuracy?: number;     // drives gate.rollout
  readonly rollout?: RolloutSettings;     // acceptance plan; demotion window and minAuditRows
  readonly mode?: Mode;                   // overrides engine.mode
  readonly auditRate?: number;            // overrides the engine's audit rate
  readonly tags?: readonly string[];
}

interface Gate<V extends Verdict> extends Asker {
  readonly id: string;
  readonly spec: GateSpec;
  readonly engine: Engine;
  readonly isBattery: boolean;
  mode: Mode;                              // the gate's own, or the engine's until assigned
  readonly auditRate: number;
  readonly rollout: Rollout;               // throws without promisedAccuracy
  ask(state: string | StateLike, opts?: { baseline?; tags? }): Promise<AskResult<V>>;
  askMany(states: readonly (string | StateLike)[], opts?: { concurrency?; baseline?; tags? }): Promise<AskResult<V>[]>;
  report(opts?: ReportOptions): Promise<QuestionReport>;
}

const engine = new Engine({ oracle, ledger, budgetUsd: 5 });
const safe = engine.gate({ id: "bash.safe", question: judge("..."), policy: policyWithBand(0.9, 0.1), floors });
const r = await safe.ask(state);
engine.gates;                              // ReadonlyMap of registered gates
```

- **Registry.** `engine.gate(spec)` validates and registers; ids are unique. A single-question
  gate claims its question id, so `engine.ask` and `engine.askAll` on that question are
  recorded under the gate, with its floors, bypasses, mode and audit rate. Any other question
  is recorded under an anonymous gate `adhoc:<questionId>` with the engine's defaults; those
  are not listed in `engine.gates`.
- **Mode and audits.** A gate without a `mode` follows `engine.mode`; assigning `gate.mode`
  pins it. `auditRate` defaults to the engine's.
- **Batteries.** A battery is asked in one request. Member verdicts are combined into one
  judge verdict, by `pool` for a `PoolMethod` or `PoolOptions` (state the members' error
  correlation there; the default is logodds at 0), by `poolLearned` for a `LogisticModel`, or
  by a function; the result is normalised and takes the gate's id. The policy rules on the
  combined verdict. The ledger gets one row per member and one combined row
  (`strategy: "battery"`, `combined: true`) that carries the ruling, all sharing the gate id
  and one `requestId`. If any member fails open, the battery fails open: a battery missing a
  member is not the battery whose bar was fitted. So does a combiner function that throws or
  returns a p(yes) that is not a probability. Floors and bypasses see the combined question
  (id = gate id), so scope them to the gate's id; a floor scoped to a member is refused at
  registration.
- **Battery shape.** Pick the combiner by what the members are. Log-odds treats every member
  as evidence for one proposition (several signals of the same answer), and only then is it
  right. For an any-of battery ("needs action if any of these is true") it outvotes one
  confident yes with confident noes: in e2e T3 the default pool leaned right on 48.1% of
  held-out moderation posts at an AUC of 0.995, and at its bar would have published 51 of the
  56 that needed action. For an all-of battery it saturates: in e2e T2, 37% of eight-member
  verdicts sat within 1e-6 of 0 or 1 and the fitted bar was 0.99999991. `combine: "any"` pools a
  disjunction as the probability that at least one member's yes is true (noisy-OR,
  `1 - prod(1 - p)` at independence), and `combine: "all"` a conjunction (`prod(p)`); a stated
  correlation moves them toward `max` and `min`, their fully correlated cases. A learned
  combiner fits either shape. The default stays logodds because changing it would move existing
  gates' evidence; reports flag a battery whose pooled verdicts saturate (revised 2026-11-12).
- **Labels.** Label the combined row. `Engine.label` then labels each member (same request,
  same gate, not combined) with the battery's truth, or with the member's own when the outcome
  carries `memberTruths` (keyed by member id; an unknown key is refused and nothing is
  written; a member a present map leaves out stays unlabelled rather than taking the
  battery's truth), `correct` re-scored against the member's own lean, and `inheritedFrom` set
  to the combined row's id. `ratchet review` on a battery asks each member's question and
  records `memberTruths`. The truth is the outcome's boolean `truth`, or, without one, recovered
  from the combined lean and `correct`. That is what makes a learned combiner fittable from the
  ledger: group member rows by `requestId`, take `batteryFeatures` of their verdicts and the
  inherited truth, and `fitLogistic`. Give an any-of or all-of battery's members their own
  truths: an inherited label scores a member against the battery's question, not its own, so
  its accuracy and correlation say little. In e2e T3 a threat member right on 99.1% of its own
  question read 59.0% inherited; in e2e T2 a dates member read 89.6% and 53.5%.
- **Cost.** Members carry the spend; the combined row records cost 0, so summing `cost`
  over all rows is right. `AskResult.decision.cost` is the request's total.
- **Rollout.** `gate.rollout` is a `Rollout` over the gate's own decision rows, flipping
  only `gate.mode`.

### Asker

```ts
interface Asker {
  askAll(state: string | StateLike, questions: readonly Question[],
         opts: AskOptions | ((q: Question) => AskOptions)): Promise<AskResult[]>;
}
```

`Engine` and `Gate` implement it, and every recipe takes one, so every recipe answer is
ledgered, budgeted, floored and auditable. The options are honoured as given: the caller's
policy and strategy rule each question whoever the asker is. The asker decides everything
else: through an engine, each question is recorded under the gate that owns it or an
anonymous one; through a gate, every question is recorded under that gate, with its floors,
mode and audit rate (a `context.keep` gate running `relevance` records one row per item, all
in the gate's slice).

Every engine request (one `ask`, `askAll`, `gate.ask`, or one state of `askMany`) has one
`requestId`. Floors and bypasses settle what they can; every remaining single-strategy
question goes to the oracle in one call; other strategies run per question.

### Decision record

Vendor-neutral, append-only, one row per question. Carries the question id and prompt, a hash
of the question (the rubric version), the gate id (`gateId`), the request id (`requestId`,
shared by every row of one request), `combined: true` on a battery's ruling row, the state's
`stateHash` (hash of the whole rendering), `trustedHash` (hash of the trusted fields alone)
and `untrusted` (names of the untrusted spans), the raw state when `keepState` is on, oracle
and model ids, strategy, the full verdict, `go`, `confidence`, `agreement`, `soft` (engine
recommendation), `action` (what happened), `mode`, cost (with `costEstimate` when the cost was
unknown or invalid and a conservative estimate was charged in its place), latency,
`failedOpen`, `error` (also a floor's, when one threw or answered outside the vocabulary),
`batch`, tags (`audit`, `recipe:<name>`, `chain:attempt:<n>`, the caller's), and an optional
`outcome { correct, truth, note, at, inheritedFrom, source, memberTruths }`. `JsonlLedger`
reads rows written before gates as their own anonymous requests (`gateId = adhoc:<questionId>`,
`requestId = id`, `trustedHash = stateHash`, no untrusted spans).

`JsonlLedger` never throws on content. It drops a byte-order mark, ignores a torn last line
until it is completed, skips and counts lines that are neither decisions nor outcomes, and keeps
the first record when a later line reuses an id (`health` reports `skipped`, `duplicates` and
`torn`; the CLI names them on stderr). Before this, one torn line from a crash mid-append made
every later ask, label and report throw (e2e T4-02), and a duplicate id silently replaced a
labelled row (T4-17). An append after a torn final line starts on a new line, so the fragment
stays one skipped line and the new rows stay whole. It indexes ids on its first read and
afterwards parses only the bytes
appended since, by this process or another, so labelling costs about the same at any ledger
size (e2e T2-11: 125 s to label 432 battery requests before).

`decisionRows(rows)` drops battery members, leaving the rows that are decisions; rollout,
shadow agreement and the per-gate report read those. Calibration figures in `report()` skip
rows a floor or bypass settled, whose confidences are placeholders no oracle stated.

Compound rows (ensemble, cascade, sequential) carry `members` and the strategy's `detail`. Each
member has a `key`, its identity across rows (its `Member` or `Tier` label, else
`<oracle>#<position>`; a sequential member sampled again is `<key>~<round>`), and the one whose
answer settled a cascade or a sequential run has `settled`. `JsonlLedger` fills keys on older
rows. `memberCorrelation(rows)` pairs members by key across labelled rows and returns the phi
per pair, their mean and a `matrix` by member key: the measured correlation the pooling math
asks for. A compound row's members are scored by their own leading answer (p(yes) against a
boolean truth, a pick's choice or a rate's level against a string one); a battery's members are
paired by request and scored by their own labels. A pair whose members did not both vary has no
phi and stays out of the mean, rather than reading as independent (e2e T5-06, T5-07, T2-06).
The mean is the right summary only for exchangeable members (replicas, framings of one model);
a panel that mixes near-duplicates with an independent model needs the matrix (e2e T5: pairs
0.58, -0.04 and -0.04 averaged to 0.165, and pooling at that mean made the panel worse; see
`pool()` below). A cascade's rows pair its tiers only on the escalated items, so measure tier
correlation on a sample where the upper tier answers every item, such as a shadow ensemble of
the two (e2e T5: -0.08 from the cascade's own fit rows against 0.04 over all held-out items).

### Label sources

`src/ledger/sources.ts` sorts labels by the route they arrived by. `Outcome.source` is
`<channel>:<kind>[:<name>]`; `trustOf(source, registry)` looks it up by `channel:kind`, then
`channel:*`, in a `TrustRegistry` (`DEFAULT_TRUST`, extended by `EngineOptions.labelTrust` or
the CLI's `--trust`) and returns `blind`, `census`, `moment`, `consequence`, `unknown` or
`unregistered`. Every reader of labels takes a `TrustFilter`: `isUnselected`,
`scoredFromLedger`, `scoredWithTruth` and `memberCorrelation` default to blind, census and
unknown, which is also what a bar is fitted on (`FitOptions.sources`) and what an acceptance
test reads (`AcceptancePlan.sources`, `RolloutSettings.sources`); consequence and unregistered
cannot be named in either. Reports count moment labels in `labelled` and accuracy but never in
a fit, and consequence labels only in their own `consequence` column. Only an absent source is
`unknown`, which reads as labels always have, so ledgers, fixtures and plan hashes from before
sources do not move. A source that is present but malformed or that no registry entry names is
`unregistered`: it fits, grades and promotes nothing and is not counted in `labelled`, and
reports count and name such sources (the CLI prints them under "Unregistered label sources").
In e2e T4, `accepted`, `Reverted:git` and `hook:inferred` each promoted a gate while they read
as `unknown` (T4-09); register a new route with `labelTrust` before writing labels from it. The
acceptance sample is still fixed without reading labels: an act whose only label is untrusted
stays in it and counts as unlabelled, because dropping it would let a label's route choose the
sample.

### Evidence grades

`src/ledger/evidence.ts` says what kind of evidence stands behind a gate's numbers, and it is
the only place that does: `gradeOf(rows, opts)` returns the strongest `EvidenceGrade` the rows
support. `measured` is an accepted planned sample (an `AcceptanceResult` a rollout evaluated,
or a plan evaluated on the rows' current phase: the newest row's configuration, shadow rows
since the last enforce row) with its exact bound, sample size and labels by trust class;
`estimated` is a Wilson interval (`wilsonInterval` in `calibration.ts`) on at least
`minEstimated` (30) labelled unselected rows of trusted sources; `borrowed` is evidence the
caller supplies that is not this gate's labels (a profile, or two models' disagreement, as data);
`none` carries its reason as a sentence. Estimates, fitted bars, `check` and a report's
calibration columns read only the current configuration (`currentConfiguration`): a row is
current when its evidence version is the gate's newest (gate-wide), its policy is one the gate's
newest request used, and its policy and rubric hashes are the newest recorded for its own
question id. Policy and rubric are matched per question because a gate used as an `Asker` asks
many; the newest-request check retires rows of a policy the gate no longer uses even when each
question id was asked once. Keep one evidence version per gate: per-question versions retire
every question but the last asked, and interleaved ones make the grade flip with each request. A rubric edit that keeps its question id
leaves the old rows behind; renaming a question makes a new one, whose old rows stay current
until the gate's `evidenceVersion` moves, so bump it when you rename; `report` and `check` flag
such a question (`strayQuestions`) when the newest request asked a single, different one. Older
rows are counted in the report's `older` column. Before this, a gate whose rubric, policy and evidence version had
all changed still passed `check` and graded estimated on the old configuration's labels (e2e
T4-20). Disagreement bounds how often at least one of the two judges is wrong, not the gate's
error, and the sentence says so ("so at least one of the two judges is wrong on at least N% of
them; this is not this gate's error rate"): in e2e T5 jev-1.13 and haiku-5.5 disagreed on 13.8%
of items while the gate pooling them was wrong on 3.5%. Two pins of one model family are not
two models, and `gradeOf` refuses them as a second opinion. `modelFamily` is deliberately
coarse: the first name token after the owner prefix, case-insensitive (`typesafe/jev-1.13` and
`jev-1.14` are both `jev`; `claude-haiku` and `claude-sonnet` are both `claude`). A false merge
only adds caution (a higher default correlation, one vote in a lead, a refused second opinion);
a false split would remove it, which is why wave 3 made the rule coarser.
jev-1.13 and jev-1.14 disagreed on 5.4% while each was wrong on 13% to 15%, because they shared
33 of jev-1.13's 37 errors (revised 2026-11-12, e2e T5-03). Every grade but `none` carries
`at`, the age of its evidence (the label that completed the sample, the newest label estimated
from, or the date borrowed evidence came with), never the time it was read. `describeGrade`
renders the one sentence every surface prints, opening with the grade's word. Consumers:
`RolloutStatus.grade`, `QuestionReport.grade` (engine), `GateReport.grade` (`ratchet report`),
`CheckResult.grade` (`ratchet check --require`) and each graded bar of a `Trail`. `FittedFrom`
(`"unselected" | "all"`) is the one spelling of where a fitted bar or a calibration figure came
from, in reports and in `check`.

A gate's reported bar is an act bar, and `src/ledger/bars.ts` is the one place that reads it:
`Gate.report()`, `Engine.report()` and `ratchet report`, `check` and `trail` all go through
`gateEvidence` with one set of levers, `REPORT_DEFAULTS` (a 0.98 promise, `minSupport` 30,
`minEstimated` 30). The bar is fitted on the probability that acting is right, against whether
acting was right, and conservatively: the lowest bar at which the lower end of a 95% Wilson
interval (a one-sided 97.5% bound) of acting right on the rows above it reaches the promise.
The point-estimate bar is printed beside it for reading, never as the one to act at. Each of those choices answers a wave 1 failure: a
bar fitted on the leading answer's confidence counts confident denials toward the promise and
delivered 89% act precision against 98% (e2e T1-06, T2-04); a point-estimate bar fitted at 98%
delivered 91.2% on held-out groups (T1-01); and the engine and the CLI used to default to
different levers, so one ledger graded measured in one and estimated in the other (T3-04). For
a battery the reading also says how often its pooled verdicts saturate.

### Calibration profiles

`src/ledger/profile.ts` makes the borrowed grade's first source. `buildProfile(rows, key, opts)`
reads, for one key (exact model pin, question kind, optional rubric hash), the labelled
unselected rows of trusted sources that model answered alone, and keeps them as equal-width
confidence bins per donor gate, `resolution` of them (100 by default; `profile-bins.ts` holds
them as integer counts, so `mergeProfiles` is exact, commutative and associative, and equal to
one build over every row, and it refuses profiles of different resolutions). The bar per target
is the cautious end: the lowest bin edge at which every donor gate with `minSupport` (30) rows
in its tail (every row at or above the edge) clears the target on that tail at the lower end of
a 95% Wilson interval (a one-sided 97.5% bound). On one gate that is the bar `fitThreshold`
keeps in its conservative mode, the same rule a gate's own reported bar now uses; across gates it is the strictest donor's bar, not the
average, because a profile is lent to a gate none of its donors is. One difference remains: a
judge profile bins the leading answer's confidence, while a gate's own bar is fitted on the act
side (act-side profiles are backlog). `gateBars` keeps each gate's own bar for reading, and the
default targets (`PROFILE_TARGETS`) start at 0.9. `profileHash` covers the key, levers, bars
and bins, not where the rows were filed. `profileMatches(profile, gate)` is the expiry rule (an
exact model and kind, and the rubric when keyed); `profileAge` dates it. `borrow.ts` reads a profile
as untrusted data (`parseProfile`: shape, provenance counts, and bars and hash recomputed from
the bins) and decides what a gate borrows (`borrowFor`, from the gate's newest answered row, or
from the profile its `barSource` names, stale once the gate moves off its key; with a model pin,
stale once the newest answered row reports a model other than the pin). Consumption keeps
policy explicit: `policyFromProfile` (in `policy.ts`) returns an ordinary, hashed `GatePolicy`
acting at the bar plus 0.05, and `GateSpec.barSource` puts the profile's hash in every row's
`detail`. `EngineOptions.profiles` and the CLI's `--profile` lend a bar until the gate's own
labels grade it estimated, not merely until they fit a bar: lending stopped at the first fit
before, and a borrowing gate graded `none` at 20 to 29 labels (e2e T3-03). `Rollout` never
reads a profile.

This is the artefact nothing else on the market has; everything the engine learns comes from it.

## Compounding, mechanically

- **pool()** in log-odds: `logit(p) = (n_eff / n) * sum_i w_i logit(p_i)` for judge; product of
  experts for pick and rate. `n_eff = n / (1 + (n - 1) rho)`. The shrink never changes the
  winner, only the confidence, which is what thresholds consume (no winner changed in 3,120
  re-pools in e2e T5). One scalar rho assumes exchangeable members; it fixed calibration for
  replicas and framings of one model (log loss 0.441 to 0.317 and 0.483 to 0.332 at the measured
  rho) and made a mixed panel worse (0.095 to 0.102). For members that are not exchangeable,
  `PoolOptions.correlations` takes the per-pair matrix by member key
  (`memberCorrelation(...).matrix`) and weighs each verdict by w = R^-1 1 (generalised least
  squares, kept non-negative by an active set: a member the others already account for is
  dropped and the rest solved again). With one rho on every pair it is the scalar shrink; the
  pool is worth at most the members it reads, and never more confident than the same answers at
  rho 0. On T5's mixed panel those weights reached log loss 0.076 and Brier 0.019,
  against 0.095 and 0.027 at rho 0 (e2e T5-02). Ensemble, sequential and cascade pass their
  member keys. Weights can change which answer wins, so adopting a matrix is a configuration
  change: bump the gate's `evidenceVersion`. For `any` and `all`, a correlation moves the pool
  from its independent value toward `max` or `min`.
- **ensemble** manufactures partial independence with transforms: shuffled option order,
  paraphrased prompts, framed state, different oracles. On Jev the transforms manufacture
  almost none: three framings erred together at phi 0.75 to 0.91 and gained nothing over one
  call, three replicas at 0.85 to 0.91 gained 0.8 points (not significant), and a second Jev pin
  gained nothing (phi 0.785 on held-out errors). A model of a different family is what adds
  evidence (e2e T5, revised 2026-11-12). An unstated correlation defaults by who the voters are,
  not by how they were spelled: members that share an oracle id or a model family
  (`modelFamily`, so two pins of one model such as jev-1.13 and jev-1.14 are one voter) pool as
  replicas at 0.75, members that share neither at 0, and a mixed panel at 0.75 times the share
  of pairs that match. A correlation or matrix the caller states always wins.
  `detail.rhoSource` records `caller`, `default-replica`, `default-mixed` or
  `default-independent` (and `rhoMatrix` when the caller pooled with a matrix). Explicit members
  used to default to 0 whatever they were, so three framings of one model pooled as three
  independent votes (ECE 0.099 against 0.042 at the measured rho, e2e T5-01). Strategy
  parameters (`members`, `k`, `minMembers`, `maxSamples`, `maxFailedSamples`) are checked when
  the gate is registered (`checkStrategy`), not on every ask. Members that fail open carry no
  evidence, and an ensemble pools only
  when at least `minMembers` answered (default: all of them); with fewer it fails open, as a
  battery does, because the member that failed may be the cautious one (e2e T4-04: a failed
  0.30 member left a 0.97 member to act alone).
- **sequential** cycles through members, pools after each, and stops when the pooled
  confidence clears `settleAbove` or `maxSamples` is hit. Its correlation defaults by voter
  identity as an ensemble's does, and a `negated` member's answer is flipped back before
  pooling, as in an ensemble (e2e T4-03: a negated "dangerous 0.95" used to pool as "safe 0.95"
  and act). A sample that fails open fails the run open (`maxFailedSamples`, default 0), for the
  reason an ensemble needs `minMembers`: the failed sample may be the cautious one, and the
  permissive member must not settle alone. Raise it to sample through a member's outage. This
  is an SPRT-shaped stopping heuristic: calibrated scores alone do not establish the
  likelihood-ratio assumptions or error guarantees of an SPRT.
- **cascade** asks tiers cheapest-first and settles where confidence clears that tier's bar.
  By default the settling tier's verdict replaces earlier ones; `pool` can combine them when
  tiers are known to be calibrated and reasonably independent. The gain depends on whether the
  upper tier is wrong in different places, and that is a property of the question as much as
  the models. On BoolQ, haiku-5.5 repeated Jev's errors (phi 0.58) and no bar helped
  (`live-findings.md`); on e2e T5's rule-application corpus the same model's errors barely
  overlapped jev-1.13's (phi 0.04), and the cascade went from 85.8% to 98.5% held out, the only
  strategy to meet a 98% precision target, at 69% of the upper tier's cost (revised 2026-11-12).
  Measure the tiers' correlation on items both answered before building one (see
  `memberCorrelation` above).
- **battery** (a gate feature, not a strategy option): different judge questions about one
  state in one request, combined by a pool method or a learned model, with the bar fitted on
  the composite. Pooling softly beats thresholding each sub-question and AND-ing, which lost on
  9 of 10 published benchmarks and by 0.107 AUC in e2e T2. Pick the pool by the battery's shape
  (see Gate, above): log-odds for members that are evidence for one answer, `any` for any-of,
  `all` or a learned combiner for all-of. A battery is not automatically better than one
  well-written question: in T2 eight conjuncts in log-odds lost to the holistic question by
  0.006 AUC, and in T1 a three-member battery did not beat the single question (revised
  2026-11-12).
- **runChain** proposes, verifies with an independent judge, commits only on an `act` ruling,
  resamples otherwise, and stops the whole chain on a `refuse` or when a step exhausts its
  attempts. The committed state is never an unverified proposal. The precision of a commit
  becomes `q = p(1 - f) / (p(1 - f) + (1 - p)(1 - t))` where t is the verifier's catch rate and
  f its false-alarm rate: a 90% verifier moves the base from 0.80 to 0.97, a 99% verifier to
  0.9975. That is all the formula predicts (e2e T2: 1,132 of 1,132 committed steps correct, a
  weak test at t = 100%). Whether a chain finishes is another matter: with independent attempts
  a step commits with probability `a = p(1 - f) + (1 - p)(1 - t)` per attempt and an n-step chain
  with m attempts finishes with `(1 - (1 - a)^m)^n`, but false alarms are not independent
  across retries. After a correct candidate was held back, the next correct one for the same
  step was held back 55.9% of the time against a 15.0% base rate, and chains finished 48% to 62%
  where that arithmetic predicted 74% to 99.8%; at a strict 0.9 bar none of 200 chains
  finished, worse than no verifier (16% and 43%). Section 5 of `sim-results.md` now simulates
  correlated false alarms: commit precision barely moves and completion falls well below the
  formula. Measure completion and per-step exhaustion
  from the ledger rather than computing them, and do not give a step verifier a `refuseBelow`
  unless a confident rejection should end the whole task (T2: completion 43.3% to 6.7%)
  (revised 2026-11-12).

  When the verifier is a gate, `verify` returns the gate's whole `AskResult`, not its
  `decision`. The chain then commits only when the gate acts and its own policy agrees (the
  more cautious of the two, by `moreCautious`), so the gate's floors, one-way doors, mode and
  blind audits hold, and a gate that refuses stops the chain. A gate in shadow acts on its
  baseline, review unless the ask passes one, so a chain verified by a shadow gate commits
  nothing until the caller says what it does anyway. `baseline: "act"` lets the chain's policy
  decide while the gate records, but the gate's floors bind the chain in every mode: the chain
  rules its own policy under the gate's floor as well as its own, so a step the gate's refuse
  floor matches stops the chain, and one its review floor or one-way door matches is never
  committed, whatever the chain's bar (a floored ask carries only a neutral 0.5 placeholder,
  which a permissive chain policy would otherwise act on). A gate action outside the vocabulary
  is read by `readAction`, never as act. Returning `result.decision` drops all of that, which
  is how a `DROP TABLE` step the gate said to review was committed in e2e T2 (T2-01). `verify` gets
  `chainTags(step, attempt)` as its fourth argument; pass them as the ask's tags, so each row
  says which step and attempt it verified. Rows tagged `chain:attempt:<n>` with n of 2 or more
  are never unselected evidence: a retry exists only because the attempt before it was held
  back, and reading retries as shadow rows fitted a bar of 0.870 where held-out supported 0.48
  (T2-03). `maxAttempts` must be a finite integer of at least 1 (T2-09).

## Recipes

Recipes are compositions of the primitives that match a pattern the community has converged
on, measured live in `docs/live-recipes.md`. Every recipe takes an `Asker` (an engine or a
gate), a `policy` from the caller (one for all questions, or one per question), and optional
`baseline` and `tags`; its rows carry `recipe:<name>` and share a request id per underlying
request.

```ts
speculate(asker, state, { root, branches, policy })        // -> { root, choice?, branch?, followUps, requestId, cost, latencyMs }
relevance(asker, context, items, { policy, perRequest })   // -> { scores, results, requestIds, cost, requests }
screenMany(asker, docs, questions, { policy, concurrency }) // -> { byDoc, skipped, cost, requests }
locateWith(asker, chunks, question, { policy, none })      // -> { result, chunk?, question }
locate(chunks, question, { none, id })                     // the pure builder: { state, question }
```

- **speculate()**: one request answers the root question and every branch's follow-up; the
  result keeps the follow-up for the branch the root chose. `choice` is absent when the root
  failed open or a floor settled it. Through an engine with a gate per question, each answer
  lands in its own gate's slice.
- **relevance() and prune()**: one judge per item on one shared context, in requests of up
  to 64 items (each one `askAll` call). The model sees summaries, never bodies. Used for
  context compaction. The item listing is trusted text and is rendered before the context's
  first untrusted span, so a span cannot pose as the listing. `prune` keeps an item with no
  bought answer (failed open, or settled without a call): a failed-open item scores 0.5, and
  under a keep bar of 0.6 failures used to remove context instead of keeping it (e2e T4-07).
- **screenMany()**: the same questions over many documents, one request per document, with
  bounded concurrency under the engine's spend cap. Asks made after the cap fail open (they
  are ledgered as review) and the document is counted in `skipped`.
- **locateWith()**: a pick over labelled chunks, optionally with a `none` option, as the
  cheap tier of tiered reading; `chunk` is absent when it chose `none`.
- **sequential() with settleLead**: first-to-ahead-by-k stopping alongside the confidence bar.
  The lead is counted in independent votes: answers are grouped by model family (`voterKey`) and
  by distinct model (`voterModel`, the model name, else the oracle id), each group casts one vote
  for its own majority answer, the leading answer gets the smaller of its two counts and every
  other answer the larger, so replicas or pins of one model agreeing never settle on a lead and
  merging models into a family can only delay a stop. In e2e T5, with
  jev-1.13 and jev-1.14 first, lead-by-2 stopped on 178 of 260 items when the two pins agreed
  and was wrong on 26 of them, 7.3 points below the fixed ensemble of the same members (T5-05);
  under this rule those two pins are one voter. The family rule is lexical, so put the most
  different member second all the same, or rely on the confidence bar alone (which used 2.10
  samples per item against 3, 1.2 points below the fixed ensemble, not significant).
  `settleLead` is part of `StrategySpec`; `sequential()` refuses unbounded or non-integer counts
  itself, and strategies given on a single ask are validated like a gate's (an invalid one fails
  that question open with no call).
- **Engine budgetUsd**: a spend cutoff based on completed, recorded requests; after it is
  reached, new asks fail open into review. A sequential run or cascade stops buying once the cap
  is spent partway through its request; ensemble members, started in parallel, and concurrent
  requests can exceed it because their final cost is not known in advance. It
  starts at zero in every process, and must be a finite, positive number. The overshoot is
  roughly concurrency times the cost of a
  request: against a $0.05 cap at $0.01 a request, e2e T4 measured 1.0x at concurrency 1, 4.0x
  at 16 and 13.6x at 64. A cost that is unknown (a timeout, `costUnknown`) or not a finite
  non-negative number is never counted as free: it is charged the larger of `reserveUsd` and
  the costliest validly priced request, noted in the row's `costEstimate`, and with no price at
  all the cap stops buying until a priced request gives it one. Spend never goes down or
  becomes NaN. In e2e T4 a NaN or negative reported cost disabled the cap ($1.00 billed against
  $0.05), and timed-out calls recorded $0 while the provider billed $0.50 (T4-05, T4-06).
- **Engine dailyBudgetUsd**: the cap a restart cannot reset. `DailySpend` reads the UTC day's
  spend from the ledger at the day's first request, and each request reserves `reserveUsd`
  (default: the costliest request on record) before it buys an answer, so a burst of
  concurrent asks cannot all slip under the cap. A refused request fails open with
  `detail.budget: "daily"`. Another process writing the same ledger is seen at the next day's
  read; a request can cost more than its reservation; a failed call can still be billed.
  It is a recorded-spend cutoff, not a prepaid budget. Measured in e2e T4 (cap $0.05, $0.01 a
  request): a restart on the same ledger made no further calls; on a fresh ledger the default
  reservation is 0, so the day's first burst is bounded only by concurrency (13.2x the cap at 64
  in flight), and a `reserveUsd` that covers one request held it to 1.0x at 64; two live engines
  on one ledger each spent their own cap, 2.0x together. Unknown and invalid costs are charged
  as for `budgetUsd`, also when read back from the ledger after a restart (a row with cost -1
  used to reopen a spent day), and with neither a reservation nor a priced request on record the
  day admits nothing until one is known. Set `reserveUsd`.
- **allowIf() bypass**: known-safe states answered without a call; a floor still wins.
- **cached() leases**: `ttlMs` and `maxUses` bound how long an answer is reused.
- **withFallback()**: a second backend (open-weight clone, local model, `RuleOracle`) when the
  primary errors or fails open; the ledger records who answered.
- **Hysteresis / Freshness**: flap suppression and stale-answer rejection for loops.
- **fitLogistic / poolLearned**: learned composition of a battery from labelled outcomes.
  `fitLogistic` takes Newton steps with a line search and returns its final `loss`, whether it
  `converged`, and when it did not, a `reason` (one class, separable, iteration cap, no
  descent); the
  gradient descent it replaced stopped early, and the held-out battery it fitted read 101 of
  108 where the converged fit reads 107 (e2e T3-06).
- **fitIsotonic / fitThresholdByCost**: recalibration and cost-minimising bars with held-out
  acceptance.
- **digest helpers**: state the comparison in words, band the number, count in code. The
  largest effect the end-to-end evaluation measured (e2e T2, T3, T4, T5: raw to digested 66.7%
  to 99.1% on approvals, 83.3% to 100% on a two-condition policy check). A window takes
  `compare(daysBetween(...), window)`; `relativeTime` is for recency, not windows: it read 31 to
  44 days as "1 month ago" (fixed: it now floors, in days below 120 days), and 27% of a 30-day
  refund desk's auto-approvals were wrong (e2e T3, revised 2026-11-12). `compare` rounds the
  difference to its inputs' precision, so float noise ("by 4.200000000000003 USD") no longer
  reaches the model (C-01), and says "equals" only for equal inputs. `compare`, `daysBetween`
  and `relativeTime` throw on a non-finite number or an invalid date rather than print a
  comparison of it.

The full map of community patterns to these pieces is `docs/idea-catalog.md`.

The standalone [shadow pilot](pilot.md) exercises both tool gates and output verification
through the real engine and JSONL ledger. It fits on one set of scenario families, saves a
candidate manifest, then measures it on separate validation and challenge groups. Its
authored fixtures never enable enforcement. A separate seeded IID experiment compares
point-estimate promotion with exact fixed-time validation and repeated inspection.

The [keywork tool gate](design/keywork-gate.md) (`experiments/keywork/`) replays the asks a
person answered in keywork, Jordan's coding-agent harness, through a shadow gate, labels each
row with the person's answer, and reports progress against a planned acceptance test.

## Rollout

`new Rollout({ gate, promisedAccuracy })` (or `gate.rollout`, built from the spec) reads only
the gate's current rubric, effective policy and caller-owned evidence version, optionally
requiring an exact recorded model. New rows carry `policyHash` and `evidenceVersion`;
legacy rows remain reportable but cannot earn promotion. Code-only floor/bypass rows
remain excluded. Gates derive their own hashes; engine-level controllers require explicit
`evidence.policyHash` and `evidence.questionHash` via exported `hashPolicy`/`hashQuestion`.

Initialize with `evaluate()` **before** collecting evidence. Without a valid checkpoint,
the first call sets shadow and excludes every row already present. Promotion runs one planned
acceptance test (`acceptance.ts`) on the fresh phase's shadow rows and is decided by the grade
it yields: the private promotion path takes a `MeasuredGrade` and nothing wider, so promoting
on an estimate is a compile error, and it refuses any other variant at run time as well. Every
status carries the phase's `grade`. Only the current enforce phase's blind audits can demote. Each transition moves a
ledger-order boundary past all existing target rows, including unlabelled rows. Late labels
cannot revive a consumed phase. No timestamp comparison decides eligibility.

`checkpoint()` returns plain JSON for caller-owned persistence. Restore it through
`RolloutSettings.checkpoint`; malformed, incompatible or missing anchors hold shadow. Every
restore of enforce re-derives a passing planned sample from the ledger. A format 3 enforce
checkpoint names the sample that promoted the gate; a format 1 or 2 one names none, so the
restore looks for the earliest planned sample the ledger accepts and writes the checkpoint back
as format 3 with it. Either way, editing a saved checkpoint's mode to `enforce`, or rewriting it
in an older format, promotes nothing (e2e T4-10). A configuration whose planned sample has
failed stays rejected even if its checkpoint is lost or edited: enforce is honoured only if no
complete planned sample of the configuration failed on the ledger, before or after the one a
checkpoint rests on. The residual
cost of that rule, and what a forged checkpoint can still choose, are in the rollout guide.
Calls on one controller serialize, but multiple controllers/processes must not own the same
target. This is not a persistence or distributed-locking layer. The
[rollout guide](rollout.md) documents restart, migration and identity limits.

The acceptance test fixes its sample before reading labels (the first eligible acts in ledger
order, retries once, an optional cap per group), keeps the result sealed until the sample is
complete and labelled, and evaluates once by an exact one-sided Clopper-Pearson bound. A pass
promotes; a failure holds the configuration in shadow, recorded in the checkpoint and
re-read from the ledger if the checkpoint is lost, until its identity changes. Table 7 of
`sim-results.md` compares it with the earlier point estimate.
It is sound under its assumptions (independent acts of a frozen configuration, correct labels),
not a certification of later traffic. A judge's correct leading answer is not
necessarily a correct action when the policy acts against that answer. Rollout therefore
scores the action's polarity from the recorded `go`, consistent with CLI action scoring.
An exact 0.5 judge verdict does not record its policy's polarity unambiguously and supplies
no positive evidence of a correct action.

The end-to-end evaluation exercised this live (e2e T1). A tool gate whose bar was fitted at 98%
on one set of template groups held 5 wrong acts in its 59-act planned sample; the test rejected
it (exact lower bound 83.0% against a 95% promise) although the phase's acts read 91.2% with a
Wilson interval reaching 95.3%, and the rejection held across a fresh process and against
tampered, stale and edited checkpoints. The red team found one edit a restore accepted, a saved
shadow checkpoint whose mode was changed to `enforce` (e2e T4-10), which the restore now
refuses, as above. How to fit a bar that survives the test is in `rollout.md`.

Audits default to 0 and must be enabled explicitly (Jordan, 2026-10-21); a gate promoted
without them cannot be demoted by evidence, and Rollout says so. They randomly sample only
enforced acts, so they monitor that acted population; they do not establish coverage or
accuracy below the existing action bar. Demotion is slow: at an audit rate of 0.2 and 30 audits
to judge, nothing can demote before about 150 acts, and in e2e T1 a gate promoted on a weak plan
executed 10 wrong acts before its 53rd audit demoted it. The current `unselected` fit
classification combines shadow and audit rows (never a chain's retries), which does not by
itself make them representative of all traffic.
Lowering a bar needs representative shadow labels and independent validation. The evidence
work ahead of broader deployment is listed first in `roadmap.md`.

## CLI

`bin/ratchet.ts` over a JSONL ledger. It groups rows by `gateId` and reads a battery's
combined rows as the gate's decisions and its members as their own groups.

- `report`: per gate, calibration, posture, the act bar and grade (read through `bars.ts`, as
  above), coverage, models seen, and any unregistered label sources.
- `check`: exit 1 when a gate breaks its promise, its ECE bound or its pinned model; for CI.
- `replay`: re-rule every recorded distribution under a new policy, without oracle calls.
- `review`: blind labels for a seeded uniform sample of one judge gate's stored states.
- `hook`: shadow a coding agent's permission prompts (below).
- `trail`: how each decision was reached: every member answer, the pooled verdict, floor,
  action and label, with the act bar inferred from the rulings; the viewer in
  `examples/trail/` renders the same `Trail`.
- `profile`: `build`, `show` and `merge` calibration profiles, which `report`, `check` and
  `trail` take as `--profile`.

`review` shows each item's question with its state and records the reviewer's answer to that
question before the model's answer is shown; on a battery it asks each member's question and
records `memberTruths`, the battery's truth being their OR for `any`, their AND for `all`, and
otherwise one more overall question. `--denied` reviews every denial, reading each
row's label through its own go polarity, and `--audits` reviews the blind-audit queue, the
labels that can demote an enforcing gate. It used to ask "Approve?" and record yes for
whatever the question asked, which inverted every label on a "needs action?" gate (e2e T3-02).

`hook` journals Claude Code and Codex hook events under `~/.ratchet/hooks/<harness>/`;
`replay` resolves each prompt from what happened next and asks the `agent.tool.<harness>` gate
in shadow (`src/hook/`, design in `docs/design/agent-hook.md`). Subjects are measured from the
session's root (`CLAUDE_PROJECT_DIR`, else the session's first cwd), not from a cwd that
follows the agent's `cd`. `harness_owned` is an allowlist: only the harness's scratch space and
its memory notes. Everything else under the harness's homes (`~/.claude`, `~/.codex`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`: settings, hooks, plugins, skills, agents, global
instructions), a project's `.claude/` and `.codex/` extension points (agents, commands, skills,
plugins, settings) and `.mcp.json`, commands that write onto those files, and links created to a
harness home carry `harness_config`, which floors review; a path with a data-stream suffix is
never harness-owned, and replay can only raise a journalled flag; paths are matched after resolving them, so `.\` or
`x\..\` cannot hide one. PowerShell is a command tool. Commands are normalised before they
are digested (line continuations joined, Unicode dashes read as `-`, quotes around a command
word dropped), git global options before the verb are understood (`git -C ../x push --force`),
and the digests are named, tested rule lists in `src/hook/subject.ts` (`DESTRUCTIVE_COMMANDS`,
`OPAQUE_COMMANDS`, `UPLOAD_COMMANDS`, `HARNESS_CONFIG_COMMANDS`, and `CHECK_BYPASS_COMMANDS`,
whose `check_bypass` digest floors to review a command that switches a check off:
`--no-verify`, `HUSKY=0`, skipped tests, TLS verification off), plus a `credential` digest on
commands and paths for printing or copying keys and credential files (`CREDENTIAL_COMMANDS`).
A rule matches if it matches the raw or the normalised command, so normalising never hides one.
The digests are lexical and a backstop for judgment and review, not a sandbox; their known
limits are listed in the design doc. The scrubber also covers WebSearch queries. In e2e T1 a PowerShell command
reached the gate as a bare key shape no floor could read, and the floors sent 34 of 200 real
calls to review, all of them approvals; 16 of 51 path calls read as outside the workspace,
among them the harness's own notes and scratch space and a file written after the shell had
moved into `node_modules` (T1-02, T1-04, T1-08). Three of T1's nine held-out wrong acts
switched a check off (`HUSKY=0`, `--no-verify`, `GOFLAGS=-insecure`). `HOOK_EVIDENCE` is
`agent-tool-v2`.

## Extension points

- **New backend**: implement `Oracle`. `SystemOneOracle` already covers every host that speaks
  the Jev wire format (TypeSafe, Cloudflare Clef, Amazon Strands Decider, Vercel's gateway);
  OpenAI's Decisions API has its own shape and needs a sibling adapter.
- **New strategy**: return a `CompoundDecision` via `compoundOf()`; the engine, policy and
  ledger need no changes.
- **New ledger**: implement `Ledger` (append, label, all; optionally get and request, which
  the engine otherwise emulates by scanning `all()`). SQLite via `node:sqlite` is the obvious
  next one after JSONL.
- **New recipe**: take an `Asker`, build per-question `AskOptions` with `recipeAskOptions`,
  and return the `AskResult`s.
- **Harness integrations**: Claude Code `PreToolUse` hook (see the example), LangChain-style
  middleware, Vercel AI SDK provider, an MCP server exposing ask / label / report.

## Conventions

- Strict TypeScript with `exactOptionalPropertyTypes`; spread optional fields conditionally.
- Biome for lint and format, LF line endings, 100 columns.
- Statistical tests are seeded and assert tolerances, not exact values.
- Simulations print markdown and are saved to `docs/sim-results.md`; regenerate after any
  change to pooling, policy or the simulated oracle.

## Command line

`bin/ratchet.ts` reads a JSONL ledger and answers three questions: what does the record say
(`report`), is a gate still keeping its promise (`check`, for CI), and what would a new bar
have done on recorded traffic (`replay`). Details and example output: `docs/cli.md`. The design
brief behind gates, state and recipes is `docs/design/gate-and-state.md`.
