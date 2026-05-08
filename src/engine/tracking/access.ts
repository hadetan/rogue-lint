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

function extractBoundedElementAccessSegment(
  project: ProjectContext,
  argument: ts.Expression,
): PathSegment | undefined {
  const node = unwrapExpression(argument);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return propertySegment(node.text);
  }

  if (ts.isNumericLiteral(node)) {
    return indexSegment(Number(node.text));
  }

  if (
    ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand)
  ) {
    return indexSegment(-Number(node.operand.text));
  }

  const type = project.checker.getTypeAtLocation(node);
  const candidateTypes = type.isUnion() ? type.types : [type];
  const seen = new Set<string>();
  let segment: PathSegment | undefined;

  for (const candidateType of candidateTypes) {
    let nextSegment: PathSegment | undefined;

    if (candidateType.flags & ts.TypeFlags.StringLiteral) {
      nextSegment = propertySegment((candidateType as ts.StringLiteralType).value);
    } else if (candidateType.flags & ts.TypeFlags.NumberLiteral) {
      nextSegment = indexSegment((candidateType as ts.NumberLiteralType).value);
    } else {
      return undefined;
    }

    const key = `${nextSegment.kind}:${nextSegment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (segment) {
      return undefined;
    }
    segment = nextSegment;
  }

  return segment;
}

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

function isObjectCreateNullExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Object"
    && node.expression.name.text === "create"
    && node.arguments.length === 1
    && node.arguments[0]!.kind === ts.SyntaxKind.NullKeyword;
}

function getLocallyOwnedRetainedBindingContainerKind(
  project: ProjectContext,
  expression: ts.Expression,
): "map-like" | "object-backed" | undefined {
  const node = unwrapExpression(expression);
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  for (const declaration of getCanonicalSymbol(project, symbol).declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }

    const initializer = unwrapExpression(declaration.initializer);
    if (
      ts.isNewExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && ["Map", "WeakMap"].includes(initializer.expression.text)
    ) {
      return "map-like";
    }

    if (isObjectCreateNullExpression(initializer)) {
      return "object-backed";
    }
  }

  return undefined;
}

function getRetainedBindingContainerReceiverKey(project: ProjectContext, receiver: ts.Expression): string | undefined {
  const node = unwrapExpression(receiver);
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  return symbol ? `container:${getCanonicalSymbolKey(project, symbol)}` : undefined;
}

function getRetainedBindingContainerStaticPropertySlotKey(
  project: ProjectContext,
  receiver: ts.Expression,
  propertyName: string,
): string | undefined {
  const receiverKey = getRetainedBindingContainerReceiverKey(project, receiver);
  return receiverKey ? `${receiverKey}:string:${propertyName}` : undefined;
}

export function isSupportedRetainedBindingContainerType(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  const typeName = getContainerTypeName(project, expression);
  return typeName === "Map"
    || typeName === "WeakMap"
    || getLocallyOwnedRetainedBindingContainerKind(project, expression) === "object-backed";
}

export function isLocallyOwnedRetainedBindingContainer(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  return getLocallyOwnedRetainedBindingContainerKind(project, expression) !== undefined;
}

function isLocallyOwnedObjectBackedRetainedBindingContainer(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  return getLocallyOwnedRetainedBindingContainerKind(project, expression) === "object-backed";
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
  const receiverKey = getRetainedBindingContainerReceiverKey(project, receiver);
  if (!receiverKey || !isSupportedRetainedBindingContainerType(project, receiver)) {
    return undefined;
  }

  const slotToken = getRetainedBindingContainerSlotToken(project, slot);
  if (!slotToken) {
    return undefined;
  }

  return `${receiverKey}:${slotToken}`;
}

export function getObjectBackedRetainedBindingSlotKeyFromAccess(
  project: ProjectContext,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (!isLocallyOwnedObjectBackedRetainedBindingContainer(project, node.expression)) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return getRetainedBindingContainerStaticPropertySlotKey(project, node.expression, node.name.text);
  }

  if (!node.argumentExpression) {
    return undefined;
  }

  const argument = unwrapExpression(node.argumentExpression);
  if (
    !ts.isStringLiteral(argument)
    && !ts.isNoSubstitutionTemplateLiteral(argument)
    && !ts.isNumericLiteral(argument)
  ) {
    return undefined;
  }

  return getRetainedBindingContainerSlotKey(project, node.expression, argument);
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
  if (ts.isAwaitExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
  }

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

    const retainedBinding = trackedBySymbolId.get(
      getObjectBackedRetainedBindingSlotKeyFromAccess(project, node) ?? "",
    );
    if (retainedBinding) {
      return {
        binding: retainedBinding,
        segments: [],
        dynamic: false,
      };
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

    const retainedBinding = trackedBySymbolId.get(
      getObjectBackedRetainedBindingSlotKeyFromAccess(project, node) ?? "",
    );
    if (retainedBinding) {
      return {
        binding: retainedBinding,
        segments: [],
        dynamic: false,
      };
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    const boundedSegment = extractBoundedElementAccessSegment(project, node.argumentExpression);
    if (boundedSegment) {
      const nextSegment = boundedSegment;
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
      && (node.expression.name.text === "pop" || node.expression.name.text === "shift")
      && node.arguments.length === 0
    ) {
      const receiver = resolveTrackedObjectAccess(
        project,
        node.expression.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
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

      const arrayLength = getTrackedArrayLength(receiver.binding.trackedObject, receiverPath);
      const targetIndex = node.expression.name.text === "pop"
        ? (arrayLength !== undefined && arrayLength > 0 ? arrayLength - 1 : undefined)
        : arrayLength === 1
          ? 0
          : undefined;
      if (targetIndex === undefined) {
        return undefined;
      }

      const aliased = resolveExactPathAlias(
        receiver.binding,
        [...receiver.segments, indexSegment(targetIndex)],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, receiver.binding)
          ? [...receiver.segments, indexSegment(targetIndex)]
          : [],
        dynamic: false,
        viaAliasObjectId: aliased.viaAliasObjectId ?? receiver.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? receiver.viaAliasPath,
      };
    }

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
