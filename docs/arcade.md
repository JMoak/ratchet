# The Ratchet Arcade

Four small browser games built on the existing engine. Start the local launcher:

```sh
bun run arcade
```

Open **http://127.0.0.1:3210**. No API key, network service, build step, or new dependency
is needed. Stop the server with Ctrl+C. Set `ARCADE_PORT` to use another local port.

| Applet | Play | Engine idea |
| --- | --- | --- |
| Signal Orchard | Guide Pip or let it choose trees and rest over a twelve-day harvest | Agent selection, optional simulated ensemble, and abstention |
| Bridge Builder | Help Bolt choose materials and cross five spans before supplies run out | Choose, verify, commit; previous spans survive a failed load test |
| Parcel Patrol | Share an eight-parcel conveyor shift with Dot, balancing time and care | Trusted manifests, untrusted notes, hard floors, and routing |
| Treasure Survey | Train Scout, freeze a digging threshold, and explore with limited energy and shovels | Agent navigation, separate practice labels, and calibration |

Each game has its own page, backend module, and tests under `examples/arcade/` and
`tests/arcade-*.test.ts`. The launcher and visual styles are shared; there is no game
framework or new production primitive. All decisions go through an actual `Engine`
and `Gate`, with a `MemoryLedger`. You can inspect the decision trail and download JSONL.

## Play with your companion

Manual controls work immediately. Each scene has a goal, limited resources, and an ending.
**Play** enables agent actions in that toy world and runs the loop to its ending.
**Pause** prevents subsequent turns; a current request can finish before it stops.
**Step** also enables agent actions, but advances only one turn at a time.
Opening a game starts in shadow; Play and Step are explicit requests to automate its
reversible game actions.

The controls sit above the scene and stay within reach while scrolling on larger screens.
**Turn pace** gives each result 1.8 seconds by default, with slower Consider and faster Quick
options. Pace changes presentation timing only; it never changes the seed, policy or game
commands. **Focus game** hides setup panels and compacts the scene; **Full page** restores
the explanations and settings. **Escape** or leaving the tab pauses automatic play.
Returning to the tab never resumes or purchases a new turn by itself. A request already
sent may complete and is still shown; pausing does not erase an observed action.

Review holds the proposed action, but does not freeze the game. Code advances a harmless
wait, inspection, or time step, consuming the relevant finite resource. A run reaches an
ending even if every model request fails. Pause at any time to help manually. The decision
trail is inside a disclosure below the game. It records proposals, applied actions, floors,
failures, and known toy-world outcomes; download JSONL to inspect the engine records.

**New game** generates a fresh seed and world. **Replay** resets the current seed, so the same
choices and settings reproduce the same outcome. Seeds change physical game conditions,
not just judge noise. Changing game settings or the agent's backend resets the run; the
backend stays locked while Play is running. Reloading starts a fresh world.
Scores and goals are game rules, not claims about model accuracy.

## Optional live AI

The free default uses scripted selection and seeded toy judges. For actual decision-model
choices, use an existing `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` in the server's `.env`
and start explicitly:

```powershell
$env:ARCADE_LIVE = "1"
bun run arcade
```

On macOS/Linux: `ARCADE_LIVE=1 bun run arcade`. Then choose **Live** in **Agent brain**.
The backend selector and permission to apply agent actions are independent. Merely storing
a key does not enable calls, and the page never receives it. Live sends only game
observations and any edited parcel note to the configured provider.

Live uses the existing version-pinned Jev adapter, without automatic HTTP retries.
The local server allows at most 100 distinct backend requests across games, at most 16
new requests in a single game update, and an eight-second deadline per request. It stops
new purchases after $0.10 in reported cost. This is a recorded-spend cutoff, not a prepaid
guarantee: an in-flight request can overshoot, and a failed request may have an unknown cost.
Unknown cost pauses further paid calls until a server restart.
The live status displays when the request limit, cache limit, or spending cutoff prevents
new judgments. Such requests still become review holds; the game's safe fallback continues.

Exact state/question requests, including failures and request-limit holds, are cached for
the server's lifetime. Reconstructing a run reuses those results instead of buying earlier
turns again. The bounded cache is application replay machinery; its verdicts are never
inserted into future model observations. A server restart clears the cache and budgets;
start a fresh game after restarting. Nothing is billed by offline play.

Cache-hit decision rows have zero additional cost, with the original call's cost/time in
vendor metadata. Reconstructed ledgers describe that update's requests; the live status
shows cumulative reported spending across the server. Repeated cached rows are not new,
independent validation evidence.

Live Orchard uses one judge rather than repeatedly asking the same model for nominally
independent votes. Its five-scout comparison belongs to the offline simulation.
Bridge's code filters out materials that cannot meet the physical constraints before
asking for a preference. If exactly one material is eligible, it skips the picker.
Every proposed placement still goes through the load-verification gate.

## How to read the examples

Offline judges are seeded simulations or explicitly scripted toy judges. Game-world facts
supply outcome labels after each judgment. They demonstrate mechanisms and failure
modes; their confidence values and scores do not establish live-model accuracy.

Agent automation defaults to shadow. Manual moves are recorded as the player's baseline,
separately from the engine's recommendation. Enabling automation lets accepted agent moves
change the toy world. Code-owned constraints still apply. An unavailable model yields
review; it does not silently switch to a scripted oracle.

Only reversible game state changes. There are no purchases, messages, or other agent tools
outside the game. Optional live model requests are the only external service calls.
Ground truth is used by the simulator and evaluator,
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
or evaluate a single round. The optional live runtime keeps a bounded response cache,
call counter, and reported-cost tally in memory, with no session database or cleanup daemon.

These applets are readable examples, not an authorization service or a competitive
game backend. A player can inspect the source, replay seeds, or alter their browser's
requests. Production integrations still need representative independent labels and a
deliberate rollout policy as described in the [pilot guide](pilot.md).
