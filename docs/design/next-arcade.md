# Next arcade: four games with an agent in the world

Proposal, 2026-10-20. These are four new applets, not changes to the current Orchard,
Bridge, Parcel, or Treasure games. Build them inside `examples/arcade/` using the existing
Bun server, browser JavaScript, CSS/SVG, `Engine`, `Gate`, and `MemoryLedger`. They require
no game framework, agent framework, new production primitive, or generated artwork.

The design test is simple: **after the player acts, the agent observes the changed world,
chooses its next action, and visibly changes that same world.** A questionnaire with an
animated answer does not pass. The player should want a useful teammate, have something
interesting to do themselves, and sometimes rescue the teammate's plan.

| Build order | Game | Player fantasy and action | Agent's job | Main decision problem |
| --- | --- | --- | --- | --- |
| 1 | Dinner Bell | Run a tiny busy kitchen; prepare food and hand off jobs | Autonomous sous-chef | Coordinate with a changing human plan |
| 2 | Spell Relay | Be the shield-bearer in a two-person magical arena | Wizard partner | Choose a spell and target under interacting effects |
| 3 | Moonlight Caper | Pull off a playful museum heist; distract guards | Clockwork thief | Interpret clues, gather evidence, and change routes |
| 4 | Pocket Starship | Get a damaged little ship home; reroute scarce power | Repair robot | Diagnose, test, recover, and know when to stop |

Dinner Bell is the best first build: cooperation is immediately legible, useful agent
behavior appears within three turns, and a bad decision creates a recoverable scramble.
Spell Relay is the cheapest second proof because its turns remove latency pressure.
Caper needs more authored clues; Starship needs the most careful causal simulator.

## The shared boundary

### A game loop, not a model-controlled simulation

Each applet owns a small typed world and a pure reducer:

1. The player moves or interacts with a visible object.
2. Code applies that action, advances scheduled world events, and builds the agent's
   observation. It lists legal affordances without ranking the best one.
3. The engine asks the game's registered gates for a typed choice.
4. Code checks the result's actual `action`, the world's revision, and the chosen move's
   preconditions. Only a current `act` may execute an agent move.
5. Code applies the move, renders its consequences, and records observed outcomes.

Pathfinding, collision, turn order, timers, recipes, spell effects, resource arithmetic,
and truth belong to code. The model receives observations and English rules; it never
receives hidden fault IDs, unseen guards, future events, ideal actions, or truth labels.
Only observed consequences and actual physical actions enter the next state. Do not
include past confidence, verdicts, recommendations, or rendered rulings as memory.

The first versions are paced turns: one player action, at most one agent action, then the
world beat resolves. Network waiting does not burn food or kill a run. Animate movements
between turns, and offer an explicit Wait action. This keeps the world alive without
pretending a hosted model controls collision at 60 Hz. Continuous time is a later option.

Use fixed, small action IDs and named targets. An absent target or illegal action is
rejected by code, even if the oracle assigns it confidence 1. Query only when the
observation changes. `Freshness` plus an application-owned world revision rejects an
answer after a restart, player intervention, or changed plan. A task can persist as
physical world state; a stored model rationale cannot become evidence for itself.

### Handing control back should be part of play

Every game starts in shadow: the teammate previews its move, and the player controls it.
The start panel has a clear **Let my teammate act** switch. Backend choice and permission
to act are independent controls. Playing with the scripted teammate also uses the engine.

`review` means the character waits and signals for help inside the scene: a bell, raised
wand, hand signal, or flashing repair beacon. The player can take over that actor's next
move, supply another observation through a game action, or change the goal. There is no
approve/reject modal or threshold slider in the main play area. A timeout does not trigger
an automatic inspection, repair, cast, or substitute action.

`refuse` means the requested move cannot proceed. The player sees the physical reason
beside its target. Hard constraints remain in code. If a game later introduces a genuine
one-way action, it must use `oneWayDoor` and require a manual player action; no confident
oracle can authorize it. All initial game state is restartable and has no external effects.

Keep a small persistent badge for **Scripted teammate** or the pinned live model. Hide the
technical trail behind an optional drawer. The main screen shows goals, resources, actors,
and consequences. Completion presents the run's story and score before any model metrics.

### Real model, honest fallback, bounded calls

Live mode uses the existing `SystemOneOracle`/`jevViaOpenRouter` adapter, or the existing
`LlmJsonOracle` for a configured compatible model. Pin the configured version and record
it. Do not assume the historically tested `typesafe/jev-1.13` is the current best option.
Keys stay on the server; the page sends only its allowed game controls.

Offline mode is a named `RuleOracle` controller consuming **the same visible observations**
as the live model. It plays complete games with simple documented priorities. It cannot
read the world's private solution and must never be called a live AI. After a live failure,
the actor waits for review; switching to scripted play is an explicit player choice.

Use one request in flight per episode, no automatic retries for the first build, a
2-second oracle timeout, and a visible waiting animation immediately. Aim for under
500 ms median model time; measure rather than promise it. A slow backend is still playable
because the world waits. Batch questions sharing a state using existing `askAll` or
`speculate`; do not buy five identical votes for one decision.

Set an initial **recorded-spend stop of $0.05 per episode**, plus the request limits below.
This is a product constraint, not a price estimate or guaranteed prepaid cap:
`Engine.budgetUsd` sees billed costs afterward, so the final in-flight call can overshoot.
Bound observation size to roughly 1,500 tokens, action lists to at most 16 options, and
provider output where the adapter permits. Display actual recorded spend. Configure
prices from the provider's published values when implementing; do not invent zero cost
for a live model. Failures with unknown billed cost must remain identifiable.

Live play must preserve an episode's engine, ledger, and request counter across turns.
Do not reconstruct a whole run by calling the live oracle again for every historical
turn. Reuse existing arcade live-session support if present; otherwise a bounded
in-memory episode map in the example server is sufficient: at most four episodes, a
30-minute idle expiry, and deletion on restart. This is application state, not a new
Ratchet session framework. Replay consumes recorded moves and spends nothing.

### What the engine contributes, and what it does not

These worlds are deliberately small enough that a good bespoke planner may beat a model.
Do not weaken the rules baseline, hide useful facts from it, or claim that a language
model is required to solve a six-room map. The experiment is whether a general decision
model can use changing instructions and contextual evidence to become a useful teammate
without writing a special policy for every combination.

Ratchet's contribution is the controlled boundary around that judgment: typed choices,
cost-sensitive abstention, floors, freshness integration, failure behavior, and a record
of what actually happened. A switch statement implements physics; it does not by itself
measure when a probabilistic teammate should yield control.

Start action-pick gates at `actAbove: 0.6`, no refuse bar, as an explicitly provisional
gameplay setting. A 3:2 wrong-action to delayed-action cost ratio motivates that starting
bar; it is not an accuracy promise. Tune only after labelled development runs, freeze
before evaluation, and report intervention frequency. More consequential readiness
judges can begin at a 4:1 ratio, or 0.8. Use code floors for categorical constraints.
No ensemble or correlation claim is needed for this round.

Keep the run's event journal alongside the `MemoryLedger`: action IDs, actor, world
revisions, score changes, reason a stale result was ignored, and final completion. The
existing ledger alone does not encode every application side effect. Join by record ID.
Only label a decision `correct` when an independent game evaluator has a stated answer
or acceptable action set. A successful episode is not proof that every pick was correct.
Do not turn a subjective action preference into a fabricated calibration label.

## 1. Dinner Bell

**The pitch.** You and a small clockwork sous-chef must survive the dinner rush in a
restaurant barely larger than a table. You start chopping mushrooms; your partner should
notice, put the water on, and clear a plate. A surprise order change makes the two of you
reorganize instead of repeating a fixed recipe.

**The board and loop.** One 6-by-5 kitchen, two actors, two burners, a chopping board, a
sink, a serving hatch, and a shared counter. Clicking a station moves the player there;
clicking an available object performs its next physical step. Each interaction consumes
one beat. Walking to an adjacent station is one beat; the tiny map keeps travel readable.
Food progresses from raw to chopped, cooking, ready, and burnt. Ticket patience falls
each beat. The agent sees the player's position, carried object, and explicit job claim.
The player can pin “I have this” to a ticket or station and can cancel that claim.

Start with three fictional dishes and six tickets over 36 beats. Ingredients, plate
availability, burner occupancy, cook progress, and ticket patience are visible. Recipes
are deterministic. Tickets include authored natural-language variations such as “the
smoky bowl, but keep it mild”; the underlying scenario owns the requested recipe and
modifiers, while the agent sees the ticket text and menu descriptions.

**Finish.** Serve at least four correct tickets before closing to win. Three abandoned
tickets lose the shift early; otherwise beat 36 ends it with a clear result. Wrong dishes
can be recovered at a time/ingredient cost. Better runs earn more tips and waste less.
Replay varies ticket order, phrasing, one blocked station, and the timing of a menu change.
Only use seeds with a feasible four-ticket plan.

**The agent decision.** Register `dinner.next-task`, a `pick` over a bounded set of task
slots plus `wait` and `request-handoff`. Each slot maps in trusted state to a concrete
task, target, duration, required objects, and availability. Example rubric:

> Choose the next useful kitchen task. Coordinate with the player's active claim, finish
> endangered orders, and avoid duplicating work. Wait or request a handoff when no useful
> independent task is available.

The reducer executes one step of the chosen task. Re-ask after a material event, a
completed task, a blocked path, or a changed player claim, not after every animation.
An application task reservation prevents two actors spending the same ingredient.
Code removes unavailable tasks from the slot table and validates the selected slot again
after the answer; a completed shift floors the whole gate to refuse. Floors run before
the oracle, so they cannot inspect a choice it has not made yet. On review the robot
rings its bell and leaves its hands unchanged.

**Why judgment is interesting.** The semantic ticket, current human commitment, and
urgency interact: chopping a valid ingredient can still be the wrong help. The engine
makes uncertainty over that coordination explicit. The baseline follows earliest
deadline, respects claims, and prioritizes burning food; it has the complete public menu.
Measure duplicate work, completed tickets, and player takeovers. If rules win, show that.

**Smallest implementation.** One page, one typed reducer/controller module, three recipes,
six station types, four authored interruptions, and simple SVG actor motion. No dialogue
generation, free-form recipe generation, skill trees, or multiplayer. Maximum 36 live
requests, usually fewer because a task can last several beats.

**End-to-end acceptance.**

- A scripted full shift serves four tickets and reaches the win screen; another fixture
  reaches closing with a loss. Restart clears actors, tickets, ledger, and pending work.
- Claiming the chopping job causes an injected cooperative oracle to choose a different
  useful task. Its returned action changes the pot/counter, not just a recommendation.
- Change a claim or occupy a station while its request is pending: the old response
  cannot consume an ingredient or move either actor.
- An oracle timeout rings the bell, creates a failed-open row, and lets the player finish
  the ticket manually. Offline mode completes the same game without any network call.

**Inspiration and difference.** Cooperative cooking comes from
[Overcooked](https://www.team17.com/games/overcooked).
[Overcooked-AI](https://github.com/HumanCompatibleAI/overcooked_ai) is an existing
human-agent coordination benchmark; [ParaCook](https://arxiv.org/abs/2510.11608) studies
collaborative cooking plans and reports coordination weaknesses. This proposal borrows
the readable shared-work setting. Its particular tiny restaurant, authored ticket
changes, and Ratchet-controlled teammate are proposed here; cooking with an AI partner
is not a claimed invention.

## 2. Spell Relay

**The pitch.** You carry the shield. Your wizard partner supplies the fireworks.
Protect a lantern from approaching paper monsters by setting up a clever combination:
stand in front of a beam, push a beetle onto a puddle, and let the wizard freeze it.

**The board and loop.** One 7-by-7 board. The player moves one tile, turns the shield,
shoves an adjacent enemy, or places one of two decoys. Enemy attacks are telegraphed
before the player acts. The wizard then chooses one spell and target, after which all
enemy intentions resolve. All collision and damage are deterministic.

The wizard starts with four spells: push, freeze, arc, and shield. Each has an English
effect card and code-owned semantics. Three enemy types have visible behavior cards,
including conditions such as “charges toward the last noise” or “splits unless frozen.”
The important information is on the board and cards, never hidden in the oracle prompt.
Mana, cooldowns, lantern health, enemy intentions, and shield direction stay visible.

**Finish.** Survive ten turns with the lantern intact. Three lantern hits lose immediately.
Score remaining health, enemies redirected into one another, and unused decoys. Replay
changes terrain, enemy order, and one authored spell modifier. There is no campaign.

**The agent decision.** Use the existing `speculate(engine, state, ...)` with registered
gates `relay.spell` and `relay.target.<spell>`. The root picks one of four spells or
`hold`; each branch picks a target from at most eight visible target slots or `none`.
The branches ask which target is best **if that spell is selected**, all on the same
post-player state. Example root rubric:

> Choose the spell that best protects the lantern through this turn's announced attacks,
> accounting for the player's shield and the spell effects. Hold if no useful cast exists.

Execute only if the root and its selected branch both have actual `action: "act"`, the
root chose a spell, and the branch chose a currently valid target. Unselected branch
answers are never actions or free future plans. `hold` is an intentional act with no cast;
review is a raised wand and an invitation for the player to aim this turn's spell.
Code rejects cooldown violations, missing mana, and direct friendly-fire targets.

**Why judgment is interesting.** Choosing a legal spell is easy; noticing how a shield,
movement, a status effect, and the next enemy intention combine is the challenge.
The model interprets the effect cards and the player's setup, while Ratchet controls
whether to use the uncertain plan and buys the spell/target answers in one round trip.
Compare against a deterministic one-turn search over legal spell-target pairs; that is
a strong and honest baseline. This game may prove batching more useful than the model.

**Smallest implementation.** One grid, four spell functions, three enemy behavior
functions, ten turns, three terrain tiles, SVG effects. No physics library, generated
spells, generative narration, or opponent model. Maximum ten live requests; each has up
to five questions but only one executed spell.

**End-to-end acceptance.**

- A complete ten-turn run reaches a result, and a three-hit fixture ends immediately.
  The board visibly resolves the exact spell and target selected by an injected oracle.
- A root choosing `freeze` never executes the `arc` branch even when that branch is more
  confident. Review of the selected branch consumes no mana and casts nothing.
- Moving a decoy or restarting while a response is pending invalidates the entire
  spell/target pair. A target cannot disappear and be replaced by another actor at its ID.
- The player can aim a spell manually after a timeout and continue; no model response
  is required to resolve enemy movement or show completion.

**Inspiration and difference.** The compact board and visible enemy intentions are
inspired by [Into the Breach](https://subsetgames.com/itb.html). The proposed shield/wizard
division, magical interactions, and spell/target gates are this applet's design. Neither
telegraphed combat nor complementary character abilities are claimed as novel.

## 3. Moonlight Caper

**The pitch.** You distract a museum's overly serious wind-up guards while a little thief
retrieves a misplaced moonstone. The job describes the real exhibit indirectly; a shiny
decoy is easier to reach. A useful partner reads the clues, scouts before guessing, and
changes course when your distraction opens a better route.

**The board and loop.** Six connected rooms shown as a cutaway dollhouse, two guards, one
thief, three exhibits, two locks, and two hiding places. The player operates a noise toy,
light switch, or door switch; the thief moves, peers through a doorway, reads a placard,
uses a key, picks up an exhibit, or exits. Guards move one patrol step per beat and react
to the player's latest distraction. Vision and sound propagation are code.

The agent knows only visited rooms and currently visible guards. Read placards and
overheard curator remarks enter an observation notebook with source and turn. Example:
the contract requests “the instrument that marked the tides before the tower had a
clock”; two observed descriptions refer to time, but only one explains tides. The player
can mark a room as a waypoint, but does not select every footstep. No chat is necessary.

**Finish.** Return the correct exhibit to the entrance within 24 beats. A wrong exhibit
can be returned and replaced. Alarm level three catches the thief and ends the run;
time expiry also ends it. Score quiet exits, spare distraction charges, and fewest wasted
room visits. Replay permutes exhibit descriptions, patrol phase, room connections from
three solvable templates, and which clue resolves an ambiguous contract.

**The agent decision.** `caper.next-move` picks one of at most twelve concrete visible
action slots plus `wait` and `request-waypoint`. The observation includes the contract,
notebook facts, visible patrol evidence, inventory, and route distances computed in code.

> Choose the next move toward retrieving the requested exhibit and returning to the
> entrance. Use observed clues to identify it, gather missing evidence when needed, and
> account for visible guard movement and the player's distraction.

A second `caper.exhibit-match` judge is asked only when an exhibit is a pickup candidate:
“Does the observed evidence identify this exhibit as the object requested by the
contract?” Its initial act bar is 0.8. A pickup requires both gates to act. This second
ask is dependent on the selected candidate; do not claim it batches with the first.
Movement continues with one gate. A floored locked door or impossible path cannot be
overridden by placard text. Review makes the thief crouch and raise a hand; the player
can scout, set a waypoint, or directly perform a move on the next beat.

**Why judgment is interesting.** Pathfinding and guard cones are deterministic; matching
indirect descriptions and deciding when to gather evidence are not supplied as an ideal
action. The engine allows the agent to decline a poorly supported pickup without
turning the entire game into approve/deny questions. The rules baseline uses public
clue wording/keyword matching, nearest unexplored room, and the same pathfinder. It cannot
see the correct exhibit ID. Compare retrieval success, alarms, and unnecessary scouting.

**Smallest implementation.** Six rooms rather than a free-moving maze, six contract/clue
families with two paraphrases each, three patrol templates, two distraction tools, and
one inventory slot. Keep the full small notebook; do not add vector search, generated
clues, or a memory framework. Maximum 30 live requests, including at most six pickup
match checks. Accept only solvable seed/template combinations.

**End-to-end acceptance.**

- A full run reads a clue, acquires the matching exhibit, changes rooms, and exits.
  Picking the decoy does not win; capture and expiry both produce complete result screens.
- Moving a distraction changes guard movement and the thief's next observation. Hidden
  guard positions, the contract's answer ID, and future patrol steps never reach the model.
- A confidently wrong exhibit match can cause a recoverable mistake; the evaluator
  labels it from the authored contract. An uncertain match waits without taking anything.
- Timeout leaves the thief in place; manual scouting or moving remains playable.
  A placard containing “ignore the lock” cannot open a code-locked door.

**Inspiration and difference.** Small stealth decisions, changing security, and replayable
layouts are inspired by [Invisible, Inc.](https://support.klei.com/hc/en-us/articles/360029880011-What-is-Invisible-Inc).
This applet proposes a cooperative distraction role and semantic exhibit hunt. It is not
another Treasure Survey: there is no digging score or threshold-training map; the player
and agent share a spatial infiltration with consequences that persist across turns.

## 4. Pocket Starship

**The pitch.** You are the pilot of a tiny broken ship. Your robot mechanic has a wrench,
a diagnostic probe, and an imperfect understanding of the repair manual. Get the drive
working before the next storm while keeping enough power for cooling. The satisfying
moment is discovering that the blinking engine is healthy and its upstream relay is not.

**The board and loop.** A cutaway ship with four connected modules: power, cooling,
navigation, and drive. Three power pips, two spare parts, heat, hull, robot position, and
diagnostic readings are visible. The player moves power between modules or operates a
temporary bypass. Each player move is followed by one robot move and a simulation beat.
Storm events and heat follow a small seeded deterministic schedule.

The robot can move to a module, inspect it, swap a part, reconnect a cable, run a test,
or declare ready. It sees raw observed symptoms and short authored manual excerpts,
including conditional relationships. Inspection reveals another observation, not the
hidden fault label. A repair can remove a fault, do nothing, or create a reversible
resource problem. Cooling/power changes can invalidate an earlier test.

**Finish.** Restore the ship and reach the beacon by beat 20. The final launch is a manual
player action after the robot signals ready; code applies the launch's actual physical
outcome. Hull zero loses immediately; beat 20 ends in a tow if the beacon was not reached.
A failed launch costs time/hull and can still be recovered before the deadline. Score
arrival, remaining hull, spare parts, and avoided repeat repairs.

Replay varies two faults drawn from six causal patterns, the manual's authored wording,
and one storm disruption. Only combinations with an attainable repair plan are playable.
The world needs actual dependencies: turning power away from cooling changes heat, and
repairing the relay changes what a drive test reveals.

**The agent decision.** `starship.next-step` picks from at most twelve concrete legal
action slots plus `wait` and `request-power-change`. Example rubric:

> Choose the next repair or diagnostic step that most helps reach the beacon with the
> available time and parts. Use observed symptoms and the manual's causal relationships.
> Avoid repeating an unchanged failed repair; ask for a power change when it is required.

Register `starship.ready` as a judge called only after the agent selects `declare-ready`:
“Do the observed tests and current configuration satisfy the stated flight requirements?”
Its starting act bar is 0.8; known missing mandatory tests floor it to review, impossible
configurations to refuse. A ready answer lights the cockpit indicator; it never presses
Launch. A failed/uncertain next-step answer makes the robot flash its beacon for a manual
command. Mandatory test validity and physical launch success remain deterministic.

**Why judgment is interesting.** The soft decision is diagnosis and information gathering
from the available evidence, not subtracting a heat number. The engine makes premature
completion and confident repeated mistakes observable, and lets a repair plan yield
control. The rules baseline prioritizes failing mandatory tests, uses an explicit public
manual lookup, and picks the cheapest applicable repair. Compare successful arrivals,
parts wasted, repeated ineffective repairs, premature ready signals, and interventions.

**Smallest implementation.** Four modules, six faults, six robot verbs, a dozen authored
symptom/manual snippets, and a simple dependency graph. No general simulator, procedural
manual generation, combat, or crew management. Use ordinary application state transitions;
do not add a general agent loop runner. Maximum 24 live requests, including at most four
readiness checks.

**End-to-end acceptance.**

- A full run diagnoses an upstream fault, repairs it, passes tests, and reaches the beacon.
  A separate run reaches hull loss; expiry gives the tow ending rather than an idle screen.
- Swapping a drive part before checking the faulty relay does not magically repair it.
  A test failure produces a new observation that changes the next agent decision.
- Moving power after a successful test invalidates that test where the simulator says
  it should. A pending readiness answer cannot mark the changed ship ready.
- `declare-ready` never launches automatically. A timeout consumes no part; the player
  can manually finish repairs and launch. The ready judge can be labelled using the
  independent simulator rather than another model's opinion.

**Inspiration and difference.** The readable ship, scarce resources, and recovery fantasy
borrow from [FTL's publisher-authored game description](https://store.steampowered.com/app/212680/FTL_Faster_Than_Light/).
The proposed game concentrates on one repair incident and a diagnostic robot. Unlike
Bridge Builder, it has no sequence of isolated material checks: earlier actions alter
coupled systems, evidence can expire, and choosing what to inspect is part of the game.

## Build and acceptance plan

Start with Dinner Bell's offline world and a deliberately controllable injected oracle.
Prove the game is fun and causally connected before spending on a model. Then connect the
existing adapter, freeze its rubric and policy, and compare the same seed/player-action
fixtures with the honest rules baseline. Proceed in the table's order; each applet ships
independently, and a weak concept can stop without affecting the others.

For each applet, the minimum delivery is one HTML page, one typed game module, targeted
tests, a launcher card, and a short addition to `docs/arcade.md`. Share only established
rendering/session utilities. Keep scenario definitions beside their game. Do not make a
generic game engine because four pages happen to use turns.

The cross-game release bar:

1. A new player can identify their actor, the teammate, the goal, and their first action
   without opening the trail. Within three turns, the teammate does visible useful work.
2. Complete one win and one loss through the browser at desktop and narrow width. Exercise
   restart, manual takeover, keyboard controls, shadow, enforce, and scripted mode.
3. Controlled oracle fixtures prove that different returned choices produce different
   legal world transitions; a precomputed ideal action must not secretly drive the actor.
4. Controlled failures, malformed verdicts, late responses, depleted budgets, and changed
   targets produce no unauthorized agent mutation. Manual play always remains available.
5. Replaying a completed journal is deterministic and makes zero provider calls. Live
   counters and spend persist across turns; restarting cannot apply an old response.
6. Check state snapshots for hidden-truth leakage and for previous engine outputs.
   Exported ledger and application events agree on actual actions and intervention causes.
7. Run `bun run check`. Use browser end-to-end evidence for the actual playable loop;
   unit tests alone do not prove the game communicates its controls or reaches completion.
8. Before advertising live competence, run a frozen evaluation set of at least 20 distinct
   episodes per game, grouped by scenario family and with held-out wording/layouts. Report
   completion, game score, takeovers, calls, cost, latency, and model version alongside the
   rules baseline. Twenty runs are an initial comparison, not a reliability guarantee.
   Keep tuning episodes separate; no threshold fitting on confidence-selected successes.

The proposal is successful if players experience four different partnerships and can see
both the value and limits of each teammate. The engine's statistics explain those
experiences afterward; they are not the activity the player is asked to perform.
