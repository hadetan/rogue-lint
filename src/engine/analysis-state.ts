import type {
  AuditRecord,
  DiagnosticRecord,
  EntityRecord,
  FindingKind,
  FindingRecord,
  SkipCategory,
} from "../types.js";
import type { AnalysisCapabilityId } from "./capabilities/types.js";
import { createCapabilityCandidateRecordId } from "./capabilities/types.js";

/**
 * Mutable accumulators shared across analysis stages during a single run.
 */
export interface AnalysisState {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
  capabilityCandidates: Map<string, CapabilityCandidateRecord>;
}

type CapabilityCandidateFamily = "internal-exported-interface-member" | "returned-contract-member";

type CapabilityCandidateOutcome = "finding" | "kept" | "skipped" | "live";

interface CapabilityCandidateRecord {
  id: string;
  family: CapabilityCandidateFamily;
  capabilityId?: AnalysisCapabilityId;
  entity: EntityRecord;
  outcome?: CapabilityCandidateOutcome;
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
    capabilityCandidates: new Map(),
  };
}

/**
 * Registers a capability candidate that must resolve to an explicit outcome by the end of analysis.
 */
export function registerCapabilityCandidate(
  state: AnalysisState,
  family: CapabilityCandidateFamily,
  entity: EntityRecord,
  capabilityId?: AnalysisCapabilityId,
): void {
  const id = createCapabilityCandidateRecordId(family, entity, capabilityId);
  if (state.capabilityCandidates.has(id)) {
    return;
  }

  state.capabilityCandidates.set(id, {
    id,
    family,
    capabilityId,
    entity,
  });
}

/**
 * Resolves a previously registered capability candidate to an explicit analysis outcome.
 */
export function resolveCapabilityCandidate(
  state: AnalysisState,
  family: CapabilityCandidateFamily,
  entity: EntityRecord,
  outcome: CapabilityCandidateOutcome,
  capabilityId?: AnalysisCapabilityId,
): void {
  const id = createCapabilityCandidateRecordId(family, entity, capabilityId);
  const existing = state.capabilityCandidates.get(id);
  if (!existing) {
    return;
  }

  existing.outcome = outcome;
}

/**
 * Returns registered capability candidates that never resolved to finding, kept, skipped, or live.
 */
export function getCapabilityCandidates(
  state: AnalysisState,
): readonly CapabilityCandidateRecord[] {
  return [...state.capabilityCandidates.values()];
}

function getUnresolvedCapabilityCandidates(
  state: AnalysisState,
): CapabilityCandidateRecord[] {
  return getCapabilityCandidates(state).filter((candidate) => !candidate.outcome);
}

/**
 * Converts unresolved capability-accounting gaps into diagnostics so validation can fail explicitly.
 */
export function appendCapabilityCoverageDiagnostics(state: AnalysisState): void {
  for (const candidate of getUnresolvedCapabilityCandidates(state)) {
    state.diagnostics.push({
      kind: "project-warning",
      file: candidate.entity.location.file,
      message: `capability coverage gap (${candidate.family}): ${candidate.entity.kind} ${candidate.entity.name} never resolved to finding, kept, skipped, or live`,
    });
  }
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
