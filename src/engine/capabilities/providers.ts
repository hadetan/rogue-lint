import type { AnalysisResult } from "../../types.js";
import type { ProjectContext } from "../../types.js";
import { SKIP_CATEGORY } from "../../shared/skip-category-vocabulary.js";

import {
  attachAnalysisRunResultMetadata,
  getAnalysisRunResultMetadata,
} from "../analysis-run-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import {
  getCapabilityFacts,
  getCapabilityObligations,
  type AnalysisState,
} from "../analysis-state.js";
import {
  createAnalysisCapabilitySummaryRegistry,
  getCapabilityBoundaryDetailLabel,
  getCapabilityFallbackBoundaryLabel,
  getCapabilityFactDetailLabel,
  getCapabilityObligationDetailLabel,
} from "./summary-models.js";
import {
  ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE,
  ANALYSIS_CAPABILITY_BOUNDARY_SOURCE,
  ANALYSIS_CAPABILITY_EVIDENCE_SOURCE,
  ANALYSIS_CAPABILITY_FACT_OUTCOME,
  ANALYSIS_CAPABILITY_ID,
  ANALYSIS_CAPABILITY_OUTCOME,
} from "./vocabulary.js";
import {
  createCapabilityObligationGapMessage,
  createCapabilityAttributionRecord,
  createCapabilityBoundaryRecord,
  createCapabilityEvidenceRecord,
  createDiagnosticCapabilityRecordId,
  createEmptyAnalysisCapabilityLedger,
  type AnalysisCapabilityId,
  type AnalysisCapabilityLedger,
  type AnalysisCapabilityObligationRecord,
} from "./types.js";

export function attachAnalysisCapabilityLedger(
  result: AnalysisResult,
  capabilityLedger: AnalysisCapabilityLedger,
): void {
  attachAnalysisRunResultMetadata(result, { capabilityLedger });
}

void attachAnalysisCapabilityLedger;

function createRecordCapabilityIndex(
  attributions: ReadonlyArray<AnalysisCapabilityLedger["attributions"][number]>,
  boundaries: ReadonlyArray<AnalysisCapabilityLedger["boundaries"][number]> = [],
): ReadonlyMap<string, AnalysisCapabilityId> {
  const recordCapabilityById = new Map<string, AnalysisCapabilityId>();
  for (const attribution of attributions) {
    if (!recordCapabilityById.has(attribution.recordId)) {
      recordCapabilityById.set(attribution.recordId, attribution.capabilityId);
    }
  }

  for (const boundary of boundaries) {
    if (
      (boundary.source === "obligation" || boundary.source === "diagnostic" || boundary.source === "fact")
      && !recordCapabilityById.has(boundary.recordId)
    ) {
      recordCapabilityById.set(boundary.recordId, boundary.capabilityId);
    }
  }

  return recordCapabilityById;
}

function createRecordDetailIndex(
  evidences: ReadonlyArray<AnalysisCapabilityLedger["evidences"][number]>,
  boundaries: ReadonlyArray<AnalysisCapabilityLedger["boundaries"][number]> = [],
): ReadonlyMap<string, string> {
  const recordDetailById = new Map<string, string>();

  for (const boundary of boundaries) {
    recordDetailById.set(boundary.recordId, boundary.label);
  }

  for (const evidence of evidences) {
    if (evidence.source === "obligation") {
      continue;
    }

    recordDetailById.set(evidence.recordId, evidence.label);
  }

  return recordDetailById;
}

function createUnresolvedObligationDiagnosticId(
  obligation: AnalysisCapabilityObligationRecord,
): string {
  return createDiagnosticCapabilityRecordId({
    kind: "project-warning",
    file: obligation.entity.location.file,
    message: createCapabilityObligationGapMessage(obligation),
  });
}

export function collectAnalysisCapabilityLedger(
  project: ProjectContext,
  state: AnalysisState,
  artifacts: AnalysisArtifacts,
): AnalysisCapabilityLedger {
  const facts = getCapabilityFacts(state);
  const obligations = getCapabilityObligations(state);
  const summaryRegistry = createAnalysisCapabilitySummaryRegistry(project, artifacts);
  const findings = state.findings;
  const kept = state.kept;
  const skipped = state.skipped;
  const findingsById = new Map(findings.map((record) => [record.id, record]));
  const keptById = new Map(kept.map((record) => [record.id, record]));
  const skippedById = new Map(skipped.map((record) => [record.id, record]));
  const merged = createEmptyAnalysisCapabilityLedger();
  const obligationIds = new Set<string>();
  const attributionIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const capabilityId of [
    ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
    ANALYSIS_CAPABILITY_ID.returnedStructureTransport,
  ] as const) {
    for (const obligation of obligations) {
      if (obligation.capabilityId !== capabilityId) {
        continue;
      }

      if (!obligationIds.has(obligation.id)) {
        obligationIds.add(obligation.id);
        merged.obligations.push(obligation);
      }

      const obligationEvidence = createCapabilityEvidenceRecord(
        capabilityId,
        ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.obligation,
        obligation.id,
        obligation.family,
      );
      const obligationEvidenceKey = `${obligationEvidence.capabilityId}:${obligationEvidence.source}:${obligationEvidence.recordId}:${obligationEvidence.label}`;
      if (!evidenceIds.has(obligationEvidenceKey)) {
        evidenceIds.add(obligationEvidenceKey);
        merged.evidences.push(obligationEvidence);
      }

      const detailLabel = getCapabilityObligationDetailLabel(
        summaryRegistry,
        capabilityId,
        obligation,
      );

      switch (obligation.outcome) {
        case ANALYSIS_CAPABILITY_OUTCOME.finding: {
          const finding = findingsById.get(obligation.entity.id);
          if (!finding) {
            break;
          }

          const attribution = createCapabilityAttributionRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.finding,
            finding.id,
          );
          const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
          if (!attributionIds.has(attributionKey)) {
            attributionIds.add(attributionKey);
            merged.attributions.push(attribution);
          }

          const findingEvidence = createCapabilityEvidenceRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.finding,
            finding.id,
            finding.kind,
          );
          const findingEvidenceKey = `${findingEvidence.capabilityId}:${findingEvidence.source}:${findingEvidence.recordId}:${findingEvidence.label}`;
          if (!evidenceIds.has(findingEvidenceKey)) {
            evidenceIds.add(findingEvidenceKey);
            merged.evidences.push(findingEvidence);
          }

          if (detailLabel && detailLabel !== finding.kind) {
            const detailEvidence = createCapabilityEvidenceRecord(
              capabilityId,
              ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.finding,
              finding.id,
              detailLabel,
            );
            const detailEvidenceKey = `${detailEvidence.capabilityId}:${detailEvidence.source}:${detailEvidence.recordId}:${detailEvidence.label}`;
            if (!evidenceIds.has(detailEvidenceKey)) {
              evidenceIds.add(detailEvidenceKey);
              merged.evidences.push(detailEvidence);
            }
          }
          break;
        }
        case ANALYSIS_CAPABILITY_OUTCOME.kept: {
          const keptRecord = keptById.get(obligation.entity.id);
          if (!keptRecord) {
            break;
          }

          const attribution = createCapabilityAttributionRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.kept,
            keptRecord.id,
          );
          const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
          if (!attributionIds.has(attributionKey)) {
            attributionIds.add(attributionKey);
            merged.attributions.push(attribution);
          }

          const keptEvidence = createCapabilityEvidenceRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.kept,
            keptRecord.id,
            keptRecord.kind,
          );
          const keptEvidenceKey = `${keptEvidence.capabilityId}:${keptEvidence.source}:${keptEvidence.recordId}:${keptEvidence.label}`;
          if (!evidenceIds.has(keptEvidenceKey)) {
            evidenceIds.add(keptEvidenceKey);
            merged.evidences.push(keptEvidence);
          }

          if (detailLabel && detailLabel !== keptRecord.kind) {
            const detailEvidence = createCapabilityEvidenceRecord(
              capabilityId,
              ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.kept,
              keptRecord.id,
              detailLabel,
            );
            const detailEvidenceKey = `${detailEvidence.capabilityId}:${detailEvidence.source}:${detailEvidence.recordId}:${detailEvidence.label}`;
            if (!evidenceIds.has(detailEvidenceKey)) {
              evidenceIds.add(detailEvidenceKey);
              merged.evidences.push(detailEvidence);
            }
          }
          break;
        }
        case ANALYSIS_CAPABILITY_OUTCOME.skipped: {
          const skippedRecord = skippedById.get(obligation.entity.id);
          if (!skippedRecord) {
            break;
          }

          const attribution = createCapabilityAttributionRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.skipped,
            skippedRecord.id,
          );
          const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
          if (!attributionIds.has(attributionKey)) {
            attributionIds.add(attributionKey);
            merged.attributions.push(attribution);
          }

          const skippedEvidence = createCapabilityEvidenceRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
            skippedRecord.id,
            skippedRecord.category ?? skippedRecord.kind,
          );
          const skippedEvidenceKey = `${skippedEvidence.capabilityId}:${skippedEvidence.source}:${skippedEvidence.recordId}:${skippedEvidence.label}`;
          if (!evidenceIds.has(skippedEvidenceKey)) {
            evidenceIds.add(skippedEvidenceKey);
            merged.evidences.push(skippedEvidence);
          }

          const skippedDetailLabel = detailLabel ?? getCapabilityFallbackBoundaryLabel(capabilityId);
          if (skippedDetailLabel !== skippedRecord.category && skippedDetailLabel !== skippedRecord.kind) {
            const detailEvidence = createCapabilityEvidenceRecord(
              capabilityId,
              ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
              skippedRecord.id,
              skippedDetailLabel,
            );
            const detailEvidenceKey = `${detailEvidence.capabilityId}:${detailEvidence.source}:${detailEvidence.recordId}:${detailEvidence.label}`;
            if (!evidenceIds.has(detailEvidenceKey)) {
              evidenceIds.add(detailEvidenceKey);
              merged.evidences.push(detailEvidence);
            }
          }

          const boundary = createCapabilityBoundaryRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.skipped,
            skippedRecord.id,
            skippedRecord.reason,
            skippedRecord.category,
          );
          const boundaryKey = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
          if (!boundaryIds.has(boundaryKey)) {
            boundaryIds.add(boundaryKey);
            merged.boundaries.push(boundary);
          }
          break;
        }
        case ANALYSIS_CAPABILITY_OUTCOME.boundary: {
          const boundary = createCapabilityBoundaryRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.boundary,
            obligation.id,
            obligation.family,
          );
          const boundaryKey = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
          if (!boundaryIds.has(boundaryKey)) {
            boundaryIds.add(boundaryKey);
            merged.boundaries.push(boundary);
          }
          break;
        }
        case undefined: {
          const unresolvedLabel = detailLabel ?? getCapabilityFallbackBoundaryLabel(capabilityId);
          const boundary = createCapabilityBoundaryRecord(
            capabilityId,
            ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.obligation,
            createUnresolvedObligationDiagnosticId(obligation),
            unresolvedLabel,
          );
          const boundaryKey = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
          if (!boundaryIds.has(boundaryKey)) {
            boundaryIds.add(boundaryKey);
            merged.boundaries.push(boundary);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  for (const skippedRecord of skipped) {
    let capabilityId: AnalysisCapabilityId | undefined;
    if (
      skippedRecord.category === SKIP_CATEGORY.arrayCallbackEscape
      || skippedRecord.category === SKIP_CATEGORY.arrayOpaqueMutation
      || skippedRecord.category === SKIP_CATEGORY.opaqueObjectCall
    ) {
      capabilityId = ANALYSIS_CAPABILITY_ID.helperTransport;
    } else if (
      skippedRecord.category === SKIP_CATEGORY.arrayAtCall
      || skippedRecord.category === SKIP_CATEGORY.computedPropertyAccess
      || skippedRecord.category === SKIP_CATEGORY.dynamicArrayIndex
    ) {
      capabilityId = ANALYSIS_CAPABILITY_ID.finiteKeyedAccess;
    }

    if (!capabilityId) {
      continue;
    }

    const attribution = createCapabilityAttributionRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.skipped,
      skippedRecord.id,
    );
    const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
    if (!attributionIds.has(attributionKey)) {
      attributionIds.add(attributionKey);
      merged.attributions.push(attribution);
    }

    const skippedEvidence = createCapabilityEvidenceRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
      skippedRecord.id,
      skippedRecord.category ?? skippedRecord.kind,
    );
    const skippedEvidenceKey = `${skippedEvidence.capabilityId}:${skippedEvidence.source}:${skippedEvidence.recordId}:${skippedEvidence.label}`;
    if (!evidenceIds.has(skippedEvidenceKey)) {
      evidenceIds.add(skippedEvidenceKey);
      merged.evidences.push(skippedEvidence);
    }

    const detailLabel = getCapabilityBoundaryDetailLabel(
      summaryRegistry,
      capabilityId,
      skippedRecord.category,
    ) ?? getCapabilityFallbackBoundaryLabel(capabilityId);
    if (detailLabel !== skippedRecord.category && detailLabel !== skippedRecord.kind) {
      const detailEvidence = createCapabilityEvidenceRecord(
        capabilityId,
        ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
        skippedRecord.id,
        detailLabel,
      );
      const detailEvidenceKey = `${detailEvidence.capabilityId}:${detailEvidence.source}:${detailEvidence.recordId}:${detailEvidence.label}`;
      if (!evidenceIds.has(detailEvidenceKey)) {
        evidenceIds.add(detailEvidenceKey);
        merged.evidences.push(detailEvidence);
      }
    }

    const boundary = createCapabilityBoundaryRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.skipped,
      skippedRecord.id,
      skippedRecord.reason,
      skippedRecord.category,
    );
    const boundaryKey = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
    if (!boundaryIds.has(boundaryKey)) {
      boundaryIds.add(boundaryKey);
      merged.boundaries.push(boundary);
    }
  }

  for (const fact of facts) {
    if (
      fact.capabilityId !== ANALYSIS_CAPABILITY_ID.helperTransport
      && fact.capabilityId !== ANALYSIS_CAPABILITY_ID.finiteKeyedAccess
    ) {
      continue;
    }

    const capabilityId = fact.capabilityId;
    const detailLabel = getCapabilityFactDetailLabel(
      summaryRegistry,
      capabilityId,
      fact,
    ) ?? getCapabilityFallbackBoundaryLabel(capabilityId);

    const factEvidence = createCapabilityEvidenceRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.fact,
      fact.id,
      detailLabel,
    );
    const factEvidenceKey = `${factEvidence.capabilityId}:${factEvidence.source}:${factEvidence.recordId}:${factEvidence.label}`;
    if (!evidenceIds.has(factEvidenceKey)) {
      evidenceIds.add(factEvidenceKey);
      merged.evidences.push(factEvidence);
    }

    if (fact.outcome === ANALYSIS_CAPABILITY_FACT_OUTCOME.live) {
      const finding = findingsById.get(fact.entity.id);
      if (finding) {
        const attribution = createCapabilityAttributionRecord(
          capabilityId,
          ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.finding,
          finding.id,
        );
        const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
        if (!attributionIds.has(attributionKey)) {
          attributionIds.add(attributionKey);
          merged.attributions.push(attribution);
        }

        const findingEvidence = createCapabilityEvidenceRecord(
          capabilityId,
          ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.finding,
          finding.id,
          finding.kind,
        );
        const findingEvidenceKey = `${findingEvidence.capabilityId}:${findingEvidence.source}:${findingEvidence.recordId}:${findingEvidence.label}`;
        if (!evidenceIds.has(findingEvidenceKey)) {
          evidenceIds.add(findingEvidenceKey);
          merged.evidences.push(findingEvidence);
        }
      }

      const keptRecord = keptById.get(fact.entity.id);
      if (keptRecord) {
        const attribution = createCapabilityAttributionRecord(
          capabilityId,
          ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.kept,
          keptRecord.id,
        );
        const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
        if (!attributionIds.has(attributionKey)) {
          attributionIds.add(attributionKey);
          merged.attributions.push(attribution);
        }

        const keptEvidence = createCapabilityEvidenceRecord(
          capabilityId,
          ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.kept,
          keptRecord.id,
          keptRecord.kind,
        );
        const keptEvidenceKey = `${keptEvidence.capabilityId}:${keptEvidence.source}:${keptEvidence.recordId}:${keptEvidence.label}`;
        if (!evidenceIds.has(keptEvidenceKey)) {
          evidenceIds.add(keptEvidenceKey);
          merged.evidences.push(keptEvidence);
        }
      }

      continue;
    }

    const skippedRecord = skippedById.get(fact.entity.id);
    if (!skippedRecord) {
      continue;
    }

    const attribution = createCapabilityAttributionRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_ATTRIBUTION_SOURCE.skipped,
      skippedRecord.id,
    );
    const attributionKey = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
    if (!attributionIds.has(attributionKey)) {
      attributionIds.add(attributionKey);
      merged.attributions.push(attribution);
    }

    const skippedEvidence = createCapabilityEvidenceRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
      skippedRecord.id,
      skippedRecord.category ?? skippedRecord.kind,
    );
    const skippedEvidenceKey = `${skippedEvidence.capabilityId}:${skippedEvidence.source}:${skippedEvidence.recordId}:${skippedEvidence.label}`;
    if (!evidenceIds.has(skippedEvidenceKey)) {
      evidenceIds.add(skippedEvidenceKey);
      merged.evidences.push(skippedEvidence);
    }

    if (detailLabel !== skippedRecord.category && detailLabel !== skippedRecord.kind) {
      const detailEvidence = createCapabilityEvidenceRecord(
        capabilityId,
        ANALYSIS_CAPABILITY_EVIDENCE_SOURCE.skipped,
        skippedRecord.id,
        detailLabel,
      );
      const detailEvidenceKey = `${detailEvidence.capabilityId}:${detailEvidence.source}:${detailEvidence.recordId}:${detailEvidence.label}`;
      if (!evidenceIds.has(detailEvidenceKey)) {
        evidenceIds.add(detailEvidenceKey);
        merged.evidences.push(detailEvidence);
      }
    }

    const boundary = createCapabilityBoundaryRecord(
      capabilityId,
      ANALYSIS_CAPABILITY_BOUNDARY_SOURCE.skipped,
      skippedRecord.id,
      detailLabel,
      skippedRecord.category,
    );
    const boundaryKey = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
    if (!boundaryIds.has(boundaryKey)) {
      boundaryIds.add(boundaryKey);
      merged.boundaries.push(boundary);
    }
  }

  return {
    ...merged,
    recordCapabilityById: createRecordCapabilityIndex(merged.attributions, merged.boundaries),
    recordDetailById: createRecordDetailIndex(merged.evidences, merged.boundaries),
  };
}

export function getAnalysisCapabilityLedger(
  result: AnalysisResult,
): AnalysisCapabilityLedger | undefined {
  return getAnalysisRunResultMetadata(result)?.capabilityLedger;
}
