<div align="center">

```text




              ┬─┐ ┌─┐ ┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌┬┐
              ├┬┘ ├─┤  │  │   ├─┤ ├┤   │
              ┴└─ ┴ ┴  ┴  └─┘ ┴ ┴ └─┘  ┴

                              ▼
        ────/|────/|────/|────/|────/|────/|────/|────/|────▶

                 small judgments.  deliberate moves.




```

A decision engine that compounds cheap, calibrated machine judgments
into reliable automated decisions.

[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-1f2937?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Bun 1.3](https://img.shields.io/badge/Bun-1.3.x-1f2937?style=flat-square&logo=bun&logoColor=white)](package.json)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-1f2937?style=flat-square)](package.json)
[![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-1f2937?style=flat-square)](LICENSE)
<br>
[![Shadow by default](https://img.shields.io/badge/default%20mode-shadow-6b7280?style=flat-square)](docs/rollout.md)
[![Fail open means review](https://img.shields.io/badge/fail%20open-review-6b7280?style=flat-square)](docs/vision.md)
[![One-way doors](https://img.shields.io/badge/one--way%20doors-never%20automated-6b7280?style=flat-square)](docs/vision.md)
[![Pre-release](https://img.shields.io/badge/status-pre--release%200.0.1-b45309?style=flat-square)](docs/publishing.md)

[Arcade](docs/arcade.md) · [Install](#install) · [Vision](docs/vision.md) ·
[Architecture](docs/architecture.md) · [Evidence](docs/pilot-results.md) ·
[Publishing](docs/publishing.md)

</div>

<br>

*Working name; pre-release source checkout. Package and hosted arcade publishing are being
[planned](docs/publishing.md).*

Decision models (TypeSafe's Jev, launched September 2026, and the rivals that followed within
weeks) answer typed questions in under half a second for hundredths of a cent, with a
calibrated probability attached. They are right about 80% of the time on mixed work. Every
vendor leaves the same things to "your code": when to act on an answer, how to combine
answers, when to escalate, and how to know whether any of it is working.

This is that code, done once, carefully, with the mathematics in the comments and a
simulation that shows where it breaks.

> A calibrated cheap decider does not make 80%-good decisions. It sorts decisions into the
> ones it can make at 98% and the ones it should hand off. The sort, the hand-off, and the
> loop that keeps the sort honest are the product.

<br>

## Votes climb. Chains fall.

```text
   a majority of n independent 80% votes

                               ┌─────  99.6%   15 votes
                         ┌─────┘  98.0%    9 votes
                   ┌─────┘  94.2%    5 votes
             ┌─────┘  89.6%    3 votes
       ──────┘  80.0%    1 vote


   n dependent 80% steps, nothing checking the work

       80.0%    1 step  ──────┐
                              └─────┐  64.0%    2 steps
                                    └─────┐  51.2%    3 steps
                                          └─────┐  32.8%    5 steps
                                                └─────┐  10.7%   10 steps
                                                      └──────   ~0%   50 steps
```

The engine gives you the first staircase and defends you from the second: pooling with a
correlation correction, sequential sampling that stops when the evidence clears a bar,
cascades that escalate only the unsure cases, and a verify-then-commit runner that puts a
tooth between every step of a chain. One caveat governs all of it. The same model asked five
times is not five voters; at pairwise error correlation 0.5, five calls are worth 1.7. So the
correlation is a parameter the ledger measures, never an assumption. The numbers above come
from the engine's own code in [docs/sim-results.md](docs/sim-results.md).

<br>

## One decision

```text
   state ───▶ oracle ───▶ p(go) 0.991 ───┐
                                         ├──▶ moreCautious ───▶ act · review · refuse ───▶ ledger
   state ───▶ floors ───▶ refuse ────────┘
```

The model proposes; code decides. Floors are regular expressions and predicates evaluated by
the harness, and a floor can only raise caution. An oracle that times out or returns garbage
contributes nothing, and the policy's answer to nothing is review. One-way doors are never
automated. Every decision lands in the ledger with its confidence, cost, latency, what the
policy recommended, what the application did, and later, what was true.

<br>

## Five clicks

```text
     shadow           label            fit            enforce           audit
   ───────/|──────────────/|──────────────/|──────────────/|──────────────/|───▶
   nothing acts     truth arrives    bar is fitted    acts begin     blind re-checks
```

A gate starts by changing nothing and earns the right to act from its own record. Promotion
goes through one planned acceptance test: the first acts of a fresh shadow phase, fixed
before their labels are read, must reach the promise by an exact one-sided 95% bound (149
consecutive correct acts for 98%). A failed configuration stays in shadow until it changes.
Blind audits demote a promoted gate; with audits off nothing can, and Rollout says so.
Thresholds are fitted only on rows the oracle's own confidence did not select. The test is
sound under its stated assumptions, not a certification of future traffic; evidence is scoped
to its rubric, policy, plan, configuration version and model pin, and every promotion,
rejection or demotion starts a fresh ledger phase. [Boundaries and migration](docs/rollout.md).

<br>

## In code

```ts
import { Engine, judge, jevViaOpenRouter, oneWayDoor, policyWithBand, refuseIf, State } from "./src/index.ts";

const engine = new Engine({ oracle: jevViaOpenRouter(), budgetUsd: 5, auditRate: 0.05 });

// A gate is one decision point: its question, policy, floors, rollout contract and ledger slice.
const safe = engine.gate({
  id: "bash.safe",
  question: judge("Is this command safe to run without asking the user?"),
  policy: policyWithBand(0.85, 0.1),           // act at 0.95 and above; the band below it is reviewed
  floors: [refuseIf(/rm -rf \/(\s|$)/), oneWayDoor((s) => /--force|DROP TABLE/.test(s))],
  promisedAccuracy: 0.98,                        // observed-accuracy target; see rollout limits above
  evidenceVersion: "shell-gate-v1",              // bump for model/config, rules, strategy or state changes
  rollout: { evidence: { version: "shell-gate-v1", model: "typesafe/jev-1.13" } },
});
await safe.rollout.evaluate();                   // initialize BEFORE collecting evidence; holds shadow

// State is built in code: trusted fields, digests, and untrusted spans kept apart.
const state = State.create("Shell command proposed by the coding agent")
  .field("command", command)
  .field("cwd", cwd)
  .untrusted("tool_output", lastOutput, { maxChars: 2000 })
  .build();

const r = await safe.ask(state);        // shadow by default: recorded, nothing acted
r.action;                               // "act" | "review" | "refuse"
r.ruling.reason;                        // "go 0.991 >= actAbove 0.95"

await engine.label(r.recordId, { correct: true, truth: true });
await safe.rollout.evaluate();          // empirical rollout; not statistical certification
```

Save `safe.rollout.checkpoint()` yourself for restart; without a valid checkpoint the
controller starts in shadow again. Three question shapes (pick, rate, judge) cover what every
decision model on the market answers. The oracle interface is one method.

<br>

## Install

```sh
bun add @jmoak/ratchet@alpha      # or: npm install @jmoak/ratchet@alpha
```

```ts
import { Engine, judge, policyWithBand, refuseIf, State } from "@jmoak/ratchet";
```

ESM only. Node 22.14 or later, or Bun 1.3 or later. Zero runtime dependencies. The package
ships the engine and the `ratchet` CLI; the arcade, simulations and experiments stay in the
repository. Until the first alpha is on the registry, the import path in the examples above
is the source checkout's `./src/index.ts`. See [CHANGELOG.md](CHANGELOG.md) for what each
version ships and the limitations to read first.

## Run it from source

```sh
bun install
bun run check     # types, lint, tests
bun run sim       # the thesis as six tables, from the engine's own code
bun run demo      # a PreToolUse gate: shadow -> label -> fit -> enforce -> audit
bun run arcade    # four local browser games using the engine; no keys needed
bun run pilot     # source-inspired shadow pilot + fixed-policy evidence experiment
bun run pilot --live  # same pilot through Jev; keeps every application action in review
bun run keywork --export decisions.jsonl  # keywork tool gate: dry run; --live replays answered asks in shadow (fit phase, then evidence after the freeze); --smoke for the pre-fit history
bun run ratchet review <ledger> --gate <id>  # blind labels for a seeded sample, before the model is shown; --denied reviews every denial
bun run quickstart  # live: triage one message with Jev via OpenRouter (needs a key in .env)
bun run live        # live: the five calibration, routing, cascade and cost experiments (< $0.10)
```

Checks and simulations need no network or keys; the demo uses a simulated oracle unless
`TYPESAFE_API_KEY` is set. Quick start and live experiments call paid backends. The simulated
oracle has known accuracy, calibration and error correlation so every claim can be checked
against the truth.

The [Ratchet Arcade](docs/arcade.md) is four small browser games (Signal Orchard, Bridge
Builder, Parcel Patrol, Treasure Survey) in which every move goes through a real `Engine` and
`Gate` with a `MemoryLedger`; you can inspect the decision trail and download the JSONL. The
[shadow pilot](docs/pilot.md) includes sourced application scenarios, separate fit and
validation groups, persisted evidence, and exportable charts. Its authored labels exercise the
workflow without claiming production accuracy. Read the
[first live results and graphs](docs/pilot-results.md).

<br>

## Where things live

```text
   src/
     engine.ts      facade and gate registry
     gate.ts        one decision point: question, policy, floors, rollout, ledger slice
     state.ts       trusted fields, digests and untrusted spans, kept apart
     policy.ts      probability to act, review or refuse, bounded below by floors
     floors.ts      refuseIf, oneWayDoor and friends: regexes and predicates, not prompts
     rollout.ts     shadow, label, fit, enforce, audit, per gate
     acceptance.ts  the planned exact bound that Rollout promotes through
     compound/      ensemble, sequential, cascade, chain, learned composition
     oracles/       System One wire format (Jev, Clef, Strands Decider), LLM-JSON, rules, sim
     ledger/        records, labels, calibration, correlation, threshold fitting
     recipes/       screen, digest, loop, speculate; each takes an Engine or a Gate
     cli/           ratchet report, check, replay, review
   sim/             the thesis as tables
   examples/        tool-gate demo, quickstart, the arcade
   experiments/     live runs, the shadow pilot, the keywork tool gate
   docs/            vision, architecture, rollout, results, idea catalogue
```

| If you want | Go to |
| --- | --- |
| The argument, stated carefully | [docs/vision.md](docs/vision.md) |
| A map of the code and its contracts | [docs/architecture.md](docs/architecture.md) |
| The six simulated tables | [docs/sim-results.md](docs/sim-results.md) |
| What Jev actually did on 1,800 live calls | [docs/live-findings.md](docs/live-findings.md) |
| Recipes measured live | [docs/live-recipes.md](docs/live-recipes.md) |
| Rollout boundaries and migration | [docs/rollout.md](docs/rollout.md) |
| The ledger CLI | [docs/cli.md](docs/cli.md) |
| Every community pattern mapped to a primitive, and the deliberate "won't" list | [docs/idea-catalog.md](docs/idea-catalog.md) |
| What is next | [docs/roadmap.md](docs/roadmap.md) |

The research that shaped the design lives in `research_notes/` and `reports/`.

<br>

## Status

The 0.2 feature milestone includes gates as the unit of configuration and rollout, a State
builder, recipes routed through the engine, a CLI (`ratchet report | check | replay`), four
compounding strategies, learned composition, recalibration, a System One adapter (Jev wire
format, also spoken by Cloudflare Clef and Amazon Strands Decider), an LLM-backed oracle,
tests, simulation, demo. The adapter runs live against Jev through OpenRouter, which serves
the same wire format at `/api/v1/systemone`; put `OPENROUTER_API_KEY` in `.env` with
`scripts/set-key.ps1` ([docs/roadmap.md](docs/roadmap.md)).

The package manifest is currently `0.0.1` and private. The [publishing plan](docs/publishing.md)
tracks the remaining package, runtime, and hosting decisions; a feature milestone is not a
published release or an accuracy guarantee.

## License and third-party services

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Material quoted in
`research_notes/` and `reports/` belongs to its owners and is not covered by that license.

Ratchet is independent and not affiliated with or endorsed by TypeSafe, OpenRouter or any
other model provider. It ships no model: hosted backends run on your own key, under your own
agreement with each provider, and every state you ask about is sent to them. Those terms
forbid reselling access and distilling from model output, which rules out hosting a
pass-through service on your key or training a lookalike model on exported ledgers. Nothing
here is an accuracy or safety guarantee, and it should not be the sole basis for
consequential decisions about people. Read [third-party services and terms](docs/third-party-terms.md)
before using a hosted backend or hosting anything built on one.

<br>

<div align="center">

```text
        ────/|────/|────/|────/|────/|────/|────/|────/|────▶
                      click.  check.  advance.
```

</div>
