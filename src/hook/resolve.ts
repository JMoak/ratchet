/**
 * Turn the journal into labelled prompts. No harness tells a hook how the person answered a
 * permission prompt, so the answer is read from what happened next: a prompted call that ran
 * was approved; a prompted call that never ran before the turn moved on, or before the session
 * ended, was denied. A prompt with neither signal yet stays open and is not ingested.
 *
 * The denial inference is the weak link, and it is treated like keywork's older journals: a
 * denial with no stated reason counts against the call until a blind review says otherwise
 * (`ratchet review --denied`). A person who denies to steer ("not that, do X") is judging the
 * moment, not the call, and only a review can tell the two apart.
 *
 * Matching is by session, tool and input hash, oldest prompt first, because `PermissionRequest`
 * carries no `tool_use_id` in either harness. If the same call is prompted twice in a session
 * and only once run, the rows may swap labels between the two prompts; the counts do not change,
 * and a repeated state enters the acceptance sample once anyway.
 */
import type { HookEvent } from "./event.ts";

export type PromptLabel = "allowed" | "denied" | "open" | "classifier";

export type SettledBy = "ran" | "failed" | "turn" | "session-end" | "classifier";

export interface PromptOutcome {
  readonly prompt: HookEvent;
  readonly label: PromptLabel;
  /** What settled it; absent while open. */
  readonly by?: SettledBy;
  /** When the settling event happened; absent while open. */
  readonly settledAt?: string;
  /** The run's tool_use_id when it ran. */
  readonly toolUseId?: string;
}

export interface Resolution {
  readonly outcomes: readonly PromptOutcome[];
  /** Runs with no prompt before them: calls a rule or mode allowed. Not the gate's population. */
  readonly runsWithoutPrompt: number;
  readonly sessions: number;
  readonly sessionsEnded: number;
}

interface Open {
  readonly prompt: HookEvent;
  settled?: {
    readonly label: PromptLabel;
    readonly by: SettledBy;
    readonly at: string;
    readonly toolUseId?: string;
  };
}

const key = (e: HookEvent): string => `${e.session}\u0000${e.tool ?? ""}\u0000${e.inputHash ?? ""}`;

export function resolvePrompts(events: readonly HookEvent[]): Resolution {
  const ordered = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || a.i - b.i)
    .map(({ e }) => e);
  const all: Open[] = [];
  const byKey = new Map<string, Open[]>();
  const bySession = new Map<string, Open[]>();
  const lastTurn = new Map<string, string>();
  const sessions = new Set<string>();
  let runsWithoutPrompt = 0;
  let sessionsEnded = 0;

  const settle = (
    o: Open,
    label: PromptLabel,
    by: SettledBy,
    at: string,
    toolUseId?: string,
  ): void => {
    if (o.settled !== undefined) return;
    o.settled = { label, by, at, ...(toolUseId === undefined ? {} : { toolUseId }) };
  };
  const takeOpen = (k: string): Open | undefined => {
    const list = byKey.get(k);
    while (list && list.length > 0) {
      const first = list.shift() as Open;
      if (first.settled === undefined) return first;
    }
    return undefined;
  };

  for (const e of ordered) {
    sessions.add(e.session);
    // A new user turn in a session means every prompt from an earlier turn was answered, and
    // one that never ran was denied: the harness does not move on past an unanswered prompt.
    if (e.turn !== undefined) {
      const previous = lastTurn.get(e.session);
      if (previous !== undefined && previous !== e.turn) {
        for (const o of bySession.get(e.session) ?? []) {
          if (o.settled === undefined && o.prompt.turn !== e.turn)
            settle(o, "denied", "turn", e.at);
        }
      }
      lastTurn.set(e.session, e.turn);
    }
    switch (e.kind) {
      case "prompt": {
        const o: Open = { prompt: e };
        all.push(o);
        push(byKey, key(e), o);
        push(bySession, e.session, o);
        break;
      }
      case "ran":
      case "failed": {
        const o = takeOpen(key(e));
        if (o === undefined) runsWithoutPrompt++;
        else settle(o, "allowed", e.kind, e.at, e.toolUseId);
        break;
      }
      case "classifier-denied": {
        const o = takeOpen(key(e));
        if (o !== undefined) settle(o, "classifier", "classifier", e.at);
        break;
      }
      case "session-end": {
        sessionsEnded++;
        for (const o of bySession.get(e.session) ?? []) settle(o, "denied", "session-end", e.at);
        break;
      }
    }
  }
  return {
    outcomes: all.map((o) =>
      o.settled === undefined
        ? { prompt: o.prompt, label: "open" }
        : {
            prompt: o.prompt,
            label: o.settled.label,
            by: o.settled.by,
            settledAt: o.settled.at,
            ...(o.settled.toolUseId === undefined ? {} : { toolUseId: o.settled.toolUseId }),
          },
    ),
    runsWithoutPrompt,
    sessions: sessions.size,
    sessionsEnded,
  };
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}
