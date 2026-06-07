import type { CollectionBoundaryRecord, EscapedPathRecord, InvalidatedPathRecord, PathSegment, SkipCategory, TrackedObject } from "../../../types.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { isSerializedPathWithin, serializePath } from "../../../shared/path-utils.js";
import { extendTrackedBinding } from "../bindings.js";
import type { ArrayProjectionBinding, ResolvedTrackedObjectAccess, TrackedObjectBinding } from "../model.js";
import { getCollectionInfo, hasTrackedChildren, resolveExactPathAlias } from "../state.js";

type PathSetByObjectId = Map<string, Set<string>>;
type PathRecordMapByObjectId<TRecord> = Map<string, Map<string, TRecord>>;
type InvalidationRecord = InvalidatedPathRecord | null;

export interface ObjectPathOverlayState {
  readsByObjectId: PathSetByObjectId;
  writesByObjectId: PathSetByObjectId;
  observedSubtreesByObjectId: PathSetByObjectId;
  observedAliasesByObjectId: PathSetByObjectId;
  invalidatedCollectionsByObjectId: PathRecordMapByObjectId<InvalidationRecord>;
  escapedPathsByObjectId: PathRecordMapByObjectId<EscapedPathRecord>;
  boundaryRecordsByObjectId: PathRecordMapByObjectId<CollectionBoundaryRecord>;
}

export function createObjectPathOverlayState(
  trackedObjects: Iterable<TrackedObject> = [],
): ObjectPathOverlayState {
  const overlayState: ObjectPathOverlayState = {
    readsByObjectId: new Map(),
    writesByObjectId: new Map(),
    observedSubtreesByObjectId: new Map(),
    observedAliasesByObjectId: new Map(),
    invalidatedCollectionsByObjectId: new Map(),
    escapedPathsByObjectId: new Map(),
    boundaryRecordsByObjectId: new Map(),
  };

  for (const trackedObject of trackedObjects) {
    if (trackedObject.collectionBoundaries.size > 0) {
      const boundaries = ensurePathRecordMap(overlayState.boundaryRecordsByObjectId, trackedObject.id);
      for (const [recordId, boundary] of trackedObject.collectionBoundaries.entries()) {
        boundaries.set(recordId, boundary);
      }
    }

    if (trackedObject.invalidatedCollectionPaths.size > 0) {
      const invalidations = ensurePathRecordMap(overlayState.invalidatedCollectionsByObjectId, trackedObject.id);
      for (const joinedPath of trackedObject.invalidatedCollectionPaths) {
        invalidations.set(joinedPath, trackedObject.invalidatedPaths.get(joinedPath) ?? null);
      }
    }

    if (trackedObject.escapedPaths.size > 0) {
      const escapes = ensurePathRecordMap(overlayState.escapedPathsByObjectId, trackedObject.id);
      for (const [joinedPath, escaped] of trackedObject.escapedPaths.entries()) {
        escapes.set(joinedPath, escaped);
      }
    }
  }

  return overlayState;
}

function ensurePathSet(pathsByObjectId: PathSetByObjectId, objectId: string): Set<string> {
  const existing = pathsByObjectId.get(objectId);
  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  pathsByObjectId.set(objectId, created);
  return created;
}

function ensurePathRecordMap<TRecord>(
  recordsByObjectId: PathRecordMapByObjectId<TRecord>,
  objectId: string,
): Map<string, TRecord> {
  const existing = recordsByObjectId.get(objectId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, TRecord>();
  recordsByObjectId.set(objectId, created);
  return created;
}

function getPathSet(pathsByObjectId: PathSetByObjectId, objectId: string): ReadonlySet<string> | undefined {
  return pathsByObjectId.get(objectId);
}

function getPathRecordMap<TRecord>(
  recordsByObjectId: PathRecordMapByObjectId<TRecord>,
  objectId: string,
): ReadonlyMap<string, TRecord> | undefined {
  return recordsByObjectId.get(objectId);
}

function clearTrackedObjectExactAliasesWithin(trackedObject: TrackedObject, segments: PathSegment[]): void {
  const prefix = serializePath(segments);
  for (const key of [...trackedObject.exactPathAliases.keys()]) {
    if (isSerializedPathWithin(key, prefix)) {
      trackedObject.exactPathAliases.delete(key);
    }
  }
}

function markSerializedRead(overlayState: ObjectPathOverlayState, objectId: string, joinedPath: string): void {
  ensurePathSet(overlayState.readsByObjectId, objectId).add(joinedPath);
}

function markSerializedObservedAlias(overlayState: ObjectPathOverlayState, objectId: string, joinedPath: string): void {
  ensurePathSet(overlayState.observedAliasesByObjectId, objectId).add(joinedPath);
}

function hasConcreteTrackedPath(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  if (segments.length === 0) {
    return true;
  }

  const serializedPath = serializePath(segments);
  return (
    trackedObject.nodes.has(serializedPath)
    || trackedObject.collections.has(serializedPath)
    || trackedObject.exactPathAliases.has(serializedPath)
    || hasTrackedChildren(trackedObject, segments)
  );
}

function markObservedAliasRead(
  overlayState: ObjectPathOverlayState,
  receiverTrackedObject: TrackedObject,
  receiverPath: PathSegment[],
  sourceTrackedObject: TrackedObject,
  sourcePath: PathSegment[],
  trackedObjectsById?: Map<string, TrackedObject>,
  observeSubtree = false,
): void {
  markSerializedObservedAlias(overlayState, receiverTrackedObject.id, serializePath(receiverPath));

  if (observeSubtree && trackedObjectsById) {
    markObjectPathObservedSubtree(overlayState, receiverTrackedObject, receiverPath, trackedObjectsById);
    markObjectPathObservedSubtree(overlayState, sourceTrackedObject, sourcePath, trackedObjectsById);
    return;
  }

  markObjectPathRead(overlayState, receiverTrackedObject, receiverPath);
  markObjectPathRead(overlayState, sourceTrackedObject, sourcePath);
}

function markObservedPath(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
  trackedObjectsById?: Map<string, TrackedObject>,
): void {
  const alias = trackedObject.exactPathAliases.get(serializePath(segments));
  if (alias) {
    const sourceTrackedObject = trackedObjectsById?.get(alias.sourceObjectId);
    if (sourceTrackedObject) {
      markObservedAliasRead(
        overlayState,
        trackedObject,
        segments,
        sourceTrackedObject,
        alias.sourcePath,
        trackedObjectsById,
      );
      return;
    }
  }

  markObjectPathRead(overlayState, trackedObject, segments);
}

function markProjectionAliasHopObserved(
  overlayState: ObjectPathOverlayState,
  receiverTrackedObject: TrackedObject,
  receiverPath: PathSegment[],
  consumedSuffixLength: number,
  suffix: PathSegment[],
  mode: "self" | "subtree" | "children" | "write",
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  const fullReceiverPath = [...receiverPath, ...suffix.slice(consumedSuffixLength)];

  markSerializedObservedAlias(overlayState, receiverTrackedObject.id, serializePath(fullReceiverPath));

  if (mode === "subtree") {
    markObjectPathObservedSubtree(overlayState, receiverTrackedObject, fullReceiverPath, trackedObjectsById);
    return;
  }

  if (mode === "children") {
    markObjectPathObservedChildPaths(overlayState, receiverTrackedObject, fullReceiverPath, trackedObjectsById);
    return;
  }

  if (mode === "write") {
    markObjectPathWrite(overlayState, receiverTrackedObject, fullReceiverPath);
    return;
  }

  markObjectPathRead(overlayState, receiverTrackedObject, fullReceiverPath);
}

function applyResolvedProjectionTargets(
  overlayState: ObjectPathOverlayState,
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[],
  mode: "self" | "subtree" | "children" | "write",
): void {
  for (const elementPath of projection.elementPaths) {
    let currentBinding: TrackedObjectBinding = {
      trackedObject: projection.trackedObject,
      prefix: elementPath,
    };

    const rootAlias = resolveExactPathAlias(currentBinding, [], trackedObjectsById);
    if (rootAlias.viaAliasObjectId && rootAlias.viaAliasPath) {
      currentBinding = rootAlias.binding;
    }

    for (const segment of suffix) {
      const aliased = resolveExactPathAlias(currentBinding, [segment], trackedObjectsById);
      if (aliased.viaAliasObjectId && aliased.viaAliasPath) {
        currentBinding = aliased.binding;
        continue;
      }

      currentBinding = extendTrackedBinding(currentBinding, [segment]);
    }

    if (!hasConcreteTrackedPath(currentBinding.trackedObject, currentBinding.prefix)) {
      continue;
    }

    let replayBinding: TrackedObjectBinding = {
      trackedObject: projection.trackedObject,
      prefix: elementPath,
    };
    const replayRootAlias = resolveExactPathAlias(replayBinding, [], trackedObjectsById);
    if (replayRootAlias.viaAliasObjectId && replayRootAlias.viaAliasPath) {
      const receiverTrackedObject = trackedObjectsById.get(replayRootAlias.viaAliasObjectId);
      if (receiverTrackedObject) {
        markProjectionAliasHopObserved(
          overlayState,
          receiverTrackedObject,
          replayRootAlias.viaAliasPath,
          0,
          suffix,
          mode,
          trackedObjectsById,
        );
      }
      replayBinding = replayRootAlias.binding;
    }

    for (const [index, segment] of suffix.entries()) {
      const replayAliased = resolveExactPathAlias(replayBinding, [segment], trackedObjectsById);
      if (replayAliased.viaAliasObjectId && replayAliased.viaAliasPath) {
        const receiverTrackedObject = trackedObjectsById.get(replayAliased.viaAliasObjectId);
        if (receiverTrackedObject) {
          markProjectionAliasHopObserved(
            overlayState,
            receiverTrackedObject,
            replayAliased.viaAliasPath,
            index + 1,
            suffix,
            mode,
            trackedObjectsById,
          );
        }
        replayBinding = replayAliased.binding;
        continue;
      }

      replayBinding = extendTrackedBinding(replayBinding, [segment]);
    }

    if (mode === "subtree") {
      markObjectPathObservedSubtree(overlayState, currentBinding.trackedObject, currentBinding.prefix, trackedObjectsById);
      continue;
    }

    if (mode === "children") {
      markObjectPathObservedChildPaths(overlayState, currentBinding.trackedObject, currentBinding.prefix, trackedObjectsById);
      continue;
    }

    if (mode === "write") {
      markObjectPathWrite(overlayState, currentBinding.trackedObject, currentBinding.prefix);
      continue;
    }

    markObjectPathRead(overlayState, currentBinding.trackedObject, currentBinding.prefix);
  }
}

export function getObjectPathOverlayReads(overlayState: ObjectPathOverlayState, objectId: string): ReadonlySet<string> | undefined {
  return getPathSet(overlayState.readsByObjectId, objectId);
}

export function getObjectPathOverlayWrites(overlayState: ObjectPathOverlayState, objectId: string): ReadonlySet<string> | undefined {
  return getPathSet(overlayState.writesByObjectId, objectId);
}

export function getObjectPathOverlayObservedSubtrees(
  overlayState: ObjectPathOverlayState,
  objectId: string,
): ReadonlySet<string> | undefined {
  return getPathSet(overlayState.observedSubtreesByObjectId, objectId);
}

export function getObjectPathOverlayObservedAliases(
  overlayState: ObjectPathOverlayState,
  objectId: string,
): ReadonlySet<string> | undefined {
  return getPathSet(overlayState.observedAliasesByObjectId, objectId);
}

export function getObjectPathOverlayInvalidatedPathRecord(
  overlayState: ObjectPathOverlayState,
  objectId: string,
  segments: PathSegment[],
): InvalidatedPathRecord | undefined {
  const invalidatedByPath = overlayState.invalidatedCollectionsByObjectId.get(objectId);
  if (!invalidatedByPath) {
    return undefined;
  }

  for (let index = segments.length; index >= 0; index -= 1) {
    const invalidated = invalidatedByPath.get(serializePath(segments.slice(0, index)));
    if (invalidated !== undefined) {
      return invalidated ?? undefined;
    }
  }

  return undefined;
}

export function getObjectPathOverlayBoundaryRecords(
  overlayState: ObjectPathOverlayState,
  objectId: string,
): ReadonlyMap<string, CollectionBoundaryRecord> | undefined {
  return getPathRecordMap(overlayState.boundaryRecordsByObjectId, objectId);
}

export function getObjectPathOverlayEscapedReason(
  overlayState: ObjectPathOverlayState,
  objectId: string,
  segments: PathSegment[],
): EscapedPathRecord | undefined {
  const escapedByPath = overlayState.escapedPathsByObjectId.get(objectId);
  if (!escapedByPath) {
    return undefined;
  }

  for (let index = segments.length; index >= 0; index -= 1) {
    const escaped = escapedByPath.get(serializePath(segments.slice(0, index)));
    if (escaped) {
      return escaped;
    }
  }

  return undefined;
}

export function isObjectPathOverlayCollectionPathInvalidated(
  overlayState: ObjectPathOverlayState,
  objectId: string,
  segments: PathSegment[],
): boolean {
  const invalidatedPaths = overlayState.invalidatedCollectionsByObjectId.get(objectId);
  if (!invalidatedPaths) {
    return false;
  }

  for (let index = segments.length; index >= 0; index -= 1) {
    if (invalidatedPaths.has(serializePath(segments.slice(0, index)))) {
      return true;
    }
  }

  return false;
}

export function markObjectPathRead(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
): void {
  for (let index = 1; index <= segments.length; index += 1) {
    markSerializedRead(overlayState, trackedObject.id, serializePath(segments.slice(0, index)));
  }
}

export function markObjectPathWrite(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
): void {
  ensurePathSet(overlayState.writesByObjectId, trackedObject.id).add(serializePath(segments));
}

export function markObjectPathAliasObserved(
  overlayState: ObjectPathOverlayState,
  resolved: ResolvedTrackedObjectAccess,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  if (!resolved.viaAliasObjectId || !resolved.viaAliasPath) {
    return;
  }

  const receiver = trackedObjectsById.get(resolved.viaAliasObjectId);
  markSerializedObservedAlias(overlayState, resolved.viaAliasObjectId, serializePath(resolved.viaAliasPath));
  if (receiver) {
    markObjectPathRead(overlayState, receiver, resolved.viaAliasPath);
  }
}

export function markObjectPathObservedChildPaths(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
  trackedObjectsById?: Map<string, TrackedObject>,
): void {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.childPaths.length === 0) {
    markObservedPath(overlayState, trackedObject, segments, trackedObjectsById);
    return;
  }

  for (const childPath of collection.childPaths) {
    markObservedPath(overlayState, trackedObject, childPath, trackedObjectsById);
  }
}

export function markObjectPathObservedSubtree(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
  trackedObjectsById?: Map<string, TrackedObject>,
  visited = new Set<string>(),
): void {
  const joinedPrefix = serializePath(segments);
  const visitKey = `${trackedObject.id}:${joinedPrefix}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);

  ensurePathSet(overlayState.observedSubtreesByObjectId, trackedObject.id).add(joinedPrefix);
  markSerializedRead(overlayState, trackedObject.id, joinedPrefix);

  const descendantKeys = trackedObject.descendantNodeKeys.get(joinedPrefix);
  if (descendantKeys) {
    for (const joinedPath of descendantKeys) {
      if (isSerializedPathWithin(joinedPath, joinedPrefix)) {
        markSerializedRead(overlayState, trackedObject.id, joinedPath);
      }
    }
  }

  if (!trackedObjectsById || trackedObject.exactPathAliases.size === 0) {
    return;
  }

  for (const [aliasPath, alias] of trackedObject.exactPathAliases.entries()) {
    if (!isSerializedPathWithin(aliasPath, joinedPrefix)) {
      continue;
    }
    markSerializedObservedAlias(overlayState, trackedObject.id, aliasPath);
    const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
    if (sourceTrackedObject) {
      markObjectPathObservedSubtree(overlayState, sourceTrackedObject, alias.sourcePath, trackedObjectsById, visited);
    }
  }
}

export function markObjectPathProjectionReads(
  overlayState: ObjectPathOverlayState,
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[] = [],
  observeSubtree = false,
): void {
  applyResolvedProjectionTargets(overlayState, projection, trackedObjectsById, suffix, observeSubtree ? "subtree" : "self");
}

export function markObjectPathProjectionChildReads(
  overlayState: ObjectPathOverlayState,
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[] = [],
): void {
  applyResolvedProjectionTargets(overlayState, projection, trackedObjectsById, suffix, "children");
}

export function markObjectPathProjectionWrites(
  overlayState: ObjectPathOverlayState,
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[],
): void {
  applyResolvedProjectionTargets(overlayState, projection, trackedObjectsById, suffix, "write");
}

export function markObjectPathProjectionElementRead(
  overlayState: ObjectPathOverlayState,
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  index: number,
  observeSubtree = false,
): void {
  const elementPath = projection.elementPaths[index];
  if (!elementPath) {
    return;
  }

  applyResolvedProjectionTargets(
    overlayState,
    {
      trackedObject: projection.trackedObject,
      sourcePath: projection.sourcePath,
      elementPaths: [elementPath],
    },
    trackedObjectsById,
    [],
    observeSubtree ? "subtree" : "self",
  );
}

export function recordObjectPathCollectionBoundary(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  record: CollectionBoundaryRecord,
  invalidatePath?: PathSegment[],
  invalidatedRecord?: InvalidatedPathRecord,
): void {
  ensurePathRecordMap(overlayState.boundaryRecordsByObjectId, trackedObject.id).set(record.entity.id, record);
  clearTrackedObjectExactAliasesWithin(trackedObject, record.path);

  if (!invalidatePath) {
    return;
  }

  const joinedPath = serializePath(invalidatePath);
  ensurePathRecordMap(overlayState.invalidatedCollectionsByObjectId, trackedObject.id).set(joinedPath, invalidatedRecord ?? null);
  clearTrackedObjectExactAliasesWithin(trackedObject, invalidatePath);
}

export function invalidateObjectPathCollectionPath(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  affectedPath: PathSegment[],
  invalidatedRecord?: InvalidatedPathRecord,
): void {
  const joinedPath = serializePath(affectedPath);
  ensurePathRecordMap(overlayState.invalidatedCollectionsByObjectId, trackedObject.id).set(joinedPath, invalidatedRecord ?? null);
  clearTrackedObjectExactAliasesWithin(trackedObject, affectedPath);
}

export function markObjectPathEscaped(
  overlayState: ObjectPathOverlayState,
  trackedObject: TrackedObject,
  segments: PathSegment[],
  category: SkipCategory,
  reason: string,
): void {
  ensurePathRecordMap(overlayState.escapedPathsByObjectId, trackedObject.id).set(serializePath(segments), { category, reason });
  if (!(category === SKIP_CATEGORY.opaqueObjectCall && segments.length === 0)) {
    clearTrackedObjectExactAliasesWithin(trackedObject, segments);
  }
}
