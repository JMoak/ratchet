import { State } from "../../src/state.ts";
import type { ToolDecision } from "./record.ts";

/**
 * What the gate sees about one call. keywork's computed facts are trusted digests; the command,
 * the path and any other arguments were written by the agent being gated, so they are untrusted
 * spans no matter how harmless they look. Nothing about the person's answer, the time it took, or
 * any earlier verdict is included: the label must never reach the oracle.
 */
export function toolCallState(d: ToolDecision): State {
  const state = State.create("Agent tool call that keywork would ask a person to approve")
    .field("tool", d.tool)
    .field("asked_because", d.ask?.rule ?? "unknown");
  if (d.ask !== undefined) state.digest("grant_offered", d.ask.grantable);
  const s = d.subject;
  if (s.kind === "command") {
    return state
      .digest("command_parts", s.parts)
      .digest("destructive", s.destructive)
      .digest("opaque", s.opaque)
      .digest("truncated", s.truncated)
      .untrusted("command", s.command)
      .build();
  }
  if (s.kind === "path") {
    state.digest("inside_workspace", s.insideWorkspace);
    if (d.ask?.change !== undefined) state.digest("creates_file", d.ask.change.creates);
    if (s.change?.kind === "write") state.digest("lines_written", s.change.lines);
    if (s.change?.kind === "edit") {
      state
        .digest("lines_removed", s.change.removedLines)
        .digest("lines_added", s.change.addedLines)
        .digest("replace_all", s.change.replaceAll);
    }
    return state.untrusted("path", s.path).build();
  }
  return state.digest("truncated", s.truncated).untrusted("arguments", s.arguments).build();
}
