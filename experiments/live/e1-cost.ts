/**
 * E1. The cost structure of a System One call: what you pay for, what is free, and what
 * batching, criteria verbosity and concurrency do to cost and latency.
 */
import { fmt, heading, note, table } from "../../sim/lib.ts";
import type { WireQuestion } from "../../src/oracles/systemone.ts";
import {
  JEV_MODEL,
  loadBoolq,
  mapLimit,
  mean,
  median,
  progress,
  quantile,
  rawSystemOne,
  type Spend,
} from "./lib.ts";

const TOPICS = [
  "a number",
  "a date or year",
  "a person",
  "a place",
  "an animal",
  "money",
  "a law",
  "a disease",
  "food",
  "a sport",
  "a war",
  "music",
  "a river",
  "a company",
  "a school",
  "weather",
  "a religion",
  "a language",
  "a vehicle",
  "a plant",
  "a city",
  "a country",
  "a book",
  "a film",
  "television",
  "a scientist",
  "a politician",
  "an invention",
  "a measurement",
  "a color",
  "a building",
  "a game",
  "a holiday",
  "a family member",
  "a weapon",
  "a chemical",
  "a planet",
  "the ocean",
  "a mountain",
  "an island",
  "a court",
  "an election",
  "a treaty",
  "a disaster",
  "an award",
  "a currency",
  "a bank",
  "a drug",
  "a hospital",
  "a university",
  "an army",
  "a ship",
  "an aircraft",
  "a train",
  "a road",
  "a bridge",
  "a festival",
  "a dance",
  "a painting",
  "a poem",
  "a tribe",
  "a king",
  "a president",
  "a child",
];

function questions(k: number, withCriteria = false): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (let i = 0; i < k; i++) {
    const topic = TOPICS[i % TOPICS.length] as string;
    out[`q${i}`] = {
      type: "noul",
      instructions: `Does the text mention ${topic}?`,
      ...(withCriteria
        ? {
            criteria: {
              true: `The text explicitly names or clearly refers to ${topic}, even once, in any form.`,
              false: `There is no mention of ${topic} anywhere in the text, not even indirectly.`,
            },
          }
        : {}),
    };
  }
  return out;
}

function stateOfWords(words: number): string {
  const passages = loadBoolq(300).map((b) => b.passage);
  let s = "";
  let i = 0;
  while (s.split(/\s+/).length < words) {
    s += `${passages[i % passages.length]}\n\n`;
    i++;
  }
  return s.split(/\s+/).slice(0, words).join(" ");
}

export async function e1(spend: Spend): Promise<void> {
  heading("E1. What a call costs: state size, question count, batching, concurrency");
  note(
    "All numbers are billed figures from OpenRouter's `usage` block for `typesafe/jev-1.13`. Output tokens are reported but priced at zero; input tokens cost $0.042 per million.",
  );

  // Grid: state words x question count.
  const words = [80, 400, 1600, 6400];
  const counts = [1, 4, 16, 64];
  const grid: (string | number)[][] = [];
  const perQuestionTokens: number[] = [];
  for (const w of words) {
    const state = stateOfWords(w);
    for (const k of counts) {
      const r = await rawSystemOne({ state, model: JEV_MODEL, questions: questions(k) });
      if (!r.body) {
        grid.push([w, k, `HTTP ${r.status}`, "", "", "", ""]);
        continue;
      }
      const u = r.body.usage ?? {};
      spend.add(u.cost ?? 0);
      grid.push([
        w,
        k,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        `$${(u.cost ?? 0).toFixed(6)}`,
        `$${(((u.cost ?? 0) / k) * 1000).toFixed(4)}`,
        Math.round(r.latencyMs),
      ]);
      if (k === 64 && w === 400) perQuestionTokens.push(((u.input_tokens ?? 0) - 0) / 64);
    }
    progress(`  e1 grid: ${w} words done`);
  }
  table(
    [
      "state words",
      "questions",
      "input tokens",
      "output tokens",
      "cost",
      "cost per 1k answers",
      "ms",
    ],
    grid,
  );

  // Marginal tokens per question: difference between 64 and 1 questions on the same state.
  const s400 = stateOfWords(400);
  const one = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(1) });
  const sixteen = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(16) });
  const sixtyfour = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(64) });
  for (const r of [one, sixteen, sixtyfour]) spend.add(r.body?.usage?.cost ?? 0);
  const t1 = one.body?.usage?.input_tokens ?? 0;
  const t16 = sixteen.body?.usage?.input_tokens ?? 0;
  const t64 = sixtyfour.body?.usage?.input_tokens ?? 0;
  note(
    `Marginal input tokens per extra question on a 400-word state: ${fmt((t64 - t1) / 63, 1)} (from 1 to 64) and ${fmt((t16 - t1) / 15, 1)} (from 1 to 16). State and request overhead at one question: ${t1} tokens.`,
  );

  // Criteria verbosity.
  const plain = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(8) });
  const rich = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(8, true) });
  spend.add(plain.body?.usage?.cost ?? 0);
  spend.add(rich.body?.usage?.cost ?? 0);
  const tp = plain.body?.usage?.input_tokens ?? 0;
  const tr = rich.body?.usage?.input_tokens ?? 0;
  let drift = 0;
  for (let i = 0; i < 8; i++) {
    const a = plain.body?.answers[`q${i}`];
    const b = rich.body?.answers[`q${i}`];
    if (a?.type === "noul" && b?.type === "noul")
      drift = Math.max(drift, Math.abs(a.noul - b.noul));
  }
  note(
    `Criteria verbosity: eight questions without criteria used ${tp} input tokens; with two-sentence yes/no criteria each, ${tr} tokens (${fmt((tr - tp) / 8, 1)} per question). Largest answer shift from adding criteria: ${fmt(drift, 2)}.`,
  );

  // Batched versus singles: same 16 questions, one request versus sixteen.
  const batched = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: questions(16) });
  spend.add(batched.body?.usage?.cost ?? 0);
  const singles = await mapLimit(
    Array.from({ length: 16 }, (_, i) => i),
    8,
    async (i) => {
      const q = questions(16)[`q${i}`] as WireQuestion;
      const r = await rawSystemOne({ state: s400, model: JEV_MODEL, questions: { [`q${i}`]: q } });
      spend.add(r.body?.usage?.cost ?? 0);
      return r;
    },
  );
  const singlesCost = singles.reduce((s, r) => s + (r.body?.usage?.cost ?? 0), 0);
  const singlesLatency = singles.reduce((s, r) => s + r.latencyMs, 0);
  let maxDelta = 0;
  let agree = 0;
  for (let i = 0; i < 16; i++) {
    const a = batched.body?.answers[`q${i}`];
    const b = singles[i]?.body?.answers[`q${i}`];
    if (a?.type === "noul" && b?.type === "noul") {
      maxDelta = Math.max(maxDelta, Math.abs(a.noul - b.noul));
      if (a.noul >= 0.5 === b.noul >= 0.5) agree++;
    }
  }
  table(
    ["16 questions on one 400-word state", "cost", "latency (sum)", "answers"],
    [
      [
        "one batched request",
        `$${(batched.body?.usage?.cost ?? 0).toFixed(6)}`,
        `${Math.round(batched.latencyMs)} ms`,
        "reference",
      ],
      [
        "sixteen single requests",
        `$${singlesCost.toFixed(6)}`,
        `${Math.round(singlesLatency)} ms`,
        `${agree}/16 same label, max |delta p| ${fmt(maxDelta, 3)}`,
      ],
      [
        "ratio",
        `${fmt(singlesCost / Math.max(batched.body?.usage?.cost ?? 1e-9, 1e-9), 1)}x`,
        `${fmt(singlesLatency / Math.max(batched.latencyMs, 1), 1)}x`,
        "",
      ],
    ],
  );

  // Concurrency: 32 single-question requests at 1 and at 16 in flight.
  const s80 = stateOfWords(80);
  const reqs = Array.from({ length: 32 }, (_, i) => i);
  const rows: (string | number)[][] = [];
  for (const limit of [1, 16]) {
    const started = performance.now();
    const rs = await mapLimit(reqs, limit, async (i) => {
      const r = await rawSystemOne({
        state: s80,
        model: JEV_MODEL,
        questions: { [`q${i}`]: questions(32)[`q${i}`] as WireQuestion },
      });
      spend.add(r.body?.usage?.cost ?? 0);
      return r;
    });
    const wall = performance.now() - started;
    const lat = rs.map((r) => r.latencyMs);
    const failures = rs.filter((r) => !r.body).map((r) => r.status);
    rows.push([
      limit,
      Math.round(wall),
      fmt(32000 / wall, 1),
      Math.round(median(lat)),
      Math.round(quantile(lat, 0.95)),
      failures.length ? failures.join(",") : "none",
    ]);
  }
  table(
    ["in flight", "wall ms for 32 calls", "calls per second", "median ms", "p95 ms", "failures"],
    rows,
  );
  note(
    `Mean per-call latency across E1: ${Math.round(mean(grid.map((g) => Number(g[6]) || 0).filter(Boolean)))} ms.`,
  );
}
