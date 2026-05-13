import path from "node:path";
import { parseArgs } from "node:util";

import type { AnalysisMode, CliOptions, FindingKind, ReportFormat } from "../types.js";

/**
 * Normalizes raw CLI arguments into the internal option shape consumed by `runCli` and `analyzeProject`.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      kept: { type: "boolean", default: false },
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
    showKept: parsed.values.kept,
    mode: parsed.values.mode as AnalysisMode | undefined,
    configPath: parsed.values.config,
    includeKinds: parsed.values.kinds
      ? (parsed.values.kinds.split(",").map((kind) => kind.trim()) as FindingKind[])
      : undefined,
  };
}
