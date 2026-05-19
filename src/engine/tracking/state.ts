import type ts from "typescript";

import type {
  EntityRecord, InvalidatedPathRecord, PathSegment, ProjectContext, SkipCategory,
  TrackedCollectionInfo, TrackedCollectionState, TrackedPlaceState, TrackedObject,
} from "../../types.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { FINDING_KIND } from "../../shared/finding-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { TRACKED_OBJECT_NODE_ORIGIN } from "../../shared/path-vocabulary.js";
import { SKIP_CATEGORY } from "../../shared/skip-category-vocabulary.js";
import { isSerializedPathWithin, renderPath, renderPathWithRoot, samePath, serializePath } from "../../shared/path-utils.js";
import { CollectionInfoRecord, CollectionState } from "./model.js";
import { TRACKING_COLLECTION_KIND, TRACKING_PLACE_STATE, TRACKING_VALUE_FATE } from "./vocabulary.js";
import type { ArrayProjectionBinding, ExactAppendSlotPlan, TrackedObjectBinding, TrackedValueFate } from "./model.js";

/**
 * Shared tracked-object state and collection helpers for the exact tracking kernel.
 *
 * This module centralizes tracked-path mutation, alias bookkeeping, collection invalidation,
 * and projection helpers so both heavy stages reuse the same state-transition rules.
 */

export function bumpTrackedObjectDerivedStateRevision(trackedObject: TrackedObject): void {
  trackedObject.derivedStateRevision += 1;
}

function observeTrackedValueFateShape(record: TrackedObject["valueFates"][number]): void {
  void record.fate;
  void record.path;
  void record.reason;
  void record.relatedObjectId;
  void record.relatedPath;
}

export function addValueFate(
  trackedObject: TrackedObject,
  fate: TrackedValueFate,
  path: PathSegment[],
  reason: string,
  relatedObjectId?: string,
  relatedPath?: PathSegment[],
): void {
  for (const record of trackedObject.valueFates) {
    if (
      record.fate === fate
      && record.reason === reason
      && samePath(record.path, path)
      && record.relatedObjectId === relatedObjectId
      && samePath(record.relatedPath ?? [], relatedPath ?? [])
    ) {
      return;
    }
  }

  const record: TrackedObject["valueFates"][number] = {
    fate,
    path,
    reason,
    relatedObjectId,
    relatedPath,
  };
  observeTrackedValueFateShape(record);
  trackedObject.valueFates.push(record);
}

function clearExactAliasesWithin(trackedObject: TrackedObject, segments: PathSegment[]): void {
  const prefix = serializePath(segments);
  for (const key of [...trackedObject.exactPathAliases.keys()]) {
    if (isSerializedPathWithin(key, prefix)) {
      if (trackedObject.exactPathAliases.delete(key)) {
        bumpTrackedObjectDerivedStateRevision(trackedObject);
      }
    }
  }
}

export function registerExactPathAlias(
  receiver: TrackedObject,
  receiverPath: PathSegment[],
  sourceBinding: TrackedObjectBinding,
  reason: string,
): void {
  const serializedReceiverPath = serializePath(receiverPath);
  const existingAlias = receiver.exactPathAliases.get(serializedReceiverPath);
  if (
    existingAlias
    && existingAlias.sourceObjectId === sourceBinding.trackedObject.id
    && samePath(existingAlias.sourcePath, sourceBinding.prefix)
  ) {
    return;
  }

  receiver.exactPathAliases.set(serializedReceiverPath, {
    fate: TRACKING_VALUE_FATE.insertedByReference,
    sourceObjectId: sourceBinding.trackedObject.id,
    sourcePath: sourceBinding.prefix,
    observed: false,
  });
  bumpTrackedObjectDerivedStateRevision(receiver);
  addValueFate(
    receiver,
    TRACKING_VALUE_FATE.insertedByReference,
    receiverPath,
    reason,
    sourceBinding.trackedObject.id,
    sourceBinding.prefix,
  );
  addValueFate(
    sourceBinding.trackedObject,
    TRACKING_VALUE_FATE.insertedByReference,
    sourceBinding.prefix,
    reason,
    receiver.id,
    receiverPath,
  );
}

export function materializeExactAppendSlot(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  receiverPath: PathSegment[],
  slotPlan: ExactAppendSlotPlan,
): void {
  ensureTrackedArraySlotNode(project, trackedObject, sourceFile, node, receiverPath);
  clearExactAliasesWithin(trackedObject, receiverPath);
  if (slotPlan.kind === "alias") {
    registerExactPathAlias(trackedObject, receiverPath, slotPlan.binding, slotPlan.insertReason);
    if (slotPlan.observeSourceAtInsert) {
      markRead(slotPlan.binding.trackedObject, slotPlan.binding.prefix);
      if (slotPlan.sourceObservationReason) {
        addValueFate(
          slotPlan.binding.trackedObject,
          "observed",
          slotPlan.binding.prefix,
          slotPlan.sourceObservationReason,
          trackedObject.id,
          receiverPath,
        );
      }
    }
  }
  markWrite(trackedObject, receiverPath);
}

/**
 * Resolves an exact alias hop without changing the exact-path contract for callers.
 */
export function resolveExactPathAlias(
  binding: TrackedObjectBinding,
  nextSegments: PathSegment[],
  trackedObjectsById: Map<string, TrackedObject>,
): { binding: TrackedObjectBinding; viaAliasObjectId?: string; viaAliasPath?: PathSegment[] } {
  const fullPath = [...binding.prefix, ...nextSegments];
  const alias = binding.trackedObject.exactPathAliases.get(serializePath(fullPath));
  if (!alias) {
    return { binding, viaAliasObjectId: undefined, viaAliasPath: undefined };
  }

  const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
  if (!sourceTrackedObject) {
    return { binding, viaAliasObjectId: undefined, viaAliasPath: undefined };
  }

  return {
    binding: {
      trackedObject: sourceTrackedObject,
      prefix: alias.sourcePath,
    },
    viaAliasObjectId: binding.trackedObject.id,
    viaAliasPath: fullPath,
  };
}

export function buildCollectionBoundaryEntity(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  segments: PathSegment[],
): EntityRecord {
  return makeEntity(
    project.rootPath,
    ENTITY_KIND.collectionBoundary,
    sourceFile,
    node,
    renderPathWithRoot(trackedObject.rootName, segments),
    trackedObject.rootName,
  );
}

export function getCollectionInfo(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): TrackedCollectionInfo | undefined {
  return trackedObject.collections.get(serializePath(segments));
}

function getCollectionState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): TrackedCollectionState | undefined {
  return trackedObject.collectionStates.get(serializePath(segments));
}

function ensureCollectionState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  arrayLength?: number,
): TrackedCollectionState {
  const joinedPath = serializePath(segments);
  const existing = trackedObject.collectionStates.get(joinedPath);
  if (existing) {
    if (arrayLength !== undefined) {
      existing.arrayLength = arrayLength;
    }
    return existing;
  }

  const created = new CollectionState(segments, 0, arrayLength);
  trackedObject.collectionStates.set(joinedPath, created);
  return created;
}

export function setCollectionInfo(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  kind: TrackedCollectionInfo["kind"],
  arrayLength?: number,
): TrackedCollectionInfo {
  const info = new CollectionInfoRecord(kind, segments, arrayLength);
  trackedObject.collections.set(serializePath(segments), info);
  ensureCollectionState(trackedObject, segments, arrayLength);
  return info;
}

export function getTrackedArrayLength(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): number | undefined {
  const state = getCollectionState(trackedObject, segments);
  if (state?.arrayLength !== undefined) {
    return state.arrayLength;
  }

  return getCollectionInfo(trackedObject, segments)?.arrayLength;
}

export function setTrackedArrayLength(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  arrayLength: number,
): void {
  const state = ensureCollectionState(trackedObject, segments, Math.max(arrayLength, 0));
  state.arrayLength = Math.max(arrayLength, 0);
  const collection = getCollectionInfo(trackedObject, segments);
  if (collection) {
    collection.arrayLength = state.arrayLength;
  }
}

export function ensureCollectionChildPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  childPath: PathSegment[],
): void {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection) {
    return;
  }

  for (const existing of collection.childPaths) {
    if (samePath(existing, childPath)) {
      return;
    }
  }

  collection.childPaths.push(childPath);
}

function ensureTrackedArraySlotNode(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  const joinedPath = serializePath(fullPath);
  if (!trackedObject.nodes.has(joinedPath)) {
    const entity = makeEntity(
      project.rootPath,
      fullPath.length === 1 ? ENTITY_KIND.arrayElement : ENTITY_KIND.nestedPath,
      sourceFile,
      node,
      renderPath(fullPath),
      trackedObject.rootName,
    );
    trackedObject.nodes.set(joinedPath, {
      entity,
      fullPath,
      origin: TRACKED_OBJECT_NODE_ORIGIN.arrayElement,
    });
    indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
  }

  trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
}

function setPlaceState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  placeState: TrackedPlaceState,
): void {
  trackedObject.placeStates.set(serializePath(segments), placeState);
}

export function createInvalidatedPathRecord(
  category: SkipCategory,
  reason: string,
): InvalidatedPathRecord {
  switch (category) {
    case SKIP_CATEGORY.arrayReplacementMutation:
      return {
        findingKind: FINDING_KIND.invalidatedRead,
        reason,
      };
    case SKIP_CATEGORY.arrayTruncateMutation:
    case SKIP_CATEGORY.arrayReorderMutation:
      return {
        findingKind: FINDING_KIND.staleReadAfterMutation,
        reason,
      };
    default:
      return {
        reason,
      };
  }
}

export function getNearestArrayCollectionPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): PathSegment[] | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const candidate = segments.slice(0, index);
    if (getCollectionInfo(trackedObject, candidate)?.kind === TRACKING_COLLECTION_KIND.array) {
      return candidate;
    }
  }

  return undefined;
}

export function hasTrackedChildren(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  return (trackedObject.descendantNodeKeys.get(serializePath(segments))?.length ?? 0) > 0;
}

export function indexTrackedObjectNode(
  trackedObject: TrackedObject,
  serializedPath: string,
  fullPath: PathSegment[],
): void {
  for (let index = 0; index < fullPath.length; index += 1) {
    const prefix = serializePath(fullPath.slice(0, index));
    const descendantKeys = trackedObject.descendantNodeKeys.get(prefix);
    if (descendantKeys) {
      descendantKeys.push(serializedPath);
    } else {
      trackedObject.descendantNodeKeys.set(prefix, [serializedPath]);
    }
  }
}

export function getProjectionBinding(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): ArrayProjectionBinding | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== TRACKING_COLLECTION_KIND.array) {
    return undefined;
  }

  return {
    trackedObject,
    sourcePath: segments,
    elementPaths: collection.childPaths,
  };
}

export function getConcreteProjectionPaths(
  projection: ArrayProjectionBinding,
  suffix: PathSegment[] = [],
): PathSegment[][] {
  const concretePaths: PathSegment[][] = [];

  for (const elementPath of projection.elementPaths) {
    const fullPath = [...elementPath, ...suffix];
    const serializedPath = serializePath(fullPath);
    if (
      projection.trackedObject.nodes.has(serializedPath)
      || projection.trackedObject.collections.has(serializedPath)
      || projection.trackedObject.exactPathAliases.has(serializedPath)
      || hasTrackedChildren(projection.trackedObject, fullPath)
    ) {
      concretePaths.push(fullPath);
    }
  }

  return concretePaths;
}

function markRead(trackedObject: TrackedObject, segments: PathSegment[]): void {
  for (let index = 1; index <= segments.length; index += 1) {
    trackedObject.reads.add(serializePath(segments.slice(0, index)));
  }
}

function markWrite(trackedObject: TrackedObject, segments: PathSegment[]): void {
  trackedObject.writes.add(serializePath(segments));
  setPlaceState(trackedObject, segments, TRACKING_PLACE_STATE.initialized);
}

/**
 * Marks a tracked path as no longer exact and clears any exact aliases nested beneath it.
 */
export function markEscaped(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  category: SkipCategory,
  reason: string,
): void {
  trackedObject.escapedPaths.set(serializePath(segments), { category, reason });
  bumpTrackedObjectDerivedStateRevision(trackedObject);
  setPlaceState(trackedObject, segments, TRACKING_PLACE_STATE.escaped);
  addValueFate(trackedObject, TRACKING_VALUE_FATE.escapedOpaquely, segments, reason);
  if (!(category === SKIP_CATEGORY.opaqueObjectCall && segments.length === 0)) {
    clearExactAliasesWithin(trackedObject, segments);
  }
}
