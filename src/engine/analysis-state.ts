import type {
  AuditRecord,
  DiagnosticRecord,
  EntityRecord,
  FindingKind,
  FindingRecord,
  SkipCategory,
} from "../types.js";

/**
 * Mutable accumulators shared across analysis stages during a single run.
 */
export interface AnalysisState {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
}

/**
 * Creates a fresh analysis-state container for a single orchestration pass.
 */
export function createAnalysisState(): AnalysisState {
  return {
    findings: [],
    kept: [],
    skipped: [],
    diagnostics: [],
  };
}

/**
 * Records a new finding with the stable entity id as its result id.
 */
export function addFinding(
  state: AnalysisState,
  entity: EntityRecord,
  kind: FindingKind,
  reason: string,
  message: string,
  suggestion: FindingRecord["suggestion"] = "remove",
): void {
  state.findings.push({
    id: entity.id,
    kind,
    entity,
    reason,
    message,
    suggestion,
  });
}

/**
 * Adds an audit record when one exists and reports whether the caller should stop further processing.
 */
export function addAudit(target: AuditRecord[], record: AuditRecord | undefined): boolean {
  if (!record) {
    return false;
  }

  target.push(record);
  return true;
}

/**
 * Records a conservative skip for an entity when exact analysis cannot continue truthfully.
 */
export function addSkipped(
  state: AnalysisState,
  entity: EntityRecord,
  category: SkipCategory,
  reason: string,
): void {
  state.skipped.push({
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    reason,
    category,
    location: entity.location,
  });
}
