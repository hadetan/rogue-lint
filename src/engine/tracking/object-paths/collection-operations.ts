import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import {
  getAccessPath,
  getBindingSymbolKey,
  resolveTrackedObjectAccess,
} from "../access.js";
import {
  extendTrackedBinding,
  getBindingByNode,
  sameTrackedBinding,
} from "../bindings.js";
import type {
  CallableReturnSummary,
  ProjectedArrayUsageContext,
  TrackedObjectBinding,
} from "../model.js";
import {
  getSupportedArrayCallbackIndexParamIndex,
  getSupportedArrayCallbackParamIndex,
  isExactArrayCallbackMethod,
} from "../projection-support.js";
import {
  ARRAY_APPEND_METHODS,
  ARRAY_REORDER_METHODS,
  ARRAY_REPLACEMENT_METHODS,
  ARRAY_TRUNCATE_METHODS,
  WHOLE_ARRAY_CONSUMPTION_METHODS,
} from "../semantics.js";
import { unwrapExpression } from "../syntax.js";
import {
  addValueFate,
  getCollectionInfo,
  getProjectionBinding,
} from "../state.js";

interface CollectionOperationHandlerOptions {
  project: ProjectContext;
  sourceFile: ts.SourceFile;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  handledExactCallbackBodies: Set<ts.Node>;
  handledSpreadAppendStarts: Set<number>;
  getPublicReturnBinding: (node: ts.Node) => TrackedObjectBinding | undefined;
  markObservedAggregateLiteralBindings: (expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression) => void;
  markObservedSubtree: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    aliasTrackedObjectsById?: Map<string, TrackedObject>,
    visited?: Set<string>,
  ) => void;
  markEscaped: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ) => void;
  handleTrackedArrayMutation: (
    project: ProjectContext,
    trackedObject: TrackedObject,
    mutationSourceFile: ts.SourceFile,
    node: ts.CallExpression,
    collectionPath: PathSegment[],
    methodName: string,
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
  visitProjectedArrayUsage: (
    project: ProjectContext,
    node: ts.Node,
    context: ProjectedArrayUsageContext,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
  ) => void;
}

/**
 * Owns collection operation rules for object-path analysis.
 */
export function createCollectionOperationHandler(options: CollectionOperationHandlerOptions): {
  handleReceiverCall: (node: ts.CallExpression, valueFateHandledIndices: Set<number>) => void;
  handleSpreadAssignment: (node: ts.SpreadAssignment) => void;
  handleSpreadElement: (node: ts.SpreadElement) => boolean;
} {
  const {
    project,
    sourceFile,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    handledExactCallbackBodies,
    handledSpreadAppendStarts,
    getPublicReturnBinding,
    markObservedAggregateLiteralBindings,
    markObservedSubtree,
    markEscaped,
    handleTrackedArrayMutation,
    recordArrayBoundary,
    visitProjectedArrayUsage,
  } = options;

  const handleReceiverCall = (
    node: ts.CallExpression,
    valueFateHandledIndices: Set<number>,
  ): void => {
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return;
    }

    const methodName = node.expression.name.text;
    const receiverExpression = unwrapExpression(node.expression.expression);
    const publicReturnBinding = getPublicReturnBinding(node);
    const wholeArrayReceiverCandidates = ts.isConditionalExpression(receiverExpression)
      ? [
        resolveTrackedObjectAccess(
          project,
          receiverExpression.whenTrue,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        ),
        resolveTrackedObjectAccess(
          project,
          receiverExpression.whenFalse,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        ),
      ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate && !candidate.dynamic))
      : [];
    const resolvedReceiver = resolveTrackedObjectAccess(
      project,
      receiverExpression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (methodName && WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
      for (const candidate of wholeArrayReceiverCandidates) {
        markObservedSubtree(
          candidate.binding.trackedObject,
          [...candidate.binding.prefix, ...candidate.segments],
          trackedObjectsById,
        );
      }
    }
    if (!resolvedReceiver || resolvedReceiver.dynamic) {
      return;
    }

    const tracked = resolvedReceiver.binding;
    const targetPath = [...resolvedReceiver.binding.prefix, ...resolvedReceiver.segments];
    const receiverBinding = extendTrackedBinding(resolvedReceiver.binding, resolvedReceiver.segments);
    const targetCollection = getCollectionInfo(tracked.trackedObject, targetPath);
    if (WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
      markObservedSubtree(tracked.trackedObject, targetPath, trackedObjectsById);
    }
    if (
      publicReturnBinding
      && sameTrackedBinding(publicReturnBinding, receiverBinding)
      && targetCollection?.kind === "array"
      && (methodName === "push" || methodName === "unshift")
    ) {
      for (const argument of node.arguments) {
        const aggregateArgument = unwrapExpression(argument);
        if (ts.isObjectLiteralExpression(aggregateArgument) || ts.isArrayLiteralExpression(aggregateArgument)) {
          markObservedAggregateLiteralBindings(aggregateArgument);
        }
      }
    }
    if (
      targetCollection?.kind === "array"
      && (
        ARRAY_APPEND_METHODS.has(methodName)
        || ARRAY_TRUNCATE_METHODS.has(methodName)
        || ARRAY_REPLACEMENT_METHODS.has(methodName)
        || ARRAY_REORDER_METHODS.has(methodName)
      )
      && !(valueFateHandledIndices.size === node.arguments.length && (methodName === "push" || methodName === "unshift"))
    ) {
      handleTrackedArrayMutation(project, tracked.trackedObject, sourceFile, node, targetPath, methodName);
    }
    if (
      targetCollection?.kind === "array"
      && isExactArrayCallbackMethod(methodName)
      && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const callee = node.expression;
      const callback = node.arguments[0];
      const paramIndex = getSupportedArrayCallbackParamIndex(methodName);
      const parameter = paramIndex === undefined ? undefined : callback.parameters[paramIndex];
      const indexParamIndex = getSupportedArrayCallbackIndexParamIndex(methodName);
      const indexParameter = indexParamIndex === undefined ? undefined : callback.parameters[indexParamIndex];
      const symbolKey = parameter ? getBindingSymbolKey(project, parameter) : undefined;
      const indexSymbolKey = indexParameter ? getBindingSymbolKey(project, indexParameter) : undefined;
      const receiverSymbolKey = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? getBindingSymbolKey(project, callee.expression)
        : undefined;
      const projection = getProjectionBinding(tracked.trackedObject, targetPath);
      if (symbolKey && projection && callback.body) {
        handledExactCallbackBodies.add(callback.body);
        visitProjectedArrayUsage(
          project,
          callback.body,
          {
            elementBindings: new Map([[symbolKey, projection]]),
            receiverBindings: receiverSymbolKey ? new Map([[receiverSymbolKey, projection]]) : new Map(),
            indexBindings: indexSymbolKey ? new Map([[indexSymbolKey, projection]]) : new Map(),
          },
          trackedObjectsById,
        );
      }
    }
  };

  const handleSpreadAssignment = (node: ts.SpreadAssignment): void => {
    const resolved = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "shallow-cloned",
        fullPath,
        "object spread reads this value to create a shallow-cloned object",
      );
    }
  };

  const handleSpreadElement = (node: ts.SpreadElement): boolean => {
    if (ts.isCallExpression(node.parent) && handledSpreadAppendStarts.has(node.getStart(sourceFile))) {
      return true;
    }

    if (ts.isCallExpression(node.parent)) {
      const calleeAccessPath = getAccessPath(node.parent.expression);
      const methodName = calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0
        && calleeAccessPath.segments.at(-1)?.kind === "property"
        ? calleeAccessPath.segments.at(-1)?.value
        : undefined;
      const trackedReceiver = calleeAccessPath
        ? getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId)
        : undefined;
      const receiverPath = trackedReceiver && calleeAccessPath
        ? [...trackedReceiver.prefix, ...calleeAccessPath.segments.slice(0, -1)]
        : undefined;
      const receiverCollection = trackedReceiver && receiverPath
        ? getCollectionInfo(trackedReceiver.trackedObject, receiverPath)
        : undefined;
      if (
        trackedReceiver
        && receiverPath
        && receiverCollection?.kind === "array"
        && (methodName === "push" || methodName === "unshift")
      ) {
        recordArrayBoundary(
          project,
          trackedReceiver.trackedObject,
          sourceFile,
          node.parent.expression,
          receiverPath,
          receiverPath,
          "array-append-mutation",
          `${methodName} spreads a source beyond exact local analysis`,
        );
        return true;
      }
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved) {
      if (ts.isArrayLiteralExpression(node.parent) && !resolved.dynamic) {
        const fullPath = [...resolved.binding.prefix, ...resolved.segments];
        markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
        addValueFate(
          resolved.binding.trackedObject,
          "shallow-cloned",
          fullPath,
          "array spread reads this value to create a shallow-cloned array",
        );
      } else {
        markEscaped(
          resolved.binding.trackedObject,
          resolved.binding.prefix,
          "spread-escape",
          "spread element escapes exact local analysis",
        );
      }
    }

    return false;
  };

  return {
    handleReceiverCall,
    handleSpreadAssignment,
    handleSpreadElement,
  };
}
