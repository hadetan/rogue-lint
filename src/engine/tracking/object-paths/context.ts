import type ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SuppressionContext,
  TrackedObject,
} from "../../../types.js";
import type { AnalysisState } from "../../analysis-state.js";
import type { AnalysisArtifacts } from "../../analysis-artifacts.js";
import type {
  ArrayProjectionBinding,
  CallableReturnSummary,
  HelperParameterSummary,
  TrackedObjectBinding,
} from "../model.js";

export interface FiniteLookupCandidate {
  binding: TrackedObjectBinding;
  segments: PathSegment[];
}

export interface HelperExactAppendPlan {
  call: ts.CallExpression;
  sourceFile: ts.SourceFile;
  methodName: "push" | "unshift";
  relativeCollectionPath: PathSegment[];
  slotPlans: import("../model.js").ExactAppendSlotPlan[];
}

export interface HelperProjectedUsagePlan {
  statement: ts.Statement;
  relativeCollectionPath: PathSegment[];
  elementSymbolKey: string;
}

export interface ObjectPathSourceFileContext {
  sourceFile: ts.SourceFile;
  projectionBindings: Map<string, ArrayProjectionBinding>;
  projectionReceiverBindings: Map<string, ArrayProjectionBinding>;
  projectionIndexBindings: Map<string, ArrayProjectionBinding>;
  finiteLookupBindings: Map<string, FiniteLookupCandidate[]>;
  helperFiniteReturnCache: Map<string, { candidates: FiniteLookupCandidate[]; suffix: PathSegment[] } | null>;
  handledExactCallbackBodies: Set<ts.Node>;
  retainedContainerConflicts: Set<string>;
  handledSpreadAppendStarts: Set<number>;
  parameterMeaningfulUse: Map<string, boolean | null>;
  parameterSummaryCache: Map<string, HelperParameterSummary | null>;
  helperExactAppendPlanCache: Map<string, HelperExactAppendPlan[] | null>;
  helperProjectedUsagePlanCache: Map<string, HelperProjectedUsagePlan[] | null>;
}

export interface ObjectPathStageContext {
  project: ProjectContext;
  reachableFiles: Set<string>;
  publicCallableIds: Set<string>;
  state: AnalysisState;
  suppressionContext: SuppressionContext;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: Map<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  boundaryTrackedObjectsById: Map<string, TrackedObject>;
  createSourceFileContext(sourceFile: ts.SourceFile): ObjectPathSourceFileContext;
}

export function createObjectPathStageContext(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): ObjectPathStageContext {
  const trackingStageArtifacts = artifacts.getTrackingStageArtifacts("object-paths");

  return {
    project,
    reachableFiles,
    publicCallableIds: artifacts.publicCallableIds,
    state,
    suppressionContext,
    trackedBySymbolId: trackingStageArtifacts.bindings.bySymbolId,
    functionReturnSummaries: trackingStageArtifacts.returnSummaries.byCallableId,
    trackedObjectsById: trackingStageArtifacts.aliases.trackedObjectsById,
    boundaryTrackedObjectsById: trackingStageArtifacts.boundaries.trackedObjectsById,
    createSourceFileContext(sourceFile: ts.SourceFile): ObjectPathSourceFileContext {
      const projectionBindings = new Map<string, ArrayProjectionBinding>();

      return {
        sourceFile,
        projectionBindings,
        projectionReceiverBindings: new Map(),
        projectionIndexBindings: new Map(),
        finiteLookupBindings: new Map<string, FiniteLookupCandidate[]>(),
        helperFiniteReturnCache: new Map<string, { candidates: FiniteLookupCandidate[]; suffix: PathSegment[] } | null>(),
        handledExactCallbackBodies: new Set<ts.Node>(),
        retainedContainerConflicts: new Set<string>(),
        handledSpreadAppendStarts: new Set<number>(),
        parameterMeaningfulUse: new Map<string, boolean | null>(),
        parameterSummaryCache: new Map<string, HelperParameterSummary | null>(),
        helperExactAppendPlanCache: new Map<string, HelperExactAppendPlan[] | null>(),
        helperProjectedUsagePlanCache: new Map<string, HelperProjectedUsagePlan[] | null>(),
      };
    },
  };
}
