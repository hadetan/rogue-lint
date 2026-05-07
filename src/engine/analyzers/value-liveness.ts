import type { ProjectContext, SuppressionContext } from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import { analyzeValueLiveness as analyzeValueLivenessInCore } from "../tracking/core.js";

/**
 * Runs exactness-gated value-fate analysis through the shared tracking kernel.
 */
export function analyzeValueLiveness(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
): void {
  analyzeValueLivenessInCore(project, reachableFiles, state, suppressionContext);
}
