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

**In auto mode almost nothing prompts, so the journal yields almost no labels.** The population
is prompted calls, and a permissive mode (Claude Code's auto mode, `acceptEdits`,
`bypassPermissions`, broad allow rules; Codex's full-auto) prompts for very little. The first
real journal, three weeks of one person's auto-mode use, held 41,628 events and 4 prompts (3 of
them `AskUserQuestion`); runs keep a hash and never an input, by design, so they cannot be
replayed or labelled. Under such a mode `replay` has nothing to ask about and the evidence plan
cannot start. The hook earns labels from people who run in the default, prompting mode. Opt-in
sampling of runs (a scrubbed subject kept for a seeded fraction of runs, labelled by blind
review rather than by a prompt) is backlog, not built.

**The denial inference is the weak link.** A person who denies in order to steer is judging the
moment, not the call. keywork solved this by asking why; a hook cannot. The hook's denials are
therefore handled as keywork handles older journals: a denial counts against the call until a
blind review (`ratchet review --denied`) says otherwise, and the uniform blind sample bounds
what the unreviewed approvals hide. A future version could read the harness transcript for the
denial message; that format is undocumented, so it is not relied on.

## What leaves the machine

The same contract as keywork, computed in `subject.ts` and printed by the dry run before any
call is made:

- **Commands** (Claude Code `Bash` and `PowerShell`; Codex `shell`, whose argv is joined, and
  `exec_command`): the text, scrubbed of the usual shapes of a secret and capped at 1,000
  characters, plus facts: parts, destructive, opaque, check_bypass, uploads, harness_config,
  truncated, redacted. The digests are lists of named rules in `subject.ts`
  (`DESTRUCTIVE_COMMANDS`, `OPAQUE_COMMANDS`, `CHECK_BYPASS_COMMANDS`, `UPLOAD_COMMANDS`,
  `HARNESS_CONFIG_COMMANDS`), each tested with commands it must and must not match
  (`tests/d-hook-digests.test.ts`). They read the command after `normaliseCommand`: line
  continuations (`\` or PowerShell's backtick before a line break) joined, Unicode dashes made
  `-` (PowerShell accepts them as parameter prefixes), and quotes around a single word dropped
  (`"rm" -rf`); the text shown is the original, scrubbed. Every git rule allows git's global
  options before the verb and any spelling of git itself (`git -C ../x push --force`,
  `git -c k=v`, `--git-dir=…`, `git.exe`, a full path).
  - Destructive: recursive or forced deletes in every shell (`rm -rf`, `rd /s`,
    `Remove-Item -Recurse/-Force` and its aliases, the switches splatted from a table, a piped
    `Remove-Item`, `[IO.Directory]::Delete`, `rimraf`), discarded work (`git reset --hard`,
    `git checkout -- .`, `git restore .` but not `git restore --staged`, `git stash drop/clear`,
    `git clean -f`), publishing (`npm`, `pnpm`, `bun`, `cargo`, `uv`, `poetry` publish, `twine
    upload`, `docker push`, `gh release`), deploying (`vercel --prod`, `mkdocs gh-deploy`,
    `firebase deploy`, `terraform apply`), cloud and container deletes (`aws s3 rm`,
    `sync --delete`, `kubectl delete`, `docker compose down -v`, `docker system prune`), and
    machine changes (`Format-Volume`, `Restart-Computer`, registry writes,
    `Set-ExecutionPolicy`, elevation with `Start-Process -Verb RunAs`, Defender or firewall off).
  - Opaque: code built, decoded or fetched at run time (`eval`, `$(...)`, POSIX backticks, a
    pipe into an interpreter, `Invoke-Expression`/`iex`, `-EncodedCommand`, also inside
    `Start-Process … -ArgumentList '-enc …'`). PowerShell backticks are escapes, not substitution.
  - Check bypass: a check switched off. Commit hooks (`--no-verify`, `git commit -n`,
    `HUSKY=0`), signing (`--no-gpg-sign`), tests and linters skipped (`gradle -x test`,
    `-DskipTests`, `-Dmaven.test.skip=true`, `-Dcheckstyle.skip`, `dotnet -p:RunAnalyzers=false`,
    `phpstan --generate-baseline`), snapshots rewritten to pass (`jest -u`, `--updateSnapshot`,
    `UPDATE_SNAPSHOTS=1`), verification off (`--dependency-verification=off`, `curl -k`,
    `NODE_TLS_REJECT_UNAUTHORIZED=0`, `GIT_SSL_NO_VERIFY`, `strict-ssl false`, `GONOSUMDB`,
    `GOFLAGS=-insecure`), an unvouched package source (a plain-`http` index, `--trusted-host`),
    and the environment dumped (`docker inspect … .Config.Env`, `env`/`printenv` piped or
    redirected). On 241 fresh calls in the wave 3 live validation, every one of Jev's 9 wrong
    acts was one of these: routine-looking, and a floor's job rather than the model's.
    A flag named only inside a quoted commit message (`-m "ci: stop using --no-verify"`) is not
    the flag, and `env | grep NODE_ENV` reads one variable rather than dumping them all.
    `cmd || true` (a failing step made to pass) is not in the list: it is too common in
    ordinary scripts to floor.
  - Harness config: a command that copies, moves, writes or redirects onto an agent harness's
    configuration (`Copy-Item x $HOME\.claude\settings.json`, `> .mcp.json`, `tee`,
    `Set-Content`, `sed -i` on `~/.claude/CLAUDE.md`), or creates a link (`ln`, `mklink`,
    `New-Item -ItemType Junction|SymbolicLink|HardLink`) that names a harness home or its files,
    including one placed in the notes folder: through such a link a path that looks ordinary
    reaches configuration.
  - Credential: a command that prints, copies or packs a credential file (`cat`, `type`,
    `Get-Content`, `head`, `less`, `cp`, `scp`, `base64`, `tar`, `grep` on `.ssh/id_*`, `*.pem`,
    `*.key`, `.aws/credentials`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`,
    `.docker/config.json`, `.kube/config`, the harnesses' own tokens, or a `.env` reached by an
    absolute, home or parent path). The path side has the same digest over the same shapes, so
    `cat ~/.ssh/id_ed25519` and a Read of it are both reviewed; T1's second real denial was this
    shape.

  A rule matches if it matches the command as written or as normalised, so normalising can only
  add matches.

  The digests read the first 100,000 characters, each rule looks at most 2,000 characters along
  a command segment, and scrubbing reads only a window a little past what is shown, so a
  hostile megabyte is digested in about 0.1 s (unbounded, one took over two minutes); a
  command that long is shown truncated, which the floors review.
- **Paths** (Edit, Write, MultiEdit, NotebookEdit, Read, Glob, Grep, Codex `apply_patch`): the
  path, whether it is inside the workspace, whether it is under the harness's own directories,
  whether it is a harness configuration file, read-only, and the change as line counts. Never
  the content: a write is its line count, an edit is lines removed and added, a patch is files,
  lines and deletes. A path is capped at 1,000 characters, and a patch's files are placed for
  its first 200; a cut one carries `truncated: true`, which the floors review.
  - `inside_workspace` is measured from the session's root, not from the cwd of the moment,
    which follows the agent's `cd` (a project file written from `node_modules/x` is still
    inside). The root is the project directory the harness reports (Claude Code sets
    `CLAUDE_PROJECT_DIR` for hooks; it is journalled as `projectDir`), else the session's first
    journalled cwd, which `resolvePrompts` hands to `promptState` at replay. Codex reports no
    project directory, but its `cwd` does not follow `cd`. A relative path resolves against the
    cwd of the call, then is measured against the root.
  - `harness_owned` is an allowlist: Claude Code's scratch space (`<tmp>/claude`) and its notes
    (`projects/<p>/memory/` under `CLAUDE_CONFIG_DIR`, default `~/.claude`). A scratchpad file or
    a memory note is outside the workspace and not a reason to review. Nothing else is owned.
  - `harness_config` marks agent harness configuration, and always wins over owned. It is every
    path under a harness home (`CLAUDE_CONFIG_DIR` or `~/.claude`, `CODEX_HOME` or `~/.codex`;
    both, whichever harness asks) except the notes: settings, credentials, plugins and their
    `hooks.json`, skills and their scripts, agents, commands, the global `CLAUDE.md`, Codex's
    `rules/`, `prompts/`, `AGENTS.md`, `config.toml`, `auth.json`. Each of these runs code or
    sets the agent's instructions or permissions, so wave 2's blanket exemption of the homes
    lowered floors that v1 had (wave 3, V3). Anywhere else, including a project and a home that
    is also the session's root, a file is configuration by its shape, the same set the command
    digest uses: `.claude/settings*.json`, `.claude/.credentials.json`, `.claude/CLAUDE.md`, and
    anything in `.claude/hooks/`, `agents/`, `commands/`, `skills/`, `plugins/` or
    `output-styles/` (an agent can set its own permission mode, a skill or command its allowed
    tools); `~/.claude.json`, a project's `.mcp.json`, managed settings; `.codex/config.toml`,
    `auth.json`, `hooks.json`, `AGENTS.md`, and anything in `.codex/rules/`, `prompts/`,
    `agents/` or `skills/`. A project's own root `CLAUDE.md` and `AGENTS.md` are ordinary files.
    Both are matched on the resolved path in the file system's own spelling: relative paths
    against the cwd, `.` and `..` and doubled separators resolved, and on Windows case ignored,
    a `\\?\` prefix, an alternate data stream (`::$DATA`) and trailing dots or spaces dropped,
    so none of those spellings hides a settings file. A path that names an alternate data
    stream is never harness-owned (`MEMORY.md:evil.ps1` is not a note).
  - `credential` marks a credential file (the shapes listed under commands; a `.env` only
    outside the workspace). Reading or writing one is reviewed, inside the workspace or not.
  - At replay, `promptState` places a whole (unredacted, uncut) path again against this
    machine's harness directories, so a prompt journalled by an older rule is judged by the
    current one. Replay only raises: a path shaped like configuration or a credential renders
    so with or without a placement, a journalled `harness_config: true` or `credential: true`
    stays true even when the replaying machine's harness home differs, and nothing configuration
    is ever `harness_owned: true`.
- **URLs and queries** (WebFetch, WebSearch): scrubbed and capped.
- **Anything else, including MCP tools**: the shape of the input (key names, value types and
  sizes), never values. That is little to judge on, and the gate will mostly review such calls;
  a per-tool subject is how to give it more.

Tool output, file contents and the conversation are never read. Scrubbing is best effort and
says so; it is a reason the dry run exists, not a guarantee. The shapes are named in
`SECRET_SHAPES`: credential headers and cookies (`Authorization:`, `Cookie:`, `curl -b`);
`key=value` pairs, quoted JSON keys ending in a secret word (`{"token": …}`, `"client_secret"`),
and assignments to names ending in one (`PGPASSWORD=`, `MYSQL_PWD=`, `DB_PASS=`,
`$env:GITHUB_TOKEN =`); the values of `--password`, `--token`, `--secret`, `--api-key` and their
kin (not `--password-stdin`, `--token-file`, or a redirect as in `--with-token < file`);
`curl -u user:pass` (not `python -u C:\x`); `sshpass -p` and `docker login -p`; URL passwords
(`scheme://user:pass@host`) and query keys (`?key=`, `&token=`, `access_token=`, `sig=`);
`mysql -p<pw>`; AWS keys and secrets passed as arguments; vendor prefixes (OpenAI-style `sk-`
with a random run carrying a digit, so a branch named `sk-add-settings` stays, Stripe
`sk_live_`/`rk_live_`, GitHub, GitLab, Slack, npm, PyPI, Hugging Face, Google, SendGrid,
DigitalOcean, Shopify); JWTs; private key blocks. Bare hex is not redacted: 40 and 64 hex
digits are commit ids and content digests far more often than credentials, and hex credentials
are caught by the name they are passed under. A name or flag keeps its name and loses its
value, so the gate still sees that a credential was passed. WebSearch queries are scrubbed like
commands. The last shape is a random-looking blob: a path segment of 20 or more
characters with three or more each of upper- and lower-case letters, a digit, and lower-case
runs averaging at most 2.5 letters. The old shape (`[A-Za-z0-9+/]{40,}`) redacted 38 of 39 real
redactions for being a long path (T1-09). The new shape was tuned on local paths, URLs and
identifiers so that only random ids trip it; it misses a few percent of random 40-character
base64 strings (172 of 5,000 in the wave 3 check), so it is a backstop behind the named shapes. Only the random
segment is redacted, never the path around it.

## The gate

One gate per harness, `agent.tool.claude-code` and `agent.tool.codex`, so evidence is
comparable with keywork's but never pooled across harnesses: their prompt populations differ
(Claude Code rarely prompts for reads; Codex prompts by sandbox policy). The question is
keywork's with the harness left open, the floors read the same digests (destructive and
publishing commands and file-deleting patches are one-way doors; opaque, check-bypassing,
uploading and truncated calls and changes to harness configuration are reviewed; so are
out-of-workspace calls, unless the path is harness-owned), and the bar is the placeholder 0.95
until a fit phase freezes
a real one as a new evidence version, exactly as keywork does. The harness-owned exemption is
read from the digest lines before the first untrusted span, so a `harness_owned: true` line
planted in a path cannot lower the floor. The promise and the plan are keywork's: 98% by an
exact one-sided 95% bound, at most ten acts per session.

The evidence version is `agent-tool-v2` (2026-11-12): PowerShell and argv commands became
command subjects, the digests and scrubbing widened, `inside_workspace` moved to the session's
root, and `harness_owned`, `harness_config` and their floors were added. Wave 3 (verifier V3
and the fresh live validation) changed v2's subjects again before any v2 evidence was used:
`check_bypass` and a command's `harness_config` were added with their floors, `harness_owned`
became an allowlist with configuration winning, the git rules read global options, commands
are normalised before digesting, and scrubbing gained shapes and dropped bare hex; whether that
is a `v3` is the release's call. A command's digests are computed when the prompt is journalled,
so an older prompt replays with the digests it was journalled with (no `check_bypass` line, a
PowerShell call as its argument shape); a path is placed again at replay, as above.

## Known limits of the digests

The digests read text. They are a backstop for the model's judgment and for review, not a
sandbox, and an agent that means to get past them can:

- **Escape a command word.** cmd's caret (`r^d /s /q x`) and a shell backslash (`r\m -rf x`)
  run the command and do not spell it. Normalising undoes quotes and line continuations, not
  these.
- **Rename a command.** A git alias defined on the spot (`git -c alias.p=push p --force`) or in
  a config file, a shell alias or function, or a script that does the work all hide the verb.
- **Hold a path in a variable.** `$t = "$HOME\.claude"; Copy-Item x $t\settings.json` names no
  harness path in the text the digests see.
- **Use a link made earlier.** Paths are matched lexically: a junction or symbolic link created
  outside the journal (or before the hook was installed) makes an ordinary-looking path reach
  configuration, and nothing here resolves it. Creating such a link while journalled is
  reviewed (above).

Each of these is a reason the floors are paired with blind review and an acceptance test, and a
reason a gate's evidence is read from labelled traffic rather than from the rules.

## Threats to validity beyond keywork's

| Threat | Answer |
| --- | --- |
| A denial was steering, not a judgment | Every denial is blind-reviewed before the evaluation; the uniform sample bounds the rest. Denials that reviews keep flipping are a reason to add a transcript reader, not to lower the bar. |
| Async hooks land out of order | Events are sorted by their own timestamps, taken when the hook started, not by file position. |
| A session that never ends leaves prompts open | They stay out of the population until a later turn or the end settles them; `status` shows how many. |
| Two replays at once | A lock file per harness, stale after ten minutes. |
| The hook slows the agent | Every event hook runs in the background; `SessionEnd` is synchronous by the harnesses' rules and appends one line in milliseconds. A hook that fails writes a note to `rejected.log` and exits 0 with no output, so the harness never sees it. |
| `tool_input` grows (PostToolBatch, large patches) | Only prompts keep a subject, capped; runs keep a hash. |
| Permission modes differ across sessions | Recorded as a `mode:` tag; the population is still "prompted calls", whatever the mode. A permissive mode prompts for almost nothing, so it contributes almost no rows (see above). |
| The agent `cd`s away from the project | `inside_workspace` is measured from the session's root (the reported project directory, else the session's first cwd), not from the cwd of the moment. |
| Stdin nested 100,000 deep, or behind a UTF-8 BOM | The input hash is computed with an explicit stack (same text as before, so old prompts still match their runs) and a BOM is stripped; neither drops the event, which would have turned its prompt into a denial. |
| A hostile `hook_event_name` (`toString`, `__proto__`) | Event names are looked up in a `Map`, never on an object; anything unknown is rejected into `rejected.log` and the hook still exits 0 silently. |

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
