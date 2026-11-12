/**
 * Live attack 6: arithmetic and dates. The same 48 business requests, labels fixed in
 * `corpus/arith.json` before any call, asked three ways (raw numbers and dates; the facts
 * digested by `compare`/`daysBetween`; the digest with its printed difference rounded) of
 * jev-1.13 and jev-1.14, in shadow. Every row is labelled through the real `ratchet review`
 * path as the decider. The comparison is paired per item: exact McNemar on the discordant pairs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../../src/engine.ts";
import { brier } from "../../../src/ledger/calibration.ts";
import { JsonlLedger } from "../../../src/ledger/ledger.ts";
import { judge } from "../../../src/questions.ts";
import type { JudgeVerdict, Oracle } from "../../../src/types.ts";
import {
  blindReview,
  corpusHash,
  DECIDER_SOURCE,
  gitHead,
  guard,
  JEV_113,
  JEV_114,
  jev113,
  jev114,
  progress,
  runDir,
  writeJson,
} from "../lib.ts";
import { mcnemar, pct, rate, TRACK, table } from "./common.ts";
import type { ArithItem } from "./corpus/arith-build.ts";

export const ARMS = ["raw", "digested", "digestedRounded"] as const;
export type Arm = (typeof ARMS)[number];
const POLICY = { actAbove: 0.9 } as const;
const EVIDENCE = "t4-arith-1";

interface Corpus {
  readonly seed: number;
  readonly question: { readonly prompt: string; readonly criteria: { yes: string; no: string } };
  readonly items: readonly ArithItem[];
}

export function loadArith(): { corpus: Corpus; file: string; text: string } {
  const file = join(import.meta.dir, "corpus", "arith.json");
  const text = readFileSync(file, "utf8");
  return { corpus: JSON.parse(text) as Corpus, file, text };
}

interface Answer {
  readonly item: ArithItem;
  readonly pYes: number;
  readonly failedOpen: boolean;
  readonly action: string;
  readonly soft: string;
}

export async function runArith(): Promise<string> {
  const { corpus, file } = loadArith();
  const hash = corpusHash(corpus);
  const dir = runDir(TRACK, "arith");
  const models: [string, () => Oracle][] = [
    [JEV_113, jev113],
    [JEV_114, jev114],
  ];
  writeJson(join(dir, "manifest.json"), {
    track: TRACK,
    phase: "arith",
    corpusFile: file,
    corpusHash: hash,
    items: corpus.items.length,
    arms: ARMS,
    models: models.map((m) => m[0]),
    policy: POLICY,
    evidenceVersion: EVIDENCE,
    budgetUsdPerEngine: 0.1,
    labelSource: DECIDER_SOURCE,
    labels:
      "fixed in corpus/arith.json (truth and why) before the first call; computed from the facts in code",
    frozen: "no fitting: one evaluation of a fixed policy",
    gitHead: gitHead(),
    at: new Date().toISOString(),
  });
  await guard("t4 arith");
  const q = judge(corpus.question.prompt, {
    id: "arith.approve",
    criteria: corpus.question.criteria,
  });
  const answers = new Map<string, Answer[]>();
  let spent = 0;
  for (const [model, make] of models) {
    const path = join(dir, `ledger-${model.replace(/[^a-z0-9.]+/gi, "_")}.jsonl`);
    const engine = new Engine({
      oracle: make(),
      ledger: new JsonlLedger(path),
      keepState: true,
      budgetUsd: 0.1,
      mode: "shadow",
      tags: ["t4", "arith"],
    });
    for (const arm of ARMS) {
      const gate = engine.gate({
        id: `arith.${arm}`,
        question: q,
        policy: POLICY,
        evidenceVersion: EVIDENCE,
      });
      progress(`[arith] ${model} ${arm}: ${corpus.items.length} asks`);
      const rs = await gate.askMany(
        corpus.items.map((i) => i[arm]),
        { concurrency: 4 },
      );
      answers.set(
        `${model}|${arm}`,
        rs.map((r, k) => ({
          item: corpus.items[k] as ArithItem,
          pYes: (r.decision.verdict as JudgeVerdict).pYes,
          failedOpen: r.decision.failedOpen === true,
          action: r.action,
          soft: r.ruling.action,
        })),
      );
      const labels = new Map(corpus.items.map((i) => [i[arm], i.truth] as const));
      const rv = await blindReview(path, `arith.${arm}`, labels, {
        sample: corpus.items.length,
        seed: 1,
      });
      progress(
        `[arith] review ${model} ${arm}: exit ${rv.exitCode}, ${rv.answered} answered, ${rv.missing} missing`,
      );
    }
    spent += engine.spent;
  }
  await guard("t4 arith done");
  const md = analyse(answers, corpus.items.length, spent, hash);
  await Bun.write(join(dir, "results.md"), md);
  writeJson(
    join(dir, "answers.json"),
    Object.fromEntries(
      [...answers].map(([k, v]) => [
        k,
        v.map((a) => ({
          id: a.item.id,
          truth: a.item.truth,
          pYes: a.pYes,
          failedOpen: a.failedOpen,
          soft: a.soft,
        })),
      ]),
    ),
  );
  process.stdout.write(`${md}\n`);
  progress(`[arith] done; engine-recorded spend $${spent.toFixed(5)}; ${dir}`);
  return md;
}

const right = (a: Answer) => !a.failedOpen && a.pYes >= 0.5 === a.item.truth;

export function analyse(
  answers: ReadonlyMap<string, readonly Answer[]>,
  n: number,
  spent: number,
  hash: string,
): string {
  const lines: string[] = [
    `# T4 arithmetic and dates (corpus ${hash.slice(0, 12)}, n = ${n} items per arm)`,
    "",
  ];
  const rows: string[][] = [];
  for (const [key, as] of answers) {
    const [model, arm] = key.split("|");
    const ok = as.filter(right).length;
    const near = as.filter((a) => a.item.margin === "near");
    const far = as.filter((a) => a.item.margin === "far");
    const acts = as.filter((a) => a.soft === "act");
    const wrongActs = acts.filter((a) => !a.item.truth).length;
    const scored = as.filter((a) => !a.failedOpen).map((a) => ({ p: a.pYes, y: a.item.truth }));
    rows.push([
      model ?? "",
      arm ?? "",
      rate(ok, as.length),
      rate(near.filter(right).length, near.length),
      rate(far.filter(right).length, far.length),
      `${acts.length} acts, ${wrongActs} wrong`,
      brier(scored.map((s) => ({ confidence: s.p, correct: s.y }))).toFixed(3),
      String(as.filter((a) => a.failedOpen).length),
    ]);
  }
  lines.push(
    "Accuracy is the lean (pYes >= 0.5) against the computed truth, with 95% Wilson intervals. Acts are rows the policy (act at 0.9) would have acted on.",
    "",
    table(
      [
        "model",
        "arm",
        "accuracy",
        "near threshold",
        "far from threshold",
        "acts at 0.9",
        "Brier (pYes vs truth)",
        "failed open",
      ],
      rows,
    ),
    "",
  );
  const pairs: string[][] = [];
  for (const model of new Set([...answers.keys()].map((k) => k.split("|")[0] as string))) {
    for (const [a, b] of [
      ["raw", "digested"],
      ["raw", "digestedRounded"],
      ["digested", "digestedRounded"],
    ] as const) {
      const xa = answers.get(`${model}|${a}`) ?? [];
      const xb = answers.get(`${model}|${b}`) ?? [];
      let onlyA = 0;
      let onlyB = 0;
      xa.forEach((x, i) => {
        const y = xb[i];
        if (!y) return;
        if (right(x) && !right(y)) onlyA++;
        if (!right(x) && right(y)) onlyB++;
      });
      const diff = (xb.filter(right).length - xa.filter(right).length) / n;
      pairs.push([
        model,
        `${a} vs ${b}`,
        String(onlyA),
        String(onlyB),
        `${diff >= 0 ? "+" : ""}${pct(diff)}`,
        mcnemar(onlyA, onlyB).toFixed(4),
      ]);
    }
  }
  lines.push(
    "Paired by item: discordant pairs and the exact two-sided McNemar (sign) test.",
    "",
    table(
      [
        "model",
        "comparison",
        "right only in first",
        "right only in second",
        "accuracy change",
        "exact p",
      ],
      pairs,
    ),
    "",
  );
  // Where raw fails: which condition the item fails on.
  const fails: string[][] = [];
  for (const [key, as] of answers) {
    const groups: [string, (a: Answer) => boolean][] = [
      ["both conditions hold", (a) => a.item.amountOk && a.item.daysOk],
      ["only the amount fails", (a) => !a.item.amountOk && a.item.daysOk],
      ["only the days fail", (a) => a.item.amountOk && !a.item.daysOk],
      ["both fail", (a) => !a.item.amountOk && !a.item.daysOk],
    ];
    fails.push([
      key.replace("|", " "),
      ...groups.map(([, f]) => rate(as.filter(f).filter(right).length, as.filter(f).length)),
    ]);
  }
  lines.push(
    "Accuracy by which condition the item fails.",
    "",
    table(["model arm", "both hold", "amount fails", "days fail", "both fail"], fails),
    "",
    `Engine-recorded spend for the phase: $${spent.toFixed(5)}.`,
    "",
  );
  return lines.join("\n");
}
