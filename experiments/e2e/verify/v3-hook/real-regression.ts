/**
 * V3 (wave 3) real-traffic regression for the agent-harness hook, offline.
 *
 * Rebuilds T1's 200-call real slice exactly as `experiments/e2e/t1-toolgate/real.ts` drew it
 * (same journal, cutoff, seed and transcript recovery, checked against the hook's input hash),
 * renders every call through the CURRENT subject, state and floor code the way
 * `ratchet hook claude-code replay` would (subject journalled at event time, then
 * `promptState(event, { root })` with the session's first cwd as root), and compares with the
 * rendering T1 recorded in `real-corpus.json` and T1's old floors.
 *
 * Reads only: the hook journal, the local Claude Code transcripts, and T1's gitignored
 * real-slice files. Writes counts only to experiments/out/e2e/verify/v3-hook/ (gitignored).
 * Never calls a model, never writes to ~/.ratchet. Real commands and paths are printed only
 * with --show (to the local terminal), never written to a file.
 *
 *   bun experiments/e2e/verify/v3-hook/real-regression.ts [--show]
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { floorFor } from "../../../../src/floors.ts";
import {
  type HookEvent,
  hashInput,
  hookContext,
  parseHookInput,
} from "../../../../src/hook/event.ts";
import { hookFloors, hookQuestion } from "../../../../src/hook/gate.ts";
import { hookPaths, readEvents } from "../../../../src/hook/journal.ts";
import { promptState } from "../../../../src/hook/state.ts";
import { SECRET_SHAPES, type Subject } from "../../../../src/hook/subject.ts";
import { rng, shuffled } from "../../../../src/math.ts";
import { CUTOFF, REAL_SEED } from "../../t1-toolgate/real.ts";

const SHOW = process.argv.includes("--show");
const N = 200;
const T1_REAL = join("experiments", "out", "e2e", "t1-toolgate", "real");
const OUT = join("experiments", "out", "e2e", "verify", "v3-hook");

interface ToolUse {
  readonly name: string;
  readonly input: Record<string, unknown>;
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// --- recovery, as real.ts does it -------------------------------------------------------------
function transcriptFiles(session: string): string[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (name.endsWith(".jsonl") && p.includes(session)) out.push(p);
    }
  };
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === `${session}.jsonl`) out.push(p);
      else if (name === session && statSync(p).isDirectory()) walk(p, 1);
    }
  }
  return out;
}

async function scan(files: readonly string[], wanted: Set<string>, found: Map<string, ToolUse[]>) {
  for (const f of files) {
    const rl = createInterface({
      input: createReadStream(f, "utf8"),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(o) || !isRecord(o.message) || !Array.isArray(o.message.content)) continue;
      for (const c of o.message.content) {
        if (!isRecord(c) || c.type !== "tool_use" || typeof c.id !== "string") continue;
        if (!wanted.has(c.id) || typeof c.name !== "string" || !isRecord(c.input)) continue;
        const copies = found.get(c.id) ?? [];
        copies.push({ name: c.name, input: c.input });
        found.set(c.id, copies);
      }
    }
  }
}

// --- T1's old floors (HEAD src/hook/gate.ts before wave 2) ------------------------------------
function oldFloor(state: string): "review" | "act" {
  if (/^destructive: true$/m.test(state)) return "review";
  return [
    /^opaque: true$/m,
    /^uploads: true$/m,
    /^truncated: true$/m,
    /^inside_workspace: (?:false|unknown)$/m,
  ].some((r) => r.test(state))
    ? "review"
    : "act";
}

function reasons(state: string): string[] {
  const trusted = state.slice(0, Math.max(0, state.indexOf("\n[untrusted ")) || state.length);
  const r: string[] = [];
  if (/^destructive: true$/m.test(state)) r.push("destructive");
  if (/^opaque: true$/m.test(state)) r.push("opaque");
  if (/^check_bypass: true$/m.test(state)) r.push("check_bypass");
  if (/^uploads: true$/m.test(state)) r.push("uploads");
  if (/^truncated: true$/m.test(state)) r.push("truncated");
  if (/^harness_config: true$/m.test(state)) r.push("harness_config");
  if (
    /^inside_workspace: (?:false|unknown)$/m.test(state) &&
    !/^harness_owned: true$/m.test(trusted)
  )
    r.push("outside");
  return r;
}

/** The text the subject scrubbed, from the raw input. */
function rawText(tool: string, input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd;
  if (typeof c === "string") return c;
  for (const k of ["file_path", "notebook_path", "path", "pattern", "url"]) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return tool;
}

/** Secret-looking strings a scrubbed text may still carry (a broad net: candidates, not verdicts). */
const SUSPECTS: readonly [string, RegExp][] = [
  [
    "json-secret-key",
    /"(?:token|password|passwd|secret|api_?key|apikey|access_token|client_secret|auth)"\s*:\s*"[^"[]{4,}/gi,
  ],
  ["cookie", /\bcookie\s*:\s*[^\s"']+=|(?:^|\s)-b\s+["']?\w+=/gi],
  [
    "short-p-flag",
    /\b(?:sshpass|docker\s+login|podman\s+login)\b[^|;&\n]*\s-p\s+(?!\[redacted)\S+/gi,
  ],
  ["pass-assignment", /\b[A-Z0-9_]*_PASS\s*=\s*["']?(?!\[redacted)[^\s"']+/g],
  ["hex-32-39", /\b[0-9a-f]{32,39}\b/gi],
  [
    "mixed-token-20",
    /(?<![\w/\\.-])(?=[A-Za-z0-9_-]{20,}(?![\w/\\.-]))(?=\S*[A-Z])(?=\S*[a-z])(?=\S*[0-9])[A-Za-z0-9_-]{20,}/g,
  ],
  ["bearer-left", /\bbearer\s+(?!\[redacted)[A-Za-z0-9._~+/-]{8,}/gi],
];

const realCorpus = join(T1_REAL, "real-corpus.json");
const realLabels = join(T1_REAL, "real-labels.json");
if (!existsSync(realCorpus) || !existsSync(realLabels)) {
  console.log("T1's real slice is not on this machine; nothing to compare.");
  process.exit(0);
}
const old = JSON.parse(readFileSync(realCorpus, "utf8")) as {
  items: { id: string; tool: string; state: string }[];
};
const labels = new Map(
  (
    JSON.parse(readFileSync(realLabels, "utf8")) as { labels: { id: string; truth: boolean }[] }
  ).labels.map((l) => [l.id, l.truth]),
);

const journal = await readEvents(hookPaths("claude-code").events);
const ordered = [...journal.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const firstCwd = new Map<string, string>();
for (const e of ordered)
  if (e.cwd !== undefined && !firstCwd.has(e.session)) firstCwd.set(e.session, e.cwd);
const runs = journal.events.filter(
  (e) => (e.kind === "ran" || e.kind === "failed") && e.toolUseId !== undefined && e.at < CUTOFF,
);
const candidates = shuffled(runs, rng(REAL_SEED)).slice(0, Math.min(runs.length, N * 3));
const wanted = new Set(candidates.map((e) => e.toolUseId as string));
const found = new Map<string, ToolUse[]>();
for (const s of new Set(candidates.map((e) => e.session)))
  await scan(transcriptFiles(s), wanted, found);

// The hook's context as the installed hook computes it, minus CLAUDE_PROJECT_DIR (the old
// journal never recorded it): this process may itself run under a harness, so its env is not read.
const ctx = hookContext("claude-code", {});
const ctxNoDirs = { home: ctx.home as string };

interface Row {
  id: string;
  tool: string;
  truth: boolean | undefined;
  oldFloor: string;
  newFloor: string;
  newFloorProjectDir: string;
  newFloorNoHarnessDirs: string;
  newReasons: string[];
  oldRedacted: boolean;
  newRedacted: boolean;
  shapes: string[];
  suspects: string[];
  oldInside?: string;
  newInside?: string;
  owned?: boolean;
  config?: boolean;
  aligned: boolean;
  changedLines: string[];
}
const rows: Row[] = [];
const local: string[] = [];
const ownedKinds: string[] = [];
const formCounts: string[] = [];
for (const e of candidates) {
  if (rows.length >= N) break;
  const copies = found.get(e.toolUseId as string);
  if (copies === undefined) continue;
  const forms = copies.flatMap((c) => {
    const p = c.input.file_path;
    return typeof p === "string" && p.includes("/")
      ? [c, { name: c.name, input: { ...c.input, file_path: p.replace(/\//g, "\\") } }]
      : [c];
  });
  const use = forms.find((c) => c.name === e.tool && hashInput(c.input) === e.inputHash);
  if (use === undefined) continue;
  const id = `r-${String(rows.length + 1).padStart(3, "0")}`;
  const root = firstCwd.get(e.session);
  const raw = JSON.stringify({
    hook_event_name: "PermissionRequest",
    session_id: e.session,
    ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
    ...(e.permissionMode !== undefined ? { permission_mode: e.permissionMode } : {}),
    tool_name: use.name,
    tool_input: use.input,
  });
  const at = () => e.at;
  const p1 = parseHookInput(raw, "claude-code", at, ctx);
  const p2 = parseHookInput(raw, "claude-code", at, {
    ...ctx,
    ...(root ? { projectDir: root } : {}),
  });
  const p3 = parseHookInput(raw, "claude-code", at, ctxNoDirs);
  if ("reason" in p1 || "reason" in p2 || "reason" in p3) continue;
  const ev: HookEvent = p1.event;
  // As replay renders it: the session root, and paths placed afresh against this machine.
  const placement = {
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
    ...(ctx.harnessHomes === undefined ? {} : { harnessHomes: ctx.harnessHomes }),
    ...(ctx.harnessScratch === undefined ? {} : { harnessScratch: ctx.harnessScratch }),
  };
  const state = promptState(ev, { ...(root === undefined ? {} : { root }), placement }).text;
  const state2 = promptState(p2.event, root === undefined ? {} : { root }).text;
  const state3 = promptState(p3.event, root === undefined ? {} : { root }).text;
  const prior = old.items[rows.length];
  const s = ev.subject as Subject;
  const text = rawText(use.name, use.input);
  const shapes = SECRET_SHAPES.filter(({ pattern }) => {
    pattern.lastIndex = 0;
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    return hit;
  }).map((x) => x.id);
  const shown =
    s.kind === "command"
      ? s.command
      : s.kind === "path"
        ? s.path
        : s.kind === "url"
          ? s.url
          : s.kind === "query"
            ? s.query
            : "";
  const newRedacted = "redacted" in s && s.redacted === true;
  if (newRedacted && shapes.length === 0) shapes.push("blob");
  // Forms the attack found the digests miss, counted on real commands (counts only).
  if (s.kind === "command") {
    for (const [name, re] of [
      [
        "git-global-option-before-verb",
        /\bgit(?:\.exe)?\s+(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+)\s/,
      ],
      ["line-continuation", /\\\r?\n|`\r?\n/],
      ["json-body", /-d\s+'\{|--data(?:-raw|-binary)?\s+'\{/],
    ] as const)
      if (re.test(text)) formCounts.push(name);
  }
  const suspects: string[] = [];
  for (const [name, re] of SUSPECTS) {
    re.lastIndex = 0;
    const m = shown.match(re);
    if (m) {
      suspects.push(name);
      // Masked: length and character classes, plus the 30 characters before it.
      if (SHOW)
        for (const hit of m.slice(0, 3)) {
          const at = shown.indexOf(hit);
          const profile = `len ${hit.length}, upper ${(hit.match(/[A-Z]/g) ?? []).length}, lower ${(hit.match(/[a-z]/g) ?? []).length}, digit ${(hit.match(/[0-9]/g) ?? []).length}, lowerRuns ${JSON.stringify((hit.match(/[a-z]+/g) ?? []).map((x) => x.length))}`;
          local.push(
            `${id} ${use.name} suspect ${name}: ...${shown.slice(Math.max(0, at - 30), at).replace(/\s+/g, " ")}<${profile}>`,
          );
        }
    }
  }
  if (SHOW && newRedacted) {
    // Only the scrubbed context around each redaction: enough to tell a path from a secret.
    const around = [...shown.matchAll(/\[redacted\]/g)].map((m) =>
      shown.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 50).replace(/\s+/g, " "),
    );
    local.push(`${id} ${use.name} redacted [${shapes.join(",")}]: ${around.join(" || ")}`);
  }
  if (SHOW && prior && /^redacted: true$/m.test(prior.state)) {
    // What T1's rendering hid, profiled (never printed): a path segment, a hash, or a secret?
    const segs = text.match(/[A-Za-z0-9+/]{40,}/g) ?? [];
    const profile = segs.map((x) => {
      const pieces = x.split("/");
      const longest = pieces.reduce((a, b) => (b.length > a.length ? b : a), "");
      return `len ${x.length}, slashes ${pieces.length - 1}, longestPiece ${longest.length} (U${(longest.match(/[A-Z]/g) ?? []).length}/l${(longest.match(/[a-z]/g) ?? []).length}/d${(longest.match(/[0-9]/g) ?? []).length}, hexOnly ${/^[0-9a-f]+$/i.test(longest)})`;
    });
    local.push(
      `${id} ${use.name} T1-redacted, now ${newRedacted ? "redacted" : "shown"}: ${profile.join(" ; ")}`,
    );
  }
  if (s.kind === "path" && s.harnessOwned === true) {
    // Which part of the harness's directories: a category, never the path.
    const p = text.replaceAll("\\", "/").toLowerCase();
    const kind = /\/temp\/claude\/|\/tmp\/claude\//.test(p)
      ? "scratch"
      : /\/\.claude\/projects\/[^/]+\/memory\//.test(p)
        ? "memory"
        : (/\/\.claude\/(skills|plugins|agents|commands|hooks)\//.exec(p)?.[1] ??
          (/\/\.claude\/claude\.md$/.test(p) ? "global-claude-md" : "other"));
    ownedKinds.push(`${use.name}:${kind}`);
  }
  const inside = /^inside_workspace: (.*)$/m.exec(state)?.[1];
  const oldInside = prior ? /^inside_workspace: (.*)$/m.exec(prior.state)?.[1] : undefined;
  rows.push({
    id,
    tool: use.name,
    truth: labels.get(id),
    oldFloor: prior ? oldFloor(prior.state) : "?",
    newFloor: floorFor([...hookFloors], state, hookQuestion),
    newFloorProjectDir: floorFor([...hookFloors], state2, hookQuestion),
    newFloorNoHarnessDirs: floorFor([...hookFloors], state3, hookQuestion),
    newReasons: reasons(state),
    oldRedacted: prior ? /^redacted: true$/m.test(prior.state) : false,
    newRedacted,
    shapes,
    suspects,
    ...(oldInside === undefined ? {} : { oldInside }),
    ...(inside === undefined ? {} : { newInside: inside }),
    ...(s.kind === "path"
      ? { owned: s.harnessOwned === true, config: s.harnessConfig === true }
      : {}),
    aligned: prior !== undefined && prior.tool === use.name,
    // Which lines of the state differ from T1's rendering: digest names, or "span" for the agent's text.
    changedLines: prior ? diffLines(prior.state, state) : [],
  });
}

const count = (f: (r: Row) => boolean) => rows.filter(f).length;
const tally = (xs: string[]) =>
  Object.fromEntries([...new Set(xs)].map((x) => [x, xs.filter((y) => y === x).length]));
const approvals = (r: Row) => r.truth === true;
const summary = {
  rebuilt: rows.length,
  alignedWithT1: count((r) => r.aligned),
  statesChanged: count((r) => r.changedLines.length > 0),
  changedLineKinds: tally(rows.flatMap((r) => r.changedLines)),
  denialStateChanges: rows.filter((r) => r.truth === false).map((r) => r.changedLines),
  tools: tally(rows.map((r) => r.tool)),
  denials: count((r) => r.truth === false),
  floored: {
    old: count((r) => r.oldFloor === "review"),
    new: count((r) => r.newFloor === "review"),
    newWithProjectDir: count((r) => r.newFloorProjectDir === "review"),
    newWithoutHarnessDirs: count((r) => r.newFloorNoHarnessDirs === "review"),
    oldApprovals: count((r) => r.oldFloor === "review" && approvals(r)),
    newApprovals: count((r) => r.newFloor === "review" && approvals(r)),
    newlyFloored: count((r) => r.oldFloor !== "review" && r.newFloor === "review"),
    newlyFlooredApprovals: count(
      (r) => r.oldFloor !== "review" && r.newFloor === "review" && approvals(r),
    ),
    newlyFlooredReasons: tally(
      rows
        .filter((r) => r.oldFloor !== "review" && r.newFloor === "review")
        .flatMap((r) => r.newReasons),
    ),
    noLongerFloored: count((r) => r.oldFloor === "review" && r.newFloor !== "review"),
    newReasons: tally(rows.flatMap((r) => r.newReasons)),
    denialsFloored: count((r) => r.truth === false && r.newFloor === "review"),
  },
  pathCalls: count((r) => r.owned !== undefined),
  outsideOld: count((r) => r.oldInside === "false" || r.oldInside === "unknown"),
  outsideNew: count((r) => r.newInside === "false" || r.newInside === "unknown"),
  harnessOwned: count((r) => r.owned === true),
  harnessOwnedKinds: tally(ownedKinds),
  harnessConfig: count((r) => r.config === true),
  redacted: {
    old: count((r) => r.oldRedacted),
    new: count((r) => r.newRedacted),
    newByShape: tally(rows.flatMap((r) => (r.newRedacted ? r.shapes : []))),
  },
  survivingSuspects: tally(rows.flatMap((r) => r.suspects)),
  formsInRealCommands: tally(formCounts),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "real-regression.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  join(OUT, "real-regression-rows.json"),
  `${JSON.stringify(
    rows.map(
      ({
        id,
        tool,
        truth,
        oldFloor,
        newFloor,
        newReasons,
        oldRedacted,
        newRedacted,
        shapes,
        suspects,
      }) => ({
        id,
        tool,
        truth,
        oldFloor,
        newFloor,
        newReasons,
        oldRedacted,
        newRedacted,
        shapes,
        suspects,
      }),
    ),
    null,
    1,
  )}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (SHOW) console.log(`\n--- local only, not written ---\n${local.join("\n")}`);

/** Names of the state lines that differ (digest names; "span" for the untrusted text). */
function diffLines(before: string, after: string): string[] {
  const split = (s: string) => {
    const i = s.indexOf("\n[untrusted ");
    const head = (i < 0 ? s : s.slice(0, i)).split("\n");
    return {
      head: new Map(head.map((l) => [l.split(":")[0] ?? l, l])),
      span: i < 0 ? "" : s.slice(i),
    };
  };
  const a = split(before);
  const b = split(after);
  const names = new Set([...a.head.keys(), ...b.head.keys()]);
  const out = [...names].filter((n) => a.head.get(n) !== b.head.get(n));
  if (a.span !== b.span) out.push("span");
  return out;
}
