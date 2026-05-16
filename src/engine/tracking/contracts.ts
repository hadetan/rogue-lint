import type {
  TrackingAliasSurface,
  TrackingBindingsSurface,
  TrackingBoundarySurface,
  TrackingContractDiagnostic,
  TrackingContractDiagnosticDetails,
  TrackingConvergenceDebugTrace,
  TrackingReturnSummarySurface,
  TrackingRuntimeSummary,
} from "./ownership.js";
import { TRACKING_CONTRACT_DIAGNOSTIC_CODE } from "./ownership.js";

export const VALUE_LIVENESS_TRACKING_STAGE = "value-liveness";
export const OBJECT_PATHS_TRACKING_STAGE = "object-paths";
const _TRACKING_STAGES = [VALUE_LIVENESS_TRACKING_STAGE, OBJECT_PATHS_TRACKING_STAGE] as const;

export type TrackingStage = (typeof _TRACKING_STAGES)[number];

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
  readonly debugTrace?: TrackingConvergenceDebugTrace;
  readonly runtimeSummary: TrackingRuntimeSummary;
  getStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }>;
};

export function createConvergenceWarning(
  message: string,
  details?: TrackingContractDiagnosticDetails,
): TrackingContractDiagnostic {
  const diagnostic: TrackingContractDiagnostic = {
    code: TRACKING_CONTRACT_DIAGNOSTIC_CODE.convergenceWarning,
    message,
    details,
  };

  void diagnostic.code;
  void diagnostic.message;
  void diagnostic.details;
  return diagnostic;
}

export function createConvergenceGuardExceeded(
  message: string,
  details?: TrackingContractDiagnosticDetails,
): TrackingContractDiagnostic {
  const diagnostic: TrackingContractDiagnostic = {
    code: TRACKING_CONTRACT_DIAGNOSTIC_CODE.convergenceGuardExceeded,
    message,
    details,
  };

  void diagnostic.code;
  void diagnostic.message;
  void diagnostic.details;
  return diagnostic;
}

export {
  TRACKING_CONTRACT_DIAGNOSTIC_CODE,
  TRACKING_ALIAS_OWNER,
  TRACKING_BINDINGS_OWNER,
  TRACKING_BOUNDARY_OWNER,
  TRACKING_RETURN_SUMMARY_OWNER,
} from "./ownership.js";
export type {
  MutableTrackingRuntimeSummary,
  MutableTrackingSnapshot,
  TrackingContractDiagnostic,
  TrackingContractDiagnosticDetails,
  TrackingConvergenceDebugTrace,
  TrackingConvergencePassTrace,
  TrackingRuntimeSummary,
  TrackingSharedFactsPlane,
} from "./ownership.js";
