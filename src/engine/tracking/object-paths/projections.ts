import ts from "typescript";

import type { PathSegment, ProjectContext, TrackedObject } from "../../../types.js";
import { serializePath } from "../../../shared/path-utils.js";
import { isReadLikeUse } from "../../../compiler/ast-utils.js";
import { getBindingSymbolKey, resolveProjectionAccess } from "../access.js";
import { extendTrackedBinding, getCanonicalSymbolKey, sameTrackedBinding } from "../bindings.js";
import type { ArrayProjectionBinding, ProjectedArrayUsageContext, TrackedObjectBinding } from "../model.js";
import { classifySupportedCallArgumentUse } from "../semantics.js";
import { getCollectionInfo, getConcreteProjectionPaths, getProjectionBinding, hasTrackedChildren, resolveExactPathAlias } from "../state.js";
import { maybeInvalidateReplacedTrackedPath, recordArrayBoundary } from "./effects.js";
import { getSupportedArrayCallbackIndexParamIndex, getSupportedArrayCallbackParamIndex, isExactArrayCallbackMethod } from "../vocabulary.js";
import {
  markObjectPathProjectionChildReads as markProjectionChildReads, markObjectPathProjectionReads as markProjectionReads,
  markObjectPathProjectionWrites as markProjectionWrites, type ObjectPathOverlayState,
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

function getProjectedTypePropertyNames(
  project: ProjectContext,
  node: ts.Expression,
): string[] {
  const type = project.checker.getApparentType(project.checker.getTypeAtLocation(node));
  return project.checker.getPropertiesOfType(type)
    .filter((property) => (property.flags & ts.SymbolFlags.Property) !== 0)
    .map((property) => property.getName());
}

function candidateHasTrackedProperty(
  trackedObject: TrackedObject,
  candidatePath: PathSegment[],
  propertyName: string,
  trackedObjectsById: Map<string, TrackedObject>,
): boolean {
  const propertyPath = [...candidatePath, { kind: "property", value: propertyName } as const];
  const aliased = resolveExactPathAlias(
    {
      trackedObject,
      prefix: candidatePath,
    },
    [{ kind: "property", value: propertyName }],
    trackedObjectsById,
  );

  return !sameTrackedBinding(aliased.binding, { trackedObject, prefix: candidatePath })
    || trackedObject.nodes.has(serializePath(propertyPath))
    || Boolean(getCollectionInfo(trackedObject, propertyPath))
    || hasTrackedChildren(trackedObject, propertyPath);
}

function resolveProjectedTrackedBinding(
  project: ProjectContext,
  node: ts.Expression,
  context: ProjectedArrayUsageContext,
  trackedObjectsById: Map<string, TrackedObject>,
  preferFirstCandidate = false,
): TrackedObjectBinding | undefined {
  const projected = resolveProjectionAccess(project, node, context);
  if (!projected || projected.dynamic) {
    return undefined;
  }

  let candidatePaths = getConcreteProjectionPaths(projected.projection, projected.suffix);
  if (candidatePaths.length > 1) {
    const typePropertyNames = getProjectedTypePropertyNames(project, node);
    if (typePropertyNames.length > 0) {
      candidatePaths = candidatePaths.filter((candidatePath) =>
        typePropertyNames.every((propertyName) => candidateHasTrackedProperty(
          projected.projection.trackedObject,
          candidatePath,
          propertyName,
          trackedObjectsById,
        )));
    }
  }

  if (candidatePaths.length === 0) {
    return undefined;
  }

  const resolvedBindings = candidatePaths.map((candidatePath) => resolveExactPathAlias(
    {
      trackedObject: projected.projection.trackedObject,
      prefix: candidatePath,
    },
    [],
    trackedObjectsById,
  ).binding);

  const [firstBinding] = resolvedBindings;
  if (!firstBinding) {
    return undefined;
  }

  if (preferFirstCandidate) {
    return firstBinding;
  }

  if (!resolvedBindings.every((binding) => sameTrackedBinding(binding, firstBinding))) {
    return undefined;
  }

  return firstBinding;
}

export function visitProjectedArrayUsage(
  project: ProjectContext,
  node: ts.Node,
  context: ProjectedArrayUsageContext,
  trackedObjectsById: Map<string, TrackedObject>,
  overlayState: ObjectPathOverlayState,
  trackedBySymbolId?: Map<string, TrackedObjectBinding>,
): void {
  const captureProjectedBinding = (
    target: ts.Identifier,
    source: ts.Expression,
    preferFirstCandidate = false,
  ): void => {
    if (!trackedBySymbolId) {
      return;
    }

    const symbol = project.checker.getSymbolAtLocation(target);
    const symbolKey = symbol ? getCanonicalSymbolKey(project, symbol) : undefined;
    const binding = symbolKey
      ? resolveProjectedTrackedBinding(project, source, context, trackedObjectsById, preferFirstCandidate)
      : undefined;
    if (symbolKey && binding) {
      trackedBySymbolId.set(symbolKey, binding);
    }
  };

  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }

    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
      captureProjectedBinding(current.name, current.initializer);
    }

    if (
      ts.isBinaryExpression(current)
      && ts.isIdentifier(current.left)
      && (
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
      )
    ) {
      captureProjectedBinding(
        current.left,
        current.right,
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken,
      );
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
                trackedBySymbolId,
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
            trackedBySymbolId,
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
