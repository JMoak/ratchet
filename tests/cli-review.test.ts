import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, REVIEW_SOURCE, type ReviewIo } from "../src/cli/main.ts";
import { Engine } from "../src/engine.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import { judge } from "../src/questions.ts";
import type { Decision, Oracle, Question } from "../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const leaningYes: Oracle = {
  id: "fixed",
  decide: async (_state: string, questions: readonly Question[]): Promise<Decision[]> =>
    questions.map((q) => ({
      verdict: { kind: "judge", questionId: q.id, pYes: 0.9, confidence: 0.9 },
      oracle: "fixed",
      latencyMs: 0,
      cost: 0,
      at: "2026-10-21T00:00:00.000Z",
    })),
};

async function ledgerWith(states: readonly string[], keepState = true) {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-review-"));
  dirs.push(dir);
  const path = join(dir, "ledger.jsonl");
  const engine = new Engine({ oracle: leaningYes, ledger: new JsonlLedger(path), keepState });
  const gate = engine.gate({
    id: "tool",
    question: judge("ok?", { id: "ok" }),
    policy: { actAbove: 0.8 },
  });
  const ids: string[] = [];
  for (const s of states) ids.push((await gate.ask(s)).recordId);
  await engine.label(ids[0] as string, { correct: true, truth: true, source: "keywork:person" });
  return { path, ids };
}

function scripted(answers: readonly string[]): ReviewIo & { printed: string[]; asked: number } {
  const queue = [...answers];
  const io = {
    printed: [] as string[],
    asked: 0,
    print: (text: string) => {
      io.printed.push(text);
    },
    ask: async () => {
      io.asked++;
      return queue.shift();
    },
  };
  return io;
}

describe("ratchet review", () => {
  it("records blind answers and reveals the model and the earlier label only at the end", async () => {
    const { path } = await ledgerWith(["state one", "state two", "state three"]);
    const io = scripted(["n", "y", "y"]);

    const result = await main(["review", path, "--gate", "tool", "--seed", "7"], io);

    expect(result.exitCode).toBe(0);
    expect(io.printed.join("")).not.toMatch(/0\.9|act|lean/);
    expect(result.output).toContain("Recorded 3 blind labels for tool (seed 7).");
    expect(result.output).toContain("matched the model's lean on 2 of 3");
    const rows = await new JsonlLedger(path).all();
    expect(rows.every((r) => r.outcome?.source === REVIEW_SOURCE)).toBe(true);
  });

  it("keeps the replaced label in the note", async () => {
    const { path, ids } = await ledgerWith(["only state"]);

    await main(["review", path, "--gate", "tool", "--seed", "1"], scripted(["n"]));

    const row = (await new JsonlLedger(path).all()).find((r) => r.id === ids[0]);
    expect(row?.outcome).toMatchObject({
      truth: false,
      correct: false,
      source: REVIEW_SOURCE,
      note: "replaced keywork:person label truth=true",
    });
  });

  it("draws the same sample from the same seed and never draws a reviewed row again", async () => {
    const { path } = await ledgerWith(["a", "b", "c", "d", "e"]);
    const first = scripted(["s", "s"]);
    const again = scripted(["s", "s"]);
    await main(["review", path, "--gate", "tool", "--sample", "2", "--seed", "3"], first);
    await main(["review", path, "--gate", "tool", "--sample", "2", "--seed", "3"], again);
    expect(again.printed).toEqual(first.printed);

    await main(
      ["review", path, "--gate", "tool", "--seed", "3", "--reviewer", "jm"],
      scripted(["y", "y", "y", "y", "y"]),
    );
    const rows = await new JsonlLedger(path).all();
    expect(rows.every((r) => r.outcome?.source === `${REVIEW_SOURCE}:jm`)).toBe(true);
    const done = await main(["review", path, "--gate", "tool"], scripted([]));
    expect(done.exitCode).toBe(2);
    expect(done.output).toContain("no unreviewed judge rows");
  });

  it("reviews every unreviewed denial in ledger order with --denied", async () => {
    const { path, ids } = await ledgerWith(["a", "b", "c"]);
    const ledger = new JsonlLedger(path);
    const denied = { at: "2026-10-22T00:00:00.000Z", correct: false, truth: false };
    await ledger.label(ids[1] as string, { ...denied, source: "keywork:person" });
    await ledger.label(ids[2] as string, { ...denied, source: "keywork:person" });
    const io = scripted(["y", "y"]);

    const result = await main(["review", path, "--gate", "tool", "--denied"], io);

    expect(io.printed.join("")).toContain("every unreviewed denial, 2 of 3 rows");
    expect(io.printed.join("")).toMatch(/--- 1 of 2 ---\nb\n[\s\S]*--- 2 of 2 ---\nc\n/);
    expect(result.output).toContain("Recorded 2 blind labels for tool (every denial).");
    expect(result.output).toContain("matched the earlier label on 0 of 2");
    const again = await main(["review", path, "--gate", "tool", "--denied"], scripted([]));
    expect(again.exitCode).toBe(2);
    expect(again.output).toContain("no unreviewed denials");
  });

  it("stops on q or at the end of input and keeps what was answered", async () => {
    const { path } = await ledgerWith(["a", "b", "c"]);
    const result = await main(
      ["review", path, "--gate", "tool", "--seed", "2"],
      scripted(["maybe", "y", "q"]),
    );
    expect(result.output).toContain("Recorded 1 blind label for tool");
  });

  it("needs a terminal, and stored states to show", async () => {
    const { path } = await ledgerWith(["a"], false);
    expect((await main(["review", path, "--gate", "tool"])).output).toContain(
      "needs an interactive terminal",
    );
    expect((await main(["review", path, "--gate", "tool"], scripted([]))).output).toContain(
      "keepState",
    );
  });
});
