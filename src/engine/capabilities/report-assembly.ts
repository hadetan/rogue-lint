import { uniqueById } from "../../shared/general-utils.js";
import type { AuditRecord, DiagnosticRecord, FindingKind, FindingRecord } from "../../types.js";

import type { AnalysisState } from "../analysis-state.js";
import {
  createDiagnosticCapabilityRecordId,
  type AnalysisCapabilityLedger,
} from "./types.js";

interface ProviderBackedReportSurface {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
}

function createDiagnosticAssemblyId(
  diagnostic: DiagnosticRecord,
  index: number,
  providerOwnedDiagnosticIds: ReadonlySet<string>,
): string {
  const providerRecordId = createDiagnosticCapabilityRecordId(diagnostic);
  return providerOwnedDiagnosticIds.has(providerRecordId)
    ? providerRecordId
    : `${diagnostic.kind}:${index}`;
}

export function assembleProviderBackedReportSurface(
  state: AnalysisState,
  capabilityLedger: AnalysisCapabilityLedger,
  includeKinds: readonly FindingKind[],
): ProviderBackedReportSurface {
  const filteredFindings =
    includeKinds.length > 0
      ? state.findings.filter((finding) => includeKinds.includes(finding.kind))
      : state.findings;

  const providerOwnedDiagnosticIds = new Set(
    capabilityLedger.boundaries
      .filter((boundary) => boundary.source === "obligation" || boundary.source === "diagnostic")
      .map((boundary) => boundary.recordId),
  );

  return {
    findings: uniqueById(filteredFindings),
    kept: uniqueById(state.kept),
    skipped: uniqueById(state.skipped),
    diagnostics: uniqueById(
      state.diagnostics.map((diagnostic, index) => ({
        ...diagnostic,
        id: createDiagnosticAssemblyId(diagnostic, index, providerOwnedDiagnosticIds),
      })),
    ).map(({ id: _id, ...diagnostic }) => diagnostic),
  };
}
