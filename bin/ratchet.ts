#!/usr/bin/env bun
import { main } from "../src/cli/main.ts";

const result = await main(process.argv.slice(2));
// Usage errors go to stderr so a CI log separates "could not run" from a check's verdict.
const stream = result.exitCode === 2 ? process.stderr : process.stdout;
stream.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
process.exitCode = result.exitCode;
