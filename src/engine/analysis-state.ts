import type {
  AuditRecord,
  DiagnosticRecord,
  EntityRecord,
  FindingKind,
  FindingRecord,
  SkipCategory,
} from "../types.js";
import type {
  AnalysisCapabilityFactFamily,
  AnalysisCapabilityFactOutcome,
  AnalysisCapabilityFactRecord,
  AnalysisCapabilityId,
  AnalysisCapabilityObligationFamily,
  AnalysisCapabilityObligationRecord,
  AnalysisCapabilityOutcome,
} from "./capabilities/types.js";
import {
  createCapabilityFactRecordId,
  createCapabilityObligationGapMessage,
  createProviderObligationRecordId,
} from "./capabilities/types.js";

/**
 * Mutable accumulators shared across analysis stages during a single run.
 */
export interface AnalysisState {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
  capabilityObligations: Map<string, AnalysisCapabilityObligationRecord>;
}

const capabilityFactsByState = new WeakMap<AnalysisState, Map<string, AnalysisCapabilityFactRecord>>();

/**
 * Creates a fresh analysis-state container for a single orchestration pass.
 */
export function createAnalysisState(): AnalysisState {
  const state: AnalysisState = {
    findings: [],
    kept: [],
    skipped: [],
    diagnostics: [],
    capabilityObligations: new Map(),
  };

  capabilityFactsByState.set(state, new Map());
  return state;
}

/**
 * Registers a provider-facing capability fact emitted by analyzer or tracking code.
 */
export function registerCapabilityFact(
  state: AnalysisState,
  family: AnalysisCapabilityFactFamily,
  entity: EntityRecord,
  capabilityId: AnalysisCapabilityId,
  outcome: AnalysisCapabilityFactOutcome,
  options: {
    category?: SkipCategory;
    reason?: string;
    detailHint?: string;
  } = {},
): void {
  const id = createCapabilityFactRecordId(family, entity, capabilityId, options.detailHint);
  const facts = capabilityFactsByState.get(state);
  if (!facts || facts.has(id)) {
    return;
  }

  facts.set(id, {
    id,
    family,
    capabilityId,
    entity,
    outcome,
    category: options.category,
    reason: options.reason,
    detailHint: options.detailHint,
  });
}

/**
 * Returns provider-facing capability facts emitted during analysis.
 */
export function getCapabilityFacts(
  state: AnalysisState,
): readonly AnalysisCapabilityFactRecord[] {
  const facts = capabilityFactsByState.get(state);
  if (!facts) {
    return [];
  }

  return [...facts.values()];
}

/**
 * Registers a provider-owned capability obligation that must resolve to an explicit outcome by the end of analysis.
 */
export function registerCapabilityObligation(
  state: AnalysisState,
  family: AnalysisCapabilityObligationFamily,
  entity: EntityRecord,
  capabilityId?: AnalysisCapabilityId,
  detailHint?: string,
): void {
  const id = createProviderObligationRecordId(family, entity, capabilityId);
  if (state.capabilityObligations.has(id)) {
    return;
  }

  state.capabilityObligations.set(id, {
    id,
    family,
    capabilityId,
    entity,
    detailHint,
  });
}

/**
 * Resolves a previously registered provider-owned obligation to an explicit analysis outcome.
 */
export function resolveCapabilityObligation(
  state: AnalysisState,
  family: AnalysisCapabilityObligationFamily,
  entity: EntityRecord,
  outcome: AnalysisCapabilityOutcome,
  capabilityId?: AnalysisCapabilityId,
): void {
  const id = createProviderObligationRecordId(family, entity, capabilityId);
  const existing = state.capabilityObligations.get(id);
  if (!existing) {
    return;
  }

  existing.outcome = outcome;
}

/**
 * Returns registered provider-owned capability obligations.
 */
export function getCapabilityObligations(
  state: AnalysisState,
): readonly AnalysisCapabilityObligationRecord[] {
  return [...state.capabilityObligations.values()];
}

function getUnresolvedCapabilityObligations(
  state: AnalysisState,
): AnalysisCapabilityObligationRecord[] {
  return getCapabilityObligations(state).filter((obligation) => !obligation.outcome);
}

/**
 * Converts unresolved provider-owned obligations into diagnostics so validation can fail explicitly.
 */
export function appendProviderObligationDiagnostics(state: AnalysisState): void {
  for (const obligation of getUnresolvedCapabilityObligations(state)) {
    state.diagnostics.push({
      kind: "project-warning",
      file: obligation.entity.location.file,
      message: createCapabilityObligationGapMessage(obligation),
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
    owner: entity.owner,
    reason,
    category,
    location: entity.location,
  });
}
