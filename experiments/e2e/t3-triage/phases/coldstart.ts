/**
 * Phase 5: cold start with a calibration profile. Build the pick and rate profiles from the
 * routing ledger (through `ratchet profile build`, and in code, which must agree), lend them
 * to a sibling product's routing and urgency gates (a re-worded question on the same model
 * pin) with `policyFromProfile` and `barSource`, ask every sibling ticket in shadow, then let
 * labels arrive in ledger order and read the grade at each checkpoint from every surface:
 * `Gate.report()` (QuestionReport.grade), `ratchet report` (JSON and text), `checkGate` and
 * `ratchet check`, and `ratchet trail` (JSON and text). Finally: does precision above the
 * borrowed bar hold on the sibling's own labels, and does the profile expire on a pin change?
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, checkGate, groupGates, profile, report, trail } from "../../../../src/cli/main.ts";
import { Engine } from "../../../../src/engine.ts";
import { parseProfile } from "../../../../src/ledger/borrow.ts";
import { coverageAt, fitThreshold, scoredFromLedger } from "../../../../src/ledger/calibration.ts";
import { describeGrade, type EvidenceGrade, gradeWord } from "../../../../src/ledger/evidence.ts";
import {
  type DecisionRecord,
  hashQuestion,
  JsonlLedger,
  parseJsonlLedger,
} from "../../../../src/ledger/ledger.ts";
import {
  borrowedBar,
  buildProfile,
  type CalibrationProfile,
  gateBars,
} from "../../../../src/ledger/profile.ts";
import { type GatePolicy, hashPolicy, policyFromProfile } from "../../../../src/policy.ts";
import type {
  PickQuestion,
  PickVerdict,
  RateQuestion,
  RateVerdict,
} from "../../../../src/types.ts";
import { labelAsDecider } from "../../lib.ts";
import type { TicketItem } from "../corpus/routing.ts";
import type { Ctx } from "../main.ts";
import { calib, clopper, fmt, loadCorpus, mapLimit, num, pct } from "../util.ts";
import { ROUTING_POLICY } from "./routing.ts";

/** The promise each gate borrows for: the highest of these the profile has a bar for, fixed before any sibling call. */
const TARGET_LADDER = [0.98, 0.95, 0.9, 0.85, 0.8] as const;
const CHECKPOINTS = [0, 5, 10, 15, 20, 25, 28, 29, 30, 31, 35, 40, 50, 60, 70, 80, 100, 120, 140];
const MIN = { minSupport: 30, minEstimated: 30 };

interface Surface {
  readonly kind: string;
  readonly sentence: string;
}

const surface = (g: EvidenceGrade | undefined): Surface =>
  g === undefined
    ? { kind: "missing", sentence: "" }
    : { kind: gradeWord(g), sentence: describeGrade(g) };

function mostCommonModel(rows: readonly DecisionRecord[], qid: string): string {
  const counts = new Map<string, number>();
  for (const r of rows)
    if (r.questionId === qid && r.model && !r.failedOpen)
      counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top) throw new Error(`no answered ${qid} rows`);
  return top[0];
}

export async function coldstart(ctx: Ctx): Promise<void> {
  const routingLedger = join(ctx.dir, "routing.jsonl");
  if (!existsSync(routingLedger))
    throw new Error("coldstart needs this run's routing ledger: run the routing phase first");
  const rrows = await new JsonlLedger(routingLedger).all();
  const model = mostCommonModel(rrows, "route");
  const out: Record<string, unknown> = { model };

  // ---- profiles: the CLI and the library must build the same one -------------
  const built: Record<"pick" | "rate", CalibrationProfile> = {} as never;
  const paths = {
    pick: join(ctx.dir, "profile-pick.json"),
    rate: join(ctx.dir, "profile-rate.json"),
  };
  for (const kind of ["pick", "rate"] as const) {
    const cli = await profile([
      "build",
      routingLedger,
      "--model",
      model,
      "--kind",
      kind,
      "--out",
      paths[kind],
    ]);
    if (cli.exitCode !== 0) throw new Error(`profile build ${kind}: ${cli.output}`);
    const fromFile = parseProfile(JSON.parse(readFileSync(paths[kind], "utf8")));
    const inCode = buildProfile(rrows, { model, kind }, { ledgers: [routingLedger] });
    built[kind] = fromFile;
    const shown = await profile(["show", paths[kind]]);
    out[`profile-${kind}`] = {
      cliLine: cli.output.trim(),
      hash: fromFile.hash,
      codeHash: inCode?.hash,
      sameAsCode: inCode?.hash === fromFile.hash,
      bars: fromFile.bars,
      ladder: Object.fromEntries(TARGET_LADDER.map((t) => [t, borrowedBar(fromFile, t)])),
      gateBars: TARGET_LADDER.map((t) => ({ t, bars: gateBars(fromFile, t) })),
      rows: fromFile.from.rows,
      show: shown.output,
    };
    ctx.md(
      `- profile ${kind}: ${cli.output.trim()} (library build ${inCode?.hash === fromFile.hash ? "agrees" : `DIFFERS: ${inCode?.hash}`})`,
    );
    ctx.md(
      `  - bars on the ladder: ${TARGET_LADDER.map((t) => `${pct(t, 0)} ${num(borrowedBar(fromFile, t), 2)}`).join(", ")}`,
    );
  }
  const targetOf = (p: CalibrationProfile) =>
    TARGET_LADDER.find((t) => borrowedBar(p, t) !== undefined);
  const tPick = targetOf(built.pick);
  const tRate = targetOf(built.rate);

  // ---- the sibling: borrowed policies, shadow, no labels yet ---------------
  const corpus = loadCorpus<{
    items: TicketItem[];
    questions: { route: PickQuestion; urgency: RateQuestion };
  }>("sibling");
  const { route, urgency } = corpus.questions;
  const byState = new Map(corpus.items.map((i) => [i.state, i]));
  const truth = (state: string, q: { id: string }) => {
    const it = byState.get(state);
    if (!it) return undefined;
    return q.id === route.id ? { pick: it.route.truth } : { rate: it.urgency.truth };
  };
  const policyFor = (p: CalibrationProfile, t: number | undefined): GatePolicy =>
    t === undefined ? ROUTING_POLICY : policyFromProfile(p, t);
  const policies = { route: policyFor(built.pick, tPick), urgency: policyFor(built.rate, tRate) };
  const ledgerPath = join(ctx.dir, "sibling.jsonl");
  const profiles = [built.pick, built.rate];
  // Offline, the same simulated pin as the routing phase, so the profile key matches the sibling.
  const oracle = ctx.oracle(truth, { accuracy: 0.8, temperature: 1.6 });
  const engine = new Engine({
    oracle,
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.1,
    seed: 13,
    profiles,
  });
  const gRoute = engine.gate({
    id: "sib.route",
    question: route,
    policy: policies.route,
    ...(tPick !== undefined ? { barSource: { profileHash: built.pick.hash } } : {}),
  });
  const gUrg = engine.gate({
    id: "sib.urgency",
    question: urgency,
    policy: policies.urgency,
    ...(tRate !== undefined ? { barSource: { profileHash: built.rate.hash } } : {}),
  });
  ctx.manifest.freeze("coldstart", {
    model,
    targets: { route: tPick ?? null, urgency: tRate ?? null },
    profiles: { pick: built.pick.hash, rate: built.rate.hash },
    policies: {
      route: { ...policies.route, hash: hashPolicy(policies.route) },
      urgency: { ...policies.urgency, hash: hashPolicy(policies.urgency) },
    },
    questionHashes: { route: hashQuestion(route), urgency: hashQuestion(urgency) },
    rule: "target = highest of 0.98, 0.95, 0.9, 0.85, 0.8 with a borrowed bar; policy = policyFromProfile(profile, target)",
  });
  ctx.md(
    `- sibling targets: route ${tPick ?? "none"}, urgency ${tRate ?? "none"}; policies ${JSON.stringify(policies)}`,
  );

  await ctx.guard("coldstart");
  const asked = await mapLimit(corpus.items, 8, async (item) => {
    const [r, u] = await engine.askAll(item.state, [route, urgency], (q) => ({
      policy: q.id === route.id ? policies.route : policies.urgency,
    }));
    if (!r || !u) throw new Error("too few results");
    return { item, r, u };
  });
  // Labels arrive in ledger order, one ticket (both questions) at a time.
  const order = (await new JsonlLedger(ledgerPath).all()).map((x) => x.requestId);
  const queue = asked
    .slice()
    .sort((a, b) => order.indexOf(a.r.requestId) - order.indexOf(b.r.requestId));

  const readers = new Engine({ oracle, ledger: new JsonlLedger(ledgerPath) }); // no profiles: the "none" baseline
  const walk: Record<string, unknown>[] = [];
  const mismatches: string[] = [];
  let labelled = 0;
  for (const k of CHECKPOINTS) {
    while (labelled < Math.min(k, queue.length)) {
      const a = queue[labelled] as (typeof queue)[number];
      await labelAsDecider(engine, a.r.recordId, a.r.decision.verdict, a.item.route);
      await labelAsDecider(engine, a.u.recordId, a.u.decision.verdict, a.item.urgency);
      labelled++;
    }
    const rows = parseJsonlLedger(readFileSync(ledgerPath, "utf8"));
    const groups = groupGates(rows);
    for (const [gid, gate, T] of [
      ["sib.route", gRoute, tPick ?? 0.9],
      ["sib.urgency", gUrg, tRate ?? 0.9],
    ] as const) {
      const t = String(T);
      const profileArgs = ["--profile", paths.pick, "--profile", paths.rate];
      const levers = ["--min-support", "30", "--min-estimated", "30"];
      const repJson = JSON.parse(
        (
          await report([
            ledgerPath,
            "--gate",
            gid,
            "--target",
            t,
            ...levers,
            ...profileArgs,
            "--json",
          ])
        ).output,
      ) as { gates: { gate: string; grade: EvidenceGrade }[] };
      const repText = (
        await report([ledgerPath, "--gate", gid, "--target", t, ...levers, ...profileArgs])
      ).output;
      const repDefault = JSON.parse(
        (await report([ledgerPath, "--gate", gid, ...profileArgs, "--json"])).output,
      ) as { gates: { gate: string; grade: EvidenceGrade }[] };
      const repNoProfile = JSON.parse(
        (await report([ledgerPath, "--gate", gid, "--target", t, ...levers, "--json"])).output,
      ) as { gates: { gate: string; grade: EvidenceGrade }[] };
      const chk = checkGate(groups, {
        gate: gid,
        promise: T,
        minRows: 30,
        window: 500,
        profiles,
        ...MIN,
      });
      const chkText = (
        await check([ledgerPath, "--gate", gid, "--promise", t, ...levers, ...profileArgs])
      ).output;
      const trJson = JSON.parse(
        (
          await trail([
            ledgerPath,
            "--gate",
            gid,
            "--target",
            t,
            ...levers,
            ...profileArgs,
            "--json",
          ])
        ).output,
      ) as { bars: { gate: string; grade: EvidenceGrade }[] };
      const trText = (
        await trail([
          ledgerPath,
          "--gate",
          gid,
          "--target",
          t,
          ...levers,
          ...profileArgs,
          "--last",
          "1",
        ])
      ).output;
      const engAligned = (await gate.report({ targetAccuracy: T, ...MIN })).grade;
      const engDefault = (await gate.report()).grade;
      // The promise aligned but the engine's own minSupport default (20, where the CLI's is 30).
      const engTargetOnly = (await gate.report({ targetAccuracy: T })).grade;
      const engNone = (await readers.gateReport(gid, { targetAccuracy: T, ...MIN })).grade;
      const s = {
        engine: surface(engAligned),
        reportJson: surface(repJson.gates.find((g) => g.gate === gid)?.grade),
        checkGate: surface(chk.grade),
        trailJson: surface(trJson.bars.find((b) => b.gate === gid)?.grade),
      };
      const sentences = new Set(Object.values(s).map((x) => x.sentence));
      const texts = {
        reportText: repText.includes(`- ${gid}: ${s.engine.sentence}`),
        checkText: chkText.includes(s.engine.sentence),
        trailText: trText.includes(s.engine.sentence),
      };
      const agree = sentences.size === 1 && Object.values(texts).every(Boolean);
      if (!agree) mismatches.push(`${gid} at ${k}: ${JSON.stringify({ s, texts })}`);
      walk.push({
        k,
        gate: gid,
        target: T,
        kind: s.engine.kind,
        sentence: s.engine.sentence,
        agree,
        surfaces: Object.fromEntries(Object.entries(s).map(([n, v]) => [n, v.kind])),
        texts,
        defaults: {
          engine: surface(engDefault).kind,
          report: surface(repDefault.gates[0]?.grade).kind,
          engineTargetOnly: surface(engTargetOnly).kind,
        },
        withoutProfile: {
          engine: surface(engNone).kind,
          report: surface(repNoProfile.gates[0]?.grade).kind,
        },
        checkLine: chkText.trim().slice(0, 400),
      });
    }
  }
  out.walk = walk;
  out.mismatches = mismatches;
  ctx.md(
    "\n| labels | gate | promise | grade (all aligned surfaces) | agree | engine, promise only | engine defaults | report defaults | without profile |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const w of walk) {
    const d = w.defaults as { engine: string; report: string; engineTargetOnly: string };
    const n = w.withoutProfile as { engine: string; report: string };
    ctx.md(
      `| ${w.k} | ${w.gate} | ${pct(w.target as number, 0)} | ${w.kind} | ${w.agree ? "yes" : "NO"} | ${d.engineTargetOnly} | ${d.engine} | ${d.report} | ${n.engine} / ${n.report} |`,
    );
  }
  for (const w of walk.filter(
    (x, i) => i === 0 || (walk[i - 2] as { kind?: string } | undefined)?.kind !== x.kind,
  )) {
    ctx.md(`- ${w.gate} at ${w.k} labels: ${w.sentence}`);
  }
  if (mismatches.length > 0)
    ctx.md(`- surface mismatches: ${mismatches.length}; first: ${mismatches[0]}`);

  // ---- is the borrowed bar honest on the sibling's own labels? --------------
  const rows = await new JsonlLedger(ledgerPath).all();
  const honesty: Record<string, unknown> = {};
  ctx.md(
    "\n| gate | promise | borrowed bar | rows at or above | precision there (exact 95%) | at or above act bar | precision there | sibling's own conservative bar | own point bar | sibling posture |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [gid, p, T, policy] of [
    ["sib.route", built.pick, tPick, policies.route],
    ["sib.urgency", built.rate, tRate, policies.urgency],
  ] as const) {
    const s = scoredFromLedger(rows.filter((r) => r.gateId === gid));
    const c = calib(s);
    const bar = T === undefined ? undefined : borrowedBar(p, T);
    const at = bar === undefined ? undefined : coverageAt(s, bar);
    const act = coverageAt(s, policy.actAbove);
    const pBar = at === undefined ? undefined : clopper(Math.round(at.accuracy * at.n), at.n);
    const pAct = clopper(Math.round(act.accuracy * act.n), act.n);
    const own =
      T === undefined ? undefined : fitThreshold(s, T, 30, { conservative: true })?.threshold;
    const ownPoint = T === undefined ? undefined : fitThreshold(s, T, 30)?.threshold;
    honesty[gid] = {
      target: T,
      bar,
      atBar: at,
      precisionAtBar: pBar,
      actBar: policy.actAbove,
      atAct: act,
      precisionAtAct: pAct,
      ownConservative: own,
      ownPoint,
      calib: c,
    };
    ctx.md(
      `| ${gid} | ${T === undefined ? "-" : pct(T, 0)} | ${num(bar, 2)} | ${at === undefined ? "-" : `${at.n} (${pct(at.coverage)})`} | ${pBar === undefined ? "-" : fmt(pBar)} | ${act.n} (${pct(act.coverage)}) at ${num(policy.actAbove, 2)} | ${fmt(pAct)} | ${num(own, 2)} | ${num(ownPoint, 2)} | ${c.posture}, ${fmt(c.accuracy)} vs ${pct(c.expected)} expected |`,
    );
  }
  out.honesty = honesty;

  // ---- expiry: the same profile on a gate whose newest answer is another pin ---
  const stalePolicy = policies.route;
  const staleSpec = {
    id: "sib.route.stale",
    question: route,
    policy: stalePolicy,
    ...(tPick !== undefined ? { barSource: { profileHash: built.pick.hash } } : {}),
  };
  const otherEngine = new Engine({
    oracle: ctx.other(truth),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.02,
    seed: 17,
    profiles,
  });
  const gStaleA = engine.gate(staleSpec);
  const gStaleB = otherEngine.gate(staleSpec);
  const gOther = otherEngine.gate({ id: "sib.route.other", question: route, policy: stalePolicy });
  await ctx.guard("coldstart-expiry");
  for (const it of corpus.items.slice(0, 6)) await gStaleA.ask(it.state);
  for (const it of corpus.items.slice(6, 10)) {
    await gStaleB.ask(it.state);
    await gOther.ask(it.state);
  }
  const T = tPick ?? 0.9;
  const expiry: Record<string, unknown> = {};
  for (const gid of ["sib.route.stale", "sib.route.other"]) {
    const args = [
      ledgerPath,
      "--gate",
      gid,
      "--target",
      String(T),
      "--min-support",
      "30",
      "--profile",
      paths.pick,
      "--profile",
      paths.rate,
    ];
    const rep = JSON.parse((await report([...args, "--json"])).output) as {
      gates: { grade: EvidenceGrade }[];
    };
    const tr = JSON.parse((await trail([...args, "--json"])).output) as {
      bars: { gate: string; grade: EvidenceGrade }[];
    };
    const chk = checkGate(groupGates(parseJsonlLedger(readFileSync(ledgerPath, "utf8"))), {
      gate: gid,
      promise: T,
      minRows: 30,
      window: 500,
      profiles,
      minSupport: 30,
    });
    const eng = (await engine.gateReport(gid, { targetAccuracy: T, minSupport: 30 })).grade;
    const models = [
      ...new Set(
        rows
          .concat(await new JsonlLedger(ledgerPath).all())
          .filter((r) => r.gateId === gid && r.model)
          .map((r) => r.model),
      ),
    ];
    expiry[gid] = {
      report: surface(rep.gates[0]?.grade),
      trail: surface(tr.bars.find((b) => b.gate === gid)?.grade),
      check: surface(chk.grade),
      engine: surface(eng),
      models,
    };
    ctx.md(
      `- expiry, ${gid} (models ${models.join(", ")}): report ${surface(rep.gates[0]?.grade).kind}, trail ${surface(tr.bars.find((b) => b.gate === gid)?.grade).kind}, check ${surface(chk.grade).kind}, engine ${surface(eng).kind}; "${surface(eng).sentence}"`,
    );
  }
  out.expiry = expiry;
  const all = await new JsonlLedger(ledgerPath).all();
  out.cost = all.reduce((s, r) => s + r.cost, 0);
  out.answered = asked.filter((a) => a.r.decision.failedOpen !== true).length;
  out.verdicts = asked.map((a) => ({
    id: a.item.id,
    route: (a.r.decision.verdict as PickVerdict).choice,
    urgency: (a.u.decision.verdict as RateVerdict).level,
  }));
  ctx.md(`\ncoldstart spend: $${(out.cost as number).toFixed(5)}`);
  ctx.result("coldstart", out);
}
