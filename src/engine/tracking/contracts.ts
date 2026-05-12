import type { TrackedObject } from "../../types.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "./model.js";

export type TrackingStage = "value-liveness" | "object-paths";

type TrackingContractDiagnosticCode =
  | "convergence-warning"
  | "convergence-guard-exceeded"
  | "contract-violation";

export type TrackingContractDiagnostic = {
  code: TrackingContractDiagnosticCode;
  message: string;
  stage?: TrackingStage;
};

type TrackingSeedPhaseArtifacts = {
  reachableFileCount: number;
  reachableSourceFileCount: number;
};

type TrackingBindingsSurface = {
  readonly owner: "binding-convergence";
  readonly bySymbolId: Map<string, TrackedObjectBinding>;
};

type TrackingReturnSummarySurface = {
  readonly owner: "return-summary-convergence";
  readonly byCallableId: Map<string, CallableReturnSummary>;
};

type TrackingAliasSurface = {
  readonly owner: "alias-state";
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

type TrackingBoundarySurface = {
  readonly owner: "boundary-state";
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

export type TrackingConvergenceSummary = {
  passes: number;
  warningPassThreshold: number;
  maxPasses: number;
  warned: boolean;
};

type TrackingRuntimeSummary = {
  seed: TrackingSeedPhaseArtifacts;
  convergence: TrackingConvergenceSummary;
  totals: {
    trackedBindings: number;
    returnSummaries: number;
    trackedObjects: number;
  };
  stageRequests: Record<TrackingStage, number>;
};

type TrackingFacts = {
  bindings: TrackingBindingsSurface;
  returnSummaries: TrackingReturnSummarySurface;
  aliases: TrackingAliasSurface;
  boundaries: TrackingBoundarySurface;
};

type ValueLivenessTrackingStageArtifacts = {
  stage: "value-liveness";
  returnSummaries: TrackingReturnSummarySurface;
  runtimeSummary: TrackingRuntimeSummary;
};

type ObjectPathTrackingStageArtifacts = {
  stage: "object-paths";
  bindings: TrackingBindingsSurface;
  returnSummaries: TrackingReturnSummarySurface;
  aliases: TrackingAliasSurface;
  boundaries: TrackingBoundarySurface;
  runtimeSummary: TrackingRuntimeSummary;
};

export type TrackingStageArtifacts = ValueLivenessTrackingStageArtifacts | ObjectPathTrackingStageArtifacts;

export type TrackingRunArtifacts = {
  seed: TrackingSeedPhaseArtifacts;
  facts: TrackingFacts;
  runtimeSummary: TrackingRuntimeSummary;
  diagnostics: readonly TrackingContractDiagnostic[];
  getStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }>;
};

export function createContractViolation(stage: TrackingStage | undefined, message: string): TrackingContractDiagnostic {
  return {
    code: "contract-violation",
    message,
    stage,
  };
}

export function createConvergenceWarning(message: string): TrackingContractDiagnostic {
  return {
    code: "convergence-warning",
    message,
  };
}

export function createConvergenceGuardExceeded(message: string): TrackingContractDiagnostic {
  return {
    code: "convergence-guard-exceeded",
    message,
  };
}
