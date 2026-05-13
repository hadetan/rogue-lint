import type { AnalysisResult, AuditRecord, DiagnosticRecord } from "../../types.js";
import type { ProjectContext } from "../../types.js";

import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import {
  getCapabilityCandidates,
  type AnalysisState,
} from "../analysis-state.js";
import {
  createCapabilityAttributionRecord,
  createCapabilityBoundaryRecord,
  createCapabilityEvidenceRecord,
  createDiagnosticCapabilityRecordId,
  createEmptyAnalysisCapabilityLedger,
  type AnalysisCapabilityId,
  type AnalysisCapabilityLedger,
} from "./types.js";

interface AnalysisCapabilityProviderContext {
  project: ProjectContext;
  state: AnalysisState;
  artifacts: AnalysisArtifacts;
  candidates: ReturnType<typeof getCapabilityCandidates>;
  diagnostics: readonly DiagnosticRecord[];
  findings: AnalysisResult["findings"];
  kept: AnalysisResult["kept"];
  skipped: AnalysisResult["skipped"];
}

type AnalysisCapabilityProvider = (context: AnalysisCapabilityProviderContext) => AnalysisCapabilityLedger;

const analysisCapabilityLedgerByResult = new WeakMap<AnalysisResult, AnalysisCapabilityLedger>();

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
      (boundary.source === "candidate" || boundary.source === "diagnostic")
      && !recordCapabilityById.has(boundary.recordId)
    ) {
      recordCapabilityById.set(boundary.recordId, boundary.capabilityId);
    }
  }

  return recordCapabilityById;
}

function createCandidateBackedProvider(capabilityId: AnalysisCapabilityId): AnalysisCapabilityProvider {
  return (context) => {
    const ledger = createEmptyAnalysisCapabilityLedger();
    const findingsById = new Map(context.findings.map((record) => [record.id, record]));
    const keptById = new Map(context.kept.map((record) => [record.id, record]));
    const skippedById = new Map(context.skipped.map((record) => [record.id, record]));

    for (const candidate of context.candidates) {
      if (candidate.capabilityId !== capabilityId) {
        continue;
      }

      ledger.evidences.push(
        createCapabilityEvidenceRecord(capabilityId, "candidate", candidate.id, candidate.family),
      );

      switch (candidate.outcome) {
        case "finding": {
          const finding = findingsById.get(candidate.entity.id);
          if (finding) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "finding", finding.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "finding", finding.id, finding.kind),
            );
          }
          break;
        }
        case "kept": {
          const kept = keptById.get(candidate.entity.id);
          if (kept) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "kept", kept.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "kept", kept.id, kept.kind),
            );
          }
          break;
        }
        case "skipped": {
          const skipped = skippedById.get(candidate.entity.id);
          if (skipped) {
            ledger.attributions.push(
              createCapabilityAttributionRecord(capabilityId, "skipped", skipped.id),
            );
            ledger.evidences.push(
              createCapabilityEvidenceRecord(capabilityId, "skipped", skipped.id, skipped.category ?? skipped.kind),
            );
            ledger.boundaries.push(
              createCapabilityBoundaryRecord(capabilityId, "skipped", skipped.id, skipped.reason, skipped.category),
            );
          }
          break;
        }
        case undefined: {
          const recordId = createDiagnosticCapabilityRecordId({
            kind: "project-warning",
            file: candidate.entity.location.file,
            message: `capability coverage gap (${candidate.family}): ${candidate.entity.kind} ${candidate.entity.name} never resolved to finding, kept, skipped, or live`,
          });
          ledger.boundaries.push(
            createCapabilityBoundaryRecord(capabilityId, "candidate", recordId, candidate.family),
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
      ledger.boundaries.push(
        createCapabilityBoundaryRecord(capabilityId, "skipped", skipped.id, skipped.reason, skipped.category),
      );
    }

    const providerLedger = {
      ...ledger,
      recordCapabilityById: createRecordCapabilityIndex(ledger.attributions, ledger.boundaries),
    };
    assertProviderCapabilityOwnership(capabilityId, providerLedger);
    return providerLedger;
  };
}

function mergeCapabilityLedgers(
  ledgers: readonly AnalysisCapabilityLedger[],
): AnalysisCapabilityLedger {
  const merged = createEmptyAnalysisCapabilityLedger();
  const attributionIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const ledger of ledgers) {
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
  };
}

function assertProviderCapabilityOwnership(
  capabilityId: AnalysisCapabilityId,
  ledger: AnalysisCapabilityLedger,
): void {
  const mismatchedRecord =
    ledger.attributions.find((entry) => entry.capabilityId !== capabilityId)
    ?? ledger.boundaries.find((entry) => entry.capabilityId !== capabilityId)
    ?? ledger.evidences.find((entry) => entry.capabilityId !== capabilityId);

  if (mismatchedRecord) {
    throw new Error(`Capability provider ${capabilityId} emitted mismatched capability attribution.`);
  }
}

const ANALYSIS_CAPABILITY_PROVIDERS: readonly AnalysisCapabilityProvider[] = [
  createCandidateBackedProvider("library-public-surface-aliasing"),
  createCandidateBackedProvider("returned-structure-transport"),
  createSkippedBoundaryProvider("helper-transport", [
    "array-callback-escape",
    "array-opaque-mutation",
    "opaque-object-call",
  ]),
  createSkippedBoundaryProvider("finite-keyed-access", [
    "array-at-call",
    "computed-property-access",
    "dynamic-array-index",
  ]),
];

export function collectAnalysisCapabilityLedger(
  project: ProjectContext,
  state: AnalysisState,
  artifacts: AnalysisArtifacts,
): AnalysisCapabilityLedger {
  const context: AnalysisCapabilityProviderContext = {
    project,
    state,
    artifacts,
    candidates: getCapabilityCandidates(state),
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
  analysisCapabilityLedgerByResult.set(result, ledger);
}

export function getAnalysisCapabilityLedger(
  result: AnalysisResult,
): AnalysisCapabilityLedger | undefined {
  return analysisCapabilityLedgerByResult.get(result);
}
