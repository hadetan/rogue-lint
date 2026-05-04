#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { analyzeProject } from "./analyze.js";
import { resolveConfig } from "./config.js";
import { renderResult } from "./reporting.js";
import type { AnalysisDepth, AnalysisMode, CliOptions, FindingKind, ReportFormat } from "./types.js";

function parseCliOptions(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
      options: {
        json: { type: "boolean", default: false },
        mode: { type: "string" },
        depth: { type: "string" },
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
    analysisDepth: parsed.values.depth as AnalysisDepth | undefined,
    configPath: parsed.values.config,
    includeKinds: parsed.values.kinds
      ? (parsed.values.kinds.split(",").map((kind) => kind.trim()) as FindingKind[])
      : undefined,
  };
}

// dead-lint-ignore-next
export async function runCli(
  argv: string[],
  io: {
    writeStdout?: (value: string) => void;
    writeStderr?: (value: string) => void;
  } = {},
): Promise<number> {
  const cliOptions = parseCliOptions(argv);
  const writeStdout = io.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = io.writeStderr ?? ((value: string) => process.stderr.write(value));
  const rootPath = path.resolve(cliOptions.targetPath ?? cliOptions.cwd);
  let failureExitCode = 2;

  try {
    failureExitCode = resolveConfig(rootPath, cliOptions).value.failureExitCode;
    const result = await analyzeProject(cliOptions);
    writeStdout(`${renderResult(result, cliOptions.format)}\n`);
    return result.summary.findings > 0 ? result.exitCodes.findings : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`${message}\n`);
    return failureExitCode;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
