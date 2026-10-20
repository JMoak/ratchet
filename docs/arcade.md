# The Ratchet Arcade

Four small browser games built on the existing engine. Start the local launcher:

```sh
bun run arcade
```

Open **http://127.0.0.1:3210**. No API key, network service, build step, or new dependency
is needed. Stop the server with Ctrl+C. Set `ARCADE_PORT` to use another local port.

| Applet | Play | Engine idea |
| --- | --- | --- |
| Signal Orchard | Pick trees over a twelve-day harvest; compare one scout with five | Ensemble pooling, explicit correlation assumptions, and abstention |
| Bridge Builder | Choose materials to complete five spans while keeping earlier progress | Verify before committing, retry, code-owned constraints, and failure → review |
| Parcel Patrol | Route imaginary parcels; inspect manifests and suspicious sender notes | Trusted state, untrusted text, hard floors, and manual versus automated action |
| Treasure Survey | Practice on one map, freeze a digging threshold, then explore another | Ledger-based fitting, separate evaluation data, and calibration |

Each game has its own page, backend module, and tests under `examples/arcade/` and
`tests/arcade-*.test.ts`. The launcher and visual styles are shared; there is no game
framework or new production primitive. All decisions go through an actual `Engine`
and `Gate`, with a `MemoryLedger`. You can inspect the decision trail and download JSONL.

## How to read the games

The judges are seeded simulations or explicitly scripted toy judges. Game-world facts
supply outcome labels after each judgment. They demonstrate mechanisms and failure
modes; their confidence values and scores do not establish live-model accuracy.

The default is shadow. Orchard, Bridge, and Treasure show suggestions without applying
automated game moves until you enable toy automation. Parcel lets you make manual moves
in shadow and compares those with the engine's recommendation; its ledger records your
manual choice as the baseline. Enabling automation lets the engine route the toy parcels.
Code-owned floors still constrain automated actions.

Only reversible game state changes. There are no external actions, live backend calls,
accounts, or hidden credentials. Ground truth is used by the simulator and evaluator,
never fed back as an engine verdict into the next model state. Floor placeholders and
failed judges are identified in the trail instead of shown as genuine confidence scores.

Settings that replay a world are experiments on the same data, not fresh validation.
The orchard's correlation slider changes the pooling assumption for the same votes;
it does not measure their correlation. Treasure's practice and expedition maps are
separate, but repeatedly replaying the expedition still turns it into familiar data.

## Implementation boundaries

The server binds to loopback, accepts only its explicit routes, checks request origins,
and bounds JSON request sizes. Each applet validates its own controls and limits its
rounds. It does not expose arbitrary workspace files or write game history to disk.
The page owns its play history; reloading resets it. Requests reconstruct a toy world
or evaluate a single round, so no session store or cleanup daemon is needed.

These applets are readable examples, not an authorization service or a competitive
game backend. A player can inspect the source, replay seeds, or alter their browser's
requests. Production integrations still need representative independent labels and a
deliberate rollout policy as described in the [pilot guide](pilot.md).
