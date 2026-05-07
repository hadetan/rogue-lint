/**
 * Controls whether analysis preserves only runtime reachability or also the package's public surface.
 */
export type AnalysisMode = "application" | "library";

/**
 * Canonical finding categories emitted by rogue-lint.
 */
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

/**
 * Entity categories used to identify findings, kept audits, and skipped audits.
 */
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

/**
 * Output formats supported by the CLI renderer and API consumers.
 */
export type ReportFormat = "json" | "text";

/**
 * Conservative-boundary categories recorded when exact reasoning has to stop.
 */
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

/**
 * User configuration loaded from CLI flags and `rogue-lint` config files.
 */
export interface RogueLintConfig {
  mode?: AnalysisMode;
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

/**
 * Normalized options consumed by the CLI flow and top-level analysis API.
 */
export interface CliOptions {
  cwd: string;
  format: ReportFormat;
  mode?: AnalysisMode;
  configPath?: string;
  targetPath?: string;
  includeKinds?: FindingKind[];
}

/**
 * One-based source location used in reports and audits.
 */
export interface Location {
  file: string;
  line: number;
  column: number;
}

/**
 * Stable identifier for a file, symbol, member, or structural path segment in the report.
 */
export interface EntityRecord {
  id: string;
  kind: EntityKind;
  name: string;
  owner?: string;
  location: Location;
}

/**
 * A justified analyzer finding with a stable entity identity and suggested action.
 */
export interface FindingRecord {
  id: string;
  kind: FindingKind;
  message: string;
  entity: EntityRecord;
  reason: string;
  suggestion: "remove" | "review";
}

/**
 * A record explaining why a potentially dead entity was intentionally retained or conservatively skipped.
 */
export interface AuditRecord {
  id: string;
  kind: EntityKind;
  name: string;
  reason: string;
  category?: SkipCategory;
  location?: Location;
}

/**
 * Non-finding project diagnostics discovered while loading or traversing the target project.
 */
export interface DiagnosticRecord {
  kind: "project-error" | "project-warning";
  message: string;
  file?: string;
}

/**
 * Aggregated counts for the current analysis run.
 */
interface SummaryRecord {
  filesAnalyzed: number;
  reachableFiles: number;
  findings: number;
  kept: number;
  skipped: number;
  byKind: Partial<Record<FindingKind, number>>;
}

/**
 * Complete machine-readable result returned by the API and rendered by the CLI.
 */
export interface AnalysisResult {
  tool: "rogue-lint";
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
