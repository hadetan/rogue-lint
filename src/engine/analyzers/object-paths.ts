import type { ProjectContext, SuppressionContext } from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import { analyzeObjectPaths as analyzeObjectPathsInCore } from "../tracking/core.js";

/**
 * Runs object-path and collection analysis through the shared tracking kernel.
 */
export function analyzeObjectPaths(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
): void {
  analyzeObjectPathsInCore(project, reachableFiles, state, suppressionContext);
}
