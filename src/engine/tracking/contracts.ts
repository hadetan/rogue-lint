import type { TrackedObject } from "../../types.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "./model.js";

export const VALUE_LIVENESS_TRACKING_STAGE = "value-liveness";
export const OBJECT_PATHS_TRACKING_STAGE = "object-paths";
const _TRACKING_STAGES = [VALUE_LIVENESS_TRACKING_STAGE, OBJECT_PATHS_TRACKING_STAGE] as const;

export const TRACKING_BINDINGS_OWNER = "binding-convergence";
export const TRACKING_RETURN_SUMMARY_OWNER = "return-summary-convergence";
export const TRACKING_ALIAS_OWNER = "alias-state";
export const TRACKING_BOUNDARY_OWNER = "boundary-state";

export type TrackingStage = (typeof _TRACKING_STAGES)[number];

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
  readonly owner: typeof TRACKING_BINDINGS_OWNER;
  readonly bySymbolId: ReadonlyMap<string, TrackedObjectBinding>;
};

type MutableTrackingBindingsSurface = {
  readonly owner: typeof TRACKING_BINDINGS_OWNER;
  readonly bySymbolId: Map<string, TrackedObjectBinding>;
};

type TrackingReturnSummarySurface = {
  readonly owner: typeof TRACKING_RETURN_SUMMARY_OWNER;
  readonly byCallableId: ReadonlyMap<string, CallableReturnSummary>;
};

type MutableTrackingReturnSummarySurface = {
  readonly owner: typeof TRACKING_RETURN_SUMMARY_OWNER;
  readonly byCallableId: Map<string, CallableReturnSummary>;
};

type TrackingAliasSurface = {
  readonly owner: typeof TRACKING_ALIAS_OWNER;
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingAliasSurface = {
  readonly owner: typeof TRACKING_ALIAS_OWNER;
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

type TrackingBoundarySurface = {
  readonly owner: typeof TRACKING_BOUNDARY_OWNER;
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingBoundarySurface = {
  readonly owner: typeof TRACKING_BOUNDARY_OWNER;
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
  stage: typeof VALUE_LIVENESS_TRACKING_STAGE;
  returnSummaries: TrackingReturnSummarySurface;
  runtimeSummary: TrackingRuntimeSummary;
};

type ObjectPathTrackingStageArtifacts = {
  stage: typeof OBJECT_PATHS_TRACKING_STAGE;
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
