import type {
  ProjectContext,
  SuppressionContext,
} from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { createObjectPathStageContext } from "./object-paths/stage-context.js";
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

  const stageContext = createObjectPathStageContext(
    project,
    reachableFiles,
    state,
    suppressionContext,
    artifacts,
  );

  for (const sourceFile of project.sourceFiles) {
    if (!stageContext.reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    visitObjectPathSourceFile(stageContext, stageContext.createSourceFileContext(sourceFile));
  }

  finalizeObjectPathFindings(
    project,
    state,
    suppressionContext,
    stageContext.trackedObjectRegistry.values(),
    stageContext.overlayState,
    stageContext.trackedBindingRegistry,
  );
}
