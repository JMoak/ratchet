# The agent-harness hook: shadow evidence from permission prompts

Status: implemented 2026-10-24 (`ratchet hook`), nothing enforces. This generalises the
[keywork tool gate](keywork-gate.md) to the harnesses most people run, Claude Code and Codex,
by reading their hook events. The keywork design remains the reference for the evidence plan;
this document records only what differs.

## Why

The roadmap's blocker is labelled real traffic: 149 planned acts, answered by hand, take months
on one person's keywork use. Every coding-agent harness already asks its person to approve tool
calls, and every answer is a label. A hook that journals the prompt and what happened next
turns each installer into a source of labels at no cost per label, and gives the package its
first users. Nothing about the person's workflow changes: the hooks run in the background and
cannot decide anything.

## The loop

```text
harness hooks (PermissionRequest, PostToolUse, PostToolUseFailure, SessionEnd)
  |  ratchet hook <harness> event              one line per event, no stdout, exit 0
  v
~/.ratchet/hooks/<harness>/events.jsonl        scrubbed subject on prompts; ids and hashes on runs
  |  ratchet hook <harness> replay --live      resolve prompts, ask the gate in shadow, label
  v
~/.ratchet/hooks/<harness>/ledger.jsonl        gate agent.tool.<harness>, source <harness>:person
  |  ratchet report / check / review --denied
  v
fit report, then a freeze, then evidence (as keywork)
```

Cadence is batch, as keywork chose: the hooks only append, so they need no key, no network and
add no latency; `replay` does the asking under a spend cap per UTC day read from the ledger.

## What the harnesses give, and what they do not

Both harnesses send the same JSON shape to a hook's stdin (`hook_event_name`, `session_id`,
`cwd`, `tool_name`, `tool_input`; `tool_use_id` on runs; a turn id as Claude Code `prompt_id`
or Codex `turn_id`). Neither tells a hook how the person answered a prompt. `PermissionRequest`
fires before the prompt and carries no `tool_use_id`; a hook that stays silent leaves the
prompt to the person. So the answer is read from what happened next, in `resolve.ts`:

| Signal | Label | Source of the label |
| --- | --- | --- |
| A `PostToolUse` or `PostToolUseFailure` with the same session, tool and input hash | allowed | the person approved (the tool may then have failed) |
| No run before an event from a later turn in the same session | denied | the harness does not proceed past an unanswered prompt |
| No run before `SessionEnd` | denied | same |
| Neither yet | open | not ingested until settled |
| A Claude Code `PermissionDenied` (auto mode) for the call | classifier | the harness's classifier answered; a person did not |

A run with no prompt before it was allowed by a rule or a mode; it is counted and left out, as
keywork leaves out standing grants. Matching is oldest prompt first; when the same call is
prompted twice and run once, two rows may swap labels, which changes no count, and a repeated
state enters the acceptance sample once anyway.

**The denial inference is the weak link.** A person who denies in order to steer is judging the
moment, not the call. keywork solved this by asking why; a hook cannot. The hook's denials are
therefore handled as keywork handles older journals: a denial counts against the call until a
blind review (`ratchet review --denied`) says otherwise, and the uniform blind sample bounds
what the unreviewed approvals hide. A future version could read the harness transcript for the
denial message; that format is undocumented, so it is not relied on.

## What leaves the machine

The same contract as keywork, computed in `subject.ts` and printed by the dry run before any
call is made:

- **Commands**: the text, scrubbed of the usual shapes of a secret and capped at 1,000
  characters, plus facts: parts, destructive, opaque, uploads, truncated, redacted.
- **Paths** (Edit, Write, MultiEdit, NotebookEdit, Read, Glob, Grep, Codex `apply_patch`): the
  path, whether it is inside the workspace, read-only, and the change as line counts. Never the
  content: a write is its line count, an edit is lines removed and added, a patch is files,
  lines and deletes.
- **URLs and queries** (WebFetch, WebSearch): scrubbed and capped.
- **Anything else, including MCP tools**: the shape of the input (key names, value types and
  sizes), never values. That is little to judge on, and the gate will mostly review such calls;
  a per-tool subject is how to give it more.

Tool output, file contents and the conversation are never read. Scrubbing is best effort and
says so; it is a reason the dry run exists, not a guarantee.

## The gate

One gate per harness, `agent.tool.claude-code` and `agent.tool.codex`, so evidence is
comparable with keywork's but never pooled across harnesses: their prompt populations differ
(Claude Code rarely prompts for reads; Codex prompts by sandbox policy). The question is
keywork's with the harness left open, the floors read the same digests (destructive and
publishing commands and file-deleting patches are one-way doors; opaque, uploading, truncated
and out-of-workspace calls are reviewed), and the bar is the placeholder 0.95 until a fit phase
freezes a real one as a new evidence version, exactly as keywork does. The promise and the plan
are keywork's: 98% by an exact one-sided 95% bound, at most ten acts per session.

## Threats to validity beyond keywork's

| Threat | Answer |
| --- | --- |
| A denial was steering, not a judgment | Every denial is blind-reviewed before the evaluation; the uniform sample bounds the rest. Denials that reviews keep flipping are a reason to add a transcript reader, not to lower the bar. |
| Async hooks land out of order | Events are sorted by their own timestamps, taken when the hook started, not by file position. |
| A session that never ends leaves prompts open | They stay out of the population until a later turn or the end settles them; `status` shows how many. |
| Two replays at once | A lock file per harness, stale after ten minutes. |
| The hook slows the agent | Every event hook runs in the background; `SessionEnd` is synchronous by the harnesses' rules and appends one line in milliseconds. A hook that fails writes a note to `rejected.log` and exits 0 with no output, so the harness never sees it. |
| `tool_input` grows (PostToolBatch, large patches) | Only prompts keep a subject, capped; runs keep a hash. |
| Permission modes differ across sessions | Recorded as a `mode:` tag; the population is still "prompted calls", whatever the mode. |

## Runbook

```text
ratchet hook claude-code install          # the settings to paste; same for codex
ratchet hook claude-code status           # what has been recorded and how prompts resolved
ratchet hook claude-code replay           # dry run: the exact text the gate would see
ratchet hook claude-code replay --live    # ask Jev in shadow, $0.05 a UTC day by default
ratchet report ~/.ratchet/hooks/claude-code/ledger.jsonl
ratchet review ~/.ratchet/hooks/claude-code/ledger.jsonl --gate agent.tool.claude-code --denied
```

Set `RATCHET_HOME` to keep the journals somewhere else. From a source checkout the hook command
is `bun <checkout>/bin/ratchet.ts hook claude-code event`.
