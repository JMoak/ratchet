/**
 * Live experiments against Jev through OpenRouter. Writes markdown to stdout, progress to
 * stderr, raw rows and ledgers to experiments/out/. Hard budget: $0.50.
 *
 *   bun experiments/live/main.ts > docs/live-results.md
 */
import { note } from "../../sim/lib.ts";
import { e1 } from "./e1-cost.ts";
import { e2 } from "./e2-boolq.ts";
import { e3 } from "./e3-banking77.ts";
import { e4 } from "./e4-cascade.ts";
import { e5 } from "./e5-jagged.ts";
import { JEV_MODEL, progress, Spend, STRONG_MODEL } from "./lib.ts";

const spend = new Spend(0.5);
const only = new Set(process.argv.slice(2));
const run = (name: string) => only.size === 0 || only.has(name);

console.log("# Live results: Jev through OpenRouter\n");
note(
  `Run on ${new Date().toISOString().slice(0, 10)}. Decision model \`${JEV_MODEL}\` via https://openrouter.ai/api/v1/systemone; strong judge \`${STRONG_MODEL}\` via chat completions. Every cost figure is the gateway's billed amount. Raw rows and the engine ledgers are in \`experiments/out/\`.`,
);

const started = performance.now();
try {
  if (run("e1")) await e1(spend);
  const jevRows = run("e2") || run("e4") ? await e2(spend) : [];
  if (run("e3")) await e3(spend);
  if (run("e4")) await e4(spend, jevRows);
  if (run("e5")) await e5(spend);
} catch (e) {
  note(`\n**Stopped:** ${(e as Error).message}`);
  progress(`stopped: ${(e as Error).message}`);
}
const secs = (performance.now() - started) / 1000;
note(
  `\n**Total spend: $${spend.total.toFixed(4)} over ${spend.calls} calls in ${secs.toFixed(0)} s.**`,
);
progress(`done: $${spend.total.toFixed(4)} over ${spend.calls} calls in ${secs.toFixed(0)} s`);
