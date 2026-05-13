import type { DiagnosticRecord, EntityRecord, SkipCategory } from "../../types.js";

export type AnalysisCapabilityId =
  | "finite-keyed-access"
  | "returned-structure-transport"
  | "helper-transport"
  | "library-public-surface-aliasing";

export type AnalysisCapabilityObligationFamily =
  | "internal-exported-interface-member"
  | "returned-contract-member";

export type AnalysisCapabilityOutcome = "finding" | "kept" | "skipped" | "live" | "boundary";

export interface AnalysisCapabilityObligationRecord {
  id: string;
  family: AnalysisCapabilityObligationFamily;
  capabilityId?: AnalysisCapabilityId;
  entity: EntityRecord;
  outcome?: AnalysisCapabilityOutcome;
  detailHint?: string;
}

type CapabilityEvidenceSource = "finding" | "kept" | "skipped" | "diagnostic" | "obligation";

type CapabilityBoundarySource = "skipped" | "diagnostic" | "obligation" | "boundary";

type CapabilityAttributionSource = "finding" | "kept" | "skipped";

interface CapabilityEvidenceRecord {
  capabilityId: AnalysisCapabilityId;
  source: CapabilityEvidenceSource;
  recordId: string;
  label: string;
}

interface CapabilityBoundaryRecord {
  capabilityId: AnalysisCapabilityId;
  source: CapabilityBoundarySource;
  recordId: string;
  label: string;
  category?: SkipCategory;
}

interface CapabilityAttributionRecord {
  capabilityId: AnalysisCapabilityId;
  recordId: string;
  source: CapabilityAttributionSource;
}

export interface AnalysisCapabilityLedger {
  obligations: AnalysisCapabilityObligationRecord[];
  attributions: CapabilityAttributionRecord[];
  boundaries: CapabilityBoundaryRecord[];
  evidences: CapabilityEvidenceRecord[];
  recordCapabilityById: ReadonlyMap<string, AnalysisCapabilityId>;
  recordDetailById: ReadonlyMap<string, string>;
}

export function createCapabilityEvidenceRecord(
  capabilityId: AnalysisCapabilityId,
  source: CapabilityEvidenceSource,
  recordId: string,
  label: string,
): CapabilityEvidenceRecord {
  return {
    capabilityId,
    source,
    recordId,
    label,
  };
}

export function createCapabilityBoundaryRecord(
  capabilityId: AnalysisCapabilityId,
  source: CapabilityBoundarySource,
  recordId: string,
  label: string,
  category?: SkipCategory,
): CapabilityBoundaryRecord {
  return {
    capabilityId,
    source,
    recordId,
    label,
    category,
  };
}

export function createCapabilityAttributionRecord(
  capabilityId: AnalysisCapabilityId,
  source: CapabilityAttributionSource,
  recordId: string,
): CapabilityAttributionRecord {
  return {
    capabilityId,
    recordId,
    source,
  };
}

export function createEmptyAnalysisCapabilityLedger(): AnalysisCapabilityLedger {
  return {
    obligations: [],
    attributions: [],
    boundaries: [],
    evidences: [],
    recordCapabilityById: new Map<string, AnalysisCapabilityId>(),
    recordDetailById: new Map<string, string>(),
  };
}

export function createDiagnosticCapabilityRecordId(diagnostic: DiagnosticRecord): string {
  return `${diagnostic.kind}:${diagnostic.file ?? ""}:${diagnostic.message}`;
}

export function createCapabilityObligationGapMessage(
  obligation: Pick<AnalysisCapabilityObligationRecord, "family" | "entity">,
): string {
  return `capability coverage gap (${obligation.family}): ${obligation.entity.kind} ${obligation.entity.name} never resolved to finding, kept, skipped, or live`;
}

export function createProviderObligationRecordId(
  family: AnalysisCapabilityObligationFamily,
  entity: Pick<EntityRecord, "id">,
  capabilityId?: AnalysisCapabilityId,
): string {
  return capabilityId === undefined ? `${family}:${entity.id}` : `${capabilityId}:${family}:${entity.id}`;
}
