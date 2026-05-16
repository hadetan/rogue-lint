import type ts from "typescript";

import type { PathSegment, ProjectContext, SuppressionContext, TrackedObject } from "../../../types.js";
import type { AnalysisState } from "../../analysis-state.js";
import type { ArrayProjectionBinding, CallableReturnSummary, ExactAppendSlotPlan, HelperParameterSummary, TrackedObjectBinding } from "../model.js";
import type { TrackingAppendMethodName } from "../vocabulary.js";
import type { ObjectPathOverlayState } from "./overlay.js";

/**
 * Candidate exact bindings for a bounded finite lookup read.
 */
export interface FiniteLookupCandidate {
  binding: TrackedObjectBinding;
  segments: PathSegment[];
}

/**
 * Replayable append plan inferred from helper behavior.
 */
export interface HelperExactAppendPlan {
  call: ts.CallExpression;
  sourceFile: ts.SourceFile;
  methodName: TrackingAppendMethodName;
  relativeCollectionPath: PathSegment[];
  slotPlans: ExactAppendSlotPlan[];
}

/**
 * Replayable projected-element usage plan inferred from helper behavior.
 */
export interface HelperProjectedUsagePlan {
  statement: ts.Statement;
  relativeCollectionPath: PathSegment[];
  elementSymbolKey: string;
}

/**
 * Cached higher-order helper read summary reused across object-path visits.
 */
export interface HigherOrderCallableReturnSummary {
  exactReadPaths: PathSegment[][];
  boundaryReason?: string;
}

/**
 * Per-source-file mutable caches and bindings used during object-path traversal.
 */
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
  higherOrderCallableReturnSummaryCache: Map<string, HigherOrderCallableReturnSummary | null>;
}

/**
 * Run-scoped object-path stage state shared across source-file visits.
 */
export interface ObjectPathStageContext {
  project: ProjectContext;
  reachableFiles: Set<string>;
  publicSurfaceIds: Set<string>;
  publiclyReachableCallableIds: Set<string>;
  state: AnalysisState;
  suppressionContext: SuppressionContext;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  overlayState: ObjectPathOverlayState;
  trackedBindingRegistry: Map<string, TrackedObjectBinding>;
  trackedObjectRegistry: Map<string, TrackedObject>;
  createSourceFileContext(sourceFile: ts.SourceFile): ObjectPathSourceFileContext;
}
