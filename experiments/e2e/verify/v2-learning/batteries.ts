/**
 * V2, post hoc: re-pool the battery member answers wave 1 already bought, with `any`, `all`,
 * the default log-odds pool and the learned combiner (fitted on the fit split only), and read
 * held-out accuracy and the saturation readout for each. No refit is chosen on held-out; every
 * bar is fitted on the fit split. Each pool is computed twice, by the library (`poolJudge`,
 * `fitLogistic`, `describeBattery`) and by the formulas written out here, and the two must agree.
 * Offline.
 *
 *   bun experiments/e2e/verify/v2-learning/batteries.ts
 *
 * T3 moderation (disjunction: "needs moderator action" = any member true; act = publish, on
 * P(no action)) and T2's verifier battery (conjunction: "passes" = every member holds; act =
 * commit, on P(pass)).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolJudge } from "../../../../src/compound/aggregate.ts";
import { batteryFeatures, fitLogistic, predictLogistic } from "../../../../src/compound/learned.ts";
import { describeBattery } from "../../../../src/ledger/bars.ts";
import type { JudgeVerdict } from "../../../../src/types.ts";
import { exactLower, type Item, lowestBar, pct, type Row, readLedger } from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");
const T3 = join(ROOT, "experiments", "out", "e2e", "t3-triage", "2026-11-12T10-19-41-682Z-live");
const T2 = join(
  ROOT,
  "experiments",
  "out",
  "e2e",
  "t2-verifier",
  "2026-11-12T10-32-34-553Z-live",
  "ledgers",
);

interface Req {
  members: number[];
  truth: boolean;
}

const lg = (p: number) => {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
};
const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** My own pools, written from the definitions. */
const mine = {
  logodds: (ps: readonly number[]) => sig(ps.reduce((s, p) => s + lg(p), 0)),
  any: (ps: readonly number[]) =>
    1 - ps.reduce((s, p) => s * Math.min(1, Math.max(1e-12, 1 - p)), 1),
  all: (ps: readonly number[]) => ps.reduce((s, p) => s * Math.min(1, Math.max(1e-12, p)), 1),
};

/** Group a battery ledger's member rows by request, members in `order`. */
function requests(rows: readonly Row[], gate: string, order: readonly string[]) {
  const byReq = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.gateId !== gate) continue;
    const list = byReq.get(r.requestId) ?? [];
    list.push(r);
    byReq.set(r.requestId, list);
  }
  const out: { combined: Row; members: Row[] }[] = [];
  for (const list of byReq.values()) {
    const combined = list.find((r) => r.combined);
    if (combined === undefined || combined.strategy === "floored" || combined.failedOpen) continue;
    const ms = order.map((q) => list.find((r) => !r.combined && r.questionId === q));
    if (ms.some((m) => m === undefined || m.pYes === undefined || m.failedOpen)) continue;
    out.push({ combined, members: ms as Row[] });
  }
  return out;
}

const verdict = (q: string, p: number): JudgeVerdict => ({
  kind: "judge",
  questionId: q,
  pYes: p,
  confidence: Math.max(p, 1 - p),
});

interface Pooled {
  name: string;
  fit: number[];
  held: number[];
}

/** My own Newton fit of the same penalised loss (l2 0.01 per row on weights, bias free). */
function myLogistic(xs: readonly number[][], ys: readonly boolean[], l2 = 0.01) {
  const d = xs[0]?.length ?? 0;
  const n = xs.length;
  let th = new Array<number>(d + 1).fill(0);
  const loss = (t: readonly number[]) => {
    let s = 0;
    xs.forEach((x, i) => {
      let z = t[d] ?? 0;
      for (let j = 0; j < d; j++) z += (t[j] ?? 0) * (x[j] ?? 0);
      s += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - (ys[i] ? z : 0);
    });
    let pen = 0;
    for (let j = 0; j < d; j++) pen += (t[j] ?? 0) ** 2;
    return s / n + (l2 / 2) * pen;
  };
  for (let it = 0; it < 200; it++) {
    const g = new Array<number>(d + 1).fill(0);
    const h = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
    xs.forEach((x, i) => {
      const xx = [...x, 1];
      let z = 0;
      for (let j = 0; j <= d; j++) z += (th[j] ?? 0) * (xx[j] ?? 0);
      const p = sig(z);
      for (let a = 0; a <= d; a++) {
        (g as number[])[a] = (g[a] ?? 0) + ((p - (ys[i] ? 1 : 0)) * (xx[a] ?? 0)) / n;
        for (let b = 0; b <= d; b++) {
          const row = h[a] as number[];
          row[b] = (row[b] ?? 0) + (p * (1 - p) * (xx[a] ?? 0) * (xx[b] ?? 0)) / n;
        }
      }
    });
    for (let j = 0; j < d; j++) {
      g[j] = (g[j] ?? 0) + l2 * (th[j] ?? 0);
      const row = h[j] as number[];
      row[j] = (row[j] ?? 0) + l2;
    }
    // Gauss-Jordan solve h s = g.
    const m = h.map((row, i) => [...row, g[i] ?? 0]);
    for (let c = 0; c <= d; c++) {
      let piv = c;
      for (let r = c + 1; r <= d; r++) {
        if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[piv]?.[c] ?? 0)) piv = r;
      }
      [m[c], m[piv]] = [m[piv] as number[], m[c] as number[]];
      const top = m[c] as number[];
      for (let r = 0; r <= d; r++) {
        if (r === c) continue;
        const row = m[r] as number[];
        const f = (row[c] ?? 0) / (top[c] ?? 1);
        for (let k = c; k <= d + 1; k++) row[k] = (row[k] ?? 0) - f * (top[k] ?? 0);
      }
    }
    const step = m.map((row, i) => (row[d + 1] ?? 0) / (row[i] ?? 1));
    let t = 1;
    const base = loss(th);
    let next = th;
    for (let k = 0; k < 50; k++) {
      next = th.map((v, i) => v - t * (step[i] ?? 0));
      if (loss(next) <= base) break;
      t /= 2;
    }
    th = next;
    if (Math.max(...g.map(Math.abs)) < 1e-10) break;
  }
  return { weights: th.slice(0, d), bias: th[d] ?? 0, loss: loss(th) };
}

function analyse(
  title: string,
  fit: readonly Req[],
  held: readonly Req[],
  order: readonly string[],
  actOnYes: boolean,
  lines: string[],
): void {
  const pools: Pooled[] = [];
  const agreeFails: string[] = [];
  for (const method of ["logodds", "any", "all"] as const) {
    const run = (rs: readonly Req[]) =>
      rs.map((r) => {
        const lib = poolJudge(
          r.members.map((p, i) => verdict(order[i] ?? "", p)),
          { method },
        ).pYes;
        const own = mine[method](r.members);
        if (Math.abs(lib - own) > 1e-9) agreeFails.push(`${method}: lib ${lib} own ${own}`);
        return lib;
      });
    pools.push({
      name: method === "logodds" ? "logodds (default)" : method,
      fit: run(fit),
      held: run(held),
    });
  }
  const xsFit = fit.map((r) =>
    batteryFeatures(r.members.map((p, i) => verdict(order[i] ?? "", p))),
  );
  const ysFit = fit.map((r) => r.truth);
  const model = fitLogistic(xsFit.map((x, i) => ({ x, y: ysFit[i] === true })));
  const own = myLogistic(xsFit, ysFit);
  const wdiff = Math.max(
    Math.abs(model.bias - own.bias),
    ...model.weights.map((w, i) => Math.abs(w - (own.weights[i] ?? 0))),
  );
  const predict = (rs: readonly Req[]) =>
    rs.map((r) =>
      predictLogistic(model, batteryFeatures(r.members.map((p, i) => verdict(order[i] ?? "", p)))),
    );
  pools.push({ name: "learned (fitted on fit)", fit: predict(fit), held: predict(held) });

  lines.push(`## ${title}`, "");
  lines.push(
    `Fit ${fit.length} requests, held-out ${held.length}. Library pools equal the formulas on every request: ${agreeFails.length === 0 ? "yes" : `NO (${agreeFails.length})`}. ` +
      `fitLogistic: loss ${model.loss.toFixed(4)}, converged ${String(model.converged)} in ${model.iterations} Newton steps; my own Newton fit of the same penalised loss: ${own.loss.toFixed(4)}, largest weight difference ${wdiff.toExponential(1)}. ` +
      `Weights ${model.weights.map((w) => w.toFixed(2)).join(", ")}, bias ${model.bias.toFixed(2)}.`,
    "",
  );
  lines.push(
    "| combiner | held-out accuracy (lean) | Brier | held-out saturated | readout sentence (library) | act bar at 95%, fitted on fit (conservative / point) | held-out precision at the conservative bar | at the point bar |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of pools) {
    const truths = held.map((r) => r.truth);
    const right = p.held.filter((x, i) => x >= 0.5 === truths[i]).length;
    const brier = p.held.reduce((s, x, i) => s + (x - (truths[i] ? 1 : 0)) ** 2, 0) / held.length;
    const sat = p.held.filter((x) => Math.min(x, 1 - x) < 0.001).length;
    const combine = p.name.startsWith("learned")
      ? "learned"
      : p.name.startsWith("logodds")
        ? "logodds"
        : p.name;
    const sentence = describeBattery({
      combine,
      verdicts: held.length,
      saturated: sat,
      share: sat / held.length,
    });
    // Act side: the probability that acting is right, against whether it was.
    const items = (ps: readonly number[], rs: readonly Req[]): Item[] =>
      ps.map((x, i) => ({
        p: actOnYes ? x : 1 - x,
        right: actOnYes ? rs[i]?.truth === true : rs[i]?.truth === false,
      }));
    const fitItems = items(p.fit, fit);
    const heldItems = items(p.held, held);
    const cons = lowestBar(fitItems, 0.95, 30, true);
    const point = lowestBar(fitItems, 0.95, 30, false);
    const at = (t: number | undefined) => {
      if (t === undefined) return "no bar";
      const a = heldItems.filter((x) => x.p >= t);
      const r = a.filter((x) => x.right).length;
      return a.length === 0
        ? "no acts"
        : `${r}/${a.length} = ${pct(r / a.length)} (exact lower ${pct(exactLower(r, a.length))}), coverage ${pct(a.length / held.length)}`;
    };
    const fmt = (b: ReturnType<typeof lowestBar>) =>
      b === undefined
        ? "none"
        : b.threshold >= 0.9995
          ? b.threshold.toPrecision(8)
          : b.threshold.toFixed(3);
    lines.push(
      `| ${p.name} | ${right}/${held.length} = ${pct(right / held.length)} | ${brier.toFixed(3)} | ${sat}/${held.length} = ${pct(sat / held.length)} | ${sentence} | ${fmt(cons)} / ${fmt(point)} | ${at(cons?.threshold)} | ${at(point?.threshold)} |`,
    );
  }
  lines.push("");
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = [
    "# Battery re-pools on wave-1 member answers (post hoc)",
    "",
    "Post hoc analyses of answers already bought: member verdicts are read from the live",
    "ledgers, re-pooled offline, and scored on the held-out split. Every bar and the learned",
    "combiner's weights are fitted on the fit split only; nothing is chosen on held-out.",
    "Saturated: pooled p(yes) beyond 0.001 or 0.999 (`SATURATION_CUT`).",
    "",
  ];

  // T3 moderation: held-out asked once through mod.action; corpus gives the split by state.
  const corpus = JSON.parse(
    readFileSync(
      join(ROOT, "experiments", "e2e", "t3-triage", "corpus", "moderation.json"),
      "utf8",
    ),
  ) as { items: { state: string; split: string; label: { truth: boolean } }[] };
  const byState = new Map(corpus.items.map((i) => [i.state, i]));
  const modOrder = ["threat", "harass", "spam", "selfharm"];
  const modRows = readLedger(join(T3, "moderation.jsonl"));
  const stateOf = new Map<string, string>();
  for (const line of readFileSync(join(T3, "moderation.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const l = JSON.parse(line) as { type: string; record?: { id: string; state?: string } };
    if (l.type === "decision" && l.record?.state !== undefined)
      stateOf.set(l.record.id, l.record.state);
  }
  const mod = requests(modRows, "mod.action", modOrder).flatMap((q) => {
    const item = byState.get(stateOf.get(q.combined.id) ?? "");
    if (item === undefined) return [];
    return [
      {
        split: item.split,
        req: { members: q.members.map((m) => m.pYes ?? 0.5), truth: item.label.truth },
      },
    ];
  });
  analyse(
    "T3 moderation battery (disjunction; act = publish on P(no action))",
    mod.filter((m) => m.split === "fit").map((m) => m.req),
    mod.filter((m) => m.split === "heldout").map((m) => m.req),
    modOrder,
    false,
    lines,
  );

  // T2 verifier battery: fit and held-out ledgers; truth on the combined row.
  const t2Order = [
    "t2.m.complete",
    "t2.m.format",
    "t2.m.numbers",
    "t2.m.dates",
    "t2.m.entities",
    "t2.m.supported",
    "t2.m.references",
    "t2.m.polarity",
  ];
  const t2 = (file: string) =>
    requests(readLedger(join(T2, file)), "t2.verify.battery", t2Order).flatMap((q) => {
      const t = q.combined.outcome?.truth;
      return typeof t === "boolean"
        ? [{ members: q.members.map((m) => m.pYes ?? 0.5), truth: t }]
        : [];
    });
  analyse(
    "T2 verifier battery (conjunction; act = commit on P(pass))",
    t2("fit-battery.jsonl"),
    t2("heldout-battery.jsonl"),
    t2Order,
    true,
    lines,
  );
  const md = `${lines.join("\n")}\n`;
  writeFileSync(join(OUT, "batteries.md"), md);
  process.stdout.write(md);
}

if (import.meta.main) main();
