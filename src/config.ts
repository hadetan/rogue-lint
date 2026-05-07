import fs from "node:fs";
import path from "node:path";

import type { CliOptions, ResolvedConfig, RogueLintConfig } from "./types.js";

const DEFAULT_CONFIG: ResolvedConfig["value"] = {
  mode: "application",
  tsconfig: "",
  entrypoints: [],
  hiddenRoots: [],
  include: [],
  exclude: [],
  includeKinds: [],
  findingsExitCode: 1,
  failureExitCode: 2,
  keep: {
    files: [],
    symbols: [],
    members: [],
    entityIds: [],
  },
  objectAnalysis: {
    enabled: true,
    maxPathDepth: 5,
  },
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function loadPackageJson(rootPath: string): {
  path?: string;
  value: Record<string, unknown> | null;
} {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { value: null };
  }

  return {
    path: packageJsonPath,
    value: readJsonFile(packageJsonPath),
  };
}

export function resolveConfig(rootPath: string, cliOptions: CliOptions): ResolvedConfig {
  const packageJson = loadPackageJson(rootPath);
  const explicitPath = cliOptions.configPath
    ? path.resolve(rootPath, cliOptions.configPath)
    : undefined;
  const candidatePaths = [
    explicitPath,
    path.join(rootPath, "rogue-lint.config.json"),
  ].filter(Boolean) as string[];

  let sourcePath: string | undefined;
  let rawConfig: RogueLintConfig = {};

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      sourcePath = candidatePath;
      rawConfig = readJsonFile(candidatePath) as RogueLintConfig;
      break;
    }
  }

  const packageConfig = packageJson.value?.rogueLint;
  if (!sourcePath && packageConfig && typeof packageConfig === "object") {
    rawConfig = packageConfig as RogueLintConfig;
  }

  const merged: ResolvedConfig["value"] = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    mode: cliOptions.mode ?? rawConfig.mode ?? DEFAULT_CONFIG.mode,
    includeKinds:
      cliOptions.includeKinds && cliOptions.includeKinds.length > 0
        ? cliOptions.includeKinds
        : rawConfig.includeKinds ?? DEFAULT_CONFIG.includeKinds,
    keep: {
      ...DEFAULT_CONFIG.keep,
      ...rawConfig.keep,
    },
    objectAnalysis: {
      ...DEFAULT_CONFIG.objectAnalysis,
      ...rawConfig.objectAnalysis,
    },
  };

  return {
    value: merged,
  };
}
