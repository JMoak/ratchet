/**
 * Regenerate `profiles/*.json` from the live ledgers under `experiments/out/`: one calibration
 * profile per model pin and question kind they hold, and `profiles/README.md` naming each
 * profile's donor ledgers, dates and rows. The donors are the ledgers `experiments/live` writes
 * (e2's BoolQ frames, e3's BANKING77 intents, e4's strong judges on BoolQ); the simulated CLI
 * fixture and the pilot's authored labels are not evidence about a model and are left out.
 * Experiment outputs are untrusted, so they are only ever parsed as JSON. With no live ledger
 * present it says what it skipped and writes nothing; it never deletes a profile.
 *
 *   bun run profiles
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfile } from "../src/ledger/borrow.ts";
import { describeSources } from "../src/ledger/evidence.ts";
import { type DecisionRecord, decisionRows, parseJsonlLedger } from "../src/ledger/ledger.ts";
import {
  buildProfile,
  type CalibrationProfile,
  PROFILE_TARGETS,
  type ProfileKey,
} from "../src/ledger/profile.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(ROOT, "experiments", "out");
const PROFILES = join(ROOT, "profiles");
/** The ledgers `experiments/live` writes: `boolq-ledger.jsonl`, `banking77-ledger.jsonl`, `boolq-<model>-ledger.jsonl`. */
const LIVE = /^(?:boolq|banking77)(?:-[\w.-]+)?-ledger\.jsonl$/;
const MIN_SUPPORT = 30;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const slug = (model: string): string => model.replace(/[^\w.-]+/g, "_");
const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const day = (at: string): string => at.slice(0, 10);

function liveLedgers(): { name: string; rows: DecisionRecord[] }[] {
  if (!existsSync(OUT)) {
    say("skipped: experiments/out/ does not exist; run `bun run live` to write the live ledgers");
    return [];
  }
  const names = readdirSync(OUT)
    .filter((f) => LIVE.test(f))
    .sort();
  if (names.length === 0) {
    say("skipped: no live ledger in experiments/out/ (boolq-*, banking77-*); run `bun run live`");
  }
  return names.flatMap((f) => {
    const name = `experiments/out/${f}`;
    try {
      return [{ name, rows: parseJsonlLedger(readFileSync(join(OUT, f), "utf8")) }];
    } catch (e) {
      say(`skipped ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  });
}

/** Every model pin and kind the ledgers hold answers from, an answer given by one model alone. */
function keysOf(ledgers: readonly { rows: readonly DecisionRecord[] }[]): ProfileKey[] {
  const keys = new Map<string, ProfileKey>();
  for (const { rows } of ledgers) {
    for (const r of decisionRows(rows)) {
      if (r.model === undefined || r.strategy !== "single") continue;
      keys.set(`${r.model}\u0000${r.kind}`, { model: r.model, kind: r.kind });
    }
  }
  return [...keys.values()].sort((a, b) =>
    `${a.model} ${a.kind}` < `${b.model} ${b.kind}` ? -1 : 1,
  );
}

function build(ledgers: readonly { name: string; rows: DecisionRecord[] }[]): string[] {
  const written: string[] = [];
  for (const key of keysOf(ledgers)) {
    const opts = { targets: PROFILE_TARGETS, minSupport: MIN_SUPPORT };
    // Name only the ledgers that lent a row, so a donor list never claims one that did not.
    const donors = ledgers.filter((l) => buildProfile(l.rows, key, { ...opts, ledgers: [l.name] }));
    const profile =
      donors.length === 0
        ? undefined
        : buildProfile(
            donors.flatMap((l) => l.rows),
            key,
            { ...opts, ledgers: donors.map((l) => l.name) },
          );
    if (profile === undefined) {
      say(`skipped ${key.model} ${key.kind}: no labelled unselected row of a trusted source`);
      continue;
    }
    const file = `${slug(key.model)}.${key.kind}.json`;
    mkdirSync(PROFILES, { recursive: true });
    writeFileSync(join(PROFILES, file), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    say(`wrote profiles/${file}: profile ${profile.hash}, ${profile.from.rows} rows`);
    written.push(file);
  }
  return written;
}

function readme(): string {
  const rows: string[] = [];
  let barred = false;
  for (const file of readdirSync(PROFILES)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    let p: CalibrationProfile;
    try {
      p = parseProfile(JSON.parse(readFileSync(join(PROFILES, file), "utf8")));
    } catch (e) {
      say(`not listed: profiles/${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    barred ||= p.bars.length > 0;
    const bars = p.targets.map((t) => {
      const b = p.bars.find((x) => x.target === t);
      return b ? `${pct(t)} at ${b.bar.toFixed(2)} (${b.support} rows)` : `${pct(t)} none`;
    });
    rows.push(
      `| \`${file}\` | \`${p.hash}\` | ${p.key.model} | ${p.key.kind} | ${p.from.rows} | ${p.from.gates.length} | ${p.from.ledgers.map((l) => `\`${l}\``).join(", ")} | ${day(p.from.firstAt)} to ${day(p.from.lastAt)} | ${describeSources(p.from.sources)} | ${p.resolution} | ${bars.join(", ")} |`,
    );
  }
  return [
    "# Calibration profiles",
    "",
    "Generated by `bun run profiles` (`scripts/profiles.ts`) from the live ledgers under",
    "`experiments/out/`, which `bun run live` writes and git ignores, so the donor ledgers named",
    "below are not in the repository. Do not edit a profile by hand: one whose bars or hash are",
    "not what its bins give is refused.",
    "",
    "A profile is borrowed evidence. A gate may start from one in shadow (`policyFromProfile`, or",
    "`ratchet report|check|trail --profile <file>` for a gate with no fitted bar), only while its",
    "model pin and question kind match the key, and nothing reaches enforce without a measured",
    "grade of the gate's own. Each bar is the cautious end over the donor gates: the lowest edge",
    `of the profile's equal bins at which every donor gate with at least ${MIN_SUPPORT} rows in its tail`,
    "(every row at or above the edge) keeps the promise on that tail by a 95% Wilson lower bound,",
    "as `ratchet report` fits a bar on one gate. It is the strictest donor's bar, not the average,",
    'because a profile is lent to gates none of its donors is. "none" means no edge held on every',
    "such gate; in brackets, the fewest tail rows a bar rests on. `ratchet profile show <file>`",
    "prints each donor gate's own bar. Rows are labelled unselected rows of trusted sources",
    "answered by the model alone.",
    "",
    "| file | hash | model | kind | rows | gates | donor ledgers | rows from | labels | bins | bars |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(barred
      ? []
      : [
          "",
          `None of these supports a bar at ${PROFILE_TARGETS.map(pct).join(", ")}: at every edge some donor`,
          "gate's tail fell short, so they lend no bar yet, and a report offered one grades a gate",
          "none rather than borrowed. Their bins still say where each model's confidence stood and",
          "how often it was right there (`ratchet profile show <file>`).",
        ]),
    "",
  ].join("\n");
}

const ledgers = liveLedgers();
if (ledgers.length > 0 && build(ledgers).length > 0) {
  writeFileSync(join(PROFILES, "README.md"), readme(), "utf8");
  say("wrote profiles/README.md");
} else {
  say("nothing written");
}
