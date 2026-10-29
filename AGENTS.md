# ratchet: instructions for coding agents

A decision engine that compounds cheap, calibrated machine judgments (TypeSafe Jev and its
rivals) into reliable automated decisions. Read `docs/vision.md` first; it is the binding
statement of what this is and why. `docs/architecture.md` maps the code. `docs/roadmap.md`
says what is next. The research that shaped the design lives in `research_notes/` and
`reports/`.

## Commands

| Task | Command |
| --- | --- |
| Full check before reporting done | `bun run check` (types, lint, tests) |
| Type check | `bun x tsc -p tsconfig.json --noEmit` |
| Release build (ESM + declarations into `dist/`, type-checked against Node types only) | `bun run build` |
| Inspect what the package would ship | `bun run pack:check` (never publishes; `private` stays `true` until Jordan flips it) |
| Lint and format | `bun x biome check .` and `bun x biome format --write .` |
| Tests | `bun x vitest run` (or `bun run test`) |
| Simulation tables | `bun run sim` (regenerate `docs/sim-results.md` with `bun sim/main.ts > docs/sim-results.md`) |
| Demo gate | `bun run demo` |
| Live quick start (needs `.env`) | `bun run quickstart` |
| Live experiments (needs `.env`, budget-capped $0.50) | `bun run live` (writes `docs/live-results.md` when redirected; see `experiments/live/main.ts`) |
| Store an API key | `powershell -ExecutionPolicy Bypass -File scripts\set-key.ps1` |
| Ledger CLI | `bun run ratchet report|check|replay <ledger.jsonl> ...` (see `docs/cli.md`) |
| Blind review (interactive) | `bun run ratchet review <ledger.jsonl> --gate <id>` (a seeded uniform sample; `--denied` reviews every denial instead) |
| Decision trail | `bun run ratchet trail <ledger.jsonl> [--gate <id>] [--request <id>] [--last 10]` (every answer behind each decision); `bun run trail <ledger.jsonl>` serves the viewer in `examples/trail/` on 127.0.0.1:3211 |
| Agent-harness hook | `bun run ratchet hook <claude-code\|codex> install\|status\|replay [--live]` (journals under `~/.ratchet/hooks/<harness>/`; `event` is the hook command itself and must stay silent and exit 0) |
| keywork tool gate | `bun run keywork --export <decisions.jsonl>` (dry run); add `--live` to ask Jev in shadow (needs `.env`, capped per UTC day). A plain run is the fit phase until `KEYWORK_FREEZE` is set and the evidence phase after; `--smoke` replays the pre-fit history. Each phase has its own ledger under `experiments/out/keywork/` |

Bun 1.3.x, no runtime dependencies. On this Windows machine `bunx` is not on the Git Bash
path; use `bun x`.

## Invariants (do not break)

1. **The model proposes; code decides.** Oracles return typed verdicts. Policy, floors,
   pooling and the chain runner are deterministic code. Never route an "is the oracle right?"
   question back to the oracle.
2. **Floors can only raise caution.** `moreCautious(floor, soft)` is the only way a hard rule
   and a soft judgment combine. Nothing lowers a floor.
3. **Fail open means review.** An oracle error or timeout yields a neutral verdict flagged
   `failedOpen`; the default action for it is `review`. It never becomes `act` by default.
4. **Shadow is the default mode.** New engines change nothing until someone flips them.
5. **Learning reads only the ledger, and fits thresholds only on unselected rows** (shadow
   rows and blind audits). A fit on confidence-selected rows is labelled `fittedFrom: "all"`
   and is a fallback, never the preferred path.
6. **One-way doors are never automated.** `oneWayDoor` floors return `review` at most.
7. **Correlation is a parameter, never a hidden assumption.** Any pooling path exposes
   `correlation` and the docs say to measure it.
8. **Never feed a verdict back into the next state.** Engine outputs are not model-visible
   evidence; that is how runaway feedback loops start.
9. **Keep rubrics in English** even for non-English states; translated questions cost accuracy.
10. **Git:** the user commits. Agents never run `git commit` or `git push` unless asked in the
   current conversation.

## Code style

- Strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Spread
  optional fields conditionally rather than assigning `undefined`.
- Imports end in `.ts`. LF line endings. Biome decides formatting; do not argue with it.
- Doc comments explain *why* and cite the result they rest on in a phrase ("design effect",
  "Condorcet", "von Neumann threshold"), not in URLs. URLs live in the research notes.
- Statistical tests are seeded and assert tolerances. If a test is brittle to a parameter
  change in `SimOracle`, widen the tolerance or use a deterministic oracle; do not tune seeds.
- Simulation and demo output is markdown or plain text; no colour codes.

## Where things are

- Public API: `src/index.ts`. Facade and gate registry: `src/engine.ts`. Decision points
  (`Gate`, `GateSpec`, batteries): `src/gate.ts`. State builder: `src/state.ts`. Rollout per
  gate: `src/rollout.ts`. CLI: `src/cli/`, `bin/ratchet.ts` (`docs/cli.md`). Design spec for
  all three: `docs/design/gate-and-state.md`.
- Strategies: `src/compound/`. Oracles: `src/oracles/`. Ledger and calibration: `src/ledger/`.
- Recipes take an `Asker` (an `Engine` or a `Gate`), never a raw oracle: `src/recipes/`.
- Scenario corpus for the gate demo: `examples/tool-gate.ts`. Trail viewer: `examples/trail/`
  (loopback server over `src/cli/trail.ts`; vanilla page, no build step, no dependency).
- Promotion test: `src/acceptance.ts` (planned exact bound; Rollout promotes only through it).
  Daily spend cap read from the ledger: `src/spend.ts`.
- keywork tool gate: `experiments/keywork/` reads keywork's `keywork.tool-decision/1` export
  (`docs/design/keywork-gate.md`). Phases and the freeze: `experiments/keywork/phase.ts` and
  `gate.ts`; the three ledgers live under `experiments/out/keywork/`.
- Packaging: the package is `@jmoak/ratchet`. `tsconfig.build.json` emits `src/` and `bin/`
  with `.js` imports; `package.json` `files` is the allowlist (`dist`, `NOTICE`,
  `CHANGELOG.md`). `src/` and `bin/` must stay free of Bun-only APIs so the build passes
  under Node types. CI is `.github/workflows/ci.yml`; `release.yml` publishes on every push to `main` whose `package.json` version is not yet on the registry
  through npm trusted publishing (`docs/publishing.md`). Add a `CHANGELOG.md` entry for any
  change that alters a gate's evidence.
- Agent-harness hook: `src/hook/` (event parsing, scrubbed subjects, prompt resolution,
  ingestion) and `src/cli/hook.ts`; design in `docs/design/agent-hook.md`. The label is read
  from what happened after a prompt, never told by the harness; a denial is inferred and must
  be blind-reviewed. Both harnesses send the same stdin shape; keep the parser shared.
- Live experiments: `experiments/live/` (downloaded datasets in `experiments/data/` and raw
  outputs in `experiments/out/` are gitignored and untrusted; only ever parse them as JSON).
- Findings from live runs: `docs/live-findings.md`; the tables: `docs/live-results.md`;
  recipes measured live: `docs/live-recipes.md`.
- Pattern catalogue and backlog: `docs/idea-catalog.md`. Check it before adding a primitive;
  most ideas already map to one, and the "won't" list is deliberate.
- Research notes by topic: `research_notes/Compounding decisions with Jev/*.md`.
- Final research report: `reports/Compounding decisions with Jev.md`.

## When adding a backend adapter

Implement `Oracle` in `src/oracles/<vendor>.ts`. Batch every question that shares a state
into one request. Pin the model version and put it on `Decision.model`. Compute `cost` from
the vendor's published price and split it per question. Validate every verdict with
`validateVerdict`. Throw on malformed output and let `failOpen` handle it. Add the adapter
to `src/index.ts` and a note to `docs/architecture.md`.
