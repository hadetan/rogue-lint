import fs from "node:fs";
import path from "node:path";

import type {
  BenchmarkDiagnosticMatcher,
  BenchmarkExpectations,
  BenchmarkFindingMatcher,
  BenchmarkSkipMatcher,
  BenchmarkTargetConfig,
  BenchmarkTargetManifest,
} from "./types.js";
import {
  BENCHMARK_DOC_PATH,
  EMPTY_BENCHMARK_CONFIG,
  isAnalysisMode,
  isBenchmarkCoverageClass,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequiredString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }

  return value;
}

function parseOptionalString(value: unknown, location: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseRequiredString(value, location);
}

function parseOptionalCount(value: unknown, location: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative integer`);
  }

  return value;
}

function parseCountBounds(
  value: Record<string, unknown>,
  location: string,
): Pick<BenchmarkFindingMatcher, "minCount" | "maxCount"> {
  const minCount = parseOptionalCount(value.minCount, `${location}.minCount`);
  const maxCount = parseOptionalCount(value.maxCount, `${location}.maxCount`);

  if (minCount !== undefined && maxCount !== undefined && maxCount < minCount) {
    throw new Error(`${location}.maxCount must be greater than or equal to ${location}.minCount`);
  }

  return {
    minCount,
    maxCount,
  };
}

function parseStringArray(value: unknown, location: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of strings`);
  }

  return value.map((entry, index) => parseRequiredString(entry, `${location}[${index}]`));
}

function parseFindingMatcher(value: unknown, location: string): BenchmarkFindingMatcher {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  return {
    ...parseCountBounds(value, location),
    label: parseRequiredString(value.label, `${location}.label`),
    id: parseOptionalString(value.id, `${location}.id`),
    kind: parseOptionalString(value.kind, `${location}.kind`) as BenchmarkFindingMatcher["kind"],
    entityKind: parseOptionalString(value.entityKind, `${location}.entityKind`) as BenchmarkFindingMatcher["entityKind"],
    file: parseOptionalString(value.file, `${location}.file`),
    name: parseOptionalString(value.name, `${location}.name`),
    owner: parseOptionalString(value.owner, `${location}.owner`),
    reasonIncludes: parseOptionalString(value.reasonIncludes, `${location}.reasonIncludes`),
    messageIncludes: parseOptionalString(value.messageIncludes, `${location}.messageIncludes`),
  };
}

function parseSkipMatcher(value: unknown, location: string): BenchmarkSkipMatcher {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  return {
    ...parseCountBounds(value, location),
    label: parseRequiredString(value.label, `${location}.label`),
    id: parseOptionalString(value.id, `${location}.id`),
    kind: parseOptionalString(value.kind, `${location}.kind`) as BenchmarkSkipMatcher["kind"],
    file: parseOptionalString(value.file, `${location}.file`),
    name: parseOptionalString(value.name, `${location}.name`),
    category: parseOptionalString(value.category, `${location}.category`) as BenchmarkSkipMatcher["category"],
    reasonIncludes: parseOptionalString(value.reasonIncludes, `${location}.reasonIncludes`),
  };
}

function parseDiagnosticMatcher(value: unknown, location: string): BenchmarkDiagnosticMatcher {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  return {
    ...parseCountBounds(value, location),
    label: parseRequiredString(value.label, `${location}.label`),
    kind: parseOptionalString(value.kind, `${location}.kind`) as BenchmarkDiagnosticMatcher["kind"],
    fileIncludes: parseOptionalString(value.fileIncludes, `${location}.fileIncludes`),
    messageIncludes: parseOptionalString(value.messageIncludes, `${location}.messageIncludes`),
  };
}

function parseMatcherArray<Matcher>(
  value: unknown,
  location: string,
  parse: (entry: unknown, entryLocation: string) => Matcher,
): Matcher[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }

  return value.map((entry, index) => parse(entry, `${location}[${index}]`));
}

function parseAcceptedDebtCountFromLabel(label: string, noun: "findings" | "skips"): number | undefined {
  const match = label.match(/\((\d+) current (findings|skips)\)$/);
  if (!match || match[2] !== noun) {
    return undefined;
  }

  return Number(match[1]);
}

function applyAcceptedDebtFallback<Matcher extends { label: string; maxCount?: number }>(
  matchers: Matcher[],
  noun: "findings" | "skips",
): Matcher[] {
  return matchers.map((matcher) => {
    if (matcher.maxCount !== undefined) {
      return matcher;
    }

    const inferredMaxCount = parseAcceptedDebtCountFromLabel(matcher.label, noun);
    return inferredMaxCount === undefined
      ? matcher
      : {
          ...matcher,
          maxCount: inferredMaxCount,
        };
  });
}

function parseExpectations(value: unknown, location: string): BenchmarkExpectations {
  if (value === undefined) {
    return {
      mustFind: [],
      mustNotFind: [],
      mustSkip: [],
      mustDiagnose: [],
      mustNotDiagnose: [],
      acceptedFindings: [],
      knownSkips: [],
    };
  }

  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  const acceptedFindings = parseMatcherArray(
    value.acceptedFindings,
    `${location}.acceptedFindings`,
    parseFindingMatcher,
  );
  const knownSkips = parseMatcherArray(value.knownSkips, `${location}.knownSkips`, parseSkipMatcher);

  return {
    mustFind: parseMatcherArray(value.mustFind, `${location}.mustFind`, parseFindingMatcher),
    mustNotFind: parseMatcherArray(value.mustNotFind, `${location}.mustNotFind`, parseFindingMatcher),
    mustSkip: parseMatcherArray(value.mustSkip, `${location}.mustSkip`, parseSkipMatcher),
    mustDiagnose: parseMatcherArray(value.mustDiagnose, `${location}.mustDiagnose`, parseDiagnosticMatcher),
    mustNotDiagnose: parseMatcherArray(value.mustNotDiagnose, `${location}.mustNotDiagnose`, parseDiagnosticMatcher),
    acceptedFindings: applyAcceptedDebtFallback(acceptedFindings, "findings"),
    knownSkips: applyAcceptedDebtFallback(knownSkips, "skips"),
  };
}

function parseConfig(value: unknown, location: string): BenchmarkTargetConfig {
  if (value === undefined) {
    return { ...EMPTY_BENCHMARK_CONFIG };
  }

  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  const mode = value.mode;
  if (mode !== undefined && !isAnalysisMode(mode)) {
    throw new Error(`${location}.mode must be "application" or "library"`);
  }

  return {
    mode,
    entrypoints: parseStringArray(value.entrypoints, `${location}.entrypoints`),
    hiddenRoots: parseStringArray(value.hiddenRoots, `${location}.hiddenRoots`),
    include: parseStringArray(value.include, `${location}.include`),
    exclude: parseStringArray(value.exclude, `${location}.exclude`),
    objectAnalysis: isRecord(value.objectAnalysis)
      ? {
          enabled:
            typeof value.objectAnalysis.enabled === "boolean"
              ? value.objectAnalysis.enabled
              : undefined,
          maxPathDepth:
            typeof value.objectAnalysis.maxPathDepth === "number"
              ? value.objectAnalysis.maxPathDepth
              : undefined,
        }
      : undefined,
  };
}

function walkJsonFiles(directoryPath: string): string[] {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const result: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = walkJsonFiles(fullPath);
      for (const nestedFile of nestedFiles) {
        result.push(nestedFile);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      result.push(fullPath);
    }
  }

  return result;
}

function parseManifest(filePath: string): BenchmarkTargetManifest {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }

  const repository = raw.repository;
  if (!isRecord(repository)) {
    throw new Error(`${filePath}: repository must be an object`);
  }

  if (!isBenchmarkCoverageClass(raw.coverageClass)) {
    throw new Error(
      `${filePath}: coverageClass must be one of "application-entrypoint-driven", `
      + `"library-public-surface", or "workspace-monorepo-subproject"`,
    );
  }

  return {
    id: parseRequiredString(raw.id, `${filePath}: id`),
    description: parseRequiredString(raw.description, `${filePath}: description`),
    coverageClass: raw.coverageClass,
    repository: {
      url: parseRequiredString(repository.url, `${filePath}: repository.url`),
      ref: parseRequiredString(repository.ref, `${filePath}: repository.ref`),
    },
    localCorpusPath: parseRequiredString(raw.localCorpusPath, `${filePath}: localCorpusPath`),
    targetPath: parseOptionalString(raw.targetPath, `${filePath}: targetPath`),
    config: parseConfig(raw.config, `${filePath}: config`),
    expectations: parseExpectations(raw.expectations, `${filePath}: expectations`),
  };
}

export function loadBenchmarkManifests(workspaceRoot: string): BenchmarkTargetManifest[] {
  const suiteRoot = path.join(workspaceRoot, "benchmark", "suites");
  return walkJsonFiles(suiteRoot).map((filePath) => parseManifest(filePath));
}

export function getBenchmarkDocsPath(_workspaceRoot: string): string {
  return BENCHMARK_DOC_PATH;
}
