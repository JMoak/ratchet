# The Ratchet Arcade

Four browser games, each a duel: one seeded world run without the engine and with it, then the
same duel in hundreds of worlds. Start the local launcher:

```sh
bun run arcade
```

Open **http://127.0.0.1:3210**. No API key, network service, build step, or new dependency
is needed. Stop the server with Ctrl+C. Set `ARCADE_PORT` to use another local port.

*Rebuilt 2026-11-13.* The earlier arcade played each world turn by turn against scripted
judges and ended on a score. Every page now opens on its result, and the judges are seeded
simulations with a stated error rate, so the levers change outcomes for a reason.

| Game | The duel | Engine piece | At the defaults |
| --- | --- | --- | --- |
| Bridge Builder | Lay ten spans and walk, or verify each piece before building on it | `runChain`: verified commits, attempt budgets, a second verifier | Crossed 17% → 69%; collapses 83% → 8% |
| Signal Orchard | Pool five alike scouts as five, or as what is independent | Ensemble pooling with a correlation for each pair, and `priorYes` | Picks that were ripe 90% → 99%, where both pools claimed 98% or more |
| Parcel Patrol | A persuadable judge alone, or the same judge under rules in code | `State` with an untrusted span, `floorOn` over trusted entries | Bad parcels shipped 33 → 9 in 100; none that a rule covers |
| Treasure Survey | Promote when it looks good, or plan the test and keep auditing | `Rollout`: the planned exact test, audits, the three demotion rules | Worse Scouts promoted 99% → 3%; empty pits nobody saw 21 → 1.6 |

The figures are what the pages compute today, over fixed batch seeds. Change a world's rules
and they change; the tests in `tests/arcade-*.test.ts` assert the mechanisms with tolerances,
not these exact numbers.

## How a page works

1. **The result is already there.** Opening a page runs its default world both ways and the
   batch behind it, in under a second. Each square of a strip is one step of that world;
   point at it to read what happened. The launcher's cards show each game's headline from the
   same code.
2. **Watch it happen** replays the squares in order. It is a replay of a result already on the
   page and makes no request. **New world** draws another seed and puts it in the address, so a
   world can be shared or reloaded.
3. **Your levers** re-run the world and the batch as you move them. The batch uses the same
   worlds every time, so a figure moves only because a lever did.
4. **The target** is a set of conditions on the engine's arm that the defaults miss. Each can be
   met, and meeting all of them at once takes more than one lever.
5. **The whole trade-off** sweeps one lever across its range with the others held, and draws
   what each setting would do.
6. **The decision ledger** for the world on screen is at the bottom, with a JSONL download that
   the [trail viewer](cli.md) can open.

### What each game has to teach

- **Bridge Builder.** A chain of steps that each mostly work fails together: ten spans at about
  four in five is one crossing in six. Committing only verified pieces turns most failures into
  bridges that stop short with nobody on them. The inspector's bar trades collapses against
  stops, a budget shared across spans turns stops into crossings, and a second crew with its own
  instrument cuts the flaws that get through without raising the bar.
- **Signal Orchard.** Five scouts who share a sensor are worth about one and a third. Pooled as
  independent, they claim 99.6% and deliver 90%. Given the true correlation the pool's claim
  matches what it delivers, and it picks less. More scouts of one family buy almost nothing; a
  second family buys a lot. The sweep shows the claim and the delivery meeting at the truth.
- **Parcel Patrol.** Senders of bad parcels write notes that talk the judge round. Floors read
  the manifest's own values through the state's entries, so nothing in a note trips or clears
  one, and a floor only raises caution. Damage is on no manifest, so the rest is the judge's:
  withholding the note stops it working, and costs a few parcels that honest notes explained.
  **Be the sender** puts your own note on every bad parcel in the world on screen.
- **Treasure Survey.** Looking after every dig and promoting when the last twenty read at the
  promise promotes nearly every Scout. One planned exact test holds false promotions near its
  5% and passes about half the good Scouts; allowing a wrong dig in the sample passes more, with
  a longer sample. After promotion only audits can send a Scout back, and the window, detector
  and first-error rules trade empty pits nobody saw against good Scouts sent back for nothing.

## What is real and what is simulated

Every decision in an engine arm goes through a real `Engine` and `Gate` with a `MemoryLedger`:
`runChain` commits the bridge's pieces, an ensemble gate pools the scouts, `floorOn` rules hold
the parcels, and `Rollout` promotes and demotes Scout. The batch runs the same code as the world
on screen.

The judges are seeded simulations. Each takes one noisy look at a hidden fact and states the
probability that look supports, so a judge is calibrated by construction and wrong at a known
rate. Parcel Patrol's judge is persuadable on purpose. Ground truth belongs to the simulation: it
labels the ledger after each decision and never enters a later state.

The figures show how the mechanisms behave in toy worlds with known error rates. They are not
claims about any model's accuracy, and a world's parameters (how often a piece is sound, how
alike the scouts are) are chosen to make the mechanism visible.

## Optional live judge

For a real decision model in place of the seeded judge, use an existing `TYPESAFE_API_KEY` or
`OPENROUTER_API_KEY` in the server's `.env` and start explicitly:

```powershell
$env:ARCADE_LIVE = "1"
bun run arcade
```

On macOS/Linux: `ARCADE_LIVE=1 bun run arcade`. Then choose **Live** under the decision ledger
of Bridge Builder, Signal Orchard or Parcel Patrol. Merely storing a key does not enable calls,
and the page never receives it.

Live judges the engine's arm of the one world on screen. The batch, the sweep and the first arm
stay seeded, so the batch figures do not describe the live model. The model sees the same
observations the seeded judge does (load-test readings, sugar readings, the manifest and the
sender's note) and never the hidden fact. Live Orchard asks one judge rather than a panel, and
Treasure Survey is seeded only: an expedition is 300 identical questions.

Live uses the version-pinned Jev adapter without automatic HTTP retries. The local server allows
at most 100 distinct backend requests, at most 24 new requests in one update, and an
eight-second deadline per request. It stops new purchases after $0.10 in reported cost. This is
a recorded-spend cutoff, not a prepaid guarantee: an in-flight request can overshoot, and a
failed request may have an unknown cost, which pauses further paid calls until a restart. A
request the limits refuse becomes a review hold, as any failed judge does: a piece is not
committed, a fruit is not picked, a parcel goes to a person.

Exact state and question requests, including failures, are cached for the server's lifetime, so
reloading a world reuses its answers instead of buying them again. Cached verdicts are replay
machinery and are never inserted into a model's state. Cache-hit rows carry zero added cost with
the original call's cost in vendor metadata, and are not new evidence.

## Implementation boundaries

The server binds to loopback, accepts only its explicit routes, checks request origins, and
bounds JSON request sizes. Each game validates its levers against their ranges. A seeded game is
a pure function of its request, so the server answers a repeated request from a small in-memory
cache (60 answers) and runs each game's default once at startup. Nothing is written to disk.

Each game is one backend module and one page under `examples/arcade/`, with shared helpers in
`shared.ts`, the page driver in `duel.js`, and tests in `tests/arcade-*.test.ts`. There is no
game framework, no build step, and no new production primitive.

These are readable examples, not an authorization service. A player can inspect the source,
replay seeds, or alter their browser's requests. Production integrations still need
representative independent labels and a deliberate rollout policy as described in the
[pilot guide](pilot.md).
