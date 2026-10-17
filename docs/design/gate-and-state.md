# Design: Gate, State, and recipes through the engine

Status: approved direction, 2026-10-17. This is the spec the implementation agents build to.
It follows from `docs/idea-catalog.md` and the two research reports, and from walking ten
applications through the current API (section 1). Invariants in `AGENTS.md` still bind.

## 1. The applications this shape must serve

Each row is a real pattern with evidence in the research. "Fit" says whether the proposed
shape serves it without contortion; the last column is what the walk-through changed.

| Application | Decision points | State | Fit | What it added to the spec |
| --- | --- | --- | --- | --- |
| Coding-agent PreToolUse gate (Claude Code hook) | `bash.safe` judge, floors for irreversible commands, allowlist bypass, drift-sized band, rollout from shadow | command, cwd, branch; tool output excluded | yes | nothing new |
| Stop-hook "done" verifier (AUROC 0.976 with four questions) | one decision point that is a battery of four judges combined by a fitted model | diff summary, test results digested, the agent's claims | needs batteries | a Gate may own a battery and a combiner |
| Context compaction (40 to 46% cut, zero required lines lost) | `context.keep` judge per item, shared context, up to 64 items per request | task plus one-line item summaries, never bodies | yes if recipes go through the engine | rows from one request share a request id |
| Bulk triage, a million tickets | `department` pick over 77, `urgent` judge, `frustration` rate; shortlist below the bar | records rendered with relative dates and counts | yes | fitting needs a coverage-at-target readout per gate |
| Systematic-review screening (AUC 0.966, calibration poor) | `include` judge; the target is recall, not precision | title plus abstract | mostly | fitting needs a recall-target mode |
| Browser next action (speculative heads) | root `op` pick plus one branch pick per operation | goal plus element table | yes | speculate takes a group of gates, not a raw oracle |
| Entity resolution (F1 to 0.996) | `same_entity` judge, or a battery of attribute matches with a learned combiner | two records side by side, fields pruned | yes | State must render structured pairs |
| Streaming log triage with shedding (300 msg/s, 12.6% shed to regex) | `severity` rate with a rules fallback | one event, digested | yes | nothing new |
| Invoice coding (71% auto-applied, zero errors) | `gl_code` pick with shortlist; selective prediction is the product | line item plus vendor history | yes | report coverage at the fitted bar |
| Reviewer queue and blind audits | not a decision point; a consumer of the ledger | n/a | out of library scope | the CLI must answer "what would this bar have done" |

Verdict: the three structural moves (Gate, State, recipes through the engine) survive every
row. Four refinements: batteries with combiners are a Gate feature, rows carry a request id,
fitting gains a recall-target mode, and the CLI gains `replay`.

## 2. Gate: the unit of configuration, learning and rollout

A Gate is one decision point. It owns the question (or battery), the policy, its floors and
bypasses, its strategy, its rollout contract, and its slice of the ledger.

```ts
export interface GateSpec {
  /** Stable decision-point id, e.g. "bash.safe". Ledger rows carry it. */
  readonly id: string;
  /** One question, or a battery of judge questions combined into one. */
  readonly question: Question | readonly JudgeQuestion[];
  /** For batteries: how members become one judge verdict. Default "logodds". */
  readonly combine?: PoolMethod | LogisticModel | ((verdicts: readonly JudgeVerdict[]) => JudgeVerdict);
  readonly policy: GatePolicy;
  readonly floors?: readonly FloorRule[];
  readonly bypass?: readonly BypassRule[];
  readonly strategy?: StrategySpec;
  /** Accuracy promised on acted rows; drives Rollout. */
  readonly promisedAccuracy?: number;
  /** Per-gate overrides of the engine defaults. */
  readonly mode?: Mode;
  readonly auditRate?: number;
  readonly tags?: readonly string[];
}

export interface Gate {
  readonly id: string;
  readonly spec: GateSpec;
  ask(state: string | State, opts?: { baseline?: Action; tags?: readonly string[] }): Promise<AskResult>;
  /** Several states, one gate: one request per state, bounded concurrency, budget-aware. */
  askMany(states: readonly (string | State)[], opts?: { concurrency?: number }): Promise<AskResult[]>;
  report(opts?: ReportOptions): Promise<QuestionReport>;
  readonly rollout: Rollout;
  mode: Mode;
}

// Engine becomes the registry and the shared machinery (oracle, ledger, budget, audits).
const engine = new Engine({ oracle, ledger, budgetUsd: 5 });
const safe = engine.gate({ id: "bash.safe", question: judge("..."), policy: policyWithBand(0.9, 0.1), floors: [...] });
const r = await safe.ask(state);
engine.gates;            // registry
engine.ask(...)          // still works: an anonymous gate with id "adhoc:<questionId>"
```

Semantics:

- A battery is asked in one request. Member verdicts are combined by `combine` into one judge
  verdict, which is what the policy rules on. The ledger stores one row per member (tagged
  with the gate id and a shared `requestId`) and one combined row (`strategy: "battery"`)
  that carries the ruling. Labels attach to the combined row; member rows inherit the
  outcome for calibration of each member, which is what makes learned combiners fittable.
- `combine` as a `LogisticModel` uses `poolLearned`; as a `PoolMethod` uses `pool`.
- Gate-level `mode` and `auditRate` override engine defaults; `Rollout` operates per gate.
- `engine.askAll(state, questions, ...)` remains for several different questions about one
  state in one request; internally each question maps to its gate (or an anonymous one).

Ledger additions: `gateId`, `requestId` (shared by every row answered from one oracle call),
and `combined: true` on battery rows.

## 3. State: evidence, built in code

```ts
const s = State.create()
  .field("command", cmd)                         // trusted, from the harness
  .field("cwd", cwd)
  .digest("hp", band(hp, HP_BANDS, "healthy"))   // arithmetic done in code
  .digest("last_login", relativeTime(lastLogin, now))
  .untrusted("tool_output", output, { maxChars: 2000 })  // marked and truncated
  .pair("left", recordA, "right", recordB, { keep: ["name", "email"] }) // side-by-side records
  .build();

s.text        // what the oracle sees: "command: ...\ncwd: ...\n\n[untrusted tool_output]\n..."
s.hash        // hash of the whole rendering (the ledger's stateHash)
s.trustedHash // hash of trusted fields only, for grouping and replay
s.untrusted   // names of untrusted spans, recorded on the ledger row
```

Rules the builder enforces:

- `field()` and `digest()` throw if the value is an engine object (anything with `verdict`,
  `ruling` or `decision` keys) or a string that looks like a rendered ruling. Verdicts never
  re-enter the state. This is invariant 8 made mechanical.
- `untrusted()` content is rendered under a marker and never used in `trustedHash`. The
  research shows markers do not stop injection; the marker is for the ledger and the auditor,
  and floors on untrusted content stay in code.
- Numbers and dates go in through `digest()`, never raw, when a comparison is the point.
- `Engine.ask`, `Gate.ask` and the recipes accept `string | State`; a string is wrapped as a
  single trusted field so nothing changes for existing callers.

## 4. Recipes through the engine

Every recipe takes an `Asker` instead of a raw oracle, so every answer is ledgered, budgeted,
floored and auditable:

```ts
export interface Asker {
  askAll(state: string | State, questions: readonly Question[], opts: AskOptions | ((q: Question) => AskOptions)): Promise<AskResult[]>;
}
// Engine and Gate implement Asker.
speculate(asker, state, { root, branches, policy })
relevance(asker, context, items, { policy, perRequest })
screenMany(asker, docs, questions, { policy, concurrency })
locateWith(asker, chunks, question, { policy, none })
```

Rows produced by one recipe call share a `requestId` per underlying request and a `recipe`
tag (`speculate`, `relevance`, `screen`, `locate`). The existing oracle-taking signatures are
removed, not kept; there is no reason to bypass the ledger.

## 5. Fitting target modes

`fitThreshold` gains a mode: `accuracy` (today), `recall` (lowest bar that keeps recall of the
positive class at or above a target, for screening), reported with coverage. `report()` shows
coverage at the fitted bar for every gate; invoice coding's "71% auto-applied at zero errors"
is exactly that number.

## 6. CLI

`bin/ratchet.ts`, no dependencies, over a JSONL ledger:

- `report <ledger> [--gate id] [--target 0.98]`: per gate, rows, labelled, unselected, accuracy,
  expected accuracy, ECE, Brier, fitted bar and coverage, posture (under / over confident),
  models seen.
- `check <ledger> --gate id --promise 0.98 [--min-rows 30] [--max-ece 0.05] [--model id]`: exit 1
  when audited accuracy is below the promise, ECE above the bound, or a model version other
  than the pinned one answered. For CI.
- `replay <ledger> --gate id --act-above 0.95 [--refuse-below 0.2]`: re-rule every recorded
  distribution under a new policy; print what would have changed and, on labelled rows, the
  accuracy and coverage the new bar would have delivered. This is why the ledger stores full
  distributions.

## 7. API tiers

Documented in `docs/architecture.md` after the refactor:

- **core**: types, questions, policy, floors, state, engine, gate, ledger, calibration, rollout.
- **compounding**: aggregate, learned, ensemble, sequential, cascade, chain.
- **adapters**: systemone, llm-json, rules, sim.
- **recipes**: speculate, screen, digest, loop.
- **utilities**: math.

Core and adapters are the stable surface. Recipes are expected to change.

## 8. Out of scope for this round

Reviewer UI, shared multi-process ledger (SQLite), hook and MCP packages, Box and images,
streaming token gates, novelty gate, request coalescing. All remain on the roadmap.

## Implementation notes: gate, engine, ledger, recipes (sections 2 and 4)

Deliberate deviations from the text above, as built:

- `combine` also takes `PoolOptions` (`{ method, correlation, weights }`), because invariant 7
  requires every pooling path to expose correlation. The default stays logodds, at
  correlation 0, which is the engine's default for explicit ensemble members.
- `GateSpec.rollout` (window and minimum rows) is added so `gate.rollout` is configurable;
  `gate.rollout` throws when the spec has no `promisedAccuracy`. `Gate` also exposes `engine`,
  `isBattery` and `auditRate`, and is generic in its verdict type.
- The `Asker` contract honours the caller's options: in `askAll`, the given policy and
  strategy rule each question even when a registered gate owns it, and the gate supplies its
  id, floors, bypasses, mode, audit rate and tags. Recipes depend on this. `Engine.ask` routes
  the same way as `askAll`, so it records under a registered gate when one owns the question
  and under `adhoc:<questionId>` otherwise.
- `askAll` now settles floored and bypassed questions before the oracle call, as `ask`
  already did; previously it sent every question and applied floors only to the ruling.
- A `requestId` is per engine request (one `ask`, `askAll`, `gate.ask`, or one state of
  `askMany`), which covers every row answered from its one oracle call and also the floored
  or non-single-strategy rows of the same request.
- Batteries: if any member fails open the battery fails open; a battery takes no strategy
  other than single; floors and bypasses see the combined question (id = gate id); when a
  floor or bypass settles a battery only the combined row is written. Member rows mirror the
  combined row's `soft`, `action`, `mode` and tags (including `audit`, so they count as
  unselected where it does); their `go` and `confidence` are their own. The combined row's
  cost is 0 because the members carry the spend.
- Inherited labels re-score `correct` against each member's own lean and set a new
  `Outcome.inheritedFrom`; the truth is the outcome's boolean `truth` or, without one, is
  recovered from the combined lean. `Ledger` gains optional `get` and `request`, and
  `JsonlLedger` reads rows written before gates as their own anonymous requests.
- The recipe tag is the tag `recipe:<name>` in `tags`, not a new field. Recipe results
  changed shape to carry `AskResult`s (`Speculated.root`, `Relevance.results`,
  `Screened.byDoc`), `policy` may be a function of the question, and `ScreenOptions.budgetUsd`
  is removed in favour of the engine's cap.
- `Report` gains `byGate`; its calibration figures skip battery members and rows a floor or
  bypass settled, matching the CLI.
