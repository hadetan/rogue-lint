#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";

import { analyzeProject } from "./analyze.js";
import { renderResult } from "./reporting.js";
import type { AnalysisMode, CliOptions, FindingKind, ReportFormat } from "./types.js";

function parseCliOptions(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      mode: { type: "string" },
      config: { type: "string" },
      kinds: { type: "string" },
    },
    allowPositionals: true,
  });

  const [targetPath] = parsed.positionals;
  return {
    cwd: process.cwd(),
    targetPath: targetPath ? path.resolve(process.cwd(), targetPath) : undefined,
    format: parsed.values.json ? ("json" satisfies ReportFormat) : ("text" satisfies ReportFormat),
    mode: parsed.values.mode as AnalysisMode | undefined,
    configPath: parsed.values.config,
    includeKinds: parsed.values.kinds
      ? (parsed.values.kinds.split(",").map((kind) => kind.trim()) as FindingKind[])
      : undefined,
  };
}

async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  try {
    const result = await analyzeProject(cliOptions);
    process.stdout.write(`${renderResult(result, cliOptions.format)}\n`);
    process.exitCode = result.summary.findings > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

void main();
