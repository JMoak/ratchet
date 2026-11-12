/**
 * Wave 2, package D. T3-02: `ratchet review` shows the question it labels and asks for that
 * question's answer, so a "does this need moderator action?" gate is not labelled inverted, and
 * `--denied` reads a denial through the row's go polarity. T1-13: `--audits` reviews the blind
 * audit queue. The e2e harness's `blindReview` still parses the printed state block.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blindReview } from "../experiments/e2e/lib.ts";
import { main, type ReviewIo } from "../src/cli/main.ts";
import { shortQuestion } from "../src/cli/review.ts";
import { Engine } from "../src/engine.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import { judge, judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempLedger(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-d-review-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

const fixed = (pYes: number): Oracle => ({
  id: "fixed",
  async decide(_state, qs) {
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, pYes),
      oracle: "fixed",
      model: "fixed-1",
      latencyMs: 0,
      cost: 0,
      at: "2026-11-12T00:00:00.000Z",
    }));
  },
});

function scripted(answers: readonly string[]): ReviewIo & { printed: string[]; prompts: string[] } {
  const queue = [...answers];
  const io = {
    printed: [] as string[],
    prompts: [] as string[],
    print: (text: string) => {
      io.printed.push(text);
    },
    ask: async (prompt: string) => {
      io.prompts.push(prompt);
      return queue.shift();
    },
  };
  return io;
}

/** A moderation gate: yes means "needs action", so acting (publishing) is the no side. */
async function moderation(posts: readonly string[], pYes = 0.03) {
  const path = await tempLedger();
  const engine = new Engine({
    oracle: fixed(pYes),
    ledger: new JsonlLedger(path),
    keepState: true,
  });
  const q = judge("Does this post need moderator action?", { id: "needs_action" });
  const policy = { actAbove: 0.9, goIsYes: false };
  const gate = engine.gate({ id: "mod", question: q, policy });
  const ids: string[] = [];
  for (const post of posts) ids.push((await gate.ask(`post: ${post}`)).recordId);
  return { path, ids, engine };
}

describe("T3-02: review asks the gate's own question", () => {
  it("shows the question and asks for its answer; n on a harmless post records truth false", async () => {
    const { path } = await moderation(["Caught three fluke off the jetty this morning."]);
    const io = scripted(["n"]);

    const result = await main(["review", path, "--gate", "mod", "--seed", "1"], io);

    expect(result.exitCode).toBe(0);
    expect(io.printed.join("")).toContain("Question: Does this post need moderator action?");
    expect(io.prompts[0]).toBe(
      "Does this post need moderator action? [y]es / [n]o / [s]kip / [q]uit: ",
    );
    expect(io.prompts[0]).not.toMatch(/approve/i);
    const [row] = await new JsonlLedger(path).all();
    // Needs no action: truth false, and the model (pYes 0.03) leaned the same way.
    expect(row?.outcome).toMatchObject({ truth: false, correct: true, source: "review:blind" });
    expect(result.output).toContain("matched the model's lean on 1 of 1");
  });

  it("--denied selects rows whose label says acting was wrong, through the go polarity", async () => {
    const { path, ids, engine } = await moderation(["harmless", "spam link", "a threat"]);
    // The decider said: the harmless post needs no action (publishing was right); the spam
    // and the threat need action (publishing was wrong). Truth is the question's answer.
    await engine.label(ids[0] as string, { correct: true, truth: false, source: "mod:person" });
    await engine.label(ids[1] as string, { correct: false, truth: true, source: "mod:person" });
    await engine.label(ids[2] as string, { correct: false, truth: true, source: "mod:person" });
    const io = scripted(["y", "y"]);

    const result = await main(["review", path, "--gate", "mod", "--denied"], io);

    expect(result.exitCode).toBe(0);
    const shown = io.printed.join("");
    expect(shown).toContain("every unreviewed denial, 2 of 3 rows");
    expect(shown).toMatch(
      /--- 1 of 2 ---\npost: spam link\n[\s\S]*--- 2 of 2 ---\npost: a threat\n/,
    );
    expect(shown).not.toContain("post: harmless");
  });

  it("--denied on a yes-is-go gate still selects truth false", async () => {
    const path = await tempLedger();
    const engine = new Engine({
      oracle: fixed(0.9),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    const gate = engine.gate({
      id: "tool",
      question: judge("Would a careful developer approve this call?", { id: "ok" }),
      policy: { actAbove: 0.8 },
    });
    const a = await gate.ask("rm -rf /");
    const b = await gate.ask("ls");
    await engine.label(a.recordId, { correct: false, truth: false, source: "x:person" });
    await engine.label(b.recordId, { correct: true, truth: true, source: "x:person" });
    const io = scripted(["n"]);
    await main(["review", path, "--gate", "tool", "--denied"], io);
    expect(io.printed.join("")).toMatch(/--- 1 of 1 ---\nrm -rf \/\n/);
  });

  it("prints each item's question when the drawn rows ask different ones", async () => {
    const path = await tempLedger();
    const engine = new Engine({
      oracle: fixed(0.9),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    const q1 = judge("Is it safe?", { id: "q" });
    const q2 = judge("Is it safe to run without a sandbox?", { id: "q" });
    await engine.ask("one", q1, { policy: { actAbove: 0.8 } });
    await engine.ask("two", q2, { policy: { actAbove: 0.8 } });
    const io = scripted(["y", "y"]);
    await main(["review", path, "--gate", "adhoc:q", "--seed", "4"], io);
    const shown = io.printed.join("");
    expect(shown).toContain("Question: Is it safe?\n");
    expect(shown).toContain("Question: Is it safe to run without a sandbox?\n");
    expect(new Set(io.prompts)).toEqual(
      new Set([
        "Is it safe? [y]es / [n]o / [s]kip / [q]uit: ",
        "Is it safe to run without a sandbox? [y]es / [n]o / [s]kip / [q]uit: ",
      ]),
    );
  });

  it("asks a long rubric by its first sentence and prints the rest once", () => {
    expect(
      shortQuestion(
        "Would a careful developer approve this agent tool call without needing to look closer? Approve routine reads.",
      ),
    ).toBe(
      "Would a careful developer approve this agent tool call without needing to look closer?",
    );
    expect(shortQuestion("Is `a?b` a match?")).toBe("Is `a?b` a match?");
    expect(shortQuestion("Needs action.")).toBe("Needs action?");
    expect(shortQuestion(`Is ${"x".repeat(300)}?`)).toHaveLength(160);
  });

  it("keeps the state block the e2e harness parses: blindReview labels by state", async () => {
    const { path } = await moderation(["harmless", "a threat"]);
    const labels = new Map([
      ["post: harmless", false],
      ["post: a threat", true],
    ]);
    const res = await blindReview(path, "mod", labels, { sample: 5, seed: 2 });
    expect(res).toMatchObject({ exitCode: 0, answered: 2, missing: 0 });
    const rows = await new JsonlLedger(path).all();
    expect(Object.fromEntries(rows.map((r) => [r.state, r.outcome?.truth]))).toEqual({
      "post: harmless": false,
      "post: a threat": true,
    });
  });
});

describe("T1-13: review --audits", () => {
  async function enforcing() {
    const path = await tempLedger();
    const engine = new Engine({
      oracle: fixed(0.95),
      ledger: new JsonlLedger(path),
      keepState: true,
      mode: "enforce",
      auditRate: 0.5,
      seed: 3,
    });
    const gate = engine.gate({
      id: "tool",
      question: judge("Is this call safe to run?", { id: "safe" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 12; i++) await gate.ask(`call ${i}`);
    const rows = await new JsonlLedger(path).all();
    return { path, rows, engine };
  }

  it("reviews every unreviewed audit, in ledger order, and nothing else", async () => {
    const { path, rows } = await enforcing();
    const audits = rows.filter((r) => r.tags.includes("audit"));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.length).toBeLessThan(rows.length);
    const io = scripted(audits.map(() => "y"));

    const result = await main(["review", path, "--gate", "tool", "--audits"], io);

    expect(result.exitCode).toBe(0);
    const shown = io.printed.join("");
    expect(shown).toContain(`every unreviewed audit, ${audits.length} of ${rows.length} rows`);
    const order = [...shown.matchAll(/--- \d+ of \d+ ---\n(call \d+)\n/g)].map((m) => m[1]);
    expect(order).toEqual(audits.map((r) => r.state));
    expect(result.output).toContain(
      `Recorded ${audits.length} blind labels for tool (every audit).`,
    );
    const after = await new JsonlLedger(path).all();
    expect(after.filter((r) => r.outcome?.source === "review:blind").map((r) => r.id)).toEqual(
      audits.map((r) => r.id),
    );
    const again = await main(["review", path, "--gate", "tool", "--audits"], scripted([]));
    expect(again.exitCode).toBe(2);
    expect(again.output).toContain("no unreviewed audits");
  });

  it("is one queue at a time", async () => {
    const { path } = await enforcing();
    const r = await main(["review", path, "--gate", "tool", "--audits", "--denied"], scripted([]));
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("pick one");
  });
});

/** An oracle answering per state; "throw" fails the call, so the row fails open. */
const byState = (table: Record<string, number | "throw">): Oracle => ({
  id: "table",
  async decide(state, qs) {
    const p = table[state] ?? 0.5;
    if (p === "throw") throw new Error("boom");
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, p),
      oracle: "table",
      model: "table-1",
      latencyMs: 0,
      cost: 0,
      at: "2026-11-12T00:00:00.000Z",
    }));
  },
});

describe("wave 3, item 11: --denied reads each row by its own policy", () => {
  it("a gate that flipped polarity, with a failed-open row under the second policy", async () => {
    const path = await tempLedger();
    const table: Record<string, number | "throw"> = {
      "item: a1": 0.9,
      "item: a2": 0.9,
      "item: a3": 0.2,
      "item: b1": 0.1,
      "item: b2": 0.8,
      "item: f1": "throw",
    };
    const q = judge("Is this item safe to publish?", { id: "q" });
    const ids: Record<string, string> = {};
    const e1 = new Engine({
      oracle: byState(table),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    const g1 = e1.gate({ id: "g", question: q, policy: { actAbove: 0.8 } });
    for (const k of ["a1", "a2", "a3"]) ids[k] = (await g1.ask(`item: ${k}`)).recordId;
    const e2 = new Engine({
      oracle: byState(table),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    const g2 = e2.gate({ id: "g", question: q, policy: { actAbove: 0.8, goIsYes: false } });
    for (const k of ["b1", "b2", "f1"]) ids[k] = (await g2.ask(`item: ${k}`)).recordId;
    const truth: Record<string, boolean> = {
      a1: true,
      a2: true,
      a3: false,
      b1: false,
      b2: true,
      f1: true,
    };
    for (const [k, t] of Object.entries(truth))
      await e1.label(ids[k] as string, { correct: true, truth: t, source: "person" });
    const io = scripted(Array(10).fill("s"));
    await main(["review", path, "--gate", "g", "--denied"], io);
    const drawn = io.printed
      .filter((t) => t.startsWith("\n--- "))
      .map((t) => /item: (\w+)/.exec(t)?.[1]);
    // Under the first policy yes is go, so a3 (truth no) was a denial; under the second no is
    // go, so b2 and the failed-open f1 (truth yes) were. The gate's majority would miss f1.
    expect(drawn).toEqual(["a3", "b2", "f1"]);
  });
});

describe("wave 3, item 10: review on a battery asks each member's question", () => {
  async function battery(combine: "any" | "all" | undefined, goIsYes = false) {
    const path = await tempLedger();
    const engine = new Engine({
      oracle: byState({ "post: buy cheap pills": 0.9 }),
      ledger: new JsonlLedger(path),
      keepState: true,
    });
    const gate = engine.gate({
      id: "modb",
      question: [
        judge("Is the post spam?", { id: "spam" }),
        judge("Is the post abusive?", { id: "abuse" }),
      ],
      policy: { actAbove: 0.9, goIsYes },
      ...(combine === undefined ? {} : { combine }),
    });
    await gate.ask("post: buy cheap pills");
    return path;
  }
  const labels = async (path: string) =>
    Object.fromEntries(
      (await new JsonlLedger(path).all()).map((r) => [
        r.combined === true ? "battery" : r.questionId,
        r.outcome?.truth,
      ]),
    );

  it("any: shows and asks each member; the battery's truth is their OR", async () => {
    const path = await battery("any");
    const io = scripted(["y", "n"]);
    const res = await main(["review", path, "--gate", "modb", "--seed", "1"], io);
    expect(res.exitCode).toBe(0);
    const shown = io.printed.join("");
    expect(shown).toContain("spam: Is the post spam?");
    expect(shown).toContain("abuse: Is the post abusive?");
    expect(io.prompts).toEqual([
      "spam: Is the post spam? [y]es / [n]o / [s]kip / [q]uit: ",
      "abuse: Is the post abusive? [y]es / [n]o / [s]kip / [q]uit: ",
    ]);
    // One "y" no longer becomes every member's truth.
    expect(await labels(path)).toEqual({ battery: true, spam: true, abuse: false });
    const [combined] = (await new JsonlLedger(path).all()).filter((r) => r.combined === true);
    expect(combined?.outcome?.memberTruths).toEqual({ spam: true, abuse: false });
  });

  it("all: the battery's truth is the AND", async () => {
    const path = await battery("all");
    await main(["review", path, "--gate", "modb", "--seed", "1"], scripted(["y", "n"]));
    expect(await labels(path)).toEqual({ battery: false, spam: true, abuse: false });
  });

  it("any with a skip that leaves it open asks one overall question; the skipped member stays unlabelled", async () => {
    const path = await battery("any");
    const io = scripted(["n", "s", "y"]);
    await main(["review", path, "--gate", "modb", "--seed", "1"], io);
    expect(io.prompts[2]).toBe(
      "Overall, should modb act on this (it acts when its combined answer is no)? [y]es / [n]o / [s]kip / [q]uit: ",
    );
    // Acting is right, and no is go: the battery's truth is no.
    expect(await labels(path)).toEqual({ battery: false, spam: false, abuse: undefined });
  });

  it("another combiner asks the overall question, read through the go polarity", async () => {
    const path = await battery(undefined, true);
    const io = scripted(["y", "y", "n"]);
    await main(["review", path, "--gate", "modb", "--seed", "1"], io);
    expect(io.prompts[2]).toContain("it acts when its combined answer is yes");
    expect(await labels(path)).toEqual({ battery: false, spam: true, abuse: true });
  });

  it("blindReview still runs on a battery: the first member is answered, the rest skip", async () => {
    const path = await battery("any");
    const res = await blindReview(path, "modb", new Map([["post: buy cheap pills", true]]), {
      sample: 5,
      seed: 1,
    });
    expect(res.exitCode).toBe(0);
    expect(await labels(path)).toEqual({ battery: true, spam: true, abuse: undefined });
  });
});
