import path from "node:path";

import { analyzeProject } from "../api/analyze-project.js";
import { parseCliOptions } from "./parse-cli-options.js";
import { resolveConfig } from "../config.js";
import { renderResult } from "../output/render-result.js";

/**
 * Executes the CLI flow and returns the exit code that should be reported to the shell.
 *
 * The config is resolved before the main analysis run so configuration-defined failure exit codes
 * still apply when project loading or analysis setup fails.
 */
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
    writeStdout(`${renderResult(result, cliOptions.format, cliOptions.showKept)}\n`);
    if (result.diagnostics.some((diagnostic) => diagnostic.kind === "project-error")) {
      return result.exitCodes.failure;
    }

    return result.summary.findings > 0 ? result.exitCodes.findings : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`${message}\n`);
    return failureExitCode;
  }
}
