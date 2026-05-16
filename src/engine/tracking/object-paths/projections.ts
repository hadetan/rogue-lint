import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../../types.js";
import { isReadLikeUse } from "../../../compiler/ast-utils.js";
import {
  getBindingSymbolKey,
  resolveProjectionAccess,
} from "../access.js";
import {
  extendTrackedBinding,
  sameTrackedBinding,
} from "../bindings.js";
import type {
  ArrayProjectionBinding,
  ProjectedArrayUsageContext,
  TrackedObjectBinding,
} from "../model.js";
import {
  getSupportedArrayCallbackIndexParamIndex,
  getSupportedArrayCallbackParamIndex,
  isExactArrayCallbackMethod,
} from "../projection-support.js";
import { classifySupportedCallArgumentUse } from "../semantics.js";
import {
  getCollectionInfo,
  getConcreteProjectionPaths,
  getProjectionBinding,
  hasTrackedChildren,
  resolveExactPathAlias,
} from "../state.js";
import { maybeInvalidateReplacedTrackedPath, recordArrayBoundary } from "./effects.js";
import {
  markObjectPathProjectionChildReads as markProjectionChildReads,
  markObjectPathProjectionReads as markProjectionReads,
  markObjectPathProjectionWrites as markProjectionWrites,
  type ObjectPathOverlayState,
} from "./overlay.js";

function getProjectedNestedArrayBinding(
  projection: ArrayProjectionBinding,
  suffix: PathSegment[],
  trackedObjectsById: Map<string, TrackedObject>,
): ArrayProjectionBinding | undefined {
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
      || !sameTrackedBinding(
        { trackedObject: nestedTrackedObject, prefix: nestedSourcePath ?? [] },
        { trackedObject: nestedProjection.trackedObject, prefix: targetPath },
      )
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
}

export function visitProjectedArrayUsage(
  project: ProjectContext,
  node: ts.Node,
  context: ProjectedArrayUsageContext,
  trackedObjectsById: Map<string, TrackedObject>,
  overlayState: ObjectPathOverlayState,
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
            overlayState,
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
          markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix, true);
        }
      }
    }

    if (ts.isCallExpression(current)) {
      if (
        ts.isPropertyAccessExpression(current.expression)
        && isExactArrayCallbackMethod(current.expression.name.text)
        && current.arguments[0]
        && (ts.isArrowFunction(current.arguments[0]) || ts.isFunctionExpression(current.arguments[0]))
      ) {
        const callback = current.arguments[0];
        const projectedReceiver = resolveProjectionAccess(project, current.expression.expression, context);
        if (projectedReceiver) {
          if (projectedReceiver.dynamic) {
            recordArrayBoundary(
              project,
              overlayState,
              projectedReceiver.projection.trackedObject,
              current.getSourceFile(),
              current.expression.expression,
              projectedReceiver.projection.sourcePath,
              projectedReceiver.projection.sourcePath,
              projectedReceiver.boundaryCategory ?? "array-callback-escape",
              projectedReceiver.boundaryReason ?? "array callback escapes exact local analysis",
              true,
            );
          } else {
            const paramIndex = getSupportedArrayCallbackParamIndex(current.expression.name.text);
            const parameter = paramIndex === undefined ? undefined : callback.parameters[paramIndex];
            const indexParamIndex = getSupportedArrayCallbackIndexParamIndex(current.expression.name.text);
            const indexParameter = indexParamIndex === undefined ? undefined : callback.parameters[indexParamIndex];
            const symbolKey = parameter ? getBindingSymbolKey(project, parameter) : undefined;
            const indexSymbolKey = indexParameter ? getBindingSymbolKey(project, indexParameter) : undefined;
            const nestedProjection = getProjectedNestedArrayBinding(
              projectedReceiver.projection,
              projectedReceiver.suffix,
              trackedObjectsById,
            );
            if (symbolKey && nestedProjection) {
              visitProjectedArrayUsage(
                project,
                callback.body,
                {
                  elementBindings: new Map([[symbolKey, nestedProjection]]),
                  receiverBindings: new Map(),
                  indexBindings: indexSymbolKey ? new Map([[indexSymbolKey, nestedProjection]]) : new Map(),
                },
                trackedObjectsById,
                overlayState,
              );
            }
          }
        } else if (callback.body) {
          visitProjectedArrayUsage(
            project,
            callback.body,
            context,
            trackedObjectsById,
            overlayState,
          );
        }
      }

      for (const [argumentIndex, argument] of current.arguments.entries()) {
        const projected = resolveProjectionAccess(project, argument, context);
        if (!projected) {
          continue;
        }

        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            overlayState,
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

        const supportedArgumentUse = classifySupportedCallArgumentUse(
          current.expression.getText(current.getSourceFile()),
          argumentIndex,
        );
        if (supportedArgumentUse?.kind === "observe-subtree") {
          markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix, true);
          continue;
        }

        if (
          supportedArgumentUse?.kind === "observe-keys"
          || supportedArgumentUse?.kind === "observe-values"
        ) {
          markProjectionChildReads(overlayState, projected.projection, trackedObjectsById, projected.suffix);
          continue;
        }

        const concretePaths = getConcreteProjectionPaths(projected.projection, projected.suffix);
        const paths = concretePaths.length > 0 ? concretePaths : projected.projection.elementPaths;
        const shouldEscape = paths.some((path) =>
          getCollectionInfo(projected.projection.trackedObject, path) || hasTrackedChildren(projected.projection.trackedObject, path));
        if (shouldEscape) {
          recordArrayBoundary(
            project,
            overlayState,
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
          markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix);
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
        markProjectionReads(overlayState, projected.projection, trackedObjectsById, [], true);
      }
    }

    if (ts.isSpreadElement(current)) {
      const projected = resolveProjectionAccess(project, current.expression, context);
      if (projected) {
        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            overlayState,
            projected.projection.trackedObject,
            current.getSourceFile(),
            current,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array callback escapes exact local analysis",
            true,
          );
        } else {
          markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix, true);
        }
      }
    }

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const projected = resolveProjectionAccess(project, current, context);
      if (projected) {
        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            overlayState,
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
            markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
          }
          for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
            maybeInvalidateReplacedTrackedPath(
              project,
              overlayState,
              projected.projection.trackedObject,
              current.getSourceFile(),
              current,
              fullPath,
            );
          }
          markProjectionWrites(overlayState, projected.projection, trackedObjectsById, projected.suffix);
        } else {
          markProjectionReads(overlayState, projected.projection, trackedObjectsById, projected.suffix);
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
