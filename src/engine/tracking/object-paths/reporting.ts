import { getSuppressionAudit } from "../../../suppressions.js";
import type {
  CollectionBoundaryRecord,
  PathSegment,
  ProjectContext,
  SuppressionContext,
  TrackedObject,
} from "../../../types.js";
import { kindToFinding } from "../../../shared/entity-utils.js";
import { renderPathWithRoot, serializePath } from "../../../shared/path-utils.js";
import {
  addAudit,
  addFinding,
  addSkipped,
  type AnalysisState,
} from "../../analysis-state.js";
import {
  getCollectionInfo,
  getEscapedReason,
  hasTrackedChildren,
  isCollectionPathInvalidated,
} from "../state.js";
import { shouldSuppressStructuralPath, shouldSuppressStructuralRoot } from "../syntax.js";
import {
  getObjectPathOverlayBoundaryRecords,
  getObjectPathOverlayEscapedReason,
  getObjectPathOverlayObservedAliases,
  getObjectPathOverlayObservedSubtrees,
  getObjectPathOverlayReads,
  getObjectPathOverlayWrites,
  isObjectPathOverlayCollectionPathInvalidated,
  type ObjectPathOverlayState,
} from "./overlay.js";

function getReportingReads(
  reportingReadsById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): ReadonlySet<string> {
  return reportingReadsById.get(tracked.id) ?? new Set<string>();
}

function getReportingObservedSubtrees(
  reportingObservedSubtreesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): ReadonlySet<string> {
  return reportingObservedSubtreesById.get(tracked.id) ?? new Set<string>();
}

function getReportingObservedAliases(
  reportingObservedAliasesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): Set<string> {
  return new Set(reportingObservedAliasesById.get(tracked.id) ?? []);
}

function getReportingBoundaries(
  overlayState: ObjectPathOverlayState,
  tracked: TrackedObject,
): ReadonlyMap<string, CollectionBoundaryRecord> {
  return getObjectPathOverlayBoundaryRecords(overlayState, tracked.id) ?? tracked.collectionBoundaries;
}

function hasBoundaryAtPath(
  boundaries: ReadonlyMap<string, CollectionBoundaryRecord>,
  path: PathSegment[],
): boolean {
  const joinedPath = serializePath(path);
  return [...boundaries.values()].some((boundary) => serializePath(boundary.path) === joinedPath);
}

function shouldReportBoundary(
  overlayState: ObjectPathOverlayState,
  reportingObservedSubtreesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
  path: PathSegment[],
): boolean {
  const joinedPath = serializePath(path);
  const collection = getCollectionInfo(tracked, path);
  const hasExactCoverage = tracked.nodes.has(joinedPath)
    || hasTrackedChildren(tracked, path)
    || (collection?.childPaths.length ?? 0) > 0;

  if (!hasExactCoverage) {
    return false;
  }

  return !getReportingObservedSubtrees(reportingObservedSubtreesById, tracked).has(joinedPath)
    || isObjectPathOverlayCollectionPathInvalidated(overlayState, tracked.id, path)
    || isCollectionPathInvalidated(tracked, path);
}

export function finalizeObjectPathFindings(
  project: ProjectContext,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  trackedObjects: Iterable<TrackedObject>,
  overlayState: ObjectPathOverlayState,
): void {
  const trackedList = [...trackedObjects];
  const reportingReadsById = new Map<string, Set<string>>();
  const reportingObservedSubtreesById = new Map<string, Set<string>>();
  const reportingObservedAliasesById = new Map<string, Set<string>>();

  for (const tracked of trackedList) {
    const reportingOwnerId = tracked.reportingOwnerId ?? tracked.id;
    const reads = reportingReadsById.get(reportingOwnerId) ?? new Set<string>();
    const observedSubtrees = reportingObservedSubtreesById.get(reportingOwnerId) ?? new Set<string>();
    const observedAliases = reportingObservedAliasesById.get(reportingOwnerId) ?? new Set<string>();
    getObjectPathOverlayReads(overlayState, tracked.id)?.forEach((path) => reads.add(path));
    getObjectPathOverlayObservedSubtrees(overlayState, tracked.id)?.forEach((path) => observedSubtrees.add(path));
    getObjectPathOverlayObservedAliases(overlayState, tracked.id)?.forEach((path) => observedAliases.add(path));
    reportingReadsById.set(reportingOwnerId, reads);
    reportingObservedSubtreesById.set(reportingOwnerId, observedSubtrees);
    reportingObservedAliasesById.set(reportingOwnerId, observedAliases);
  }

  for (const tracked of trackedList) {
    if (tracked.reportingOwnerId && tracked.reportingOwnerId !== tracked.id) {
      continue;
    }

    for (const boundary of getReportingBoundaries(overlayState, tracked).values()) {
      if (boundary.path.length === 0 && shouldSuppressStructuralRoot(tracked)) {
        continue;
      }
      if (shouldSuppressStructuralPath(tracked, boundary.path)) {
        continue;
      }
      if (!shouldReportBoundary(overlayState, reportingObservedSubtreesById, tracked, boundary.path)) {
        continue;
      }
      const suppression = getSuppressionAudit(project, suppressionContext, boundary.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    if (tracked.exactPathAliases.size > 0) {
      const reportingReads = getReportingReads(reportingReadsById, tracked);
      const reportingObservedAliases = getReportingObservedAliases(reportingObservedAliasesById, tracked);
      const aliases = [...tracked.exactPathAliases.entries()];
      if (
        aliases.every(([joinedPath, alias]) => !alias.observed && !reportingReads.has(joinedPath) && !reportingObservedAliases.has(joinedPath))
        && !hasBoundaryAtPath(getReportingBoundaries(overlayState, tracked), [])
        && !shouldSuppressStructuralRoot(tracked)
      ) {
        const suppression = getSuppressionAudit(project, suppressionContext, tracked.rootEntity);
        if (!addAudit(state.kept, suppression)) {
          addFinding(
            state,
            tracked.rootEntity,
            "write-only-state",
            "tracked values are accumulated here but never meaningfully observed through an exact supported path",
            `Write-only accumulation in ${tracked.rootName}`,
            "review",
          );
        }
      }
    }

    for (const [joinedPath, objectNode] of tracked.nodes) {
      if (shouldSuppressStructuralPath(tracked, objectNode.fullPath)) {
        continue;
      }
      if (
        isObjectPathOverlayCollectionPathInvalidated(overlayState, tracked.id, objectNode.fullPath)
        || isCollectionPathInvalidated(tracked, objectNode.fullPath)
      ) {
        continue;
      }

      const escapedReason = getObjectPathOverlayEscapedReason(overlayState, tracked.id, objectNode.fullPath)
        ?? getEscapedReason(tracked, objectNode.fullPath);
      if (escapedReason) {
        addSkipped(state, objectNode.entity, escapedReason.category, escapedReason.reason);
        continue;
      }

      const suppression = getSuppressionAudit(project, suppressionContext, objectNode.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }

      const hasRead = getReportingReads(reportingReadsById, tracked).has(joinedPath);
      const hasWrite = getObjectPathOverlayWrites(overlayState, tracked.id)?.has(joinedPath)
        || objectNode.fullPath.length >= 1;

      if (!hasRead && hasWrite) {
        const findingKind = kindToFinding(objectNode.entity.kind);
        if (!findingKind) {
          continue;
        }
        addFinding(
          state,
          objectNode.entity,
          findingKind,
          "eligible object path is declared or written but never read",
          objectNode.entity.kind === "array-element"
            ? `Unused array element ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`
            : `Unused object path ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`,
        );
      }
    }
  }
}
