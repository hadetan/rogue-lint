import { getSuppressionAudit } from "../../../suppressions.js";
import type {
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

export function finalizeObjectPathFindings(
  project: ProjectContext,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  trackedObjects: Iterable<TrackedObject>,
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
    tracked.reads.forEach((path) => reads.add(path));
    tracked.observedSubtrees.forEach((path) => observedSubtrees.add(path));
    for (const [joinedPath, alias] of tracked.exactPathAliases.entries()) {
      if (alias.observed) {
        observedAliases.add(joinedPath);
      }
    }
    reportingReadsById.set(reportingOwnerId, reads);
    reportingObservedSubtreesById.set(reportingOwnerId, observedSubtrees);
    reportingObservedAliasesById.set(reportingOwnerId, observedAliases);
  }

  const getReportingReads = (tracked: TrackedObject): Set<string> => reportingReadsById.get(tracked.id) ?? tracked.reads;
  const getReportingObservedSubtrees = (tracked: TrackedObject): Set<string> =>
    reportingObservedSubtreesById.get(tracked.id) ?? tracked.observedSubtrees;
  const getReportingObservedAliases = (tracked: TrackedObject): Set<string> => {
    const observed = reportingObservedAliasesById.get(tracked.id);
    if (observed) {
      return observed;
    }

    return new Set(
      [...tracked.exactPathAliases.entries()]
        .filter(([, alias]) => alias.observed)
        .map(([joinedPath]) => joinedPath),
    );
  };

  const shouldReportBoundary = (tracked: TrackedObject, path: PathSegment[]): boolean => {
    const joinedPath = serializePath(path);
    const collection = getCollectionInfo(tracked, path);
    const hasExactCoverage = tracked.nodes.has(joinedPath)
      || hasTrackedChildren(tracked, path)
      || (collection?.childPaths.length ?? 0) > 0;

    if (!hasExactCoverage) {
      return false;
    }

    return !getReportingObservedSubtrees(tracked).has(joinedPath) || isCollectionPathInvalidated(tracked, path);
  };

  for (const tracked of trackedList) {
    if (tracked.reportingOwnerId && tracked.reportingOwnerId !== tracked.id) {
      continue;
    }

    for (const boundary of tracked.collectionBoundaries.values()) {
      if (boundary.path.length === 0 && shouldSuppressStructuralRoot(tracked)) {
        continue;
      }
      if (shouldSuppressStructuralPath(tracked, boundary.path)) {
        continue;
      }
      if (!shouldReportBoundary(tracked, boundary.path)) {
        continue;
      }
      const suppression = getSuppressionAudit(project, suppressionContext, boundary.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    if (tracked.exactPathAliases.size > 0) {
      const reportingReads = getReportingReads(tracked);
      const reportingObservedAliases = getReportingObservedAliases(tracked);
      const aliases = [...tracked.exactPathAliases.entries()];
      if (
        aliases.every(([joinedPath, alias]) => !alias.observed && !reportingReads.has(joinedPath) && !reportingObservedAliases.has(joinedPath))
        && !tracked.collectionBoundaries.has(serializePath([]))
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
      if (isCollectionPathInvalidated(tracked, objectNode.fullPath)) {
        continue;
      }

      const escapedReason = getEscapedReason(tracked, objectNode.fullPath);
      if (escapedReason) {
        addSkipped(state, objectNode.entity, escapedReason.category, escapedReason.reason);
        continue;
      }

      const suppression = getSuppressionAudit(project, suppressionContext, objectNode.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }

  const hasRead = getReportingReads(tracked).has(joinedPath);
      const hasWrite = tracked.writes.has(joinedPath) || objectNode.fullPath.length >= 1;

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
