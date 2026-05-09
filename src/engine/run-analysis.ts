import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../module-graph.js";
import { loadProject } from "../project.js";
import { buildSuppressionContext } from "../suppressions.js";
import type { AnalysisResult, CliOptions, FindingKind } from "../types.js";
import { getVersion, uniqueById } from "../shared/general-utils.js";
import { createAnalysisState } from "./analysis-state.js";
import { analyzeClassMembers } from "./analyzers/class-members.js";
import { analyzeCompilerSafetyDiagnostics } from "./analyzers/compiler-safety.js";
import { analyzeInterfaceMembers } from "./analyzers/interface-members.js";
import { analyzeObjectPaths } from "./analyzers/object-paths.js";
import { analyzeUnusedExports } from "./analyzers/unused-exports.js";
import { analyzeUnusedFiles } from "./analyzers/unused-files.js";
import { analyzeUnusedLocals } from "./analyzers/unused-locals.js";
import { analyzeValueLiveness } from "./analyzers/value-liveness.js";
import { collectPublicSurfaceIds, type ReferenceCaches } from "./analyzers/support.js";

interface AnalysisStage {
  enabled: boolean;
  run: () => void;
}

/**
 * Coordinates project loading, reachability discovery, stage execution, and final result assembly.
 *
 * Analyzer-specific logic stays in stage modules so this entrypoint remains the only place that owns
 * execution order, shared caches, and final deduplication of findings, kept audits, skips, and diagnostics.
 */
export async function analyzeProject(cliOptions: CliOptions): Promise<AnalysisResult> {
  const project = loadProject(cliOptions);
  const state = createAnalysisState();
  const suppressionContext = buildSuppressionContext(project);
  const graph = buildModuleGraph(project);
  const entrypointDiscovery = discoverEntrypoints(project);
  const reachableFiles = computeReachableFiles(entrypointDiscovery.entrypoints, graph);
  const publicSurfaceIds = collectPublicSurfaceIds(project, entrypointDiscovery.publicSurfaceEntrypoints);
  const caches: ReferenceCaches = {
    hasReference: new Map(),
    exportReferences: new Map(),
    usage: new Map(),
  };

  state.diagnostics.push(...entrypointDiscovery.diagnostics);
  state.diagnostics.push(...graph.unresolved);

  const stages: AnalysisStage[] = [
    {
      enabled: true,
      run: () => analyzeUnusedFiles(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () => analyzeCompilerSafetyDiagnostics(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () =>
        analyzeUnusedExports(project, reachableFiles, publicSurfaceIds, state, suppressionContext, caches),
    },
    {
      enabled: true,
      run: () => analyzeUnusedLocals(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () => analyzeValueLiveness(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () => analyzeInterfaceMembers(project, reachableFiles, state, suppressionContext, caches),
    },
    {
      enabled: true,
      run: () => analyzeClassMembers(project, reachableFiles, publicSurfaceIds, state, suppressionContext, caches),
    },
    {
      enabled: true,
      run: () => analyzeObjectPaths(project, reachableFiles, state, suppressionContext),
    },
  ];

  for (const stage of stages) {
    if (stage.enabled) {
      stage.run();
    }
  }

  const includeKinds = project.config.value.includeKinds;
  const filteredFindings =
    includeKinds.length > 0
      ? state.findings.filter((finding) => includeKinds.includes(finding.kind))
      : state.findings;

  const findings = uniqueById(filteredFindings);
  const kept = uniqueById(state.kept);
  const skipped = uniqueById(state.skipped);
  const diagnostics = uniqueById(
    state.diagnostics.map((diagnostic, index) => ({ ...diagnostic, id: `${diagnostic.kind}:${index}` })),
  ).map(({ id: _id, ...diagnostic }) => diagnostic);

  const byKind: Partial<Record<FindingKind, number>> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

  return {
    tool: "rogue-lint",
    version: getVersion(),
    target: project.rootPath,
    mode: project.config.value.mode,
    exitCodes: {
      findings: project.config.value.findingsExitCode,
      failure: project.config.value.failureExitCode,
    },
    generatedAt: new Date().toISOString(),
    summary: {
      filesAnalyzed: project.sourceFiles.length,
      reachableFiles: reachableFiles.size,
      findings: findings.length,
      kept: kept.length,
      skipped: skipped.length,
      byKind,
    },
    findings,
    kept,
    skipped,
    diagnostics,
  };
}
