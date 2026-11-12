/**
 * Writes `../spotcheck.json`: 20 items drawn by a fixed seed from the arithmetic and date
 * corpus, each in one seeded-random arm (raw, digested or digestedRounded), as the coordinator's
 * blind relabel needs them: id, the exact state text the model saw, and the question. No label,
 * no `why`, no margin. Run: `bun experiments/e2e/t4-redteam/corpus/spotcheck-build.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rng, shuffled } from "../../../../src/math.ts";
import type { ArithItem } from "./arith-build.ts";

const SEED = 4;
const ARMS = ["raw", "digested", "digestedRounded"] as const;
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("./arith.json", import.meta.url)), "utf8"),
) as {
  readonly question: {
    readonly prompt: string;
    readonly criteria: { readonly yes: string; readonly no: string };
  };
  readonly items: readonly ArithItem[];
};
const rand = rng(SEED);
const drawn = shuffled(corpus.items, rand).slice(0, 20);
const items = drawn.map((it) => {
  const arm = ARMS[Math.floor(rand() * ARMS.length)] ?? "raw";
  return {
    // Opaque, so the id carries no hint of the margin: sha256("<corpus id>:<arm>"), 8 hex.
    id: createHash("sha256").update(`${it.id}:${arm}`).digest("hex").slice(0, 8),
    state: it[arm],
    question: `${corpus.question.prompt} (yes: ${corpus.question.criteria.yes} no: ${corpus.question.criteria.no})`,
  };
});
const out = fileURLToPath(new URL("../spotcheck.json", import.meta.url));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      corpus: "experiments/e2e/t4-redteam/corpus/arith.json",
      idScheme: 'first 8 hex of sha256("<corpus item id>:<arm>")',
      seed: SEED,
      n: items.length,
      items,
    },
    null,
    2,
  )}\n`,
);
process.stderr.write(`wrote ${items.length} spot-check items to ${out}\n`);
