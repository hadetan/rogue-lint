import type { TrackingSafetyBudgets } from "../engine/tracking/upgrade-safety.js";
import type { BenchmarkTargetManifest } from "./types.js";
import { BENCHMARK_COVERAGE_CLASS } from "./vocabulary.js";

export function getBenchmarkTrackingSafetyBudgets(
  coverageClass: BenchmarkTargetManifest["coverageClass"],
): TrackingSafetyBudgets {
  switch (coverageClass) {
    case BENCHMARK_COVERAGE_CLASS.applicationEntrypointDriven:
      return {
        maxPasses: 8,
        maxBindingChurnMultiplier: 8,
        maxReturnSummaryChurnMultiplier: 8,
        maxElapsedMs: 1500,
      };
    case BENCHMARK_COVERAGE_CLASS.libraryPublicSurface:
      return {
        maxPasses: 8,
        maxBindingChurnMultiplier: 8,
        maxReturnSummaryChurnMultiplier: 8,
        maxElapsedMs: 3000,
      };
    case BENCHMARK_COVERAGE_CLASS.workspaceMonorepoSubproject:
      return {
        maxPasses: 10,
        maxBindingChurnMultiplier: 10,
        maxReturnSummaryChurnMultiplier: 10,
        maxElapsedMs: 8000,
      };
  }
}
