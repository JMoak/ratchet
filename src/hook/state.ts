import { State } from "../state.ts";
import type { HookEvent } from "./event.ts";
import { type Placement, placePath } from "./subject.ts";

export interface PromptStateOptions {
  /**
   * The session's root (`PromptOutcome.root`). When given, `inside_workspace` is measured from
   * it instead of from the cwd the prompt was journalled with, which follows the agent's `cd`.
   */
  readonly root?: string;
  /**
   * Where the harness keeps its own files on this machine (`hookContext(harness)`). When given,
   * `harness_owned` and `harness_config` are placed afresh from the journalled path, so a
   * prompt journalled by an older rule is judged by the current one.
   */
  readonly placement?: Pick<Placement, "home" | "harnessHomes" | "harnessScratch">;
}

/**
 * What the gate sees about one prompted call. The facts computed in `subject.ts` are trusted
 * digests; the command, path, URL or query was written by the agent being gated, so it is an
 * untrusted span however harmless it looks. The person's answer, how long it took, whether the
 * tool later ran, and any earlier verdict never enter the state: the label must never reach
 * the oracle. Digest names are what the floors in `gate.ts` match on, line by line.
 *
 * A path is placed again from its journalled text when that text is whole (not redacted, not
 * cut, not a patch's list): from the session's root when `root` is given, and against the
 * harness's directories when `placement` is. Otherwise the journalled digests stand, except
 * that a path shaped like harness configuration always renders `harness_config: true` and is
 * never harness-owned: configuration wins, and no older subject can lower a floor. A command's
 * digests are the journalled ones; one it was journalled without (`check_bypass`) is not
 * invented.
 */
export function promptState(prompt: HookEvent, opts: PromptStateOptions = {}): State {
  const s = prompt.subject;
  if (s === undefined || prompt.tool === undefined) {
    throw new Error(`event ${prompt.id} is not a prompt with a subject`);
  }
  const state = State.create("Agent tool call that the harness would ask a person to approve")
    .field("harness", prompt.harness)
    .field("tool", prompt.tool);
  switch (s.kind) {
    case "command":
      state
        .digest("command_parts", s.parts)
        .digest("destructive", s.destructive)
        .digest("opaque", s.opaque);
      if (s.checkBypass !== undefined) state.digest("check_bypass", s.checkBypass);
      state.digest("uploads", s.uploads);
      if (s.harnessConfig !== undefined) state.digest("harness_config", s.harnessConfig);
      if (s.credential !== undefined) state.digest("credential", s.credential);
      return state
        .digest("truncated", s.truncated)
        .digest("redacted", s.redacted)
        .untrusted("command", s.command)
        .build();
    case "path": {
      const whole =
        !s.redacted && s.truncated !== true && s.change?.kind !== "patch" && s.path !== "";
      const root = opts.root ?? prompt.projectDir ?? prompt.cwd;
      const at: Placement = {
        ...(prompt.cwd === undefined ? {} : { cwd: prompt.cwd }),
        ...(root === undefined ? {} : { root }),
        ...opts.placement,
      };
      // A `~` path needs the home it was expanded with; without one keep the journalled measure.
      const placeable = whole && (!/^~(?:[\\/]|$)/.test(s.path) || at.home !== undefined);
      const fresh = placeable ? placePath(s.path, at) : undefined;
      const inside =
        opts.root !== undefined || opts.placement !== undefined
          ? (fresh?.insideWorkspace ?? s.insideWorkspace)
          : s.insideWorkspace;
      // Shapes need no placement: configuration and credential files are known by their names.
      const byShape = placePath(s.path, {
        ...(prompt.cwd === undefined ? {} : { cwd: prompt.cwd }),
        ...(root === undefined ? {} : { root }),
      });
      const placed = fresh !== undefined && opts.placement !== undefined;
      // A journalled true is never lowered: a replay machine whose harness home differs from the
      // journalling one must not turn configuration back into an ordinary file.
      const config =
        (placed && fresh.harnessConfig) || byShape.harnessConfig || s.harnessConfig === true;
      const credential =
        (placed && fresh.credential) || byShape.credential || s.credential === true;
      const owned = placed ? fresh.harnessOwned : s.harnessOwned;
      state.digest("inside_workspace", inside ?? "unknown");
      if (owned !== undefined) state.digest("harness_owned", owned && !config);
      if (owned !== undefined || s.harnessConfig !== undefined || config)
        state.digest("harness_config", config);
      if (s.credential !== undefined || credential) state.digest("credential", credential);
      state.digest("read_only", s.readOnly).digest("destructive", s.destructive);
      // Only a cut path says so; the line is absent otherwise, as on subjects journalled before it.
      if (s.truncated === true) state.digest("truncated", true);
      const c = s.change;
      if (c?.kind === "write") state.digest("lines_written", c.lines);
      if (c?.kind === "edit") {
        state
          .digest("lines_removed", c.removedLines)
          .digest("lines_added", c.addedLines)
          .digest("replace_all", c.replaceAll);
      }
      if (c?.kind === "patch") {
        state
          .digest("files_changed", c.files)
          .digest("files_deleted", c.deletes)
          .digest("lines_removed", c.removedLines)
          .digest("lines_added", c.addedLines);
      }
      return state.untrusted("path", s.path).build();
    }
    case "url":
      return state.digest("truncated", s.truncated).untrusted("url", s.url).build();
    case "query":
      return state.digest("truncated", s.truncated).untrusted("query", s.query).build();
    case "call":
      return state.digest("truncated", s.truncated).untrusted("argument_shape", s.shape).build();
  }
}
