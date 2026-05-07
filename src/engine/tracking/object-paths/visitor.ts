import ts from "typescript";

import type {
  ProjectContext,
  SuppressionContext,
  TrackedObject,
} from "../../../types.js";
import { isReadLikeUse } from "../../../compiler/ast-utils.js";
import { propertySegment } from "../../../shared/path-utils.js";
import type { AnalysisState } from "../../analysis-state.js";
import {
  getAccessPath,
  getBindingSymbolKey,
  getRetainedBindingContainerSlotKey,
  getSupportedArrayCallbackIndexParamIndex,
  getSupportedArrayCallbackParamIndex,
  isExactArrayCallbackMethod,
  isLocallyOwnedRetainedBindingContainer,
  isSupportedRetainedBindingContainerType,
  resolveProjectionAccess,
  resolveTrackedObjectAccess,
} from "../access.js";
import {
  extendTrackedBinding,
  getBindingByNode,
  getCanonicalSymbolKey,
  getGlobalThisBindingKey,
  getStaticGlobalThisPropertyName,
  mergeTrackedBinding,
  sameTrackedBinding,
} from "../bindings.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getCallableReturnBinding,
  resolveAnalyzableFunctionDeclaration,
} from "../callables.js";
import type {
  ArrayProjectionBinding,
  CallableReturnSummary,
  HelperParameterSummary,
  ProjectedArrayUsageContext,
  TrackedObjectBinding,
} from "../model.js";
import {
  ARRAY_APPEND_METHODS,
  ARRAY_REORDER_METHODS,
  ARRAY_REPLACEMENT_METHODS,
  ARRAY_TRUNCATE_METHODS,
  OBSERVATION_ONLY_CALLS,
  WHOLE_ARRAY_CONSUMPTION_METHODS,
  buildHelperBoundaryReason,
  summarizeHelperParameterUse,
} from "../semantics.js";
import {
  addValueFate,
  getCollectionInfo,
  getConcreteProjectionPaths,
  getProjectionBinding,
  hasTrackedChildren,
  markAliasObserved,
  markEscaped,
  markObservedSubtree,
  markProjectionElementRead,
  markProjectionReads,
  markProjectionWrites,
  markRead,
  markWrite,
} from "../state.js";
import {
  handleSupportedValueFateCall,
  handleTrackedArrayMutation,
  maybeInvalidateReplacedTrackedPath,
  maybeReportInvalidatedRead,
  recordArrayBoundary,
} from "./effects.js";
import { isAssignmentLeft, visitProjectedArrayUsage } from "./projections.js";

export function visitObjectPathSourceFile(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
): void {
  const projectionBindings = new Map<string, ArrayProjectionBinding>();
  const projectionContext: ProjectedArrayUsageContext = {
    elementBindings: projectionBindings,
    receiverBindings: new Map(),
    indexBindings: new Map(),
  };
  const handledExactCallbackBodies = new Set<ts.Node>();
  const retainedContainerConflicts = new Set<string>();
  const handledSpreadAppendStarts = new Set<number>();
  const parameterMeaningfulUse = new Map<string, boolean | null>();
  const parameterSummaryCache = new Map<string, HelperParameterSummary | null>();

  const visit = (node: ts.Node): void => {
    if (handledExactCallbackBodies.has(node)) {
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const target = project.checker.getSymbolAtLocation(node.name);
      const resolved = resolveTrackedObjectAccess(
        project,
        node.initializer,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (target && resolved && !resolved.dynamic) {
        trackedBySymbolId.set(
          getCanonicalSymbolKey(project, target),
          extendTrackedBinding(resolved.binding, resolved.segments),
        );
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const resolved = resolveTrackedObjectAccess(
        project,
        node.right,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      const globalThisProperty = getStaticGlobalThisPropertyName(node.left);
      if (globalThisProperty && resolved && !resolved.dynamic) {
        trackedBySymbolId.set(
          getGlobalThisBindingKey(globalThisProperty),
          extendTrackedBinding(resolved.binding, resolved.segments),
        );
      } else if (globalThisProperty) {
        trackedBySymbolId.delete(getGlobalThisBindingKey(globalThisProperty));
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const resolved = resolveTrackedObjectAccess(
        project,
        node.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        const returnBinding = extendTrackedBinding(resolved.binding, resolved.segments);
        const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
        const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
        const propagated = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
        if (!propagated || !sameTrackedBinding(propagated, returnBinding)) {
          markEscaped(
            returnBinding.trackedObject,
            returnBinding.prefix,
            "returned-object",
            "returned object escapes local analysis",
          );
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const handledRetainedContainerIndices = new Set<number>();
      if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "set"
        && node.arguments.length >= 2
        && isSupportedRetainedBindingContainerType(project, node.expression.expression)
      ) {
        const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
        const resolvedValue = resolveTrackedObjectAccess(
          project,
          node.arguments[1]!,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolvedValue && !resolvedValue.dynamic) {
          handledRetainedContainerIndices.add(1);
          if (slotKey && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)) {
            mergeTrackedBinding(
              trackedBySymbolId,
              retainedContainerConflicts,
              slotKey,
              extendTrackedBinding(resolvedValue.binding, resolvedValue.segments),
            );
          }
        }
      }

      const valueFateHandledIndices = handleSupportedValueFateCall(
        project,
        sourceFile,
        node,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
        handledSpreadAppendStarts,
      );
      const calleeAccessPath = getAccessPath(node.expression);
      if (calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0) {
        const methodSegment = calleeAccessPath.segments.at(-1);
        const methodName = methodSegment?.kind === "property" ? methodSegment.value : undefined;
        const tracked = getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId);
        const targetPath = tracked ? [...tracked.prefix, ...calleeAccessPath.segments.slice(0, -1)] : undefined;
        if (tracked && methodName && targetPath) {
          const targetCollection = getCollectionInfo(tracked.trackedObject, targetPath);
          if (WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
            markObservedSubtree(tracked.trackedObject, targetPath, trackedObjectsById);
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
        }
      }

      const calleeText = node.expression.getText(sourceFile);
      const analyzableCallable = resolveAnalyzableFunctionDeclaration(project, node.expression);
      for (const [index, argument] of node.arguments.entries()) {
        const resolved = resolveTrackedObjectAccess(
          project,
          argument,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (!resolved) {
          continue;
        }

        if (handledRetainedContainerIndices.has(index)) {
          continue;
        }

        const fullPath = [...resolved.binding.prefix, ...resolved.segments];
        if (resolved.dynamic) {
          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          if (collectionInfo?.kind === "array" && resolved.boundaryCategory) {
            recordArrayBoundary(
              project,
              resolved.binding.trackedObject,
              sourceFile,
              argument,
              fullPath,
              fullPath,
              resolved.boundaryCategory,
              resolved.boundaryReason ?? "computed property access prevents exact path analysis",
              true,
            );
          } else {
            markEscaped(
              resolved.binding.trackedObject,
              fullPath,
              resolved.boundaryCategory ?? "computed-property-access",
              resolved.boundaryReason ?? "computed property access prevents exact path analysis",
            );
          }
          continue;
        }

        if (
          calleeText === "Object.keys"
          || calleeText === "Object.values"
          || calleeText === "Object.entries"
          || calleeText === "Reflect.ownKeys"
        ) {
          markEscaped(
            resolved.binding.trackedObject,
            fullPath,
            "reflective-enumeration",
            `${calleeText} makes object properties externally observable`,
          );
          continue;
        }

        if (calleeText === "JSON.stringify") {
          markEscaped(
            resolved.binding.trackedObject,
            fullPath,
            "serialization",
            "JSON.stringify makes object properties externally observable",
          );
          continue;
        }

        const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
        const parameter = analyzableCallable?.parameters[index];
        const helperHasStructuredChildren = collectionInfo !== undefined
          || hasTrackedChildren(resolved.binding.trackedObject, fullPath);
        if (parameter && ts.isIdentifier(parameter.name) && analyzableCallable && helperHasStructuredChildren) {
          const summary = summarizeHelperParameterUse(
            project,
            analyzableCallable,
            parameter.name,
            parameterMeaningfulUse,
            parameterSummaryCache,
          );
          if (collectionInfo?.kind === "array") {
            if (summary.boundaryReason) {
              recordArrayBoundary(
                project,
                resolved.binding.trackedObject,
                sourceFile,
                argument,
                fullPath,
                fullPath,
                "array-opaque-mutation",
                buildHelperBoundaryReason(
                  project,
                  summary,
                  "same-project helper receives this collection beyond exact local analysis",
                ),
                true,
              );
            }
            continue;
          }

          if (summary.boundaryReason) {
            markEscaped(
              resolved.binding.trackedObject,
              fullPath,
              "opaque-object-call",
              buildHelperBoundaryReason(
                project,
                summary,
                resolved.segments.length === 0
                  ? "same-project helper receives this object beyond exact local analysis"
                  : "same-project helper receives this object path beyond exact local analysis",
              ),
            );
          }
          continue;
        }

        if (valueFateHandledIndices.has(index)) {
          continue;
        }

        if (OBSERVATION_ONLY_CALLS.has(calleeText)) {
          markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
          continue;
        }

        if (collectionInfo?.kind === "array") {
          recordArrayBoundary(
            project,
            resolved.binding.trackedObject,
            sourceFile,
            argument,
            fullPath,
            fullPath,
            "array-opaque-mutation",
            resolved.segments.length === 0
              ? "collection passed to call expression escapes exact local analysis"
              : "collection path passed to call expression escapes exact local analysis",
            true,
          );
          continue;
        }

        if (resolved.segments.length > 0 && !hasTrackedChildren(resolved.binding.trackedObject, fullPath) && !collectionInfo) {
          markAliasObserved(resolved, trackedObjectsById);
          markRead(resolved.binding.trackedObject, fullPath);
          continue;
        }

        markEscaped(
          resolved.binding.trackedObject,
          fullPath,
          "opaque-object-call",
          resolved.segments.length === 0
            ? "object passed to call expression escapes exact local analysis"
            : "object path passed to call expression escapes exact local analysis",
        );
      }
    }

    if (ts.isForOfStatement(node)) {
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
          );
        } else {
          markObservedSubtree(
            resolved.binding.trackedObject,
            [...resolved.binding.prefix, ...resolved.segments],
            trackedObjectsById,
          );
        }
      }
    }

    if (ts.isSpreadAssignment(node)) {
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
    }

    if (ts.isSpreadElement(node)) {
      if (ts.isCallExpression(node.parent) && handledSpreadAppendStarts.has(node.getStart(sourceFile))) {
        return;
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
          return;
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
    }

    if (ts.isIdentifier(node)) {
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

      if (ts.isCallExpression(node.parent)) {
        const argumentIndex = node.parent.arguments.findIndex((argument) => argument === node);
        const callable = argumentIndex >= 0 ? resolveAnalyzableFunctionDeclaration(project, node.parent.expression) : undefined;
        const resolved = argumentIndex >= 0
          ? resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById)
          : undefined;
        if (callable && resolved && !resolved.dynamic) {
          const fullPath = [...resolved.binding.prefix, ...resolved.segments];
          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          const parameter = callable.parameters[argumentIndex];
          if (collectionInfo?.kind === "array" && parameter && ts.isIdentifier(parameter.name)) {
            const summary = summarizeHelperParameterUse(
              project,
              callable,
              parameter.name,
              parameterMeaningfulUse,
              parameterSummaryCache,
            );
            if (!summary.boundaryReason) {
              return;
            }
            recordArrayBoundary(
              project,
              resolved.binding.trackedObject,
              sourceFile,
              node,
              fullPath,
              fullPath,
              "array-opaque-mutation",
              buildHelperBoundaryReason(
                project,
                summary,
                "same-project helper receives this collection beyond exact local analysis",
              ),
              true,
            );
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const resolved = resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
      if (!resolved) {
        const projected = resolveProjectionAccess(project, node, projectionContext);
        if (!projected) {
          return ts.forEachChild(node, visit);
        }

        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            sourceFile,
            node,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array projection escapes exact local analysis",
            true,
          );
          return ts.forEachChild(node, visit);
        }

        if (isAssignmentLeft(node)) {
          if (projected.suffix.length > 1) {
            markProjectionReads(projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
          }
          for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
            maybeInvalidateReplacedTrackedPath(project, projected.projection.trackedObject, sourceFile, node, fullPath);
          }
          markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
        } else {
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
        }
        return ts.forEachChild(node, visit);
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      if (resolved.dynamic) {
        const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
        if (collectionInfo?.kind === "array" && resolved.boundaryCategory) {
          recordArrayBoundary(
            project,
            resolved.binding.trackedObject,
            sourceFile,
            node,
            fullPath,
            fullPath,
            resolved.boundaryCategory,
            resolved.boundaryReason ?? "computed property access prevents exact path analysis",
            true,
          );
        } else {
          markEscaped(
            resolved.binding.trackedObject,
            fullPath,
            resolved.boundaryCategory ?? "computed-property-access",
            resolved.boundaryReason ?? "computed property access prevents exact path analysis",
          );
        }
        return ts.forEachChild(node, visit);
      }

      if (fullPath.length === 0) {
        return ts.forEachChild(node, visit);
      }

      if (isAssignmentLeft(node)) {
        if (fullPath.length > 1) {
          markAliasObserved(resolved, trackedObjectsById);
          markRead(resolved.binding.trackedObject, fullPath.slice(0, -1));
        }
        maybeInvalidateReplacedTrackedPath(project, resolved.binding.trackedObject, sourceFile, node, fullPath);
        markWrite(resolved.binding.trackedObject, fullPath);
      } else {
        maybeReportInvalidatedRead(
          project,
          sourceFile,
          state,
          suppressionContext,
          resolved.binding.trackedObject,
          node,
          fullPath,
        );
        markAliasObserved(resolved, trackedObjectsById);
        markRead(resolved.binding.trackedObject, fullPath);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) {
      const resolved = resolveTrackedObjectAccess(
        project,
        node.initializer,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        return ts.forEachChild(node, visit);
      }

      const projection = getProjectionBinding(
        resolved.binding.trackedObject,
        [...resolved.binding.prefix, ...resolved.segments],
      );
      if (!projection) {
        return ts.forEachChild(node, visit);
      }

      node.name.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) {
          return;
        }

        if (element.dotDotDotToken) {
          recordArrayBoundary(
            project,
            projection.trackedObject,
            sourceFile,
            element,
            projection.sourcePath,
            projection.sourcePath,
            "array-rest",
            "array rest pattern escapes remaining elements",
            true,
          );
          return;
        }

        if (ts.isIdentifier(element.name)) {
          const symbolKey = getBindingSymbolKey(project, element.name);
          if (symbolKey) {
            const elementPath = projection.elementPaths[index];
            if (elementPath) {
              projectionBindings.set(symbolKey, {
                trackedObject: projection.trackedObject,
                sourcePath: elementPath,
                elementPaths: [elementPath],
              });
            }
          }
          markProjectionElementRead(projection, trackedObjectsById, index);
          return;
        }

        markProjectionElementRead(projection, trackedObjectsById, index, true);
      });
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const resolved = resolveTrackedObjectAccess(
        project,
        node.initializer,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        return ts.forEachChild(node, visit);
      }

      for (const element of node.name.elements) {
        if (element.dotDotDotToken) {
          markEscaped(
            resolved.binding.trackedObject,
            [...resolved.binding.prefix, ...resolved.segments],
            "object-rest",
            "object rest pattern escapes remaining properties",
          );
          continue;
        }

        const keyNode = element.propertyName ?? element.name;
        if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
          markAliasObserved(resolved, trackedObjectsById);
          markRead(
            resolved.binding.trackedObject,
            [...resolved.binding.prefix, ...resolved.segments, propertySegment(keyNode.text)],
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
}
