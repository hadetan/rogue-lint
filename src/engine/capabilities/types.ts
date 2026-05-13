import type { DiagnosticRecord, EntityRecord, SkipCategory } from "../../types.js";

export type AnalysisCapabilityId =
  | "finite-keyed-access"
  | "returned-structure-transport"
  | "helper-transport"
  | "library-public-surface-aliasing";

type CapabilityRecordSource = "finding" | "kept" | "skipped" | "diagnostic" | "candidate";

interface CapabilityEvidenceRecord {
  capabilityId: AnalysisCapabilityId;
  source: CapabilityRecordSource;
  recordId: string;
  label: string;
}

interface CapabilityBoundaryRecord {
  capabilityId: AnalysisCapabilityId;
  source: Extract<CapabilityRecordSource, "skipped" | "diagnostic" | "candidate">;
  recordId: string;
  label: string;
  category?: SkipCategory;
}

interface CapabilityAttributionRecord {
  capabilityId: AnalysisCapabilityId;
  recordId: string;
  source: Exclude<CapabilityRecordSource, "candidate">;
}

export interface AnalysisCapabilityLedger {
  attributions: CapabilityAttributionRecord[];
  boundaries: CapabilityBoundaryRecord[];
  evidences: CapabilityEvidenceRecord[];
  recordCapabilityById: ReadonlyMap<string, AnalysisCapabilityId>;
}

export function createCapabilityEvidenceRecord(
  capabilityId: AnalysisCapabilityId,
  source: CapabilityRecordSource,
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
  source: Extract<CapabilityRecordSource, "skipped" | "diagnostic" | "candidate">,
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
  source: Exclude<CapabilityRecordSource, "candidate">,
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
    attributions: [],
    boundaries: [],
    evidences: [],
    recordCapabilityById: new Map<string, AnalysisCapabilityId>(),
  };
}

export function createDiagnosticCapabilityRecordId(diagnostic: DiagnosticRecord): string {
  return `${diagnostic.kind}:${diagnostic.file ?? ""}:${diagnostic.message}`;
}

export function createCapabilityCandidateRecordId(
  family: string,
  entity: Pick<EntityRecord, "id">,
  capabilityId?: AnalysisCapabilityId,
): string {
  return capabilityId === undefined ? `${family}:${entity.id}` : `${capabilityId}:${family}:${entity.id}`;
}
