/**
 * Shared helpers for the wave 3 V1 safety verification: deterministic offline oracles and a
 * result collector. Every attack states the contract it tests and whether it held.
 */
import { judgeVerdictFrom } from "../../../../src/questions.ts";
import type { Decision, JudgeQuestion, Oracle, Question } from "../../../../src/types.ts";

export interface Attack {
  readonly area: string;
  readonly finding: string;
  readonly name: string;
  readonly held: boolean;
  readonly observed: string;
}

export const results: Attack[] = [];

/** Run one attack. `fn` returns whether the contract held and what was observed. */
export async function attack(
  area: string,
  finding: string,
  name: string,
  fn: () => Promise<{ held: boolean; observed: string }> | { held: boolean; observed: string },
): Promise<void> {
  let r: { held: boolean; observed: string };
  try {
    r = await fn();
  } catch (error) {
    r = {
      held: false,
      observed: `attack harness threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  results.push({ area, finding, name, ...r });
}

/** Print a markdown table of results and return the number broken. */
export function report(title: string): number {
  const out: string[] = [`## ${title}`, "", "| area | finding | attack | held | observed |"];
  out.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
    out.push(
      `| ${r.area} | ${r.finding} | ${cell(r.name)} | ${r.held ? "yes" : "**NO**"} | ${cell(r.observed)} |`,
    );
  }
  const broken = results.filter((r) => !r.held).length;
  out.push("", `${results.length} attacks, ${broken} broke a contract.`, "");
  process.stdout.write(`${out.join("\n")}\n`);
  return broken;
}

export const at = (): string => "2026-11-12T12:00:00.000Z";

/** A decision with a valid judge verdict at pYes. */
export function judged(q: Question, pYes: number, extra: Partial<Decision> = {}): Decision {
  return {
    verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
    oracle: "scripted",
    latencyMs: 1,
    cost: 0.001,
    at: at(),
    ...extra,
  };
}

/** An oracle whose answers come from a function of the questions (and call count). */
export function scripted(
  id: string,
  fn: (qs: readonly Question[], call: number, state: string) => unknown,
  extra: Record<string, unknown> = {},
): Oracle {
  let calls = 0;
  return {
    id,
    ...extra,
    async decide(state: string, qs: readonly Question[]) {
      calls++;
      return fn(qs, calls, state) as Decision[];
    },
  } as Oracle;
}

/** A judge oracle answering pYes for every question, reporting `model`. */
export function fixed(id: string, pYes: number, model?: string, cost = 0.001): Oracle {
  return scripted(id, (qs) =>
    qs.map((q) => judged(q, pYes, { oracle: id, cost, ...(model ? { model } : {}) })),
  );
}

export const describeError = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "an unprintable error";
  }
};
