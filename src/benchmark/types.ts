import type {
  AnalysisMode,
  AnalysisResult,
  AuditRecord,
  DiagnosticRecord,
  EntityKind,
  FindingKind,
  FindingRecord,
  RogueLintConfig,
  SkipCategory,
} from "../types.js";

interface BenchmarkRepositoryRef {
  url: string;
  ref: string;
}

type BenchmarkCoverageClass =
  | "application-entrypoint-driven"
  | "library-public-surface"
  | "workspace-monorepo-subproject";

interface BenchmarkCountMatcherFields {
  minCount?: number;
  maxCount?: number;
}

export interface BenchmarkFindingMatcher extends BenchmarkCountMatcherFields {
  label: string;
  id?: string;
  kind?: FindingKind;
  entityKind?: EntityKind;
  file?: string;
  name?: string;
  owner?: string;
  reasonIncludes?: string;
  messageIncludes?: string;
}

export interface BenchmarkSkipMatcher extends BenchmarkCountMatcherFields {
  label: string;
  id?: string;
  kind?: EntityKind;
  file?: string;
  name?: string;
  category?: SkipCategory;
  reasonIncludes?: string;
}

export interface BenchmarkDiagnosticMatcher extends BenchmarkCountMatcherFields {
  label: string;
  kind?: DiagnosticRecord["kind"];
  fileIncludes?: string;
  messageIncludes?: string;
}

export type BenchmarkTargetConfig = Pick<
  RogueLintConfig,
  "entrypoints" | "exclude" | "hiddenRoots" | "include" | "mode" | "objectAnalysis"
>;

export interface BenchmarkExpectations {
  mustFind: BenchmarkFindingMatcher[];
  mustNotFind: BenchmarkFindingMatcher[];
  mustSkip: BenchmarkSkipMatcher[];
  mustDiagnose: BenchmarkDiagnosticMatcher[];
  mustNotDiagnose: BenchmarkDiagnosticMatcher[];
  acceptedFindings: BenchmarkFindingMatcher[];
  knownSkips: BenchmarkSkipMatcher[];
}

export interface BenchmarkTargetManifest {
  id: string;
  description: string;
  coverageClass: BenchmarkCoverageClass;
  repository: BenchmarkRepositoryRef;
  localCorpusPath: string;
  targetPath?: string;
  config: BenchmarkTargetConfig;
  expectations: BenchmarkExpectations;
}

export interface MatcherRecords<Matcher, Record> {
  matcher: Matcher;
  records: Record[];
}

export interface CountedMatcherRecords<Matcher, Record> extends MatcherRecords<Matcher, Record> {
  actualCount: number;
}

export interface ExpectationCountViolation<Matcher, Record> extends CountedMatcherRecords<Matcher, Record> {
  minCount?: number;
  maxCount?: number;
}

export interface PositiveExpectationResult<Matcher, Record> {
  total: number;
  matched: CountedMatcherRecords<Matcher, Record>[];
  missing: Matcher[];
  overLimit: ExpectationCountViolation<Matcher, Record>[];
}

export interface NegativeExpectationResult<Matcher, Record> {
  total: number;
  clean: Matcher[];
  violations: ExpectationCountViolation<Matcher, Record>[];
}

export interface AcceptedDebtResult<Matcher, Record> {
  total: number;
  present: CountedMatcherRecords<Matcher, Record>[];
  reduced: CountedMatcherRecords<Matcher, Record>[];
  resolved: Matcher[];
  regressions: ExpectationCountViolation<Matcher, Record>[];
}

export type BenchmarkGapPriorityScope =
  | "accepted-finding"
  | "accepted-finding-growth"
  | "known-skip"
  | "known-skip-growth"
  | "unexpected-finding"
  | "unexpected-skip";

export interface BenchmarkGapPriorityEntry {
  scope: BenchmarkGapPriorityScope;
  label: string;
  count: number;
}

export interface BenchmarkEvaluation {
  contract: {
    requiredAnchorTotal: number;
    incomplete: boolean;
  };
  required: {
    mustFind: PositiveExpectationResult<BenchmarkFindingMatcher, FindingRecord>;
    mustNotFind: NegativeExpectationResult<BenchmarkFindingMatcher, FindingRecord>;
    mustSkip: PositiveExpectationResult<BenchmarkSkipMatcher, AuditRecord>;
    mustDiagnose: PositiveExpectationResult<BenchmarkDiagnosticMatcher, DiagnosticRecord>;
    mustNotDiagnose: NegativeExpectationResult<BenchmarkDiagnosticMatcher, DiagnosticRecord>;
  };
  accepted: {
    findings: AcceptedDebtResult<BenchmarkFindingMatcher, FindingRecord>;
    skips: AcceptedDebtResult<BenchmarkSkipMatcher, AuditRecord>;
  };
  unexpected: {
    findings: FindingRecord[];
    skips: AuditRecord[];
    diagnostics: DiagnosticRecord[];
  };
  gapSignal: {
    findingsByKind: Array<[FindingKind, number]>;
    skipsByCategory: Array<[SkipCategory, number]>;
  };
  gapPriority: BenchmarkGapPriorityEntry[];
  failed: boolean;
}

interface MissingCorpusBenchmarkTarget {
  state: "missing-corpus";
  manifest: BenchmarkTargetManifest;
  corpusPath: string;
}

interface InvalidBenchmarkTarget {
  state: "invalid-target";
  manifest: BenchmarkTargetManifest;
  corpusPath: string;
  targetPath: string;
  problem: string;
  error?: string;
}

export interface AnalyzedBenchmarkTarget {
  state: "analyzed";
  manifest: BenchmarkTargetManifest;
  corpusPath: string;
  targetPath: string;
  result: AnalysisResult;
  evaluation: BenchmarkEvaluation;
  exitCode: 0 | 1;
}

export type BenchmarkTargetRun =
  | MissingCorpusBenchmarkTarget
  | InvalidBenchmarkTarget
  | AnalyzedBenchmarkTarget;

export interface BenchmarkWorkspaceRun {
  docsPath: string;
  exitCode: 0 | 1;
  manifests: BenchmarkTargetManifest[];
  noCorpusInstalled: boolean;
  targets: BenchmarkTargetRun[];
}

export const BENCHMARK_DOC_PATH = "benchmark/README.md";

export const EMPTY_BENCHMARK_CONFIG: BenchmarkTargetConfig = {};

export function isAnalysisMode(value: unknown): value is AnalysisMode {
  return value === "application" || value === "library";
}

export function isBenchmarkCoverageClass(value: unknown): value is BenchmarkCoverageClass {
  return (
    value === "application-entrypoint-driven"
    || value === "library-public-surface"
    || value === "workspace-monorepo-subproject"
  );
}
