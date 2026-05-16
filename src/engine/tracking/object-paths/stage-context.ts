import type ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SuppressionContext,
  TrackedObject,
} from "../../../types.js";
import type { AnalysisState } from "../../analysis-state.js";
import type { AnalysisArtifacts } from "../../analysis-artifacts.js";
import { OBJECT_PATHS_TRACKING_STAGE, type TrackingSharedFactsPlane } from "../contracts.js";
import type {
  ArrayProjectionBinding,
  CallableReturnSummary,
  HelperParameterSummary,
  TrackedObjectBinding,
} from "../model.js";
import type { ObjectPathOverlayState } from "./overlay.js";
import { computePubliclyReachableCallableIds } from "./returned-structures.js";
import type {
  FiniteLookupCandidate,
  HelperExactAppendPlan,
  HelperProjectedUsagePlan,
  HigherOrderCallableReturnSummary,
  ObjectPathSourceFileContext,
  ObjectPathStageContext,
} from "./types.js";

function cloneTrackedObjectForObjectPathStage(base: TrackedObject): TrackedObject {
  return {
    ...base,
    nodes: new Map([...base.nodes.entries()].map(([joinedPath, node]) => [
      joinedPath,
      {
        entity: node.entity,
        fullPath: [...node.fullPath],
        origin: node.origin,
      },
    ])),
    callablePaths: new Map([...base.callablePaths.entries()].map(([joinedPath, callable]) => [
      joinedPath,
      {
        symbolKey: callable.symbolKey,
        declaration: callable.declaration,
      },
    ])),
    descendantNodeKeys: new Map([...base.descendantNodeKeys.entries()].map(([joinedPath, descendantKeys]) => [
      joinedPath,
      [...descendantKeys],
    ])),
    collections: new Map([...base.collections.entries()].map(([joinedPath, collection]) => [
      joinedPath,
      {
        kind: collection.kind,
        path: [...collection.path],
        childPaths: collection.childPaths.map((childPath) => [...childPath]),
        arrayLength: collection.arrayLength,
      },
    ])),
    collectionStates: new Map([...base.collectionStates.entries()].map(([joinedPath, state]) => [
      joinedPath,
      {
        path: [...state.path],
        epoch: state.epoch,
        arrayLength: state.arrayLength,
      },
    ])),
    collectionBoundaries: new Map([...base.collectionBoundaries.entries()].map(([id, boundary]) => [
      id,
      {
        entity: boundary.entity,
        path: [...boundary.path],
        category: boundary.category,
        reason: boundary.reason,
      },
    ])),
    invalidatedCollectionPaths: new Set(base.invalidatedCollectionPaths),
    invalidatedPaths: new Map([...base.invalidatedPaths.entries()].map(([joinedPath, invalidated]) => [
      joinedPath,
      {
        reason: invalidated.reason,
        findingKind: invalidated.findingKind,
      },
    ])),
    placeStates: new Map(base.placeStates),
    observedSubtrees: new Set(base.observedSubtrees),
    escapedPaths: new Map([...base.escapedPaths.entries()].map(([joinedPath, escaped]) => [
      joinedPath,
      {
        category: escaped.category,
        reason: escaped.reason,
      },
    ])),
    exactPathAliases: new Map([...base.exactPathAliases.entries()].map(([joinedPath, alias]) => [
      joinedPath,
      {
        fate: alias.fate,
        sourceObjectId: alias.sourceObjectId,
        sourcePath: [...alias.sourcePath],
        observed: alias.observed,
      },
    ])),
    valueFates: base.valueFates.map((valueFate) => ({
      ...valueFate,
      path: [...valueFate.path],
      relatedPath: valueFate.relatedPath ? [...valueFate.relatedPath] : undefined,
    })),
    reads: new Set(base.reads),
    writes: new Set(base.writes),
  };
}

function cloneTrackedObjectBindingForObjectPathStage(
  binding: TrackedObjectBinding,
  trackedObjectsById: ReadonlyMap<string, TrackedObject>,
): TrackedObjectBinding {
  return {
    trackedObject: trackedObjectsById.get(binding.trackedObject.id) ?? binding.trackedObject,
    prefix: [...binding.prefix],
  };
}

function cloneCallableReturnSummaryForObjectPathStage(
  summary: CallableReturnSummary,
  trackedObjectsById: ReadonlyMap<string, TrackedObject>,
): CallableReturnSummary {
  if (summary.kind === "structured" || summary.kind === "returned-alias") {
    return {
      kind: summary.kind,
      binding: cloneTrackedObjectBindingForObjectPathStage(summary.binding, trackedObjectsById),
    };
  }

  return summary;
}

interface ObjectPathTrackingInput {
  sharedFacts: Pick<TrackingSharedFactsPlane, "bindings" | "returnSummaries" | "aliases" | "boundaries">;
}

function createObjectPathTrackingInput(artifacts: AnalysisArtifacts): ObjectPathTrackingInput {
  const trackingStageArtifacts = artifacts.getTrackingStageArtifacts(OBJECT_PATHS_TRACKING_STAGE);

  const trackingInput: ObjectPathTrackingInput = {
    sharedFacts: {
      bindings: trackingStageArtifacts.bindings,
      returnSummaries: trackingStageArtifacts.returnSummaries,
      aliases: trackingStageArtifacts.aliases,
      boundaries: trackingStageArtifacts.boundaries,
    },
  };

  void trackingInput.sharedFacts.boundaries;
  return trackingInput;
}

/**
 * Clones the shared tracking snapshot into the mutable state used by the object-path stage.
 */
export function createObjectPathStageContext(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): ObjectPathStageContext {
  const trackingInput = createObjectPathTrackingInput(artifacts);
  const overlayState: ObjectPathOverlayState = {
    readsByObjectId: new Map(),
    writesByObjectId: new Map(),
    observedSubtreesByObjectId: new Map(),
    observedAliasesByObjectId: new Map(),
    invalidatedCollectionsByObjectId: new Map(),
    escapedPathsByObjectId: new Map(),
    boundaryRecordsByObjectId: new Map(),
  };
  const trackedObjectRegistry = new Map(
    [...trackingInput.sharedFacts.aliases.trackedObjectsById.entries()].map(([id, trackedObject]) => [
      id,
      cloneTrackedObjectForObjectPathStage(trackedObject),
    ]),
  );
  const trackedBindingRegistry = new Map(
    [...trackingInput.sharedFacts.bindings.bySymbolId.entries()].map(([symbolId, binding]) => [
      symbolId,
      cloneTrackedObjectBindingForObjectPathStage(binding, trackedObjectRegistry),
    ]),
  );
  const functionReturnSummaries = new Map(
    [...trackingInput.sharedFacts.returnSummaries.byCallableId.entries()].map(([callableId, summary]) => [
      callableId,
      cloneCallableReturnSummaryForObjectPathStage(summary, trackedObjectRegistry),
    ]),
  );
  const publiclyReachableCallableIds = computePubliclyReachableCallableIds({
    publicSurfaceIds: artifacts.publicSurfaceIds,
    publicCallableIds: artifacts.publicCallableIds,
    trackedBySymbolId: trackedBindingRegistry,
    functionReturnSummaries,
    trackedObjectsById: trackedObjectRegistry,
  });

  return {
    project,
    reachableFiles,
    publicSurfaceIds: artifacts.publicSurfaceIds,
    publiclyReachableCallableIds,
    state,
    suppressionContext,
    functionReturnSummaries,
    overlayState,
    trackedBindingRegistry,
    trackedObjectRegistry,
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
        higherOrderCallableReturnSummaryCache: new Map<string, HigherOrderCallableReturnSummary | null>(),
      };
    },
  };
}
