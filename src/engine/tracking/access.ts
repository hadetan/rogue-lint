import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { getSymbolKey } from "../../compiler/ast-utils.js";
import {
  indexSegment,
  propertySegment,
  samePath,
} from "../../shared/path-utils.js";
import type {
  CallableReturnSummary,
  ForwardedParameterBinding,
  ProjectedArrayUsageContext,
  ResolvedProjectionAccess,
  ResolvedTrackedObjectAccess,
  TrackedObjectBinding,
} from "./model.js";
import {
  extendTrackedBinding,
  getBindingByNode,
  getCanonicalSymbol,
  getCanonicalSymbolKey,
  getGlobalThisBindingKey,
  isGlobalThisIdentifier,
  sameTrackedBinding,
} from "./bindings.js";
import {
  getAnalyzableCallableBinding,
  getCallableReturnBinding,
} from "./callables.js";
import {
  getCollectionInfo,
  getConcreteProjectionPaths,
  getTrackedArrayLength,
  resolveExactPathAlias,
} from "./state.js";
import { unwrapExpression } from "./syntax.js";

/**
 * Shared access-resolution helpers for the exact tracking kernel.
 *
 * This module owns exact path resolution, retained-container slot identity,
 * callback projection resolution, and the binding propagation helpers used by
 * both heavy analyzer stages.
 */

const EXACT_ARRAY_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

function resolveLiteralArrayIndex(argument: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(argument)) {
    return Number(argument.text);
  }

  if (
    ts.isPrefixUnaryExpression(argument)
    && argument.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(argument.operand)
  ) {
    return -Number(argument.operand.text);
  }

  return undefined;
}

function resolveArrayAtIndex(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  argument: ts.Expression,
): number | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== "array") {
    return undefined;
  }

  const literalIndex = resolveLiteralArrayIndex(argument);
  if (literalIndex === undefined) {
    return undefined;
  }

  const arrayLength = getTrackedArrayLength(trackedObject, segments) ?? 0;

  if (literalIndex >= 0) {
    return literalIndex < arrayLength ? literalIndex : undefined;
  }

  const normalized = arrayLength + literalIndex;
  return normalized >= 0 ? normalized : undefined;
}

export function isExactArrayCallbackMethod(methodName: string): boolean {
  return EXACT_ARRAY_CALLBACK_METHODS.has(methodName);
}

export function getSupportedArrayCallbackParamIndex(methodName: string): number | undefined {
  if (!isExactArrayCallbackMethod(methodName)) {
    return undefined;
  }

  return methodName === "reduce" || methodName === "reduceRight" ? 1 : 0;
}

export function getSupportedArrayCallbackIndexParamIndex(methodName: string): number | undefined {
  const valueParamIndex = getSupportedArrayCallbackParamIndex(methodName);
  return valueParamIndex === undefined ? undefined : valueParamIndex + 1;
}

function getContainerTypeName(project: ProjectContext, expression: ts.Expression): string | undefined {
  const typeSymbol = project.checker.getTypeAtLocation(expression).getSymbol();
  return typeSymbol?.getName();
}

export function isSupportedRetainedBindingContainerType(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  const typeName = getContainerTypeName(project, expression);
  return typeName === "Map" || typeName === "WeakMap";
}

export function isLocallyOwnedRetainedBindingContainer(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  const node = unwrapExpression(expression);
  if (!ts.isIdentifier(node)) {
    return false;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }

  return getCanonicalSymbol(project, symbol).declarations?.some((declaration) =>
    ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && ts.isNewExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression)
      && ["Map", "WeakMap"].includes(declaration.initializer.expression.text)
  ) ?? false;
}

function getRetainedBindingContainerSlotToken(project: ProjectContext, expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `string:${node.text}`;
  }
  if (ts.isNumericLiteral(node)) {
    return `number:${node.text}`;
  }
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? `symbol:${getCanonicalSymbolKey(project, symbol)}` : undefined;
  }
  return undefined;
}

export function getRetainedBindingContainerSlotKey(
  project: ProjectContext,
  receiver: ts.Expression,
  slot: ts.Expression,
): string | undefined {
  const node = unwrapExpression(receiver);
  if (!ts.isIdentifier(node) || !isSupportedRetainedBindingContainerType(project, node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  const slotToken = getRetainedBindingContainerSlotToken(project, slot);
  if (!symbol || !slotToken) {
    return undefined;
  }

  return `container:${getCanonicalSymbolKey(project, symbol)}:${slotToken}`;
}

export function getAccessPath(
  node: ts.Node,
): { root: ts.Identifier; segments: PathSegment[]; dynamic: boolean } | undefined {
  if (ts.isIdentifier(node)) {
    return { root: node, segments: [], dynamic: false };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    return { root: nested.root, segments: [...nested.segments, propertySegment(node.name.text)], dynamic: nested.dynamic };
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        root: nested.root,
        segments: [
          ...nested.segments,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
        dynamic: nested.dynamic,
      };
    }
    return { root: nested.root, segments: nested.segments, dynamic: true };
  }

  return undefined;
}

/**
 * Resolves tracked access paths while preserving exactness boundaries for callers.
 */
export function resolveTrackedObjectAccess(
  project: ProjectContext,
  node: ts.Node,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): ResolvedTrackedObjectAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
  }

  if (ts.isIdentifier(node)) {
    const binding = getBindingByNode(project, node, trackedBySymbolId);
    return binding ? { binding, segments: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.name.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (nested?.dynamic) {
      return nested;
    }
    if (!nested) {
      return undefined;
    }
    const aliased = resolveExactPathAlias(nested.binding, [...nested.segments, propertySegment(node.name.text)], trackedObjectsById);
    return {
      binding: aliased.binding,
      segments: sameTrackedBinding(aliased.binding, nested.binding) ? [...nested.segments, propertySegment(node.name.text)] : [],
      dynamic: nested.dynamic,
      boundaryCategory: nested.boundaryCategory,
      boundaryReason: nested.boundaryReason,
      viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
      viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
    };
  }

  if (ts.isElementAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.argumentExpression.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      const nextSegment = ts.isNumericLiteral(node.argumentExpression)
        ? indexSegment(Number(node.argumentExpression.text))
        : propertySegment(node.argumentExpression.text);
      const aliased = resolveExactPathAlias(nested.binding, [...nested.segments, nextSegment], trackedObjectsById);
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, nested.binding) ? [...nested.segments, nextSegment] : [],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
        viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
      };
    }

    const targetPath = [...nested.binding.prefix, ...nested.segments];
    const isArrayIndex = getCollectionInfo(nested.binding.trackedObject, targetPath)?.kind === "array";
    return {
      binding: nested.binding,
      segments: nested.segments,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "at"
      && node.arguments.length === 1
    ) {
      const receiver = resolveTrackedObjectAccess(project, node.expression.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
      if (!receiver) {
        return undefined;
      }

      if (receiver.dynamic) {
        return receiver;
      }

      const receiverPath = [...receiver.binding.prefix, ...receiver.segments];
      const collection = getCollectionInfo(receiver.binding.trackedObject, receiverPath);
      if (collection?.kind !== "array") {
        return undefined;
      }

      const resolvedIndex = resolveArrayAtIndex(receiver.binding.trackedObject, receiverPath, node.arguments[0]!);
      if (resolvedIndex === undefined) {
        return {
          binding: receiver.binding,
          segments: receiver.segments,
          dynamic: true,
          boundaryCategory: "array-at-call",
          boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
          viaAliasObjectId: receiver.viaAliasObjectId,
          viaAliasPath: receiver.viaAliasPath,
        };
      }

      const aliased = resolveExactPathAlias(
        receiver.binding,
        [...receiver.segments, indexSegment(resolvedIndex)],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, receiver.binding)
          ? [...receiver.segments, indexSegment(resolvedIndex)]
          : [],
        dynamic: false,
        viaAliasObjectId: aliased.viaAliasObjectId ?? receiver.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? receiver.viaAliasPath,
      };
    }

    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "get"
      && node.arguments.length === 1
      && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)
    ) {
      const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
      const binding = slotKey ? trackedBySymbolId.get(slotKey) : undefined;
      if (binding) {
        return {
          binding,
          segments: [],
          dynamic: false,
        };
      }
    }

    const callable = getAnalyzableCallableBinding(project, node.expression);
    const binding = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
    return binding
      ? {
          binding,
          segments: [],
          dynamic: false,
        }
      : undefined;
  }

  if (
    ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    const left = resolveTrackedObjectAccess(project, node.left, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const right = resolveTrackedObjectAccess(project, node.right, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }
    return sameTrackedBinding(extendTrackedBinding(left.binding, left.segments), extendTrackedBinding(right.binding, right.segments))
      ? {
          binding: left.binding,
          segments: left.segments,
          dynamic: left.dynamic || right.dynamic,
          boundaryCategory: left.boundaryCategory ?? right.boundaryCategory,
          boundaryReason: left.boundaryReason ?? right.boundaryReason,
        }
      : undefined;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveTrackedObjectAccess(project, node.whenTrue, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const whenFalse = resolveTrackedObjectAccess(project, node.whenFalse, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!whenTrue) {
      return whenFalse;
    }
    if (!whenFalse) {
      return whenTrue;
    }
    return sameTrackedBinding(
      extendTrackedBinding(whenTrue.binding, whenTrue.segments),
      extendTrackedBinding(whenFalse.binding, whenFalse.segments),
    )
      ? {
          binding: whenTrue.binding,
          segments: whenTrue.segments,
          dynamic: whenTrue.dynamic || whenFalse.dynamic,
          boundaryCategory: whenTrue.boundaryCategory ?? whenFalse.boundaryCategory,
          boundaryReason: whenTrue.boundaryReason ?? whenFalse.boundaryReason,
        }
      : undefined;
  }

  return undefined;
}

export function getForwardedParameterBindings(
  project: ProjectContext,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): ForwardedParameterBinding[] {
  const callable = getAnalyzableCallableBinding(project, node.expression);
  if (!callable) {
    return [];
  }

  const forwarded: ForwardedParameterBinding[] = [];

  node.arguments.forEach((argument, index) => {
    const parameter = callable.declaration.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return;
    }

    const resolved = resolveTrackedObjectAccess(project, argument, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!resolved || resolved.dynamic) {
      return;
    }

    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) {
      return;
    }

    forwarded.push({
      index,
      paramSymbolKey: getSymbolKey(parameterSymbol),
      binding: extendTrackedBinding(resolved.binding, resolved.segments),
    });
  });

  return forwarded;
}

export function getBindingSymbolKey(
  project: ProjectContext,
  node: ts.Expression | ts.ForInitializer | ts.ParameterDeclaration,
): string | undefined {
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  if (ts.isVariableDeclarationList(node) && node.declarations.length === 1) {
    const [declaration] = node.declarations;
    if (declaration && ts.isIdentifier(declaration.name)) {
      const symbol = project.checker.getSymbolAtLocation(declaration.name);
      return symbol ? getSymbolKey(symbol) : undefined;
    }
  }

  if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
    const symbol = project.checker.getSymbolAtLocation(node.name);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  return undefined;
}

/**
 * Resolves projected callback element access while preserving exactness boundaries.
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
            boundaryCategory: "dynamic-array-index",
            boundaryReason: "callback index cannot yet be correlated across different tracked arrays",
          };
    }

    if (nested.dynamic) {
      return nested;
    }

    if (ts.isNumericLiteral(node.argumentExpression) || ts.isStringLiteral(node.argumentExpression)) {
      return {
        projection: nested.projection,
        suffix: [
          ...nested.suffix,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
      };
    }

    const concreteTargets = getConcreteProjectionPaths(nested.projection, nested.suffix);
    const isArrayIndex = concreteTargets.some((path) => getCollectionInfo(nested.projection.trackedObject, path)?.kind === "array");
    return {
      projection: nested.projection,
      suffix: nested.suffix,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "at"
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
