import type ts from "typescript";

import type {
  EscapedPathRecord,
  EntityRecord,
  InvalidatedPathRecord,
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedCollectionInfo,
  TrackedCollectionState,
  TrackedPlaceState,
  TrackedObject,
} from "../../types.js";
import { makeEntity } from "../../shared/entity-utils.js";
import {
  isSerializedPathWithin,
  renderPath,
  renderPathWithRoot,
  samePath,
  serializePath,
} from "../../shared/path-utils.js";
import {
  CollectionInfoRecord,
  CollectionState,
} from "./model.js";
import type {
  ArrayProjectionBinding,
  ExactAppendSlotPlan,
  TrackedObjectBinding,
  TrackedValueFate,
} from "./model.js";

/**
 * Shared tracked-object state and collection helpers for the exact tracking kernel.
 *
 * This module centralizes tracked-path mutation, alias bookkeeping, collection invalidation,
 * and projection helpers so both heavy stages reuse the same state-transition rules.
 */

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

  trackedObject.valueFates.push({
    fate,
    path,
    reason,
    relatedObjectId,
    relatedPath,
  });
}

function clearExactAliasesWithin(trackedObject: TrackedObject, segments: PathSegment[]): void {
  const prefix = serializePath(segments);
  for (const key of [...trackedObject.exactPathAliases.keys()]) {
    if (isSerializedPathWithin(key, prefix)) {
      trackedObject.exactPathAliases.delete(key);
    }
  }
}

export function registerExactPathAlias(
  receiver: TrackedObject,
  receiverPath: PathSegment[],
  sourceBinding: TrackedObjectBinding,
  reason: string,
): void {
  receiver.exactPathAliases.set(serializePath(receiverPath), {
    fate: "inserted-by-reference",
    sourceObjectId: sourceBinding.trackedObject.id,
    sourcePath: sourceBinding.prefix,
    observed: false,
  });
  addValueFate(
    receiver,
    "inserted-by-reference",
    receiverPath,
    reason,
    sourceBinding.trackedObject.id,
    sourceBinding.prefix,
  );
  addValueFate(
    sourceBinding.trackedObject,
    "inserted-by-reference",
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
    "collection-boundary",
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
  kind: "object" | "array",
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
      fullPath.length === 1 ? "array-element" : "nested-path",
      sourceFile,
      node,
      renderPath(fullPath),
      trackedObject.rootName,
    );
    trackedObject.nodes.set(joinedPath, { entity, fullPath });
    indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
  }

  trackedObject.placeStates.set(joinedPath, "initialized");
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
    case "array-replacement-mutation":
      return {
        findingKind: "invalidated-read",
        reason,
      };
    case "array-truncate-mutation":
    case "array-reorder-mutation":
      return {
        findingKind: "stale-read-after-mutation",
        reason,
      };
    default:
      return {
        reason,
      };
  }
}

export function isCollectionPathInvalidated(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  for (let index = segments.length; index >= 0; index -= 1) {
    if (trackedObject.invalidatedCollectionPaths.has(serializePath(segments.slice(0, index)))) {
      return true;
    }
  }
  return false;
}

export function getNearestArrayCollectionPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): PathSegment[] | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const candidate = segments.slice(0, index);
    if (getCollectionInfo(trackedObject, candidate)?.kind === "array") {
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
  if (!collection || collection.kind !== "array") {
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
  setPlaceState(trackedObject, segments, "initialized");
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
  setPlaceState(trackedObject, segments, "escaped");
  addValueFate(trackedObject, "escaped-opaquely", segments, reason);
  if (!(category === "opaque-object-call" && segments.length === 0)) {
    clearExactAliasesWithin(trackedObject, segments);
  }
}

export function getEscapedReason(trackedObject: TrackedObject, segments: PathSegment[]): EscapedPathRecord | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const key = serializePath(segments.slice(0, index));
    const escaped = trackedObject.escapedPaths.get(key);
    if (escaped) {
      return escaped;
    }
  }
  return undefined;
}
