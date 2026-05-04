export type AnalysisMode = "application" | "library";

export type FindingKind =
  | "unused-file"
  | "unused-export"
  | "unused-local"
  | "unused-type"
  | "unused-enum-member"
  | "unused-class-member"
  | "unused-object-key"
  | "unused-nested-path";

export type EntityKind =
  | "file"
  | "export"
  | "local"
  | "type"
  | "enum-member"
  | "class-member"
  | "interface-member"
  | "object-key"
  | "nested-path";

export type ReportFormat = "json" | "text";

export interface KeepRules {
  files?: string[];
  symbols?: string[];
  members?: string[];
  entityIds?: string[];
}

export interface DeadLintConfig {
  mode?: AnalysisMode;
  tsconfig?: string;
  entrypoints?: string[];
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
  location?: Location;
}

export interface DiagnosticRecord {
  kind: "project-error" | "project-warning";
  message: string;
  file?: string;
}

export interface SummaryRecord {
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
  generatedAt: string;
  summary: SummaryRecord;
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
}

export interface ResolvedConfig {
  path?: string;
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
  edges: ModuleEdge[];
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
  sourceFiles: import("typescript").SourceFile[];
  program: import("typescript").Program;
  checker: import("typescript").TypeChecker;
  languageService: import("typescript").LanguageService;
  compilerOptions: import("typescript").CompilerOptions;
  fileNames: string[];
}

export interface ObjectNode {
  entity: EntityRecord;
  fullPath: string[];
}

export interface TrackedObject {
  id: string;
  rootName: string;
  sourceFile: string;
  rootEntity: EntityRecord;
  nodes: Map<string, ObjectNode>;
  escaped: boolean;
  escapeReason?: string;
  reads: Set<string>;
  writes: Set<string>;
}
