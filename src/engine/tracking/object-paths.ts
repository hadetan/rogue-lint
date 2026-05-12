import type {
  ProjectContext,
  SuppressionContext,
} from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { finalizeObjectPathFindings } from "./object-paths/reporting.js";
import { visitObjectPathSourceFile } from "./object-paths/visitor.js";

/**
 * Exact object-path and collection analysis built on top of the shared tracked-object graph.
 */
export function analyzeObjectPaths(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  if (!project.config.value.objectAnalysis.enabled) {
    return;
  }

  const trackingStageArtifacts = artifacts.getTrackingStageArtifacts("object-paths");
  const trackedBySymbolId = trackingStageArtifacts.bindings.bySymbolId;
  const functionReturnSummaries = trackingStageArtifacts.returnSummaries.byCallableId;
  const trackedObjectsById = trackingStageArtifacts.aliases.trackedObjectsById;
  const boundaryTrackedObjectsById = trackingStageArtifacts.boundaries.trackedObjectsById;

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    visitObjectPathSourceFile(
      project,
      sourceFile,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
      state,
      suppressionContext,
    );
  }

  finalizeObjectPathFindings(project, state, suppressionContext, boundaryTrackedObjectsById.values());
}
