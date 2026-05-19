/**
 * Canonical runtime vocabulary for benchmark manifests, target states, and
 * prioritized benchmark gap reporting.
 */

export const BENCHMARK_COVERAGE_CLASS = {
  applicationEntrypointDriven: "application-entrypoint-driven",
  libraryPublicSurface: "library-public-surface",
  workspaceMonorepoSubproject: "workspace-monorepo-subproject",
} as const;

export type BenchmarkCoverageClass = (typeof BENCHMARK_COVERAGE_CLASS)[keyof typeof BENCHMARK_COVERAGE_CLASS];

export function formatBenchmarkCoverageClassOptions(): string {
  const benchmarkCoverageClassValues = Object.values(BENCHMARK_COVERAGE_CLASS) as BenchmarkCoverageClass[];
  const [first, second, third] = benchmarkCoverageClassValues.map((value) => JSON.stringify(value));
  return `${first}, ${second}, or ${third}`;
}

export const BENCHMARK_TARGET_STATE = {
  missingCorpus: "missing-corpus",
  invalidTarget: "invalid-target",
  analyzed: "analyzed",
} as const;

export type BenchmarkTargetState = (typeof BENCHMARK_TARGET_STATE)[keyof typeof BENCHMARK_TARGET_STATE];

const BENCHMARK_GAP_PRIORITY_SCOPE = {
  acceptedFinding: "accepted-finding",
  acceptedFindingGrowth: "accepted-finding-growth",
  knownSkip: "known-skip",
  knownSkipGrowth: "known-skip-growth",
  unexpectedFinding: "unexpected-finding",
  unexpectedSkip: "unexpected-skip",
} as const;

export type BenchmarkGapPriorityScope =
  | (typeof BENCHMARK_GAP_PRIORITY_SCOPE)[keyof typeof BENCHMARK_GAP_PRIORITY_SCOPE]
  | typeof BENCHMARK_DIAGNOSTIC_GAP_PRIORITY_SCOPE;

export const BENCHMARK_FINDING_GAP_PRIORITY_SCOPE = {
  accepted: BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFinding,
  acceptedGrowth: BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFindingGrowth,
  unexpected: BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedFinding,
} as const;

export type BenchmarkFindingGapPriorityScope = (typeof BENCHMARK_FINDING_GAP_PRIORITY_SCOPE)[keyof typeof BENCHMARK_FINDING_GAP_PRIORITY_SCOPE];

export const BENCHMARK_SKIP_GAP_PRIORITY_SCOPE = {
  known: BENCHMARK_GAP_PRIORITY_SCOPE.knownSkip,
  knownGrowth: BENCHMARK_GAP_PRIORITY_SCOPE.knownSkipGrowth,
  unexpected: BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedSkip,
} as const;

export type BenchmarkSkipGapPriorityScope = (typeof BENCHMARK_SKIP_GAP_PRIORITY_SCOPE)[keyof typeof BENCHMARK_SKIP_GAP_PRIORITY_SCOPE];

export const BENCHMARK_DIAGNOSTIC_GAP_PRIORITY_SCOPE = "unexpected-diagnostic" as const;

export function getBenchmarkGapPriorityRank(scope: BenchmarkGapPriorityScope): number {
  switch (scope) {
    case BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFindingGrowth:
    case BENCHMARK_GAP_PRIORITY_SCOPE.knownSkipGrowth:
      return 0;
    case BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedFinding:
    case BENCHMARK_DIAGNOSTIC_GAP_PRIORITY_SCOPE:
    case BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedSkip:
      return 1;
    case BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFinding:
    case BENCHMARK_GAP_PRIORITY_SCOPE.knownSkip:
      return 2;
  }
}

export function formatBenchmarkGapPriorityScope(scope: BenchmarkGapPriorityScope): string {
  switch (scope) {
    case BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFindingGrowth:
      return "accepted finding growth";
    case BENCHMARK_GAP_PRIORITY_SCOPE.knownSkipGrowth:
      return "known skip growth";
    case BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedFinding:
      return "unexpected finding";
    case BENCHMARK_DIAGNOSTIC_GAP_PRIORITY_SCOPE:
      return "unexpected diagnostic";
    case BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedSkip:
      return "unexpected skip";
    case BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFinding:
      return "accepted finding";
    case BENCHMARK_GAP_PRIORITY_SCOPE.knownSkip:
      return "known skip";
  }
}
