import { describe, expect, it } from "vitest";
import { type HookEvent, JOURNAL_SCHEMA } from "../src/hook/event.ts";
import { resolvePrompts } from "../src/hook/resolve.ts";

let n = 0;
const at = (s: number): string => new Date(Date.UTC(2026, 9, 24, 12, 0, s)).toISOString();

function ev(partial: Partial<HookEvent> & Pick<HookEvent, "kind" | "at">): HookEvent {
  n++;
  return {
    schema: JOURNAL_SCHEMA,
    id: `e${n}`,
    harness: "claude-code",
    session: "s1",
    ...partial,
  };
}

const prompt = (sec: number, hash = "h1", extra: Partial<HookEvent> = {}): HookEvent =>
  ev({
    kind: "prompt",
    at: at(sec),
    tool: "Bash",
    inputHash: hash,
    subject: {
      kind: "command",
      command: "x",
      parts: 1,
      destructive: false,
      opaque: false,
      uploads: false,
      truncated: false,
      redacted: false,
    },
    ...extra,
  });
const ran = (sec: number, hash = "h1", extra: Partial<HookEvent> = {}): HookEvent =>
  ev({ kind: "ran", at: at(sec), tool: "Bash", inputHash: hash, toolUseId: `tu${sec}`, ...extra });

describe("resolvePrompts", () => {
  it("labels a prompted call that ran as allowed, by tool_use_id", () => {
    const r = resolvePrompts([prompt(1), ran(2)]);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]).toMatchObject({
      label: "allowed",
      by: "ran",
      settledAt: at(2),
      toolUseId: "tu2",
    });
    expect(r.runsWithoutPrompt).toBe(0);
  });

  it("counts a run with no prompt before it, and leaves an unanswered prompt open", () => {
    const r = resolvePrompts([ran(1, "other"), prompt(2)]);
    expect(r.runsWithoutPrompt).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ label: "open" });
    expect(r.outcomes[0]?.by).toBeUndefined();
  });

  it("denies a prompt that never ran once the session ends", () => {
    const r = resolvePrompts([prompt(1), ev({ kind: "session-end", at: at(5) })]);
    expect(r.outcomes[0]).toMatchObject({ label: "denied", by: "session-end", settledAt: at(5) });
    expect(r.sessionsEnded).toBe(1);
  });

  it("denies a prompt from an earlier turn when the session moves to a new turn", () => {
    const r = resolvePrompts([
      prompt(1, "h1", { turn: "t1" }),
      prompt(2, "h2", { turn: "t2" }),
      ran(3, "h2", { turn: "t2" }),
    ]);
    const [first, second] = r.outcomes;
    expect(first).toMatchObject({ label: "denied", by: "turn", settledAt: at(2) });
    expect(second).toMatchObject({ label: "allowed" });
  });

  it("keeps a prompt open within its own turn even when other calls run", () => {
    const r = resolvePrompts([prompt(1, "h1", { turn: "t1" }), ran(2, "h2", { turn: "t1" })]);
    expect(r.outcomes[0]).toMatchObject({ label: "open" });
    expect(r.runsWithoutPrompt).toBe(1);
  });

  it("matches repeated identical prompts oldest first", () => {
    const r = resolvePrompts([
      prompt(1),
      prompt(2),
      ran(3),
      ev({ kind: "session-end", at: at(9) }),
    ]);
    expect(r.outcomes.map((o) => o.label)).toEqual(["allowed", "denied"]);
  });

  it("treats a failed run as approved: the person said yes, the tool said no", () => {
    const r = resolvePrompts([
      prompt(1),
      ev({ kind: "failed", at: at(2), tool: "Bash", inputHash: "h1" }),
    ]);
    expect(r.outcomes[0]).toMatchObject({ label: "allowed", by: "failed" });
  });

  it("takes a classifier denial out of the person's population", () => {
    const r = resolvePrompts([
      prompt(1),
      ev({ kind: "classifier-denied", at: at(2), tool: "Bash", inputHash: "h1" }),
    ]);
    expect(r.outcomes[0]).toMatchObject({ label: "classifier", by: "classifier" });
  });

  it("orders by time, not by file position, because async hooks land out of order", () => {
    const r = resolvePrompts([ran(2), prompt(1)]);
    expect(r.outcomes[0]).toMatchObject({ label: "allowed" });
  });

  it("keeps sessions apart", () => {
    const r = resolvePrompts([
      prompt(1, "h1", { session: "a" }),
      ran(2, "h1", { session: "b" }),
      ev({ kind: "session-end", at: at(3), session: "b" }),
    ]);
    expect(r.outcomes[0]).toMatchObject({ label: "open" });
    expect(r.runsWithoutPrompt).toBe(1);
    expect(r.sessions).toBe(2);
  });
});
