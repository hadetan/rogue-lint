import ts from "typescript";

import type { PathSegment, ProjectContext } from "../../types.js";
import { getSymbolKey } from "../../compiler/ast-utils.js";
import { SKIP_CATEGORY } from "../../shared/skip-category-vocabulary.js";
import { indexSegment, propertySegment, samePath } from "../../shared/path-utils.js";
import type { ProjectedArrayUsageContext, ResolvedProjectionAccess } from "./model.js";
import { extractBoundedElementAccessSegment, resolveArrayAtIndex } from "./element-access.js";
import { getCollectionInfo, getConcreteProjectionPaths } from "./state.js";
import { unwrapExpression } from "./syntax.js";
import { TRACKING_ARRAY_INDEX_ACCESS_METHOD, TRACKING_COLLECTION_KIND } from "./vocabulary.js";

/**
 * Resolves callback-projection access chains (array element / index correlations)
 * for the tracked-object projection subsystem.
 */
export function resolveProjectionAccess(
  project: ProjectContext,
  node: ts.Node,
  context: ProjectedArrayUsageContext,
): ResolvedProjectionAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveProjectionAccess(project, node.expression, context);
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    const projection = symbol ? context.elementBindings.get(getSymbolKey(symbol)) : undefined;
    return projection ? { projection, suffix: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, context);
    if (nested?.dynamic) {
      return nested;
    }
    return nested
      ? {
          projection: nested.projection,
          suffix: [...nested.suffix, propertySegment(node.name.text)],
          dynamic: nested.dynamic,
          boundaryCategory: nested.boundaryCategory,
          boundaryReason: nested.boundaryReason,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, context);
    if (!nested) {
      const receiver = unwrapExpression(node.expression);
      const index = unwrapExpression(node.argumentExpression);
      if (!ts.isIdentifier(receiver) || !ts.isIdentifier(index)) {
        return undefined;
      }

      const receiverSymbol = project.checker.getSymbolAtLocation(receiver);
      const indexSymbol = project.checker.getSymbolAtLocation(index);
      const receiverProjection = receiverSymbol ? context.receiverBindings.get(getSymbolKey(receiverSymbol)) : undefined;
      const indexProjection = indexSymbol ? context.indexBindings.get(getSymbolKey(indexSymbol)) : undefined;
      if (!receiverProjection || !indexProjection) {
        return undefined;
      }

      const sameProjection = receiverProjection.trackedObject.id === indexProjection.trackedObject.id
        && samePath(receiverProjection.sourcePath, indexProjection.sourcePath);
      return sameProjection
        ? {
            projection: receiverProjection,
            suffix: [],
            dynamic: false,
          }
        : {
            projection: receiverProjection,
            suffix: [],
            dynamic: true,
            boundaryCategory: SKIP_CATEGORY.dynamicArrayIndex,
            boundaryReason: "callback index cannot yet be correlated across different tracked arrays",
          };
    }

    if (nested.dynamic) {
      return nested;
    }

    const boundedSegment = extractBoundedElementAccessSegment(project, node.argumentExpression);
    if (boundedSegment) {
      return {
        projection: nested.projection,
        suffix: [
          ...nested.suffix,
          boundedSegment,
        ],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
      };
    }

    const concreteTargets = getConcreteProjectionPaths(nested.projection, nested.suffix);
    const isArrayIndex = concreteTargets.some((path) => getCollectionInfo(nested.projection.trackedObject, path)?.kind === TRACKING_COLLECTION_KIND.array);
    return {
      projection: nested.projection,
      suffix: nested.suffix,
      dynamic: true,
      boundaryCategory: isArrayIndex ? SKIP_CATEGORY.dynamicArrayIndex : SKIP_CATEGORY.computedPropertyAccess,
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === TRACKING_ARRAY_INDEX_ACCESS_METHOD
    && node.arguments.length === 1
  ) {
    const receiver = resolveProjectionAccess(project, node.expression.expression, context);
    if (!receiver) {
      return undefined;
    }

    if (receiver.dynamic) {
      return receiver;
    }

    const elementPaths = getConcreteProjectionPaths(receiver.projection, receiver.suffix)
      .map((receiverPath) => {
        const resolvedIndex = resolveArrayAtIndex(receiver.projection.trackedObject, receiverPath, node.arguments[0]!);
        return resolvedIndex === undefined ? undefined : [...receiverPath, indexSegment(resolvedIndex)];
      })
      .filter((path): path is PathSegment[] => Boolean(path));

    if (elementPaths.length === 0) {
      return {
        projection: receiver.projection,
        suffix: receiver.suffix,
        dynamic: true,
        boundaryCategory: "array-at-call",
        boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
      };
    }

    return {
      projection: {
        trackedObject: receiver.projection.trackedObject,
        sourcePath: receiver.projection.sourcePath,
        elementPaths,
      },
      suffix: [],
      dynamic: false,
    };
  }

  return undefined;
}
