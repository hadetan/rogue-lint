import type { TrackingSafetyBudgets } from "../engine/tracking/upgrade-safety.js";
import type { BenchmarkTargetManifest } from "./types.js";

export function getBenchmarkTrackingSafetyBudgets(
  coverageClass: BenchmarkTargetManifest["coverageClass"],
): TrackingSafetyBudgets {
  switch (coverageClass) {
    case "application-entrypoint-driven":
      return {
        maxPasses: 8,
        maxBindingChurnMultiplier: 8,
        maxReturnSummaryChurnMultiplier: 8,
        maxElapsedMs: 1500,
      };
    case "library-public-surface":
      return {
        maxPasses: 8,
        maxBindingChurnMultiplier: 8,
        maxReturnSummaryChurnMultiplier: 8,
        maxElapsedMs: 3000,
      };
    case "workspace-monorepo-subproject":
      return {
        maxPasses: 10,
        maxBindingChurnMultiplier: 10,
        maxReturnSummaryChurnMultiplier: 10,
        maxElapsedMs: 8000,
      };
  }
}
