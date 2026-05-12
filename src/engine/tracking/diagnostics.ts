import type { DiagnosticRecord } from "../../types.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import type { AnalysisState } from "../analysis-state.js";
import type { TrackingContractDiagnostic } from "./contracts.js";

function toAnalysisDiagnostic(diagnostic: TrackingContractDiagnostic): DiagnosticRecord {
  const stagePrefix = diagnostic.stage ? ` (${diagnostic.stage})` : "";

  switch (diagnostic.code) {
    case "convergence-warning":
      return {
        kind: "project-warning",
        message: `tracking warning${stagePrefix}: ${diagnostic.message}`,
      };
    case "convergence-guard-exceeded":
      return {
        kind: "project-error",
        message: `tracking convergence guard exceeded${stagePrefix}: ${diagnostic.message}`,
      };
    case "contract-violation":
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
