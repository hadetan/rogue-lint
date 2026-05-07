export type AnalysisMode = "application" | "library";
export type AnalysisDepth = "surface" | "deep";

export type FindingKind =
  | "unused-file"
  | "unused-export"
  | "unused-local"
  | "unused-type"
  | "unused-enum-member"
  | "unused-class-member"
  | "unused-array-element"
  | "unused-object-key"
  | "unused-nested-path"
  | "unused-interface-member"
  | "use-before-init"
  | "invalidated-read"
  | "stale-read-after-mutation"
  | "dead-store"
  | "unused-value"
  | "write-only-state";

export type EntityKind =
  | "file"
  | "export"
  | "local"
  | "type"
  | "enum-member"
  | "class-member"
  | "array-element"
  | "collection-boundary"
  | "interface-member"
  | "object-key"
  | "nested-path"
  | "assignment"
  | "expression";

export type ReportFormat = "json" | "text";

export type SkipCategory =
  | "decorator-visibility"
  | "computed-member-name"
  | "computed-property-name"
  | "computed-property-access"
  | "dynamic-array-index"
  | "array-at-call"
  | "array-append-mutation"
  | "array-mutation"
  | "array-truncate-mutation"
  | "array-replacement-mutation"
  | "array-reorder-mutation"
  | "array-rebuild-mutation"
  | "array-opaque-mutation"
  | "array-callback-escape"
  | "object-spread"
  | "array-spread"
  | "returned-object"
  | "reflective-enumeration"
  | "serialization"
  | "opaque-object-call"
  | "spread-escape"
  | "object-rest"
  | "array-rest";

interface KeepRules {
  files?: string[];
  symbols?: string[];
  members?: string[];
  entityIds?: string[];
}

export interface DeadLintConfig {
  mode?: AnalysisMode;
  analysisDepth?: AnalysisDepth;
  tsconfig?: string;
  entrypoints?: string[];
  hiddenRoots?: string[];
  include?: string[];
  exclude?: string[];
  includeKinds?: FindingKind[];
  keep?: KeepRules;
  findingsExitCode?: number;
  failureExitCode?: number;
  objectAnalysis?: {
    enabled?: boolean;
    maxPathDepth?: number;
  };
}

export interface CliOptions {
  cwd: string;
  format: ReportFormat;
  mode?: AnalysisMode;
  analysisDepth?: AnalysisDepth;
  configPath?: string;
  targetPath?: string;
  includeKinds?: FindingKind[];
}

export interface Location {
  file: string;
  line: number;
  column: number;
}

export interface EntityRecord {
  id: string;
  kind: EntityKind;
  name: string;
  owner?: string;
  location: Location;
}

export interface FindingRecord {
  id: string;
  kind: FindingKind;
  message: string;
  entity: EntityRecord;
  reason: string;
  suggestion: "remove" | "review";
}

export interface AuditRecord {
  id: string;
  kind: EntityKind;
  name: string;
  reason: string;
  category?: SkipCategory;
  location?: Location;
}

export interface DiagnosticRecord {
  kind: "project-error" | "project-warning";
  message: string;
  file?: string;
}

interface SummaryRecord {
  filesAnalyzed: number;
  reachableFiles: number;
  findings: number;
  kept: number;
  skipped: number;
  byKind: Partial<Record<FindingKind, number>>;
}

export interface AnalysisResult {
  tool: "dead-lint";
  version: string;
  target: string;
  mode: AnalysisMode;
  exitCodes: {
    findings: number;
    failure: number;
  };
  generatedAt: string;
  summary: SummaryRecord;
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
}

export interface ResolvedConfig {
  value: Required<Omit<DeadLintConfig, "keep" | "objectAnalysis">> & {
    keep: Required<KeepRules>;
    objectAnalysis: Required<NonNullable<DeadLintConfig["objectAnalysis"]>>;
  };
}

export interface ModuleEdge {
  from: string;
  to: string;
  specifier: string;
  dynamic: boolean;
}

export interface ModuleGraph {
  outgoing: Map<string, ModuleEdge[]>;
  unresolved: DiagnosticRecord[];
}

export interface SourceCommentDirectives {
  ignoredLines: Set<number>;
  ignoredRanges: Array<{ start: number; end: number }>;
  externalLines: Set<number>;
}

export interface SuppressionContext {
  directives: Map<string, SourceCommentDirectives>;
}

export interface ProjectContext {
  rootPath: string;
  packageJsonPath?: string;
  packageJson: Record<string, unknown> | null;
  config: ResolvedConfig;
  analyzableFiles: Set<string>;
  sourceFiles: import("typescript").SourceFile[];
  program: import("typescript").Program;
  checker: import("typescript").TypeChecker;
  languageService: import("typescript").LanguageService;
  compilerOptions: import("typescript").CompilerOptions;
  fileNames: string[];
}

interface ObjectNode {
  entity: EntityRecord;
  fullPath: PathSegment[];
}

export interface EscapedPathRecord {
  category: SkipCategory;
  reason: string;
}

export interface CollectionBoundaryRecord {
  entity: EntityRecord;
  path: PathSegment[];
  category: SkipCategory;
  reason: string;
}

export type PathSegment =
  | { kind: "property"; value: string }
  | { kind: "index"; value: number };

export interface TrackedCollectionInfo {
  kind: "object" | "array";
  path: PathSegment[];
  childPaths: PathSegment[][];
  arrayLength?: number;
}

export interface TrackedCollectionState {
  path: PathSegment[];
  epoch: number;
  arrayLength?: number;
}

export type TrackedPlaceState = "uninitialized" | "initialized" | "invalidated" | "escaped" | "unknown";

export interface InvalidatedPathRecord {
  reason: string;
  findingKind?: Extract<FindingKind, "invalidated-read" | "stale-read-after-mutation">;
}

export type TrackedObjectStructuralRole = "record" | "state-holder";

export interface TrackedObject {
  id: string;
  canonicalSymbolKey: string;
  rootName: string;
  sourceFile: string;
  rootEntity: EntityRecord;
   structuralRole?: TrackedObjectStructuralRole;
  nodes: Map<string, ObjectNode>;
  descendantNodeKeys: Map<string, string[]>;
  collections: Map<string, TrackedCollectionInfo>;
  collectionStates: Map<string, TrackedCollectionState>;
  collectionBoundaries: Map<string, CollectionBoundaryRecord>;
  invalidatedCollectionPaths: Set<string>;
  invalidatedPaths: Map<string, InvalidatedPathRecord>;
  placeStates: Map<string, TrackedPlaceState>;
  observedSubtrees: Set<string>;
  escapedPaths: Map<string, EscapedPathRecord>;
  exactPathAliases: Map<string, {
    fate: "inserted-by-reference";
    sourceObjectId: string;
    sourcePath: PathSegment[];
    observed: boolean;
  }>;
  valueFates: Array<{
    fate:
      | "observed"
      | "inserted-by-reference"
      | "shallow-cloned"
      | "deep-cloned"
      | "resource-transferred"
      | "escaped-opaquely"
      | "overwritten"
      | "invalidated";
    path: PathSegment[];
    reason: string;
    relatedObjectId?: string;
    relatedPath?: PathSegment[];
  }>;
  reads: Set<string>;
  writes: Set<string>;
}
