# Changelog

All notable changes to `@jmoak/ratchet`. The API is experimental until 1.0: minor versions
may change exported signatures, and every change that affects a gate's evidence (rubric,
policy, strategy, state builder or model pin) is called out so you know when to bump an
`evidenceVersion`.

## 0.3.0-alpha.1 (unreleased)

The first version released through CI: a push to `main` with a new version runs the checks, builds, and stages the
package on npm through trusted publishing, where it waits for a 2FA approval.

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

### Evidence

- New gates `agent.tool.claude-code` and `agent.tool.codex`, evidence version `agent-tool-v1`,
  placeholder bar 0.95 until a fit phase freezes one. Same promise and plan as the keywork
  gate. No existing gate's evidence changes.

### Changed

- The CLI prints nothing when a command's output is empty, so a hook's stdout stays clean.
- The README imports from the package.

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
