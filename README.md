# ratchet

**Small judgments. Deliberate moves.** A decision engine that compounds cheap, calibrated
machine judgments into reliable automated decisions.

```text
             .-.
             |o|                 R A T C H E T
          .--'-'--.
     _   /  o   o  \   _         the model proposes.
    / \  |    >    |  / \        code decides.
    \_/==| .-----. |==\_/
         | | >>> | |
         | '-----' |             [ ACT | REVIEW | REFUSE ]
         '---+---+-'
          __|   |__
         [___] [___]             click. check. advance.
```

`TypeScript · strict` &nbsp; `Bun 1.3.x` &nbsp; `0 runtime dependencies` &nbsp; `shadow by default`

[Play the arcade](docs/arcade.md) · [Run locally](#run-it) · [Vision](docs/vision.md) ·
[Architecture](docs/architecture.md) · [Evidence](docs/pilot-results.md) ·
[Publishing plan](docs/publishing.md)

*Working name; pre-release source checkout. Package and hosted arcade publishing are being
[planned](docs/publishing.md).*

Decision models (TypeSafe's Jev, launched September 2026, and the rivals that followed within
weeks) answer typed questions in under half a second for hundredths of a cent, with a
calibrated probability attached. They are right about 80% of the time on mixed work. Every
vendor leaves the same things to "your code": when to act on an answer, how to combine
answers, when to escalate, and how to know whether any of it is working.

This is that code, done once, carefully, with the mathematics in the comments and a
simulation that shows where it breaks.

```ts
import { Engine, judge, jevViaOpenRouter, oneWayDoor, policyWithBand, refuseIf, State } from "./src/index.ts";

const engine = new Engine({ oracle: jevViaOpenRouter(), budgetUsd: 5, auditRate: 0.05 });

// A gate is one decision point: its question, policy, floors, rollout contract and ledger slice.
const safe = engine.gate({
  id: "bash.safe",
  question: judge("Is this command safe to run without asking the user?"),
  policy: policyWithBand(0.85, 0.1),           // act at 0.95 and above; the band below it is reviewed
  floors: [refuseIf(/rm -rf \/(\s|$)/), oneWayDoor((s) => /--force|DROP TABLE/.test(s))],
  promisedAccuracy: 0.98,                        // observed-accuracy target; see rollout limits below
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

Rollout currently compares observed accuracy with its target. Before relying on automatic
promotion, independently validate the policy on representative labels; audits of allowed
actions do not validate a lower action bar. The [roadmap](docs/roadmap.md) puts this evidence
loop ahead of more integrations.
Rollout evidence is scoped to its rubric, effective policy, configuration version and model
pin. Every promotion or demotion starts a fresh ledger phase. Save `safe.rollout.checkpoint()`
yourself for restart; without a valid checkpoint the controller starts in shadow again.
See [rollout lifecycle and migration](docs/rollout.md) for the exact boundaries and limits.

## Why it exists

- **Aggregating compounds accuracy; chaining compounds error.** Five independent 80% votes
  are right 94% of the time. Ten dependent 80% steps succeed 10.7% of the time. The engine
  gives you the first and defends you from the second.
- **Correlation and calibration decide whether any of it works.** Both are measured from the
  ledger, never assumed.
- **The model proposes; code decides.** Floors are code. Fail-open means review. One-way
  doors are never automated. The default is shadow mode.
- **The 80/20 split is a human-factors trap**, so confident acts are blind-audited at random,
  and thresholds are fitted only on data the oracle did not select.

Read [docs/vision.md](docs/vision.md) for the argument, [docs/architecture.md](docs/architecture.md)
for the code, [docs/sim-results.md](docs/sim-results.md) for the simulated tables,
[docs/live-findings.md](docs/live-findings.md) for what Jev actually did on 1,800 live calls,
[docs/live-recipes.md](docs/live-recipes.md) for the recipes measured live, and
[docs/idea-catalog.md](docs/idea-catalog.md) for every community pattern mapped to the engine.

## Run it

```
bun install
bun run check     # types, lint, tests
bun run sim       # the thesis as six tables, from the engine's own code
bun run demo      # a PreToolUse gate: shadow -> label -> fit -> enforce -> audit
bun run arcade    # four local browser games using the engine; no keys needed
bun run pilot     # source-inspired shadow pilot + fixed-policy evidence experiment
bun run pilot --live  # same pilot through Jev; keeps every application action in review
bun run quickstart  # live: triage one message with Jev via OpenRouter (needs a key in .env)
bun run live        # live: the five calibration, routing, cascade and cost experiments (< $0.10)
```

Checks and simulations need no network or keys; the demo uses a simulated oracle unless
`TYPESAFE_API_KEY` is set. Quick start and live experiments call paid backends.
The simulated oracle has known accuracy, calibration and error
correlation so every claim can be checked against the truth.

The [shadow pilot](docs/pilot.md) includes sourced application scenarios, separate fit and
validation groups, persisted evidence, and exportable charts. Its authored labels exercise
the workflow without claiming production accuracy. Read the
[first live results and graphs](docs/pilot-results.md).

For hands-on examples, play the [Ratchet Arcade](docs/arcade.md): four small games about
ensembles, verified progress, hard rules, and learning from a ledger.

## Status

The 0.2 feature milestone includes gates as the unit of configuration and rollout, a State
builder, recipes routed through the engine, a CLI (`ratchet report | check | replay`),
four compounding strategies, learned composition,
recalibration, a System One adapter
(Jev wire format, also spoken by Cloudflare Clef and Amazon Strands Decider), an LLM-backed
oracle, tests, simulation, demo. The adapter runs live against Jev through OpenRouter, which
serves the same wire format at `/api/v1/systemone`; put `OPENROUTER_API_KEY` in `.env` with
`scripts/set-key.ps1` ([docs/roadmap.md](docs/roadmap.md)). Research behind the design: `research_notes/` and
`reports/`.

The package manifest is currently `0.0.1` and private. The [publishing plan](docs/publishing.md)
tracks the remaining package, license, runtime, and hosting decisions; a feature milestone
is not a published release or an accuracy guarantee.
