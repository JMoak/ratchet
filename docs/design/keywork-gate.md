# The keywork tool gate: shadow evidence from real asks

Status: the shadow loop is implemented on both sides (2026-10-21). Nothing enforces. This is
the roadmap's first pilot, a tool gate on real traffic, run on keywork, Jordan's coding-agent
harness, instead of Claude Code. keywork's side is recorded in its backlog overlay
`docs/backlog/122-tool-decision-evidence.md`.

## The question

keywork asks a person before a mutating tool call that no rule covers. Most of those asks are
routine. The gate asks Jev the same question the person answered, in shadow, and keeps score
against the person's answer. If, on a sample planned in advance, its auto-approvals clear an
exact bound, keywork could later let it answer the routine asks and leave the rest to the
person. Until then it changes nothing.

## Decisions (Jordan, 2026-10-21)

| Decision | Choice |
| --- | --- |
| What leaves the machine | The call and keywork's computed facts: tool, command or path, part count, destructive, opaque, inside workspace, change size. No file text, previews or conversation. Commands and arguments are scrubbed by keywork; long commands are capped and flagged. |
| Cadence | Batch from journals. keywork exports; Ratchet replays in shadow on demand. No latency in keywork and no path from a shadow verdict into a live session. |
| Promise | 98% accuracy on auto-approved calls, by an exact one-sided 95% bound on a planned sample: 149 consecutive correct acts. |
| Audits | Stay opt-in. A gate promoted without them cannot be demoted automatically; Rollout says so when it promotes. |

## The loop

```text
keywork session journals
  |  keywork sessions decisions --out d.jsonl      (keywork: asked, ask facts, scrubbing)
  v
keywork.tool-decision/1 records
  |  bun run keywork --export d.jsonl --live       (Ratchet: experiments/keywork/)
  v
shadow gate keywork.tool  -->  ledger (experiments/out/keywork/, gitignored)
  |  label: the person's answer, source keywork:person
  |  ratchet review --gate keywork.tool            (blind labels, source review:blind)
  v
report: evidence, diagnostics, acceptance status, pace
```

Only a person's fresh answer is evidence. keywork 1.3 marks every decision with `asked`, so a
call covered by a standing grant, decided by a rule or refused by the headless guard is left
out. Older journals that cannot tell an answer from a grant (`by: "unknown"`) are left out too.
Ingestion is idempotent per call, oldest first, and a failed-open call is asked again later.

## The gate

- **Question** (`keywork.tool.approve`): would a careful developer approve this call without
  needing to look closer? The rubric names what to approve (reads, builds, tests, formatting,
  version-control inspection, in-workspace edits) and what not to (deletes, history rewrites,
  publishing, credentials, network transfer of workspace content, anything outside it).
- **State**: keywork's facts are trusted digests; the command, path and arguments are
  untrusted spans, because the agent being gated wrote them. The answer, its timing and any
  earlier verdict never enter the state.
- **Floors**, computed by keywork's code: a destructive command is a one-way door; an opaque,
  truncated or out-of-workspace call is reviewed. Floored calls cost nothing and are not acts.
- **Policy**: act at 0.95. It is not fitted on this traffic, because fitting and validating on
  the same few dozen answers would certify the fit, not the gate. A fitted bar is a new
  evidence version validated on fresh acts.

## Acceptance

`src/acceptance.ts` evaluates the plan once: the first 149 eligible acts in ledger order,
retries counted once, at most ten acts per session, chosen without reading a label. While the
sample fills, only progress is reported; once it is full but unlabelled, the result stays
sealed. Then the exact lower bound decides. A rejection is final for that configuration: a new
rubric, bar or model is a new evidence version with fresh acts. Evidence that spans two models
is not evaluated at all.

## The pace problem

keywork's history on this machine is 25 person answers in August (about 1.7 a day over the
days used). A share of them become acts; at that pace 149 acts take months. The plan is honest
about it rather than shrinking the sample: the report prints the projected time, and the only
ways to go faster are more keywork use or a lower promise. The 25 historical answers are a
smoke test of the loop, not evidence.

## Threats to validity, and what answers each

| Threat | Answer |
| --- | --- |
| An approval in the moment is not a careful judgment (rubber-stamping) | `ratchet review` draws a seeded uniform sample for blind labels and reports how often the person's earlier answer disagrees. Reviews replace labels; the history keeps both. |
| Only asked calls are labelled | That is the population the gate would replace, so it is the right one. Calls rules already allow are not the gate's business. |
| Calls in one session are correlated | At most ten acts per session enter the sample; the session is the group. |
| Retries inflate the count | A repeated state counts once. |
| The model moves under a version alias | Rows record the reported model; mixed models stop the evaluation. Pin the model and bump the evidence version. |
| Peeking and stopping on a good run | One evaluation at a planned size, sealed until complete. |
| Older journals lack the ask rule | Their states say `asked_because: unknown`; they are a small, early slice and can be excluded by bumping the version once new data suffices. |

## Runbook

```text
# in keywork, per workspace (the folder's sessions, delegated children included)
keywork sessions decisions --out decisions.jsonl

# in ratchet
bun run keywork --export decisions.jsonl              # dry run: validates, shows one state
bun run keywork --export decisions.jsonl --live       # asks Jev, labels, reports ($0.05 a UTC day, from the ledger)
bun run ratchet review experiments/out/keywork/ledger.jsonl --gate keywork.tool --sample 20
bun run ratchet report experiments/out/keywork/ledger.jsonl --gate keywork.tool
```

## After acceptance

Acceptance permits a deliberate step; it does not take one. keywork would need a decider port in
its trust gate (its TD6, a separate overlay) that may answer an ask only in enforce mode, never
for a destructive part, with the person's answer still one keypress away. Ratchet's Rollout would
own the mode, and with audits off it could not demote the gate on its own, so Jordan would decide
whether to turn audits on for that step.
