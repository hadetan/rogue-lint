import type { TrackedObject } from "../../types.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "./model.js";

export const TRACKING_BINDINGS_OWNER = "binding-convergence";
export const TRACKING_RETURN_SUMMARY_OWNER = "return-summary-convergence";
export const TRACKING_ALIAS_OWNER = "alias-state";
export const TRACKING_BOUNDARY_OWNER = "boundary-state";

export const TRACKING_CONTRACT_DIAGNOSTIC_CODE = {
  convergenceWarning: "convergence-warning",
  convergenceGuardExceeded: "convergence-guard-exceeded",
  contractViolation: "contract-violation",
} as const;

type TrackingContractDiagnosticCode = (typeof TRACKING_CONTRACT_DIAGNOSTIC_CODE)[keyof typeof TRACKING_CONTRACT_DIAGNOSTIC_CODE];

class TrackingStructuralRoleVocabulary {
  readonly record: "record" = "record";
  readonly stateHolder: "state-holder" = "state-holder";
  readonly structuralRecord: "structural-record" = "structural-record";
  readonly structuralRecordArray: "structural-record-array" = "structural-record-array";
}

export const TRACKING_STRUCTURAL_ROLE = new TrackingStructuralRoleVocabulary();

type TrackingStructuralRole = (typeof TRACKING_STRUCTURAL_ROLE)[keyof typeof TRACKING_STRUCTURAL_ROLE];

const TRACKING_PROTECTED_STRUCTURAL_ROLES = new Set<TrackingStructuralRole>([
  TRACKING_STRUCTURAL_ROLE.structuralRecord,
  TRACKING_STRUCTURAL_ROLE.structuralRecordArray,
  TRACKING_STRUCTURAL_ROLE.stateHolder,
]);

export function isTrackingProtectedStructuralRole(role: TrackingStructuralRole | undefined): boolean {
  return role !== undefined && TRACKING_PROTECTED_STRUCTURAL_ROLES.has(role);
}

export type TrackingContractDiagnostic = {
  code: TrackingContractDiagnosticCode;
  message: string;
  stage?: string;
  details?: TrackingContractDiagnosticDetails;
};

export type TrackingContractDiagnosticDetails = {
  readonly elapsedMs?: number;
  readonly pass?: number;
  readonly bindingChanges?: number;
  readonly returnSummaryChanges?: number;
  readonly trackedObjectRegistryEntries?: number;
  readonly callSiteSpecializations?: number;
  readonly literalBindingCacheEntries?: number;
  readonly returnLiteralBindingCacheEntries?: number;
  readonly trackedObjectRegistryGrowth?: number;
  readonly callSiteSpecializationGrowth?: number;
  readonly literalBindingCacheGrowth?: number;
  readonly returnLiteralBindingCacheGrowth?: number;
  readonly bindingSamples?: readonly string[];
  readonly returnSummarySamples?: readonly string[];
};

export type TrackingConvergencePassTrace = {
  readonly pass: number;
  readonly elapsedMs: number;
  readonly bindingChanges: number;
  readonly returnSummaryChanges: number;
  readonly bindingSamples: readonly string[];
  readonly returnSummarySamples: readonly string[];
  readonly solverState?: {
    readonly trackedObjectRegistryEntries: number;
    readonly callSiteSpecializations: number;
    readonly literalBindingCacheEntries: number;
    readonly returnLiteralBindingCacheEntries: number;
  };
};

export type TrackingConvergenceDebugTrace = {
  readonly sampleLimit: number;
  readonly passTraces: readonly TrackingConvergencePassTrace[];
};

type TrackingSeedPhaseArtifacts = {
  readonly reachableFileCount: number;
  readonly reachableSourceFileCount: number;
};

export type TrackingBindingsSurface = {
  readonly owner: typeof TRACKING_BINDINGS_OWNER;
  readonly bySymbolId: ReadonlyMap<string, TrackedObjectBinding>;
};

type MutableTrackingBindingsSurface = {
  readonly owner: typeof TRACKING_BINDINGS_OWNER;
  readonly bySymbolId: Map<string, TrackedObjectBinding>;
};

export type TrackingReturnSummarySurface = {
  readonly owner: typeof TRACKING_RETURN_SUMMARY_OWNER;
  readonly byCallableId: ReadonlyMap<string, CallableReturnSummary>;
};

type MutableTrackingReturnSummarySurface = {
  readonly owner: typeof TRACKING_RETURN_SUMMARY_OWNER;
  readonly byCallableId: Map<string, CallableReturnSummary>;
};

export type TrackingAliasSurface = {
  readonly owner: typeof TRACKING_ALIAS_OWNER;
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingAliasSurface = {
  readonly owner: typeof TRACKING_ALIAS_OWNER;
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

export type TrackingBoundarySurface = {
  readonly owner: typeof TRACKING_BOUNDARY_OWNER;
  readonly trackedObjectsById: ReadonlyMap<string, TrackedObject>;
};

type MutableTrackingBoundarySurface = {
  readonly owner: typeof TRACKING_BOUNDARY_OWNER;
  readonly trackedObjectsById: Map<string, TrackedObject>;
};

export type TrackingRuntimeSummary = {
  readonly seed: TrackingSeedPhaseArtifacts;
  readonly convergence: {
    readonly passes: number;
    readonly warningPassThreshold: number;
    readonly maxPasses: number;
    readonly warned: boolean;
    readonly elapsedMs: number;
    readonly churn: {
      readonly bindingChanges: number;
      readonly bindingChangedPasses: number;
      readonly returnSummaryChanges: number;
      readonly returnSummaryChangedPasses: number;
    };
    readonly widening: {
      readonly bindingChanges: number;
      readonly returnSummaryChanges: number;
      readonly reasons: {
        readonly bindings: readonly string[];
        readonly returnSummaries: readonly string[];
      };
    };
    readonly unstableSamples: {
      readonly bindings: readonly string[];
      readonly returnSummaries: readonly string[];
    };
  };
  readonly totals: {
    readonly trackedBindings: number;
    readonly returnSummaries: number;
    readonly trackedObjects: number;
  };
  readonly solverState: {
    readonly trackedObjectRegistryEntries: number;
    readonly callSiteSpecializations: number;
    readonly literalBindingCacheEntries: number;
    readonly returnLiteralBindingCacheEntries: number;
  };
  readonly stageTimingsMs: Readonly<Record<string, number>>;
  readonly stageRequests: Readonly<Record<string, number>>;
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
    elapsedMs: number;
    churn: {
      bindingChanges: number;
      bindingChangedPasses: number;
      returnSummaryChanges: number;
      returnSummaryChangedPasses: number;
    };
    widening: {
      bindingChanges: number;
      returnSummaryChanges: number;
      reasons: {
        bindings: string[];
        returnSummaries: string[];
      };
    };
    unstableSamples: {
      bindings: string[];
      returnSummaries: string[];
    };
  };
  totals: {
    trackedBindings: number;
    returnSummaries: number;
    trackedObjects: number;
  };
  solverState: {
    trackedObjectRegistryEntries: number;
    callSiteSpecializations: number;
    literalBindingCacheEntries: number;
    returnLiteralBindingCacheEntries: number;
  };
  stageTimingsMs: Record<string, number>;
  stageRequests: Record<string, number>;
};

export type TrackingSharedFactsPlane = {
  readonly bindings: TrackingBindingsSurface;
  readonly returnSummaries: TrackingReturnSummarySurface;
  readonly aliases: TrackingAliasSurface;
  readonly boundaries: TrackingBoundarySurface;
};

type MutableTrackingSharedFactsPlane = {
  bindings: MutableTrackingBindingsSurface;
  returnSummaries: MutableTrackingReturnSummarySurface;
  aliases: MutableTrackingAliasSurface;
  boundaries: MutableTrackingBoundarySurface;
};

type MutableTrackingSolverStatePlane = {
  runtimeSummary: MutableTrackingRuntimeSummary;
  diagnostics: TrackingContractDiagnostic[];
};

export type MutableTrackingSnapshot = {
  sharedFacts: MutableTrackingSharedFactsPlane;
  solverState: MutableTrackingSolverStatePlane;
};
