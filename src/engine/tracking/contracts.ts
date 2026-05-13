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
  readonly reachableFileCount: number;
  readonly reachableSourceFileCount: number;
};

type TrackingBindingsSurface = {
  readonly owner: "binding-convergence";
  readonly bySymbolId: ReadonlyMap<string, TrackedObjectBinding>;
};

type MutableTrackingBindingsSurface = {
  readonly owner: "binding-convergence";
  readonly bySymbolId: Map<string, TrackedObjectBinding>;
};

type TrackingReturnSummarySurface = {
  readonly owner: "return-summary-convergence";
  readonly byCallableId: ReadonlyMap<string, CallableReturnSummary>;
};

type MutableTrackingReturnSummarySurface = {
  readonly owner: "return-summary-convergence";
  readonly byCallableId: Map<string, CallableReturnSummary>;
};

type TrackingAliasSurface = {
  readonly owner: "alias-state";
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingAliasSurface = {
  readonly owner: "alias-state";
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

type TrackingBoundarySurface = {
  readonly owner: "boundary-state";
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingBoundarySurface = {
  readonly owner: "boundary-state";
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

type TrackingRuntimeSummary = {
  readonly seed: TrackingSeedPhaseArtifacts;
  readonly convergence: {
    readonly passes: number;
    readonly warningPassThreshold: number;
    readonly maxPasses: number;
    readonly warned: boolean;
  };
  readonly totals: {
    readonly trackedBindings: number;
    readonly returnSummaries: number;
    readonly trackedObjects: number;
  };
  readonly stageRequests: Readonly<Record<TrackingStage, number>>;
};

export type MutableTrackingRuntimeSummary = {
  seed: {
    reachableFileCount: number;
    reachableSourceFileCount: number;
  };
  convergence: {
    passes: number;
    warningPassThreshold: number;
    maxPasses: number;
    warned: boolean;
  };
  totals: {
    trackedBindings: number;
    returnSummaries: number;
    trackedObjects: number;
  };
  stageRequests: Record<TrackingStage, number>;
};

export type MutableTrackingSnapshot = {
  bindings: MutableTrackingBindingsSurface;
  returnSummaries: MutableTrackingReturnSummarySurface;
  aliases: MutableTrackingAliasSurface;
  boundaries: MutableTrackingBoundarySurface;
  runtimeSummary: MutableTrackingRuntimeSummary;
  diagnostics: TrackingContractDiagnostic[];
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
  readonly diagnostics: readonly TrackingContractDiagnostic[];
  getStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }>;
};

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
