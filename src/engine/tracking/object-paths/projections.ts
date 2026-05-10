import ts from "typescript";

import type {
  ProjectContext,
  TrackedObject,
} from "../../../types.js";
import { isReadLikeUse } from "../../../compiler/ast-utils.js";
import { resolveProjectionAccess } from "../access.js";
import type { ProjectedArrayUsageContext } from "../model.js";
import {
  getCollectionInfo,
  getConcreteProjectionPaths,
  hasTrackedChildren,
  markProjectionReads,
  markProjectionWrites,
} from "../state.js";
import { maybeInvalidateReplacedTrackedPath, recordArrayBoundary } from "./effects.js";

export function visitProjectedArrayUsage(
  project: ProjectContext,
  node: ts.Node,
  context: ProjectedArrayUsageContext,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }

    if (ts.isForOfStatement(current)) {
      const projected = resolveProjectionAccess(project, current.expression, context);
      if (projected) {
        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            current.expression,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array projection escapes exact local analysis",
            true,
          );
        } else {
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix, true);
        }
      }
    }

    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) {
        const projected = resolveProjectionAccess(project, argument, context);
        if (!projected) {
          continue;
        }

        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            argument,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array callback escapes exact local analysis",
            true,
          );
          continue;
        }

        const concretePaths = getConcreteProjectionPaths(projected.projection, projected.suffix);
        const paths = concretePaths.length > 0 ? concretePaths : projected.projection.elementPaths;
        const shouldEscape = paths.some((path) =>
          getCollectionInfo(projected.projection.trackedObject, path) || hasTrackedChildren(projected.projection.trackedObject, path));
        if (shouldEscape) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            argument,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            "array-callback-escape",
            "array callback escapes exact local analysis",
            true,
          );
        } else {
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
        }
      }
    }

    if (ts.isIdentifier(current)) {
      const projected = resolveProjectionAccess(project, current, context);
      if (
        projected
        && !projected.dynamic
        && isReadLikeUse(current)
        && !ts.isPropertyAccessExpression(current.parent)
        && !ts.isElementAccessExpression(current.parent)
      ) {
        markProjectionReads(projected.projection, trackedObjectsById, [], true);
      }
    }

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const projected = resolveProjectionAccess(project, current, context);
      if (projected) {
        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            current,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array callback escapes exact local analysis",
            true,
          );
        } else if (isAssignmentLeft(current)) {
          if (projected.suffix.length > 1) {
            markProjectionReads(projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
          }
          for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
            maybeInvalidateReplacedTrackedPath(project, projected.projection.trackedObject, current.getSourceFile(), current, fullPath);
          }
          markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
        } else {
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
        }
      }
    }

    ts.forEachChild(current, visit);
  };

  visit(node);
}

export function isAssignmentLeft(node: ts.Node): boolean {
  return ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}
