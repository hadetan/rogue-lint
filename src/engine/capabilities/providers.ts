import type { AnalysisResult, AuditRecord, DiagnosticRecord } from "../../types.js";
import type { ProjectContext } from "../../types.js";

import { attachAnalysisRunResultMetadata, getAnalysisRunResultMetadata } from "../analysis-run-state.js";
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
  createCapabilityObligationGapMessage,
  createCapabilityAttributionRecord,
  createCapabilityBoundaryRecord,
  createCapabilityEvidenceRecord,
  createDiagnosticCapabilityRecordId,
  createEmptyAnalysisCapabilityLedger,
  type AnalysisCapabilityFactRecord,
  type AnalysisCapabilityFactFamily,
  type AnalysisCapabilityId,
  type AnalysisCapabilityLedger,
  type AnalysisCapabilityObligationRecord,
} from "./types.js";

interface AnalysisCapabilityProviderContext {
  project: ProjectContext;
  artifacts: AnalysisArtifacts;
  facts: readonly AnalysisCapabilityFactRecord[];
  obligations: ReturnType<typeof getCapabilityObligations>;
  summaryRegistry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>;
  diagnostics: readonly DiagnosticRecord[];
  findings: AnalysisResult["findings"];
  kept: AnalysisResult["kept"];
  skipped: AnalysisResult["skipped"];
}

type AnalysisCapabilityProvider = (context: AnalysisCapabilityProviderContext) => AnalysisCapabilityLedger;

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

function createObligationBackedProvider(capabilityId: AnalysisCapabilityId): AnalysisCapabilityProvider {
  return (context) => {
    const ledger = createEmptyAnalysisCapabilityLedger();
    const findingsById = new Map(context.findings.map((record) => [record.id, record]));
    const keptById = new Map(context.kept.map((record) => [record.id, record]));
    const skippedById = new Map(context.skipped.map((record) => [record.id, record]));

    for (const obligation of context.obligations) {
      if (obligation.capabilityId !== capabilityId) {
        continue;
      }

      ledger.obligations.push(obligation);
      ledger.evidences.push(
        createCapabilityEvidenceRecord(capabilityId, "obligation", obligation.id, obligation.family),
      );
      const detailLabel = getCapabilityObligationDetailLabel(
        context.summaryRegistry,
        capabilityId,
        obligation,
      );

      switch (obligation.outcome) {
        case "finding": {
          const finding = findingsById.get(obligation.entity.id);
          if (finding) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "finding", finding.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "finding", finding.id, finding.kind),
            );
            if (detailLabel && detailLabel !== finding.kind) {
              ledger.evidences.push(
                createCapabilityEvidenceRecord(capabilityId, "finding", finding.id, detailLabel),
              );
            }
          }
          break;
        }
        case "kept": {
          const kept = keptById.get(obligation.entity.id);
          if (kept) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "kept", kept.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "kept", kept.id, kept.kind),
            );
            if (detailLabel && detailLabel !== kept.kind) {
              ledger.evidences.push(
                createCapabilityEvidenceRecord(capabilityId, "kept", kept.id, detailLabel),
              );
            }
          }
          break;
        }
        case "skipped": {
          const skipped = skippedById.get(obligation.entity.id);
          if (skipped) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "skipped", skipped.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, skipped.category ?? skipped.kind),
            );
            const skippedDetailLabel = detailLabel ?? getCapabilityFallbackBoundaryLabel(capabilityId);
            if (skippedDetailLabel !== skipped.category && skippedDetailLabel !== skipped.kind) {
              ledger.evidences.push(
                createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, skippedDetailLabel),
              );
            }
            ledger.boundaries.push(
              createCapabilityBoundaryRecord(capabilityId, "skipped", skipped.id, skipped.reason, skipped.category),
            );
          }
          break;
        }
        case "boundary": {
          ledger.boundaries.push(
            createCapabilityBoundaryRecord(capabilityId, "boundary", obligation.id, obligation.family),
          );
          break;
        }
        case undefined: {
          const recordId = createUnresolvedObligationDiagnosticId(obligation);
          const unresolvedLabel = detailLabel ?? getCapabilityFallbackBoundaryLabel(capabilityId);
          ledger.boundaries.push(
            createCapabilityBoundaryRecord(capabilityId, "obligation", recordId, unresolvedLabel),
          );
          break;
        }
        default:
          break;
      }
    }

    const providerLedger = {
      ...ledger,
      recordCapabilityById: createRecordCapabilityIndex(ledger.attributions, ledger.boundaries),
      recordDetailById: createRecordDetailIndex(ledger.evidences, ledger.boundaries),
    };
    assertProviderCapabilityOwnership(capabilityId, providerLedger);
    return providerLedger;
  };
}

function createSkippedBoundaryProvider(
  capabilityId: AnalysisCapabilityId,
  categories: readonly AuditRecord["category"][],
): AnalysisCapabilityProvider {
  return (context) => {
    const ledger = createEmptyAnalysisCapabilityLedger();

    for (const skipped of context.skipped) {
      if (!categories.includes(skipped.category)) {
        continue;
      }

      ledger.attributions.push(
        createCapabilityAttributionRecord(capabilityId, "skipped", skipped.id),
      );
      ledger.evidences.push(
        createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, skipped.category ?? skipped.kind),
      );
      const detailLabel = getCapabilityBoundaryDetailLabel(
        context.summaryRegistry,
        capabilityId,
        skipped.category,
      ) ?? getCapabilityFallbackBoundaryLabel(capabilityId);
      if (detailLabel !== skipped.category && detailLabel !== skipped.kind) {
        ledger.evidences.push(
          createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, detailLabel),
        );
      }
      ledger.boundaries.push(
        createCapabilityBoundaryRecord(capabilityId, "skipped", skipped.id, skipped.reason, skipped.category),
      );
    }

    const providerLedger = {
      ...ledger,
      recordCapabilityById: createRecordCapabilityIndex(ledger.attributions, ledger.boundaries),
      recordDetailById: createRecordDetailIndex(ledger.evidences, ledger.boundaries),
    };
    assertProviderCapabilityOwnership(capabilityId, providerLedger);
    return providerLedger;
  };
}

function createFactBackedProvider(
  capabilityId: AnalysisCapabilityId,
  family: AnalysisCapabilityFactFamily,
): AnalysisCapabilityProvider {
  return (context) => {
    const ledger = createEmptyAnalysisCapabilityLedger();
    const findingsById = new Map(context.findings.map((record) => [record.id, record]));
    const keptById = new Map(context.kept.map((record) => [record.id, record]));
    const skippedById = new Map(context.skipped.map((record) => [record.id, record]));

    for (const fact of context.facts) {
      if (fact.capabilityId !== capabilityId || fact.family !== family) {
        continue;
      }

      const detailLabel = getCapabilityFactDetailLabel(
        context.summaryRegistry,
        capabilityId,
        fact,
      ) ?? getCapabilityFallbackBoundaryLabel(capabilityId);

      ledger.evidences.push(
        createCapabilityEvidenceRecord(capabilityId, "fact", fact.id, detailLabel),
      );

      if (fact.outcome === "live") {
        const finding = findingsById.get(fact.entity.id);
        if (finding) {
          ledger.attributions.push(
            createCapabilityAttributionRecord(capabilityId, "finding", finding.id),
          );
          ledger.evidences.push(
            createCapabilityEvidenceRecord(capabilityId, "finding", finding.id, finding.kind),
          );
        }

        const kept = keptById.get(fact.entity.id);
        if (kept) {
          ledger.attributions.push(
            createCapabilityAttributionRecord(capabilityId, "kept", kept.id),
          );
          ledger.evidences.push(
            createCapabilityEvidenceRecord(capabilityId, "kept", kept.id, kept.kind),
          );
        }
        continue;
      }

      const skipped = skippedById.get(fact.entity.id);
      if (!skipped) {
        continue;
      }

      ledger.attributions.push(
        createCapabilityAttributionRecord(capabilityId, "skipped", skipped.id),
      );
      ledger.evidences.push(
        createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, skipped.category ?? skipped.kind),
      );
      if (detailLabel !== skipped.category && detailLabel !== skipped.kind) {
        ledger.evidences.push(
          createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, detailLabel),
        );
      }
      ledger.boundaries.push(
        createCapabilityBoundaryRecord(capabilityId, "skipped", skipped.id, detailLabel, skipped.category),
      );
    }

    const providerLedger = {
      ...ledger,
      recordCapabilityById: createRecordCapabilityIndex(ledger.attributions, ledger.boundaries),
      recordDetailById: createRecordDetailIndex(ledger.evidences, ledger.boundaries),
    };
    assertProviderCapabilityOwnership(capabilityId, providerLedger);
    return providerLedger;
  };
}

function mergeCapabilityLedgers(
  ledgers: readonly AnalysisCapabilityLedger[],
): AnalysisCapabilityLedger {
  const merged = createEmptyAnalysisCapabilityLedger();
  const obligationIds = new Set<string>();
  const attributionIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const ledger of ledgers) {
    for (const obligation of ledger.obligations) {
      if (obligationIds.has(obligation.id)) {
        continue;
      }
      obligationIds.add(obligation.id);
      merged.obligations.push(obligation);
    }

    for (const attribution of ledger.attributions) {
      const key = `${attribution.capabilityId}:${attribution.source}:${attribution.recordId}`;
      if (attributionIds.has(key)) {
        continue;
      }
      attributionIds.add(key);
      merged.attributions.push(attribution);
    }

    for (const boundary of ledger.boundaries) {
      const key = `${boundary.capabilityId}:${boundary.source}:${boundary.recordId}:${boundary.category ?? ""}`;
      if (boundaryIds.has(key)) {
        continue;
      }
      boundaryIds.add(key);
      merged.boundaries.push(boundary);
    }

    for (const evidence of ledger.evidences) {
      const key = `${evidence.capabilityId}:${evidence.source}:${evidence.recordId}:${evidence.label}`;
      if (evidenceIds.has(key)) {
        continue;
      }
      evidenceIds.add(key);
      merged.evidences.push(evidence);
    }
  }

  return {
    ...merged,
    recordCapabilityById: createRecordCapabilityIndex(merged.attributions, merged.boundaries),
    recordDetailById: createRecordDetailIndex(merged.evidences, merged.boundaries),
  };
}

function assertProviderCapabilityOwnership(
  capabilityId: AnalysisCapabilityId,
  ledger: AnalysisCapabilityLedger,
): void {
  const mismatchedRecord =
    ledger.obligations.find((entry) => entry.capabilityId !== capabilityId)
    ?? ledger.attributions.find((entry) => entry.capabilityId !== capabilityId)
    ?? ledger.boundaries.find((entry) => entry.capabilityId !== capabilityId)
    ?? ledger.evidences.find((entry) => entry.capabilityId !== capabilityId);

  if (mismatchedRecord) {
    throw new Error(`Capability provider ${capabilityId} emitted mismatched capability attribution.`);
  }
}

const ANALYSIS_CAPABILITY_PROVIDERS: readonly AnalysisCapabilityProvider[] = [
  createObligationBackedProvider("library-public-surface-aliasing"),
  createObligationBackedProvider("returned-structure-transport"),
  createSkippedBoundaryProvider("helper-transport", [
    "array-callback-escape",
    "array-opaque-mutation",
    "opaque-object-call",
  ]),
  createFactBackedProvider("helper-transport", "helper-transport"),
  createSkippedBoundaryProvider("finite-keyed-access", [
    "array-at-call",
    "computed-property-access",
    "dynamic-array-index",
  ]),
  createFactBackedProvider("finite-keyed-access", "finite-keyed-access"),
];

export function collectAnalysisCapabilityLedger(
  project: ProjectContext,
  state: AnalysisState,
  artifacts: AnalysisArtifacts,
): AnalysisCapabilityLedger {
  const context: AnalysisCapabilityProviderContext = {
    project,
    artifacts,
    facts: getCapabilityFacts(state),
    obligations: getCapabilityObligations(state),
    summaryRegistry: createAnalysisCapabilitySummaryRegistry(project, artifacts),
    diagnostics: state.diagnostics as readonly DiagnosticRecord[],
    findings: state.findings,
    kept: state.kept,
    skipped: state.skipped,
  };

  return mergeCapabilityLedgers(
    ANALYSIS_CAPABILITY_PROVIDERS.map((provider) => provider(context)),
  );
}

export function attachAnalysisCapabilityLedger(
  result: AnalysisResult,
  ledger: AnalysisCapabilityLedger,
): void {
  attachAnalysisRunResultMetadata(result, { capabilityLedger: ledger });
}

export function getAnalysisCapabilityLedger(
  result: AnalysisResult,
): AnalysisCapabilityLedger | undefined {
  return getAnalysisRunResultMetadata(result)?.capabilityLedger;
}
