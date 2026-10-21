# Pebble: a small room worth playing with

Research and design recommendation, 2026-10-20. Scope: tactile play, environment, and
emergence. This is a proposal, not an implementation or a human playtest result. It leaves
long-term attachment, memory, collection, and return progression to the companion research.

## Recommendation

Build a short, cooperative ball toy before adding more personality weights, dialogue, or
model calls. Let the player aim a gentle roll; let stones redirect it and a box catch it;
let Pebble notice the result and take a recognizable turn. A few consistent rules should
make the player think, **“What if I move this a little?”** The next attempt should be
interesting because the player has a new idea, not because the game withholds a reward.

The strongest first slice is **a bank shot into a cardboard box, with a creature who wants
to try too**. The same room can support a direct shot, a stone-assisted shot, a near miss,
an accidental return, and a player-designed course. Keep the existing six intentions.
Deepen what `play`, `inspect`, `arrange`, and `present` can visibly do with their existing
targets rather than adding a general planner or a catalogue of unrelated minigames.

This is a design hypothesis. No cited paper establishes that a virtual pet with these
mechanics will be compelling over weeks, and no current Pebble audit measures that.

## What the implementation currently affords

Inspected: `C:/src/pebble/AGENTS.md`, `README.md`, `src/world.ts`, `public/motion.js`, and
`docs/character-audit.md`, alongside Ratchet's vision, architecture, and agreed
`research_notes/virtual-pet.md`.

- Ball play selects a destination from the player-return location or a small positional
  variant. It does not calculate interactions with the box or stones.
- Stone arrangement commits one of three patterns. The three stones are one grouped
  target in the world model, not three independently draggable bodies.
- Box play changes needs and gives an authored make-believe performance; the box stays
  in place. The scene cue changes a small keyword-selected theme.
- The recent-history continuation gives meaningful two-beat habits. The character audit
  demonstrates more connected pairs, not that humans find the room more fun.
- Most actions last 10.5–13 seconds, and rest lasts 14. Ball movement begins at 52% of a
  ball action and finishes at 82%. Thus an invited return can begin roughly 5.5–6.8
  seconds after the new action starts, plus the remainder of an unrelated current action.
  Input already cancels an activity targeting the same moved prop; unrelated activities
  can continue. This is not an entirely unresponsive interface, but instant text
  acknowledgement is different from a prompt, controllable physical response.

The room is presently stronger as an expressive vignette than as a toy the player can
learn. Its missing ingredient is a consequential relationship between the things already
on screen. Another sequence selector cannot create that relationship.

## Evidence and its limits

The following separates empirical results, research arguments, developer accounts, and
the application hypotheses that follow. These are not interchangeable kinds of evidence.

| Source and evidence type | What it supports; what it does not |
| --- | --- |
| **Kao, Ballou, Gerling, Breitsohl, and Deterding, CHI 2024 — preregistered experiment, n=1,699.** [How does Juicy Game Feedback Motivate?](https://publikationen.bibliothek.kit.edu/1000171104/152952099) | In an action RPG, success-dependent feedback improved the studied motives. Random feedback variety did not improve curiosity; amplified feedback could undermine experience when action/outcome distinctions became obscured. Curiosity predicted voluntary playtime; enjoyment did not significantly do so in their model. This is unusually relevant evidence against treating random variants, extra spectacle, or session length as sufficient evidence of fun. Generalization is limited by the single genre, short sessions, and a potentially confounded amplification treatment. |
| **Ryan, Rigby, and Przybylski, 2006 — four studies.** [The Motivational Pull of Video Games](https://selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf) | Perceived competence and autonomy were associated with enjoyment and preferences; intuitive controls also mattered. This motivates testing whether players can choose a goal and become more effective at it. These associations do not identify a universal recipe for fun. The relatedness findings were studied in multiplayer contexts, so they are not evidence that an artificial pet supplies the same benefit. |
| **Tyack and Mekler, 2024 — critical analysis of 259 HCI games papers and practitioner discourse.** [Self-Determination Theory and HCI Games Research](https://arxiv.org/abs/2405.12639) | Documents shallow uses of self-determination theory. Use autonomy and competence as questions to investigate, not labels that certify a mechanic. “Players can choose three buttons” is not itself evidence of experienced autonomy. |
| **Ng, Lepinski, Wigdor, Sanders, and Dietz, UIST 2012 — direct-touch experiments.** [Designing for Low-Latency Direct-Touch Input](https://www.tactuallabs.com/papers/designingLowLatencyDirectTouchInputUIST12.pdf) | Participants preferred lower touch latency, with perceptible improvements below 10 ms on specialized hardware. The useful transfer is architectural: immediate input feedback should not wait for expensive application processing. This does not establish a universal latency threshold for Pebble, and it does not mean a deliberate creature animation should finish in milliseconds. |
| **Oudeyer, Kaplan, and Hafner, 2007 — computational and robotic experiments.** [Intrinsic Motivation Systems for Autonomous Mental Development](https://www.pyoudeyer.com/ims.pdf) | Learning-progress-driven exploration moved toward learnable situations while avoiding some unproductive unpredictability. This distinguishes learning from novelty seeking. It is not evidence that a novelty bonus makes a pet curious to humans, nor a reason to introduce reinforcement learning here. |
| **Mateas, 1997 — research/design position grounded in the Oz project.** [An Oz-Centric Review of Interactive Drama and Believable Agents](https://www.cs.cmu.edu/Groups/oz/papers/CMU-CS-97-156.html) | Believable character is an audience effect, requiring situated action and a specific authored personality. High general intelligence is not the goal. This supports an expressive failed attempt and a consistent response to it. It does not prove that a particular behavior tree or model will be believable. |
| **Malone, 1981 — early studies and a proposed theory.** [Toward a Theory of Intrinsically Motivating Instruction](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog0504_2) | Organizes motivating game features around challenge, fantasy, and curiosity; distinguishes fantasy bound to the actual skill from a decorative overlay. Treat this as a useful design lens, with an old and restricted evidence base. A cardboard spaceship becomes more meaningful when its rules affect the game, rather than merely changing a caption. |
| **Nintendo developers, 2024 — firsthand design account.** [Echoes of Wisdom, Part 2](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-13-the-legend-of-zelda-echoes-of-wisdom-part-2/) | The developers explicitly describe an early problem where allied echoes did the work while players watched and waited. They revised actions to produce immediate accomplishment. They also describe defining distinctive object roles and maintaining behavior across contexts. This is a particularly close precedent for Pebble's indirect-control problem, but it is a retrospective account, not a controlled result or a prescription to copy Zelda's scope. |
| **Nintendo developers, 2023 — firsthand design account.** [Tears of the Kingdom, Part 5](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-9-the-legend-of-zelda-tears-of-the-kingdom-part-5/) | Describes enabling player experiments and making visual signs agree with what objects allow. The transferable principle is consistent affordances, including understandable limits. This does not demonstrate that full physics is necessary, nor that more combinations are automatically more enjoyable. |
| **Jonasson and Purho, 2012 — live developer demonstration.** [Juice It or Lose It](https://www.gdcvault.com/play/1016487/Juice-It-or-Lose) | Shows the craft value of feedback and presentation. The public session listing establishes the demonstration's scope; it is not empirical evidence of effect size. Treat it as inspiration for polish, qualified by the experimental evidence above. |

My synthesis: make actions consequential, make those consequences readable, give players
room to choose and improve, and let surprises resolve into an understandable cause. This
is more defensible than “randomness makes it alive” or “LLM novelty makes it replayable.”

## Four small mechanics, ranked

The first three form one loop. The fourth is an alternative extension, contingent on the
loop already being enjoyable. Cost estimates below are relative engineering judgments,
not measured implementation hours.

| Mechanic | Player-visible value | Cost and failure risk | Recommendation |
| --- | --- | --- | --- |
| **1. Aim a roll** | Point the ball in a direction, choose how gently to push, and see a readable trajectory and resting place. The player can intentionally stop short, reach Pebble, or aim at a prop. | Medium: input design, canonical floor coordinates, a bounded path calculation, server authority, save/cancel semantics. Weak if controls are fiddly or a pet turn takes control away mid-aim. | Build first. Make one roll satisfying before adding combinations. |
| **2. Props with reusable physical roles** | The stone group redirects the ball; the box catches it through its visible opening. A later cushion rule can brake it. Moving a prop changes the next attempt in a comprehensible way. | Medium on top of rolling: a small set of contacts and visual/audio reactions. Large if expanded to stacking, arbitrary shapes, height, or rigid-body chains. | Build the stone and box rules for the slice. Leave independent stone dragging and general construction out. |
| **3. Pebble takes a turn with an idea** | After observing a roll, Pebble looks from the ball to an achievable destination, attempts one shot, then reacts to the actual outcome. A player may copy, improve, interrupt, or ignore the offer. | Low–medium after the toy exists: a few finite goals, local trajectory probes, two-beat continuation, and outcome-specific acting. High if replaced by a general goal planner or hidden cheating. | Build one direct/catch idea and one bank-shot idea, with the second enabled only when the geometry supports it. |
| **4. Hide, peek, reveal** | A ball concealed by the box leads Pebble to inspect the last observed location, peek around the edge, and discover it. The player can predict and tease the search. | Medium–high: visibility, last-seen facts, reliable depth cues, interruption rules, and accessible representation of occlusion. Can feel arbitrary if the pet appears omniscient or visually obvious objects count as hidden. | Defer. Add only if people enjoy interacting with Pebble more than perfecting shots. It needs no LLM. |

### 1. Aim a roll

Use deliberate aim and a small strength range rather than requiring a fast flick. A flick
is appealing on some devices but is a poor sole control: the result would depend on motor
speed, pointer sampling, and screen size. The main control can be select ball, choose a
direction, select gentle/medium/firm, release. Dragging may be a shortcut to the same
intent. Keyboard arrows adjust aim, a separate control adjusts strength, Enter rolls,
and Escape cancels. Tap an aim point plus three strength buttons offers a non-drag touch
path. These interfaces must submit the same bounded action parameters.

Show an initial heading and strength cue, not necessarily the entire solution path.
Offer a fuller trajectory assist as an option if precision is frustrating. Do not make
reduced motion a different or less capable game: show the intended heading, meaningful
contact markers, then the resting position, alongside a concise outcome description.
Sound must be optional and redundant. Avoid flashing or camera shake as the primary cue.

The player controls the ball directly. They invite Pebble to participate; they do not
remote-control every creature gesture. This preserves the creature's initiative without
making the player's basic physical action depend on a queue or a model response.

### 2. Portable object rules

Start with this small grammar:

| Object/contact | Rule | Useful transfer |
| --- | --- | --- |
| Ball on floor | Moves along an aimed path with predictable deceleration and a bounded range. | The same strength intuition works from a new starting position. |
| Ball meets a stone | Redirects from a visible solid boundary, losing some speed. | What blocked a direct shot can become a bank for another shot. |
| Ball enters the box opening | Is captured; the cardboard flexes and Pebble looks inside. | The box remains a destination after it is moved elsewhere. |
| Ball hits a closed box side | Deflects or stops under one consistent rule. | The player learns that the opening matters, rather than discovering a hidden catch radius. |

Keep stones grouped initially, with deterministic collision shapes matching each visible
arrangement. A row, tower, or triangle may change the floor footprint, but a drawn stack
must not imply a simulated toppling system that does not exist. Give the current geometry
an understandable outline while aiming if necessary. The first slice can use only the
row, retaining other patterns as decorative arrangements outside that play setup.

Avoid invisible exceptions around the bowl and cushion: either put the initial course in
an unmistakable clear floor area, or give nearby solid props simple consistent contacts.
The later cushion brake is a cheap additional role if players already try it. Do not add
coins, a combo multiplier, randomized prizes, or energy charges to every player roll.
Pebble's existing needs can influence its willingness to join; the toy itself remains
available while it rests.

The depth is relational. A layout that gives a clean catch also permits a shorter shot,
a deliberate miss, a bank, or a return to Pebble. A finite collection of unexpected
animations would not supply those choices.

### 3. A bounded creature experiment

Use a small, code-owned goal vocabulary, for example `reachPlayer`, `enterBox`, and
`touchStoneThenEnterBox`. These are parameters of `play`, not new intentions. One action
may be `inspect` and the next `play`; the success or miss reaction is part of the play
animation, not a third recursively generated goal.

Code can simulate a small, fixed candidate set of directions and strengths to check that
a proposed idea is physically feasible. This is a bounded local calculation, not a
generic planning framework. Select among plausible ideas using existing personality
and whimsy. Once selected, use the same physical rules as the player. Whimsy changes
which valid experiment Pebble chooses, not whether a stone secretly becomes permeable.

Give the idea a visible setup: Pebble looks at the opening, taps beside the ball, then
pauses briefly to offer the turn. It can make a real near miss from an authored bounded
aim variation, but the result must follow the path rules, not a hidden success lottery.
Read the resulting event: a short shot earns a look between ball and destination; a
stone contact earns a glance toward that stone; a catch earns a pleased inspection.

An optional second attempt may adjust just one parameter in response to a concrete
miss. Call this authored correction unless a real prediction is updated from outcomes
and improves on unseen layouts. An observed-history record can hold the last aim,
strength, contact sequence, and rest location. Neither a cute explanation nor an LLM's
claim of understanding is evidence of learning.

Do not have Pebble continually rearrange the player's course. Recent player manipulation
can suspend autonomous prop-moving under a simple code rule. It can still look, take a
turn, or present its idea. A brief “your turn” invitation should be understandable without
opening a journal or reading a paragraph.

## Feel and timing: separate a living rhythm from input delay

Keep long rests and occasional slow inspection for watching. Give active shared play its
own shorter timing. A first tuning pass could try roughly 2–4 seconds for a nearby pet
turn and under a second to begin a meaningful response when the pet is free. These are
prototype settings to test, not research-established thresholds. Distance, legibility,
motor accessibility, and the character's style should determine the final values.

The sequence should feel like touch → notice → intention → contact → result. A small
squash when grabbed, a glance toward the aimed path, and a contact-specific sound are
useful because they clarify that sequence. Do not reward a miss with the same elaborate
celebration as a difficult catch. “Almost” should be legible from the ball's location and
the pet's glance, without a score or fake suspense.

There are two different responsibilities:

1. **Direct manipulation feedback.** A local aiming preview follows input immediately.
   The authoritative roll is validated by code. No semantic call sits between a pointer
   movement and the visible response. A preview is not a committed world change.
2. **Creature response.** At a safe boundary, Pebble can finish a tiny settle, redirect,
   or visibly decline. It should not make a ball offer wait through the remainder of a
   14-second unrelated animation merely because all actions share one dwell contract.

Define explicit cancellation/settling boundaries. Before contact, cancel a displaced
target action from its current authoritative pose and commit no completion effects.
After a physical contact, preserve what actually happened and settle or start a new
finite action; do not replay the old endpoint later. A direct roll while a pet return is
pending invalidates that proposal. Avoid concurrent writers for the same ball.

This requires an intentional revision of the app's timing/state contract: the current
proposal validator requires 8–16 second durations, and `advance`, `motionFrame`, restore,
and tests share the current timing/effect model. Simply shortening a CSS animation would
desynchronize the visible and authoritative world.

Keep scene revisions, reset epochs, and fresh precondition checks. Journal a canceled
attempt as canceled, not completed; a held/stale model proposal cannot later apply its
precomputed path. Save the current finite path or enough validated parameters to reproduce
it, and freeze it with the existing logical clock when absent. Immediate input is not a
reason to weaken the stale-response or single-effect guarantees.

## Why a small kinematic toy is enough

| Approach | Benefits | Costs and limits | Choice |
| --- | --- | --- | --- |
| **Endpoint animation, as today** | Very simple, easy authored timing. | Other objects cannot change the outcome. No spatial experimentation unless special cases are added. | Insufficient for this loop. |
| **Bounded 2D kinematic path** | One moving ball, fixed floor, static prop shapes, a few contacts, deceleration, deterministic end. Can precompute a path and animate it using the logical clock. Straightforward replay and accessible previews. | Must choose and tune geometry, contact order, and edge cases. It will not support falling towers, arbitrary stacking, or realistic spin. | Recommended. |
| **General 2D rigid-body engine** | Easier future support for multiple interacting moving bodies. | Dependency/integration cost, collision tuning, timestep and save details, resting-body jitter, chaotic outcomes, more complex keyboard/reduced-motion explanation. | Reconsider only when a proven mechanic needs it. |
| **3D physics or model-generated actions** | A much larger possible space. | New renderer/authoring burden or ungrounded action promises; both enlarge verification and content scope dramatically. Neither establishes fun. | Exclude from this slice. |

For the recommended approach, use one canonical floor coordinate system with a stable
screen mapping; do not calculate physics in distorted percentage coordinates. Bound
trajectory length and contact count so degenerate arrangements cannot bounce forever.
For the first version, a prop edit during flight can cancel/settle the flight at the
current authoritative position before applying the edit. It need not simulate a moving
obstacle striking a rolling ball. Make that interaction understandable rather than
silently following the old path through the moved object.

This is more work than more captions, but it buys a reusable source of new situations.
Full physical realism buys much less for this particular five-minute experience.

## Strongest playable vertical slice

**One room, one ball, the existing stone group, one visible box opening, two finite
Pebble ideas, and a quick retry.** Keep feeding, self-care, pause, save, and quiet watching
around it. There is no new economy, content feed, skill tree, room, or generative system.

Implement one satisfying direct shot, then one stone-assisted catch. The player can move
the box and stone group, undo the last placement, and reuse the same layout. An undo or
reset of a reversible arrangement is useful for experimentation, not a performance test.
The pet's attempt must leave the actual ball somewhere useful for the next interaction.

**A possible first 30 seconds** — an authored onboarding example, not a guaranteed script:

- **0–5 seconds:** the player selects the ball. Pebble's eyes follow the aim. A gentle
  roll stops short of the open box; its little settling movement makes that distance clear.
- **5–12 seconds:** the player chooses a little more strength and catches it. The box
  flexes, Pebble looks in, then looks back. The player knows why the second attempt worked.
- **12–22 seconds:** Pebble nudges the ball back from near the box, glances toward the
  stone group, and makes one simple attempt. A visible deflection changes the course.
- **22–30 seconds:** the player moves the box into that new path and tries the same
  strength. The same objects now support a player-invented bank shot.

Do not force all four beats into a timer. The point is that a player can encounter a
complete input/outcome/revision loop in half a minute, rather than finish one long
animation and wait for another.

**A plausible five-minute session:** learn gentle and firm rolls; notice the stone's
deflection; reposition the box to exploit it; invite Pebble's turn; try to improve a
near miss; make an intentionally silly course; watch Pebble choose a different reachable
destination; finish with the ball in the box and the room still arranged as the player
left it. The player can stop after any attempt. The environment contains the evidence
of their experiment. Later sessions can reuse the same rules in new arrangements, but
five minutes of depth does not establish a long-term retention system.

## Ratchet's useful boundary

**The core slice needs no semantic model.** The current optional model is in shadow, so
it does not create player-visible play variety or causal depth. Ratchet supplies decision
instrumentation and rollout discipline; it cannot manufacture missing toy affordances.

| Decision | Owner | Reason |
| --- | --- | --- |
| Does the aimed roll reach a stone, stop short, or enter the box? | Deterministic game code. | Geometry and event order are ground truth, not semantic judgments. |
| Can the pet play now; is the ball reserved; has the scene changed; may this action commit? | Deterministic game code. | Timing, need floors, capabilities, and mutation authority. |
| Which feasible experiment suits the fixed personality or avoids immediate repetition? | The current bounded selector. | Small known state; no model is needed to choose between authored alternatives. |
| Did the player enjoy this? | Human evidence; carefully interpreted behavioral observations. | A model's approval or longer session is not a fun measurement. |
| Does a proposed finite beat respect an informal pretend-play cue? | A possible Ratchet semantic gate. | Relational language and unusual metaphor may exceed a short keyword table. Must demonstrate an advantage over simple explicit controls. |

A useful future English rubric could be: “Given these observed scene facts and this exact
bounded activity, is the activity a coherent response to the player's play cue, including
its exclusions and pretend roles?” The candidate must include its actual predicted
contacts, target, and force category. It must not include a model-authored rationale that
the judge is then asked to trust.

Examples for a held-out comparison:

| Player cue | Candidate distinction with possible visible value |
| --- | --- |
| “Those stones are sleeping hedgehogs; get the egg home without touching them.” | A gentle direct catch may fit; a shot whose physical trace hits a stone does not. Understanding the metaphor alone is insufficient unless behavior respects the exclusion. |
| “Use the stones as a wall, but leave the little house where I put it.” | A bank shot can fit while a proposed box rearrangement conflicts. The recent-edit rule still protects the layout independently. |
| “A tiny landing, no bouncing around.” | A slow box catch may fit better than a lively bank. An explicit gentle-shot control may provide the same value more cheaply and reliably. |
| “The box can fly now. Launch Pebble into space.” | The model cannot grant flight. Code supplies only existing capabilities; the app may offer a bounded pretend version if authored. |

Keep one candidate or one predetermined small batch of candidates; do not keep asking
until something is approved. If batching is tested, label each candidate's acceptability,
then let code choose among acceptable alternatives; probabilities of mutually acceptable
options are not a creativity score. Cap calls at meaningful play-idea boundaries, never
per pointer update or collision.

Timeout, uncertainty, stale context, and budget exhaustion hold the semantic proposal.
They must not approve it by fallback. The direct player toy and independent safe idle or
self-care remain code-owned paths, not covert execution of a held proposal. Live use stays
explicit, server-side, budgeted, and shadow until evaluation supports changing it. Future
observations may contain physical outcomes, never verdicts, confidence, rationale, or a
journal summary derived from those verdicts.

To establish model value, first test paraphrases, exclusions, metaphor, ambiguity, and
injections against the frozen keyword baseline and an explicit-controls baseline. Then
run a blinded human comparison at equal mechanics, content, timing, and seed schedules.
Measure cue compatibility and willingness to use the input method, not merely judge
accuracy. Shadow labels alone cannot demonstrate a better playable experience. If free
text is rarely used or players prefer three clear controls, remove the live call from the
play loop. No claim that the pet “understands” should exceed what this test demonstrates.

## Small human playtest and explicit ways this recommendation can fail

Start with 8–12 people unfamiliar with Pebble. Include several who use a keyboard or
prefer low-motion play and several who are not precision-game enthusiasts. This is a
formative sample for finding obvious failures, not a powered estimate of retention or a
population preference claim. Prewrite the tasks and decision rules before watching.

Use counterbalanced short sessions with two builds: the current room and the causal toy.
For a cleaner diagnosis, follow with a small comparison of the causal toy with versus
without Pebble's turn-taking. Keep art and text as similar as practical; record remaining
differences instead of attributing every preference to physics.

1. **Thirty-second first contact:** say only “Spend a little time with Pebble.” Observe
   whether the person discovers a meaningful action without coaching. Record time to
   first physical consequence, mistaken inputs, and waiting. An instant text change
   does not count as the consequence measure.
2. **Five-minute free play:** count purposeful revisions after outcomes, voluntary
   invitations to Pebble, and periods spent watching by choice. Separately record the
   person trying to act but being blocked. Passive watching is not automatically failure.
3. **Transfer task:** move the box and stone group to a layout they have not seen. Ask
   them to predict a simple roll, then try it. Can they use the same object rules without
   a new explanation? Do not require exact physics predictions.
4. **Meaning question:** ask what they were trying to do, what changed their next idea,
   and whether Pebble helped or interfered. A player describing a cause and a chosen
   revision is stronger evidence of depth than counting unique animation variants.
5. **Preference plus actual choice:** get a brief enjoyment/agency rating and ask which
   build they would choose for an optional extra two minutes, including the option to
   stop. Record choice and time separately. Neither alone certifies enjoyment.

Provisional design gates, deliberately easy to falsify:

- If most participants cannot explain one transferable object rule or deliberately
  change an outcome after five minutes, the proposed causal depth has not landed.
- If aim/strength controls dominate complaints, simplify them before adding content.
- If participants repeatedly wait or click again because nothing physical responds,
  fix handover and timing before expanding autonomous behavior.
- If they prefer the ball toy with Pebble disabled, preserve the toy but redesign the
  pet's participation; more initiative is not automatically better companionship.
- If they solve one catch and see no next self-chosen experiment, the room may support
  only a brief toy. Do not call a larger random action list “emergence.” Test the optional
  hide/peek rule or one new reusable prop role, not a reward treadmill.
- If fast active play makes the room feel less cozy, keep the short direct-control loop
  available on invitation and retain slower autonomous pacing outside it.

The most promising sign is a person who understands a result, smiles at Pebble's specific
reaction, and voluntarily changes the room to answer their own next question. That is the
experience this proposal targets. Its absence is a reason to change the design, not to
add a more elaborate intelligence layer.
