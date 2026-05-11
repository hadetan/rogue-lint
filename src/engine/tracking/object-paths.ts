import type {
  ProjectContext,
  SuppressionContext,
  TrackedObject,
} from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import { buildTrackedObjects } from "./graph.js";
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
): void {
  if (!project.config.value.objectAnalysis.enabled) {
    return;
  }

  const { trackedBySymbolId, functionReturnSummaries, trackedObjectsById } = buildTrackedObjects(project, reachableFiles);

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

  finalizeObjectPathFindings(project, state, suppressionContext, trackedObjectsById.values());
}
