import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../module-graph.js";
import { loadProject } from "../project.js";
import { buildSuppressionContext } from "../suppressions.js";
import type { AnalysisOptions, AnalysisResult, FindingKind } from "../types.js";
import { getVersion } from "../shared/general-utils.js";
import { createAnalysisRunState, getOrCreateAnalysisRunResultMetadata } from "./analysis-run-state.js";
import { appendProviderObligationDiagnostics, createAnalysisState, registerCapabilityFact } from "./analysis-state.js";
import { createAnalysisArtifacts } from "./analysis-artifacts.js";
import { analyzeCompilerSafetyDiagnostics } from "./analyzers/compiler-safety.js";
import { analyzeUnusedFiles } from "./analyzers/unused-files.js";
import { analyzeSymbolLiveness } from "./analyzers/symbol-liveness.js";
import { collectPublicSurface } from "./analyzers/support.js";
import { attachAnalysisCapabilityLedger, collectAnalysisCapabilityLedger } from "./capabilities/providers.js";
import { assembleProviderBackedReportSurface } from "./capabilities/report-assembly.js";
import { createEmptyAnalysisCapabilityLedger } from "./capabilities/types.js";
import { validateFindingKindOwners } from "./finding-kind-owners.js";
import { appendTrackingAnalysisDiagnostics, toAnalysisDiagnostic } from "./tracking/diagnostics.js";
import { OBJECT_PATHS_TRACKING_STAGE, TRACKING_GRAPH_BUILD_TRACKING_STAGE, VALUE_LIVENESS_TRACKING_STAGE, getTrackingDiagnosticFromError, type TrackingStage } from "./tracking/contracts.js";
import type { TrackingConvergenceOptions } from "./tracking/convergence.js";
import { analyzeObjectPaths } from "./tracking/object-paths.js";
import { attachTrackingRuntimeSummary } from "./tracking/upgrade-safety.js";
import { analyzeValueLiveness } from "./tracking/value-liveness.js";

interface AnalysisStage {
  enabled: boolean;
  run: () => void;
  trackingStage?: TrackingStage;
}

const DEFAULT_TRACKING_CONVERGENCE_OPTIONS: TrackingConvergenceOptions = {
  maxPassElapsedMs: 5000,
};

/**
 * Coordinates project loading, reachability discovery, stage execution, and final result assembly.
 *
 * Analyzer-specific logic stays in stage modules so this entrypoint remains the only place that owns
 * execution order, shared caches, and final deduplication of findings, kept audits, skips, and diagnostics.
 */
export async function analyzeProject(options: AnalysisOptions): Promise<AnalysisResult> {
  void registerCapabilityFact;
  void attachAnalysisCapabilityLedger;
  validateFindingKindOwners();
  const project = loadProject(options);
  const runState = createAnalysisRunState();
  const state = createAnalysisState(runState);
  const suppressionContext = buildSuppressionContext(project);
  const graph = buildModuleGraph(project);
  const entrypointDiscovery = discoverEntrypoints(project);
  const reachableFiles = computeReachableFiles(entrypointDiscovery.entrypoints, graph);
  const publicSurface = collectPublicSurface(project, entrypointDiscovery.publicSurfaceEntrypoints);
  const artifacts = createAnalysisArtifacts(
    project,
    reachableFiles,
    publicSurface.ids,
    publicSurface.callableIds,
    DEFAULT_TRACKING_CONVERGENCE_OPTIONS,
    runState,
  );

  state.diagnostics.push(...entrypointDiscovery.diagnostics);
  state.diagnostics.push(...graph.unresolved);

  const stages: AnalysisStage[] = [
    {
      enabled: true,
      run: () => analyzeUnusedFiles(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () => analyzeCompilerSafetyDiagnostics(project, reachableFiles, state, suppressionContext, artifacts),
    },
    {
      enabled: true,
      run: () => analyzeSymbolLiveness(project, reachableFiles, state, suppressionContext, artifacts),
    },
    {
      enabled: true,
      run: () => {
        artifacts.getTrackingStageArtifacts(TRACKING_GRAPH_BUILD_TRACKING_STAGE);
      },
    },
    {
      enabled: true,
      run: () => analyzeValueLiveness(project, reachableFiles, state, suppressionContext, artifacts),
      trackingStage: VALUE_LIVENESS_TRACKING_STAGE,
    },
    {
      enabled: true,
      run: () => analyzeObjectPaths(project, reachableFiles, state, suppressionContext, artifacts),
      trackingStage: OBJECT_PATHS_TRACKING_STAGE,
    },
  ];

  let trackingFailure = false;

  for (const stage of stages) {
    if (stage.enabled) {
      const startedAt = Date.now();
      try {
        stage.run();
      } catch (error) {
        const trackingDiagnostic = getTrackingDiagnosticFromError(error);
        if (!trackingDiagnostic) {
          throw error;
        }

        state.diagnostics.push(toAnalysisDiagnostic(trackingDiagnostic));
        trackingFailure = true;
        break;
      } finally {
        if (stage.trackingStage && runState.trackingArtifacts) {
          runState.trackingArtifacts.recordStageTiming(stage.trackingStage, Date.now() - startedAt);
        }
      }
    }
  }

  if (!trackingFailure) {
    appendTrackingAnalysisDiagnostics(state, artifacts);
    appendProviderObligationDiagnostics(state);
  }

  const capabilityLedger = trackingFailure
    ? createEmptyAnalysisCapabilityLedger()
    : collectAnalysisCapabilityLedger(project, state, artifacts);
  runState.capabilityLedger = capabilityLedger;
  const includeKinds = project.config.value.includeKinds;
  const { findings, kept, skipped, diagnostics } = assembleProviderBackedReportSurface(
    state,
    capabilityLedger,
    includeKinds,
  );

  const byKind: Partial<Record<FindingKind, number>> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

  const result: AnalysisResult = {
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

  const trackingRuntimeSummary = trackingFailure ? undefined : artifacts.getTrackingRunArtifacts().runtimeSummary;
  runState.trackingRuntimeSummary = trackingRuntimeSummary;

  getOrCreateAnalysisRunResultMetadata(result).capabilityLedger = capabilityLedger;
  if (trackingRuntimeSummary) {
    attachTrackingRuntimeSummary(result, trackingRuntimeSummary);
  }

  return result;
}
