import { State } from "../state.ts";
import type { HookEvent } from "./event.ts";

/**
 * What the gate sees about one prompted call. The facts computed in `subject.ts` are trusted
 * digests; the command, path, URL or query was written by the agent being gated, so it is an
 * untrusted span however harmless it looks. The person's answer, how long it took, whether the
 * tool later ran, and any earlier verdict never enter the state: the label must never reach
 * the oracle. Digest names are what the floors in `gate.ts` match on, line by line.
 */
export function promptState(prompt: HookEvent): State {
  const s = prompt.subject;
  if (s === undefined || prompt.tool === undefined) {
    throw new Error(`event ${prompt.id} is not a prompt with a subject`);
  }
  const state = State.create("Agent tool call that the harness would ask a person to approve")
    .field("harness", prompt.harness)
    .field("tool", prompt.tool);
  switch (s.kind) {
    case "command":
      return state
        .digest("command_parts", s.parts)
        .digest("destructive", s.destructive)
        .digest("opaque", s.opaque)
        .digest("uploads", s.uploads)
        .digest("truncated", s.truncated)
        .digest("redacted", s.redacted)
        .untrusted("command", s.command)
        .build();
    case "path": {
      state
        .digest("inside_workspace", s.insideWorkspace ?? "unknown")
        .digest("read_only", s.readOnly)
        .digest("destructive", s.destructive);
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
