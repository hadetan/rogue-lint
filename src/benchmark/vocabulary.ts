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
  unexpectedDiagnostic: "unexpected-diagnostic",
  unexpectedSkip: "unexpected-skip",
} as const;

export type BenchmarkGapPriorityScope = (typeof BENCHMARK_GAP_PRIORITY_SCOPE)[keyof typeof BENCHMARK_GAP_PRIORITY_SCOPE];

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

export const BENCHMARK_DIAGNOSTIC_GAP_PRIORITY_SCOPE = BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedDiagnostic;

const BENCHMARK_GAP_PRIORITY_SCOPE_DETAILS = [
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFindingGrowth,
    rank: 0,
    label: "accepted finding growth",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.knownSkipGrowth,
    rank: 0,
    label: "known skip growth",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedFinding,
    rank: 1,
    label: "unexpected finding",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedDiagnostic,
    rank: 1,
    label: "unexpected diagnostic",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.unexpectedSkip,
    rank: 1,
    label: "unexpected skip",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.acceptedFinding,
    rank: 2,
    label: "accepted finding",
  },
  {
    scope: BENCHMARK_GAP_PRIORITY_SCOPE.knownSkip,
    rank: 2,
    label: "known skip",
  },
] as const satisfies ReadonlyArray<{
  scope: BenchmarkGapPriorityScope;
  rank: number;
  label: string;
}>;

function getBenchmarkGapPriorityScopeDetail(scope: BenchmarkGapPriorityScope): (typeof BENCHMARK_GAP_PRIORITY_SCOPE_DETAILS)[number] {
  const detail = BENCHMARK_GAP_PRIORITY_SCOPE_DETAILS.find((candidate) => candidate.scope === scope);
  if (!detail) {
    throw new Error(`Unknown benchmark gap priority scope: ${scope}`);
  }

  return detail;
}

export function getBenchmarkGapPriorityRank(scope: BenchmarkGapPriorityScope): number {
  return getBenchmarkGapPriorityScopeDetail(scope).rank;
}

export function formatBenchmarkGapPriorityScope(scope: BenchmarkGapPriorityScope): string {
  return getBenchmarkGapPriorityScopeDetail(scope).label;
}
