import { getSuppressionAudit } from "../../../suppressions.js";
import type {
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
  getEscapedReason,
  isCollectionPathInvalidated,
  shouldReportCollectionBoundary,
} from "../state.js";
import { shouldSuppressStructuralPath, shouldSuppressStructuralRoot } from "../syntax.js";

export function finalizeObjectPathFindings(
  project: ProjectContext,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  trackedObjects: Iterable<TrackedObject>,
): void {
  for (const tracked of trackedObjects) {
    for (const boundary of tracked.collectionBoundaries.values()) {
      if (boundary.path.length === 0 && shouldSuppressStructuralRoot(tracked)) {
        continue;
      }
      if (shouldSuppressStructuralPath(tracked, boundary.path)) {
        continue;
      }
      if (!shouldReportCollectionBoundary(tracked, boundary.path)) {
        continue;
      }
      const suppression = getSuppressionAudit(project, suppressionContext, boundary.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    if (tracked.exactPathAliases.size > 0) {
      const aliases = [...tracked.exactPathAliases.values()];
      if (
        aliases.every((alias) => !alias.observed)
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

      const hasRead = tracked.reads.has(joinedPath);
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
