/**
 * Write V4's fresh corpora and spot-check samples, labels fixed before any live call:
 *
 *   bun experiments/e2e/verify/v4-fresh/build.ts
 *
 * - `tool-corpus.json`: the fresh tool calls, each with the decider's truth and why.
 * - `moderation-corpus.json`: the fresh forum posts, each with the combined truth and every
 *   member's own truth (`memberTruths`), plus T3's member questions verbatim.
 * - `spotcheck-tool.json` (25 seeded items) and `spotcheck-mod.json` (20): states and
 *   questions, no labels, for the coordinator's blind relabel.
 *
 * Before writing it checks that the renderer here produces exactly T1's states on every one
 * of T1's own variants, and that no fresh state or post repeats one from T1 or T3. It refuses
 * to rewrite the corpora once a live run directory exists, so a label cannot move after an
 * answer has been seen; corrections go to `corrections.json`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rng, shuffled } from "../../../../src/math.ts";
import type { JudgeQuestion } from "../../../../src/types.ts";
import { corpusHash, E2E_OUT, progress, ROOT, writeJson } from "../../lib.ts";
import {
  CTX as T1_CTX,
  TEMPLATES as T1_TEMPLATES,
  renderVariant as t1Render,
} from "../../t1-toolgate/corpus.ts";
import { TOOL_QUESTION } from "../../t1-toolgate/gate.ts";
import { buildModCorpus, MOD_SEED, SUB_QUESTIONS } from "./mod-corpus.ts";
import { buildToolCorpus, CORPUS_SEED, renderCall } from "./tool-corpus.ts";

export const V4_DIR = join(ROOT, "experiments", "e2e", "verify", "v4-fresh");
export const V4_OUT = join(E2E_OUT, "verify", "v4-fresh");
export const TOOL_CORPUS_FILE = join(V4_DIR, "tool-corpus.json");
export const MOD_CORPUS_FILE = join(V4_DIR, "moderation-corpus.json");
const T1_CORPUS = join(ROOT, "experiments", "e2e", "t1-toolgate", "corpus.json");
const T3_MOD_CORPUS = join(ROOT, "experiments", "e2e", "t3-triage", "corpus", "moderation.json");

/** T3's moderation member questions, verbatim from its frozen corpus file. */
export function t3MemberQuestions(): JudgeQuestion[] {
  const t3 = JSON.parse(readFileSync(T3_MOD_CORPUS, "utf8")) as {
    questions: { members: JudgeQuestion[] };
  };
  const members = t3.questions.members;
  const ids = members.map((q) => q.id);
  if (ids.join(",") !== SUB_QUESTIONS.join(",")) {
    throw new Error(`T3 member order ${ids.join(",")} differs from ${SUB_QUESTIONS.join(",")}`);
  }
  return members;
}

function liveRunExists(): boolean {
  if (!existsSync(V4_OUT)) return false;
  return readdirSync(V4_OUT).some((d) => d.endsWith("-live"));
}

function checkRenderer(): number {
  let n = 0;
  for (const tpl of T1_TEMPLATES) {
    for (const v of tpl.variants) {
      const mine = renderCall(T1_CTX[v.ctx], v.task, v.call, v.context);
      if (mine !== t1Render(v).text) throw new Error(`renderer differs from T1 on ${tpl.group}`);
      n++;
    }
  }
  return n;
}

const postOf = (state: string): string =>
  /\[untrusted post\]\n([\s\S]*?)\n\[\/untrusted\]/.exec(state)?.[1] ?? state;

function main(): void {
  if (liveRunExists() && !process.argv.includes("--check")) {
    throw new Error(
      `a live run exists under ${V4_OUT}; the corpora are frozen (record corrections instead)`,
    );
  }
  const checked = checkRenderer();
  progress(`[build] renderer matches T1 on all ${checked} of T1's variants`);

  const tool = buildToolCorpus();
  const t1States = new Set(
    (JSON.parse(readFileSync(T1_CORPUS, "utf8")) as { items: { state: string }[] }).items.map(
      (i) => i.state,
    ),
  );
  for (const it of tool) {
    if (t1States.has(it.state)) throw new Error(`tool item ${it.id} repeats a T1 state`);
  }
  const mod = buildModCorpus();
  const t3Posts = new Set(
    (JSON.parse(readFileSync(T3_MOD_CORPUS, "utf8")) as { items: { state: string }[] }).items.map(
      (i) => postOf(i.state),
    ),
  );
  for (const it of mod) {
    if (!it.floored && t3Posts.has(postOf(it.state))) {
      throw new Error(`moderation item ${it.id} repeats a T3 post`);
    }
  }
  const members = t3MemberQuestions();

  if (process.argv.includes("--check")) {
    const onDisk = JSON.parse(readFileSync(TOOL_CORPUS_FILE, "utf8")) as { items: unknown };
    const modDisk = JSON.parse(readFileSync(MOD_CORPUS_FILE, "utf8")) as { items: unknown };
    const same =
      corpusHash(onDisk.items) === corpusHash(tool) &&
      corpusHash(modDisk.items) === corpusHash(mod);
    progress(`[build] --check: corpora on disk ${same ? "match" : "DIFFER FROM"} the generators`);
    if (!same) process.exitCode = 1;
    return;
  }

  writeJson(TOOL_CORPUS_FILE, {
    note: "V4 fresh tool-gate corpus. Labels fixed by the decider (DECIDER.md) before any live call. Rendered exactly as T1's gate renders states; question is T1's TOOL_QUESTION.",
    seed: CORPUS_SEED,
    generatedFrom: "experiments/e2e/verify/v4-fresh/tool-corpus.ts",
    items: tool,
  });
  writeJson(MOD_CORPUS_FILE, {
    note: "V4 fresh moderation corpus for T3's battery. truth = needs moderator action; memberTruths = each member's own truth. Labels fixed before any live call.",
    seed: MOD_SEED,
    generatedFrom: "experiments/e2e/verify/v4-fresh/mod-corpus.ts",
    questions: { members },
    items: mod,
  });

  const toolSample = shuffled(tool, rng(CORPUS_SEED + 25)).slice(0, 25);
  writeJson(join(V4_DIR, "spotcheck-tool.json"), {
    note: "Blind relabel sample: 25 seeded items from tool-corpus.json as the model saw them, no labels. Answer the question for each: yes (allow without asking) or no.",
    seed: CORPUS_SEED + 25,
    items: toolSample.map((it) => ({
      id: it.id,
      state: it.state,
      question: { prompt: TOOL_QUESTION.prompt, criteria: TOOL_QUESTION.criteria },
    })),
  });
  const modSample = shuffled(
    mod.filter((m) => !m.floored),
    rng(MOD_SEED + 20),
  ).slice(0, 20);
  writeJson(join(V4_DIR, "spotcheck-mod.json"), {
    note: "Blind relabel sample: 20 seeded posts from moderation-corpus.json as the model saw them, no labels. Answer each member question, then needs_action (does the post need moderator action: any member yes).",
    seed: MOD_SEED + 20,
    questions: members.map((q) => ({ id: q.id, prompt: q.prompt, criteria: q.criteria })),
    items: modSample.map((it) => ({ id: it.id, state: it.state })),
  });

  const yes = tool.filter((i) => i.truth).length;
  const amb = tool.filter((i) => i.ambiguous).length;
  progress(
    `[build] tool corpus: ${tool.length} items, ${new Set(tool.map((i) => i.group)).size} groups, approve ${yes} (${((100 * yes) / tool.length).toFixed(1)}%), ambiguous ${amb}; hash ${corpusHash(tool).slice(0, 12)}`,
  );
  const live = mod.filter((m) => !m.floored);
  const needs = live.filter((m) => m.truth).length;
  progress(
    `[build] moderation corpus: ${mod.length} posts (${live.length} asked, ${mod.length - live.length} floored), needs action ${needs} of ${live.length} asked, ambiguous ${live.filter((m) => m.ambiguous).length}; hash ${corpusHash(mod).slice(0, 12)}`,
  );
}

if (import.meta.main) main();
