# Architecture

Bun + TypeScript, strict, no runtime dependencies. One package. Everything is importable from
`src/index.ts`. The design of gates, states and recipes-through-the-engine is in
`docs/design/gate-and-state.md`; this file maps the code as built.

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
    aggregate.ts      pool(): logodds / majority / mean / max / min / geomean; agreement()
    learned.ts        fitLogistic, poolLearned: a battery's answers as features, weights from labels
    compound.ts       CompoundDecision shape shared by all strategies; the Strategy names
    ensemble.ts       parallel members, transforms that manufacture independence
    sequential.ts     sample until pooled confidence clears a bar (SPRT-shaped)
    cascade.ts        escalate the unsure cases to a stronger tier
    chain.ts          runChain(): verify-then-commit ratchet for multi-step tasks
  ledger/
    ledger.ts         DecisionRecord, Ledger, MemoryLedger, JsonlLedger; decisionRows, inheritOutcome
    calibration.ts    brier, ece, reliability, riskCoverage, fitThreshold (accuracy and recall modes),
                      coverageAt, fitThresholdByCost, fitIsotonic, correlation
  recipes/
    speculate.ts      decision-tree flattening: root pick plus every branch follow-up in one request
    screen.ts         relevance() for compaction, screenMany() map-reduce, locate() / locateWith() chunks
    loop.ts           Hysteresis and Freshness for decision models inside control loops
    digest.ts         band, compare, relativeTime, count, pruneFields, lines: arithmetic in code
  cli/                ratchet report / check / replay over a JSONL ledger (see bin/ratchet.ts)
bin/ratchet.ts        The CLI entry point
sim/                  The thesis as runnable tables (bun run sim -> docs/sim-results.md)
examples/tool-gate.ts PreToolUse gate: shadow -> label -> fit -> enforce -> audit, as registered gates
examples/quickstart.ts Live triage of one message through Jev via OpenRouter
examples/arcade/      Four browser games with agent turns; loopback server, optional capped live oracle
experiments/pilot/    Sourced shadow fixtures, frozen-policy evidence experiment, static chart report
scripts/set-key.ps1   Hidden-input prompt that writes API keys to the gitignored .env
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
        |
        v
  report() / gate.report(): ECE, Brier, reliability, expected vs observed accuracy,
                            fitThreshold on unselected rows (shadow + audit), per question and per gate
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
`failedOpen`. The engine applies this wrapper and its `timeoutMs` to explicit ensemble and
sequential members and cascade tiers as well as its default oracle. Direct strategy calls
take caller-provided oracles; wrap those with `failOpen()` when that behavior is needed.
Report `model` so versions are pinned in the ledger. Report `cost` in USD per
question (split a batched call's cost evenly). Oracles see only text: the engine passes a
State's `text`, never the object.

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
drift.

### Floors and bypasses

`FloorRule = (state, question) => Action | undefined`. The most cautious matching floor is
combined with the soft action by `moreCautious`. Floors are evaluated by code in the harness,
never by the oracle, and they apply in enforce mode and in the recorded recommendation alike.
They read the State's text. A gate's floors and bypasses are added to the engine's; a floor
that fixes the action (refuse, or review under a policy with no refuse bar) settles the
question without buying an answer. Bypasses answer judge questions yes without a call and
never override a floor.

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
  correlation there; the default is logodds at 0, the same as explicit ensemble members), by
  `poolLearned` for a `LogisticModel`, or by a function; the result is normalised and takes
  the gate's id. The policy rules on the combined verdict. The ledger gets one row per member
  and one combined row (`strategy: "battery"`, `combined: true`) that carries the ruling, all
  sharing the gate id and one `requestId`. If any member fails open, the battery fails open:
  a battery missing a member is not the battery whose bar was fitted. Floors and bypasses see
  the combined question (id = gate id), so scope them to the gate's id.
- **Labels.** Label the combined row. `Engine.label` then labels each member (same request,
  same gate, not combined) with the battery's truth, `correct` re-scored against the member's
  own lean, and `inheritedFrom` set to the combined row's id. The truth is the outcome's
  boolean `truth`, or, without one, recovered from the combined lean and `correct`. That is
  what makes a learned combiner fittable from the ledger: group member rows by `requestId`,
  take `batteryFeatures` of their verdicts and the inherited truth, and `fitLogistic`.
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
recommendation), `action` (what happened), `mode`, cost, latency, `failedOpen`, `error`,
`batch`, tags (`audit`, `recipe:<name>`, the caller's), and an optional
`outcome { correct, truth, note, at, inheritedFrom }`. `JsonlLedger` reads rows written
before gates as their own anonymous requests (`gateId = adhoc:<questionId>`,
`requestId = id`, `trustedHash = stateHash`, no untrusted spans).

`decisionRows(rows)` drops battery members, leaving the rows that are decisions; rollout,
shadow agreement and the per-gate report read those. Calibration figures in `report()` skip
rows a floor or bypass settled, whose confidences are placeholders no oracle stated.

This is the artefact nothing else on the market has; everything the engine learns comes from it.

## Compounding, mechanically

- **pool()** in log-odds: `logit(p) = (n_eff / n) * sum_i w_i logit(p_i)` for judge; product of
  experts for pick and rate. `n_eff = n / (1 + (n - 1) rho)`. The shrink never changes the
  winner, only the confidence, which is what thresholds consume.
- **ensemble** manufactures partial independence with transforms: shuffled option order,
  paraphrased prompts, framed state, different oracles. Members that fail open are dropped;
  if all fail, the compound is neutral and flagged.
- **sequential** cycles through members, pools after each, and stops when the pooled
  confidence clears `settleAbove` or `maxSamples` is hit. Engine-created replicas default to
  correlation 0.75, just like replicated ensembles; explicit members retain caller-specified
  correlation (default 0). This is an SPRT-shaped stopping heuristic: calibrated scores alone
  do not establish the likelihood-ratio assumptions or error guarantees of an SPRT.
- **cascade** asks tiers cheapest-first and settles where confidence clears that tier's bar.
  By default the settling tier's verdict replaces earlier ones; `pool` can combine them when
  tiers are known to be calibrated and reasonably independent. Expect smaller gains than the
  arithmetic suggests: stronger judges tend to repeat the cheap model's confident errors.
- **battery** (a gate feature, not a strategy option): different judge questions about one
  state in one request, combined in log-odds or by a learned model. Decompose, then pool
  softly and fit the bar on the composite; thresholding each sub-question and AND-ing lost
  on 9 of 10 benchmarks.
- **runChain** proposes, verifies with an independent judge, commits only on an `act` ruling,
  resamples otherwise, and stops the whole chain on a `refuse` or when a step exhausts its
  attempts. The committed state is never an unverified proposal. Per-step reliability becomes
  `q = p(1 - f) / (p(1 - f) + (1 - p)(1 - t))` where t is the verifier's catch rate and f its
  false-alarm rate: a 90% verifier moves the base from 0.80 to 0.97, a 99% verifier to 0.9975.

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
  context compaction.
- **screenMany()**: the same questions over many documents, one request per document, with
  bounded concurrency under the engine's spend cap. Asks made after the cap fail open (they
  are ledgered as review) and the document is counted in `skipped`.
- **locateWith()**: a pick over labelled chunks, optionally with a `none` option, as the
  cheap tier of tiered reading; `chunk` is absent when it chose `none`.
- **sequential() with settleLead**: first-to-ahead-by-k stopping alongside the confidence bar.
- **Engine budgetUsd**: a spend cutoff based on completed, recorded requests; after it is
  reached, new asks fail open into review. An in-flight request, its strategy members, and
  concurrent requests can exceed it because their final cost is not known in advance. It
  starts at zero in every process.
- **Engine dailyBudgetUsd**: the cap a restart cannot reset. `DailySpend` reads the UTC day's
  spend from the ledger at the day's first request, and each request reserves `reserveUsd`
  (default: the costliest request on record) before it buys an answer, so a burst of
  concurrent asks cannot all slip under the cap. A refused request fails open with
  `detail.budget: "daily"`. Another process writing the same ledger is seen at the next day's
  read; a request can cost more than its reservation; a failed call can still be billed.
  It is a recorded-spend cutoff, not a prepaid budget.
- **allowIf() bypass**: known-safe states answered without a call; a floor still wins.
- **cached() leases**: `ttlMs` and `maxUses` bound how long an answer is reused.
- **withFallback()**: a second backend (open-weight clone, local model, `RuleOracle`) when the
  primary errors or fails open; the ledger records who answered.
- **Hysteresis / Freshness**: flap suppression and stale-answer rejection for loops.
- **fitLogistic / poolLearned**: learned composition of a battery from labelled outcomes.
- **fitIsotonic / fitThresholdByCost**: recalibration and cost-minimising bars with held-out
  acceptance.
- **digest helpers**: state the comparison in words, band the number, make the date relative.

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
acceptance test (`acceptance.ts`) on the fresh phase's shadow rows; only the current enforce
phase's blind audits can demote. Each transition moves a
ledger-order boundary past all existing target rows, including unlabelled rows. Late labels
cannot revive a consumed phase. No timestamp comparison decides eligibility.

`checkpoint()` returns plain JSON for caller-owned persistence. Restore it through
`RolloutSettings.checkpoint`; malformed, incompatible or missing anchors hold shadow.
Calls on one controller serialize, but multiple controllers/processes must not own the same
target. This is not a persistence or distributed-locking layer. The
[rollout guide](rollout.md) documents restart, migration and identity limits.

The acceptance test fixes its sample before reading labels (the first eligible acts in ledger
order, retries once, an optional cap per group), keeps the result sealed until the sample is
complete and labelled, and evaluates once by an exact one-sided Clopper-Pearson bound. A pass
promotes; a failure holds the configuration in shadow, recorded in a format 2 checkpoint, until
its identity changes. Table 7 of `sim-results.md` compares it with the earlier point estimate.
It is sound under its assumptions (independent acts of a frozen configuration, correct labels),
not a certification of later traffic. A judge's correct leading answer is not
necessarily a correct action when the policy acts against that answer. Rollout therefore
scores the action's polarity from the recorded `go`, consistent with CLI action scoring.
An exact 0.5 judge verdict does not record its policy's polarity unambiguously and supplies
no positive evidence of a correct action.

Audits default to 0 and must be enabled explicitly (Jordan, 2026-10-21); a gate promoted
without them cannot be demoted by evidence, and Rollout says so. They randomly sample only
enforced acts, so they monitor that acted population; they do not establish coverage or
accuracy below the existing action bar. The current `unselected` fit classification combines
shadow and audit rows, which does not by itself make them representative of all traffic.
Lowering a bar needs representative shadow labels and independent validation. The evidence
work ahead of broader deployment is listed first in `roadmap.md`.

## CLI

`bin/ratchet.ts` over a JSONL ledger: `report` (per gate: calibration, posture, fitted bar
and coverage, models seen), `check` (exit 1 when a gate breaks its promise, its ECE bound or
its pinned model; for CI), `replay` (re-rule every recorded distribution under a new
policy, without oracle calls), and `review` (blind labels for a seeded uniform sample of one
judge gate's stored states, recorded before the model's answer is shown). It groups rows by `gateId` and reads a battery's combined rows
as the gate's decisions and its members as their own groups.

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
