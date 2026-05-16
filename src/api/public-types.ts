import { ENTITY_KIND } from "../shared/entity-vocabulary.js";
import { FINDING_KIND } from "../shared/finding-vocabulary.js";
import { SKIP_CATEGORY } from "../shared/skip-category-vocabulary.js";

/**
 * Controls whether analysis preserves only runtime reachability or also the package's public surface.
 */
export type AnalysisMode = "application" | "library";

/**
 * Canonical finding categories emitted by rogue-lint.
 */
export type FindingKind = (typeof FINDING_KIND)[keyof typeof FINDING_KIND];

/**
 * Entity categories used to identify findings, kept audits, and skipped audits.
 */
export type EntityKind = (typeof ENTITY_KIND)[keyof typeof ENTITY_KIND];

/**
 * Output formats supported by the CLI renderer and API consumers.
 */
export type ReportFormat = "json" | "text";

/**
 * Conservative-boundary categories recorded when exact reasoning has to stop.
 */
export type SkipCategory = (typeof SKIP_CATEGORY)[keyof typeof SKIP_CATEGORY];

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
 * Engine-facing analysis options consumed by the top-level analysis API.
 */
export interface AnalysisOptions {
  cwd: string;
  mode?: AnalysisMode;
  configPath?: string;
  targetPath?: string;
  includeKinds?: FindingKind[];
}

/**
 * Normalized CLI options consumed by the shell-facing entrypoint.
 */
export interface CliOptions extends AnalysisOptions {
  format: ReportFormat;
  showKept?: boolean;
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
  owner?: string;
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
 * Complete machine-readable result returned by the API and consumed by CLI renderers.
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
