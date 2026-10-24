# Changelog

All notable changes to `@jmoak/ratchet`. The API is experimental until 1.0: minor versions
may change exported signatures, and every change that affects a gate's evidence (rubric,
policy, strategy, state builder or model pin) is called out so you know when to bump an
`evidenceVersion`.

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
