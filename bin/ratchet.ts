#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main, type ReviewIo } from "../src/cli/main.ts";

/** A line-at-a-time terminal for `ratchet review`. End of input reads as "stop". */
function terminal(): { readonly io: ReviewIo; readonly close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const ask = (prompt: string): Promise<string | undefined> =>
    closed
      ? Promise.resolve(undefined)
      : new Promise((resolve) => {
          const onClose = (): void => resolve(undefined);
          rl.once("close", onClose);
          rl.question(prompt).then(
            (answer) => {
              rl.off("close", onClose);
              resolve(answer);
            },
            () => resolve(undefined),
          );
        });
  return {
    io: { print: (text) => process.stdout.write(text), ask },
    close: () => rl.close(),
  };
}

const argv = process.argv.slice(2);
const term = argv[0] === "review" ? terminal() : undefined;
const result = await main(argv, term?.io);
term?.close();
// Usage errors go to stderr so a CI log separates "could not run" from a check's verdict.
const stream = result.exitCode === 2 ? process.stderr : process.stdout;
// `ratchet hook ... event` must leave stdout empty: a harness parses a hook's stdout as JSON.
if (result.output !== "") {
  stream.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
}
process.exitCode = result.exitCode;
