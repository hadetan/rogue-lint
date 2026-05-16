import type { DiagnosticRecord } from "../../types.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import type { AnalysisState } from "../analysis-state.js";
import type { TrackingContractDiagnostic } from "./contracts.js";
import { TRACKING_CONTRACT_DIAGNOSTIC_CODE } from "./contracts.js";

function toAnalysisDiagnostic(diagnostic: TrackingContractDiagnostic): DiagnosticRecord {
  const stagePrefix = diagnostic.stage ? ` (${diagnostic.stage})` : "";

  switch (diagnostic.code) {
    case TRACKING_CONTRACT_DIAGNOSTIC_CODE.convergenceWarning:
      return {
        kind: "project-warning",
        message: `tracking warning${stagePrefix}: ${diagnostic.message}`,
      };
    case TRACKING_CONTRACT_DIAGNOSTIC_CODE.convergenceGuardExceeded:
      return {
        kind: "project-error",
        message: `tracking convergence guard exceeded${stagePrefix}: ${diagnostic.message}`,
      };
    case TRACKING_CONTRACT_DIAGNOSTIC_CODE.contractViolation:
      return {
        kind: "project-error",
        message: `tracking contract violation${stagePrefix}: ${diagnostic.message}`,
      };
  }
}

function getTrackingAnalysisDiagnostics(artifacts: AnalysisArtifacts): DiagnosticRecord[] {
  return artifacts.getTrackingRunArtifacts().diagnostics.map(toAnalysisDiagnostic);
}

export function appendTrackingAnalysisDiagnostics(state: AnalysisState, artifacts: AnalysisArtifacts): void {
  state.diagnostics.push(...getTrackingAnalysisDiagnostics(artifacts));
}
