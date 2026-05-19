import type { DiagnosticRecord, EntityRecord, SkipCategory } from "../../types.js";
import type {
  AnalysisCapabilityAttributionSource,
  AnalysisCapabilityBoundarySource,
  AnalysisCapabilityEvidenceSource,
  AnalysisCapabilityFactFamily,
  AnalysisCapabilityFactOutcome,
  AnalysisCapabilityId,
  AnalysisCapabilityObligationFamily,
  AnalysisCapabilityOutcome,
} from "./vocabulary.js";

export type {
  AnalysisCapabilityAttributionSource,
  AnalysisCapabilityBoundarySource,
  AnalysisCapabilityEvidenceSource,
  AnalysisCapabilityFactFamily,
  AnalysisCapabilityFactOutcome,
  AnalysisCapabilityId,
  AnalysisCapabilityObligationFamily,
  AnalysisCapabilityOutcome,
} from "./vocabulary.js";

export interface AnalysisCapabilityFactRecord {
  id: string;
  family: AnalysisCapabilityFactFamily;
  capabilityId: AnalysisCapabilityId;
  entity: EntityRecord;
  outcome: AnalysisCapabilityFactOutcome;
  category?: SkipCategory;
  reason?: string;
  detailHint?: string;
}

export interface AnalysisCapabilityObligationRecord {
  id: string;
  family: AnalysisCapabilityObligationFamily;
  capabilityId?: AnalysisCapabilityId;
  entity: EntityRecord;
  outcome?: AnalysisCapabilityOutcome;
  detailHint?: string;
}

interface CapabilityEvidenceRecord {
  capabilityId: AnalysisCapabilityId;
  source: AnalysisCapabilityEvidenceSource;
  recordId: string;
  label: string;
}

interface CapabilityBoundaryRecord {
  capabilityId: AnalysisCapabilityId;
  source: AnalysisCapabilityBoundarySource;
  recordId: string;
  label: string;
  category?: SkipCategory;
}

interface CapabilityAttributionRecord {
  capabilityId: AnalysisCapabilityId;
  recordId: string;
  source: AnalysisCapabilityAttributionSource;
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
  source: AnalysisCapabilityEvidenceSource,
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
  source: AnalysisCapabilityBoundarySource,
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
  source: AnalysisCapabilityAttributionSource,
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

export function createCapabilityFactRecordId(
  family: AnalysisCapabilityFactFamily,
  entity: Pick<EntityRecord, "id">,
  capabilityId: AnalysisCapabilityId,
  detailHint?: string,
): string {
  return detailHint === undefined
    ? `${capabilityId}:${family}:${entity.id}`
    : `${capabilityId}:${family}:${entity.id}:${detailHint}`;
}
