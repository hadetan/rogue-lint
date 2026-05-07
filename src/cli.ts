#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export { runCli } from "./cli/run-cli.js";

import { runCli } from "./cli/run-cli.js";

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
