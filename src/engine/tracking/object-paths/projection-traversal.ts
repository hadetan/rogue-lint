import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { isReadLikeUse } from "../../../compiler/ast-utils.js";
import { serializePath } from "../../../shared/path-utils.js";
import {
  getBindingSymbolKey,
  resolveProjectionAccess,
  resolveTrackedObjectAccess,
} from "../access.js";
import {
  extendTrackedBinding,
  sameTrackedBinding,
} from "../bindings.js";
import type {
  ArrayProjectionBinding,
  CallableReturnSummary,
  ProjectedArrayUsageContext,
  TrackedObjectBinding,
} from "../model.js";
import { classifySupportedCallArgumentUse } from "../semantics.js";
import {
  getProjectionBinding,
  resolveExactPathAlias,
} from "../state.js";
import {
  isAssignmentLeft,
  visitProjectedArrayUsage,
} from "./projections.js";
import type { ObjectPathOverlayState } from "./overlay.js";

interface ProjectionTraversalHandlerOptions {
  project: ProjectContext;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  overlayState: ObjectPathOverlayState;
  projectionContext: ProjectedArrayUsageContext;
  markObservedSubtree: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    aliasTrackedObjectsById?: Map<string, TrackedObject>,
    visited?: Set<string>,
  ) => void;
  markProjectionChildReads: (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix?: PathSegment[],
  ) => void;
  markProjectionReads: (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix?: PathSegment[],
    observeSubtree?: boolean,
  ) => void;
  markProjectionWrites: (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix: PathSegment[],
  ) => void;
  recordArrayBoundary: (
    project: ProjectContext,
    trackedObject: TrackedObject,
    boundarySourceFile: ts.SourceFile,
    node: ts.Node,
    collectionPath: PathSegment[],
    affectedPath: PathSegment[],
    category: SkipCategory,
    reason: string,
    invalidate?: boolean,
    detailHint?: string,
  ) => void;
}

/**
 * Owns projection-specific traversal branches for object-path analysis.
 */
export function createProjectionTraversalHandler(options: ProjectionTraversalHandlerOptions): {
  handleForOfStatement: (node: ts.ForOfStatement) => void;
  handleProjectedIdentifierRead: (node: ts.Identifier) => void;
  handleProjectedAccess: (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) => boolean;
} {
  const {
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    overlayState,
    projectionContext,
    markObservedSubtree,
    markProjectionChildReads,
    markProjectionReads,
    markProjectionWrites,
    recordArrayBoundary,
  } = options;

  const getProjectedNestedArrayBinding = (
    projection: ArrayProjectionBinding,
    suffix: PathSegment[],
  ): ArrayProjectionBinding | undefined => {
    let nestedTrackedObject: TrackedObject | undefined;
    let nestedSourcePath: PathSegment[] | undefined;
    const nestedElementPaths: PathSegment[][] = [];

    for (const candidatePath of projection.elementPaths) {
      let resolvedBinding: TrackedObjectBinding = {
        trackedObject: projection.trackedObject,
        prefix: candidatePath,
      };

      const rootAlias = resolveExactPathAlias(resolvedBinding, [], trackedObjectsById);
      if (!sameTrackedBinding(rootAlias.binding, resolvedBinding)) {
        resolvedBinding = rootAlias.binding;
      }

      for (const segment of suffix) {
        const aliased = resolveExactPathAlias(resolvedBinding, [segment], trackedObjectsById);
        if (!sameTrackedBinding(aliased.binding, resolvedBinding)) {
          resolvedBinding = aliased.binding;
          continue;
        }

        resolvedBinding = extendTrackedBinding(resolvedBinding, [segment]);
      }

      const targetTrackedObject = resolvedBinding.trackedObject;
      const targetPath = resolvedBinding.prefix;
      const nestedProjection = getProjectionBinding(targetTrackedObject, targetPath);
      if (!nestedProjection) {
        continue;
      }

      if (!nestedTrackedObject) {
        nestedTrackedObject = nestedProjection.trackedObject;
        nestedSourcePath = targetPath;
      } else if (
        nestedTrackedObject.id !== nestedProjection.trackedObject.id
        || serializePath(nestedSourcePath ?? []) !== serializePath(targetPath)
      ) {
        return undefined;
      }

      nestedElementPaths.push(...nestedProjection.elementPaths);
    }

    return nestedTrackedObject && nestedSourcePath && nestedElementPaths.length > 0
      ? {
          trackedObject: nestedTrackedObject,
          sourcePath: nestedSourcePath,
          elementPaths: nestedElementPaths,
        }
      : undefined;
  };

  const handleForOfStatement = (node: ts.ForOfStatement): void => {
    const resolved = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      const projection = getProjectionBinding(
        resolved.binding.trackedObject,
        [...resolved.binding.prefix, ...resolved.segments],
      );
      const symbolKey = getBindingSymbolKey(project, node.initializer);
      if (projection && symbolKey) {
        visitProjectedArrayUsage(
          project,
          node.statement,
          {
            elementBindings: new Map([[symbolKey, projection]]),
            receiverBindings: new Map(),
            indexBindings: new Map(),
          },
          trackedObjectsById,
          overlayState,
        );
      } else {
        markObservedSubtree(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          trackedObjectsById,
        );
      }
      return;
    }

    const projected = resolveProjectionAccess(project, node.expression, projectionContext);
    if (projected?.dynamic) {
      recordArrayBoundary(
        project,
        projected.projection.trackedObject,
        node.getSourceFile(),
        node.expression,
        projected.projection.sourcePath,
        projected.projection.sourcePath,
        projected.boundaryCategory ?? "array-callback-escape",
        projected.boundaryReason ?? "array projection escapes exact local analysis",
        true,
      );
      return;
    }

    if (!projected) {
      return;
    }

    const symbolKey = getBindingSymbolKey(project, node.initializer);
    const nestedProjection = getProjectedNestedArrayBinding(projected.projection, projected.suffix);
    if (nestedProjection && symbolKey) {
      visitProjectedArrayUsage(
        project,
        node.statement,
        {
          elementBindings: new Map([[symbolKey, nestedProjection]]),
          receiverBindings: new Map(),
          indexBindings: new Map(),
        },
        trackedObjectsById,
        overlayState,
      );
      return;
    }

    markProjectionReads(projected.projection, trackedObjectsById, projected.suffix, true);
  };

  const handleProjectedIdentifierRead = (node: ts.Identifier): void => {
    const projected = resolveProjectionAccess(project, node, projectionContext);
    if (
      projected
      && !projected.dynamic
      && !ts.isBindingElement(node.parent)
      && isReadLikeUse(node)
      && !ts.isPropertyAccessExpression(node.parent)
      && !ts.isElementAccessExpression(node.parent)
    ) {
      markProjectionReads(projected.projection, trackedObjectsById, [], true);
    }
  };

  const handleProjectedAccess = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): boolean => {
    const projected = resolveProjectionAccess(project, node, projectionContext);
    if (!projected) {
      return false;
    }

    if (projected.dynamic) {
      recordArrayBoundary(
        project,
        projected.projection.trackedObject,
        node.getSourceFile(),
        node,
        projected.projection.sourcePath,
        projected.projection.sourcePath,
        projected.boundaryCategory ?? "array-callback-escape",
        projected.boundaryReason ?? "array projection escapes exact local analysis",
        true,
      );
      return true;
    }

    if (isAssignmentLeft(node)) {
      if (projected.suffix.length > 1) {
        markProjectionReads(projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
      }
      markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
      return true;
    }

    const parentCall = ts.isCallExpression(node.parent) ? node.parent : undefined;
    const argumentIndex = parentCall
      ? parentCall.arguments.findIndex((argument) => argument === node)
      : -1;
    const supportedArgumentUse = parentCall && argumentIndex >= 0
      ? classifySupportedCallArgumentUse(parentCall.expression.getText(node.getSourceFile()), argumentIndex)
      : undefined;

    if (supportedArgumentUse?.kind === "observe-subtree") {
      markProjectionReads(projected.projection, trackedObjectsById, projected.suffix, true);
    } else if (
      supportedArgumentUse?.kind === "observe-keys"
      || supportedArgumentUse?.kind === "observe-values"
    ) {
      markProjectionChildReads(projected.projection, trackedObjectsById, projected.suffix);
    } else {
      markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
    }

    return true;
  };

  return {
    handleForOfStatement,
    handleProjectedIdentifierRead,
    handleProjectedAccess,
  };
}
