import ts from "typescript";

import type { PathSegment, SkipCategory, TrackedObject } from "../../../types.js";
import { createAnalysisState, type AnalysisState } from "../../analysis-state.js";
import { getSymbolKey } from "../../../compiler/ast-utils.js";
import { ENTITY_KIND } from "../../../shared/entity-vocabulary.js";
import { makeEntity } from "../../../shared/entity-utils.js";
import { TRACKED_OBJECT_NODE_ORIGIN } from "../../../shared/path-vocabulary.js";
import { indexSegment, isSerializedPathWithin, propertySegment, renderPath, serializePath } from "../../../shared/path-utils.js";
import { isTrackingProtectedStructuralRole } from "../ownership.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { TRACKING_COLLECTION_KIND, TRACKING_PLACE_STATE, TRACKING_RETAINED_BINDING_WRITE_METHOD } from "../vocabulary.js";
import { getObjectBackedRetainedBindingSlotKeyFromAccess, getRetainedBindingContainerSlotKey, isLocallyOwnedRetainedBindingContainer, isSupportedRetainedBindingContainerType } from "../retained-bindings.js";
import { getBindingSymbolKey, getCallSiteLiteralArgumentBinding, getCallSiteStructuredArgumentBinding, resolveAnalyzableCallableBinding, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, getCanonicalSymbolKey, getGlobalThisBindingKey, getStaticGlobalThisPropertyName, mergeTrackedBinding, sameTrackedBinding } from "../bindings.js";
import { getCarrierLookupsForProject } from "../carriers.js";
import { getAnalyzableCallableBindingFromDeclaration, getCallableReturnBinding } from "../callables.js";
import type { AnalyzableCallableBinding, ArrayProjectionBinding, ResolvedTrackedObjectAccess, TrackedObjectBinding } from "../model.js";
import { buildHelperBoundaryReason, classifySupportedCallArgumentUse, resolveHelperMemberCallCandidates, summarizeHelperParameterUse } from "../semantics.js";
import { ensureCollectionChildPath, getCollectionInfo, getProjectionBinding, hasTrackedChildren, indexTrackedObjectNode, registerExactPathAlias, resolveExactPathAlias } from "../state.js";
import { unwrapExpression } from "../syntax.js";
import {
  registerBoundaryCapabilityFact as registerBoundaryCapabilityFactHelper,
  registerLiveFiniteKeyedAccessFact,
} from "./boundary-facts.js";
import {
  handleSupportedValueFateCall as handleSupportedValueFateCallEffect, handleTrackedArrayMutation as handleTrackedArrayMutationEffect, maybeInvalidateReplacedTrackedPath as maybeInvalidateReplacedTrackedPathEffect,
  maybeReportInvalidatedRead as maybeReportInvalidatedReadEffect, recordArrayBoundary as recordArrayBoundaryEffect, tryRegisterExactArrayInsertion,
} from "./effects.js";
import { materializeTrackedLiteralAtPath } from "../literal-materialization.js";
import {
  markObjectPathAliasObserved, markObjectPathEscaped, markObjectPathObservedChildPaths, markObjectPathObservedSubtree, markObjectPathProjectionChildReads,
  markObjectPathProjectionElementRead, markObjectPathProjectionReads, markObjectPathProjectionWrites, markObjectPathRead, markObjectPathWrite,
} from "./overlay.js";
import type { ObjectPathSourceFileContext, ObjectPathStageContext } from "./types.js";
import { createCollectionOperationHandler } from "./collection-operations.js";
import { createDestructuringHandler } from "./destructuring.js";
import { createFiniteLookupPlanner } from "./finite-lookups.js";
import { createHelperTransportHandler } from "./helper-transport.js";
import { createHelperPlanningHelpers } from "./helper-plans.js";
import { createProjectionTraversalHandler } from "./projection-traversal.js";
import { isAssignmentLeft, visitProjectedArrayUsage as visitProjectedArrayUsageEffect } from "./projections.js";
import { createReturnedStructureHandler } from "./returned-structures.js";

/**
 * Visits one source file with the object-path stage's exact alias, collection, and helper rules.
 */
export function visitObjectPathSourceFile(
  stageContext: ObjectPathStageContext,
  stateOrSourceFileContext: AnalysisState | ObjectPathSourceFileContext,
  maybeSourceFileContext?: ObjectPathSourceFileContext,
): void {
  const state = maybeSourceFileContext ? stateOrSourceFileContext as AnalysisState : createAnalysisState();
  const sourceFileContext = maybeSourceFileContext ?? stateOrSourceFileContext as ObjectPathSourceFileContext;
  const {
    project,
    reachableFiles,
    publicSurfaceIds,
    publiclyReachableCallableIds,
    overlayState,
    trackedBindingRegistry: trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectRegistry: trackedObjectsById,
    suppressionContext,
  } = stageContext;
  const {
    sourceFile,
    projectionBindings,
    projectionReceiverBindings,
    projectionIndexBindings,
    finiteLookupBindings,
    helperFiniteReturnCache,
    handledExactCallbackBodies,
    retainedContainerConflicts,
    handledSpreadAppendStarts,
    parameterMeaningfulUse,
    parameterSummaryCache,
    helperExecutionSnapshotCache,
    helperExactAppendPlanCache,
    helperProjectedUsagePlanCache,
    higherOrderCallableReturnSummaryCache,
  } = sourceFileContext;
  const capabilityFacts = state.runState.capabilityFacts;
  const projectionContext = {
    elementBindings: projectionBindings,
    receiverBindings: projectionReceiverBindings,
    indexBindings: projectionIndexBindings,
  };
  const carrierLookups = getCarrierLookupsForProject(project);

  const markAliasObserved = (
    resolved: ResolvedTrackedObjectAccess,
    aliasTrackedObjectsById: Map<string, TrackedObject>,
  ): void => {
    markObjectPathAliasObserved(overlayState, resolved, aliasTrackedObjectsById);
  };

  const markObservedChildPaths = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    aliasTrackedObjectsById?: Map<string, TrackedObject>,
  ): void => {
    markObjectPathObservedChildPaths(overlayState, trackedObject, segments, aliasTrackedObjectsById);
  };

  const registerBoundaryCapabilityFact = (
    trackedObject: TrackedObject,
    boundarySourceFile: ts.SourceFile,
    node: ts.Node,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ): void => {
    registerBoundaryCapabilityFactHelper(
      capabilityFacts,
      project,
      trackedObject,
      boundarySourceFile,
      node,
      segments,
      category,
      reason,
      detailHint,
    );
  };

  const markEscaped = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ): void => {
    registerBoundaryCapabilityFact(trackedObject, sourceFile, sourceFile, segments, category, reason, detailHint);
    const escapedPath = serializePath(segments);
    if (segments.length > 0) {
      for (const [aliasPath, alias] of trackedObject.exactPathAliases.entries()) {
        if (!isSerializedPathWithin(aliasPath, escapedPath)) {
          continue;
        }

        const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
        if (sourceTrackedObject) {
          markObjectPathObservedSubtree(
            overlayState,
            sourceTrackedObject,
            alias.sourcePath,
            trackedObjectsById,
          );
        }
      }
    }
    const aliasResolved = resolveExactPathAlias(
      { trackedObject, prefix: [] },
      segments,
      trackedObjectsById,
    );
    if (!sameTrackedBinding(aliasResolved.binding, { trackedObject, prefix: [] })) {
      markObjectPathObservedSubtree(
        overlayState,
        aliasResolved.binding.trackedObject,
        aliasResolved.binding.prefix,
        trackedObjectsById,
      );
    }
    markObjectPathEscaped(overlayState, trackedObject, segments, category, reason);
  };

  const markObservedSubtree = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    aliasTrackedObjectsById?: Map<string, TrackedObject>,
    visited = new Set<string>(),
  ): void => {
    markObjectPathObservedSubtree(overlayState, trackedObject, segments, aliasTrackedObjectsById, visited);
  };

  const setLocalHelperBinding = (
    bindings: Map<string, TrackedObjectBinding>,
    identifier: ts.Identifier,
    binding: TrackedObjectBinding,
  ): void => {
    const symbol = project.checker.getSymbolAtLocation(identifier);
    if (!symbol) {
      return;
    }

    bindings.set(getSymbolKey(symbol), binding);
    bindings.set(getCanonicalSymbolKey(project, symbol), binding);
  };

  const getLocalHelperBinding = (
    bindings: ReadonlyMap<string, TrackedObjectBinding>,
    identifier: ts.Identifier,
  ): TrackedObjectBinding | undefined => {
    const symbol = project.checker.getSymbolAtLocation(identifier);
    if (!symbol) {
      return undefined;
    }

    return bindings.get(getCanonicalSymbolKey(project, symbol))
      ?? bindings.get(getSymbolKey(symbol));
  };

  const getSingleReturnExpression = (callable: ts.FunctionLikeDeclaration): ts.Expression | undefined => {
    if (!callable.body) {
      return undefined;
    }

    if (!ts.isBlock(callable.body)) {
      return callable.body;
    }

    let match: ts.Expression | undefined;
    let multiple = false;

    const visitReturn = (candidate: ts.Node): void => {
      if (multiple || (ts.isFunctionLike(candidate) && candidate !== callable)) {
        return;
      }

      if (ts.isReturnStatement(candidate) && candidate.expression) {
        if (match) {
          multiple = true;
          return;
        }

        match = candidate.expression;
        return;
      }

      ts.forEachChild(candidate, visitReturn);
    };

    ts.forEachChild(callable.body, visitReturn);
    return multiple ? undefined : match;
  };

  const getStaticAccessPath = (
    expression: ts.Expression,
  ): { root: ts.Expression; segments: string[] } | undefined => {
    const segments: string[] = [];
    let current = unwrapExpression(expression);

    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        segments.unshift(current.name.text);
        current = unwrapExpression(current.expression);
        continue;
      }

      if (
        ts.isElementAccessExpression(current)
        && current.argumentExpression
        && (
          ts.isStringLiteral(current.argumentExpression)
          || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
          || ts.isNumericLiteral(current.argumentExpression)
        )
      ) {
        segments.unshift(current.argumentExpression.text);
        current = unwrapExpression(current.expression);
        continue;
      }

      return segments.length > 0
        ? {
            root: current,
            segments,
          }
        : undefined;
    }
  };

  const bindBinaryAssignedClosureLocals = (
    node: ts.CallExpression,
    callable: ts.FunctionLikeDeclaration,
    localBindings: Map<string, TrackedObjectBinding>,
  ): void => {
    if (!(ts.isArrowFunction(callable) || ts.isFunctionExpression(callable))) {
      return;
    }

    const parent = callable.parent;
    if (
      !ts.isBinaryExpression(parent)
      || parent.right !== callable
      || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      return;
    }

    const assignmentPath = getStaticAccessPath(parent.left);
    const callPath = getStaticAccessPath(node.expression);
    if (!assignmentPath || !callPath) {
      return;
    }

    const matchesClosureAccessSegment = (
      expected: string,
      actual: string,
      index: number,
      segments: readonly string[],
    ): boolean => {
      if (expected === actual) {
        return true;
      }

      if (index === 0) {
        return false;
      }

      const namespaceSegment = segments[index - 1];
      return Boolean(namespaceSegment) && carrierLookups.areInterchangeableMethodsFor(namespaceSegment!, expected, actual);
    };

    const receiverSegments = callPath.segments.slice(0, callPath.segments.length - assignmentPath.segments.length);
    if (
      callPath.segments.length < assignmentPath.segments.length
      || assignmentPath.segments.some(
        (segment, index) => !matchesClosureAccessSegment(
          segment,
          callPath.segments[receiverSegments.length + index] ?? "",
          index,
          assignmentPath.segments,
        ),
      )
    ) {
      return;
    }

    if (ts.isIdentifier(callPath.root)) {
      const rootKey = (() => {
        try {
          return getBindingSymbolKey(project, callPath.root);
        } catch {
          return undefined;
        }
      })();
      if (!rootKey || !localBindings.has(rootKey)) {
        return;
      }
    }

    const receiverResolved = resolveTrackedObjectAccess(
      project,
      callPath.root,
      localBindings,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (!receiverResolved || receiverResolved.dynamic) {
      return;
    }

    const collapseExactAliasPrefix = (binding: TrackedObjectBinding): TrackedObjectBinding => {
      let current = binding;

      while (current.prefix.length > 0) {
        const baseBinding: TrackedObjectBinding = {
          trackedObject: current.trackedObject,
          prefix: [],
        };
        const aliased = resolveExactPathAlias(baseBinding, current.prefix, trackedObjectsById);
        if (sameTrackedBinding(aliased.binding, baseBinding)) {
          break;
        }

        current = aliased.binding;
      }

      return current;
    };

    let receiverBinding = collapseExactAliasPrefix(
      extendTrackedBinding(receiverResolved.binding, receiverResolved.segments),
    );
    for (const segment of receiverSegments) {
      const aliased = resolveExactPathAlias(receiverBinding, [propertySegment(segment)], trackedObjectsById);
      receiverBinding = sameTrackedBinding(aliased.binding, receiverBinding)
        ? extendTrackedBinding(receiverBinding, [propertySegment(segment)])
        : aliased.binding;
      receiverBinding = collapseExactAliasPrefix(receiverBinding);
    }

    if (ts.isIdentifier(assignmentPath.root)) {
      setLocalHelperBinding(localBindings, assignmentPath.root, receiverBinding);
    }

    const enclosingCallable = ts.findAncestor(
      parent,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor) && ancestor !== callable,
    );
    const definitionParameter = enclosingCallable?.parameters[1];
    if (!definitionParameter || !ts.isIdentifier(definitionParameter.name)) {
      return;
    }

    if (getLocalHelperBinding(localBindings, definitionParameter.name)) {
      return;
    }

    const assignmentNamespaceSegment = assignmentPath.segments[assignmentPath.segments.length - 2];
    const definitionPathSegments = assignmentNamespaceSegment
      ? carrierLookups.getDefinitionPathSegments(assignmentNamespaceSegment)
      : undefined;
    if (!definitionPathSegments) {
      return;
    }

    setLocalHelperBinding(
      localBindings,
      definitionParameter.name,
      extendTrackedBinding(receiverBinding, definitionPathSegments),
    );
  };

  const getHelperLocalLiteralBinding = (
    literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    localBindings: Map<string, TrackedObjectBinding>,
    callNode: ts.CallExpression,
  ): TrackedObjectBinding => {
    const trackedObjectId = `helper-local-literal:${literal.getSourceFile().fileName}:${literal.getStart()}:call:${callNode.getSourceFile().fileName}:${callNode.getStart()}`;
    const existing = trackedObjectsById.get(trackedObjectId);
    if (existing) {
      return {
        trackedObject: existing,
        prefix: [],
      };
    }

    const rootName = "localLiteral";
    const trackedObject: TrackedObject = {
      id: trackedObjectId,
      derivedStateRevision: 0,
      canonicalSymbolKey: trackedObjectId,
      rootName,
      sourceFile: literal.getSourceFile().fileName,
      rootEntity: makeEntity(project.rootPath, ENTITY_KIND.local, literal.getSourceFile(), literal, rootName),
      nodes: new Map(),
      callablePaths: new Map(),
      descendantNodeKeys: new Map(),
      collections: new Map(),
      collectionStates: new Map(),
      collectionBoundaries: new Map(),
      invalidatedCollectionPaths: new Set(),
      invalidatedPaths: new Map(),
      placeStates: new Map(),
      observedSubtrees: new Set(),
      escapedPaths: new Map(),
      exactPathAliases: new Map(),
      valueFates: [],
      reads: new Set(),
      writes: new Set(),
    };
    trackedObjectsById.set(trackedObjectId, trackedObject);
    materializeTrackedLiteralAtPath(
      project,
      trackedObject,
      literal.getSourceFile(),
      literal,
      rootName,
      [],
      localBindings,
      functionReturnSummaries,
      trackedObjectsById,
    );
    return {
      trackedObject,
      prefix: [],
    };
  };

  const resolveCapturedHigherOrderCallable = (
    callNode: ts.CallExpression,
    callable: ts.FunctionLikeDeclaration,
    expression: ts.LeftHandSideExpression,
    localBindings: Map<string, TrackedObjectBinding>,
  ): ReturnType<typeof resolveAnalyzableCallableBinding> => {
    if (!ts.isIdentifier(expression)) {
      return undefined;
    }

    const outerCallable = ts.findAncestor(
      callable,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor) && ancestor !== callable,
    );
    if (!outerCallable) {
      return undefined;
    }

    const callExpression = unwrapExpression(callNode.expression);
    if (ts.isPropertyAccessExpression(callExpression) || ts.isElementAccessExpression(callExpression)) {
      return undefined;
    }

    const expressionSymbol = project.checker.getSymbolAtLocation(expression);
    if (!expressionSymbol) {
      return undefined;
    }

    const parameterIndex = outerCallable.parameters.findIndex((parameter) => {
      if (!ts.isIdentifier(parameter.name)) {
        return false;
      }

      const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
      return parameterSymbol
        ? getCanonicalSymbolKey(project, parameterSymbol) === getCanonicalSymbolKey(project, expressionSymbol)
        : false;
    });
    if (parameterIndex < 0) {
      return undefined;
    }

    const calleeSymbol = project.checker.getSymbolAtLocation(callNode.expression);
    const calleeDeclaration = calleeSymbol?.declarations?.find(
      (declaration): declaration is ts.VariableDeclaration => {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
          return false;
        }

        return ts.isCallExpression(unwrapExpression(declaration.initializer));
      },
    );
    if (!calleeDeclaration?.initializer) {
      return undefined;
    }

    const factoryCall = unwrapExpression(calleeDeclaration.initializer);
    if (!ts.isCallExpression(factoryCall)) {
      return undefined;
    }

    const capturedArgument = factoryCall.arguments[parameterIndex];
    if (!capturedArgument) {
      return undefined;
    }

    const unwrappedArgument = unwrapExpression(capturedArgument);
    if (ts.isArrowFunction(unwrappedArgument) || ts.isFunctionExpression(unwrappedArgument)) {
      return getAnalyzableCallableBindingFromDeclaration(project, unwrappedArgument) ?? {
        declaration: unwrappedArgument,
        symbolKey: `${unwrappedArgument.getSourceFile().fileName}:${unwrappedArgument.getStart()}:captured-callback`,
      };
    }

    if (
      ts.isIdentifier(unwrappedArgument)
      || ts.isPropertyAccessExpression(unwrappedArgument)
      || ts.isElementAccessExpression(unwrappedArgument)
    ) {
      return resolveAnalyzableCallableBinding(
        project,
        unwrappedArgument,
        localBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
    }

    return undefined;
  };

  const populateHelperLocalLiteralBindings = (
    callNode: ts.CallExpression,
    callable: ts.FunctionLikeDeclaration,
    localBindings: Map<string, TrackedObjectBinding>,
    visitedCallables = new Set<string>(),
    depth = 0,
  ): void => {
    if (depth > 1 || !callable.body || !ts.isBlock(callable.body)) {
      return;
    }

    const callableBinding = getAnalyzableCallableBindingFromDeclaration(project, callable);
    if (callableBinding) {
      if (visitedCallables.has(callableBinding.symbolKey)) {
        return;
      }
      visitedCallables.add(callableBinding.symbolKey);
    }

    const visit = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.initializer) {
        const initializer = unwrapExpression(candidate.initializer);
        const existingBinding = getLocalHelperBinding(localBindings, candidate.name);
        const literalBinding = ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer)
          ? (
              ts.isArrayLiteralExpression(initializer)
              && existingBinding
              && existingBinding.prefix.length === 0
                ? existingBinding
                : getHelperLocalLiteralBinding(initializer, localBindings, callNode)
            )
          : undefined;
        const helperReturnBinding = depth > 0 || literalBinding || !ts.isCallExpression(initializer)
          ? undefined
          : resolveBoundedHelperReturnBinding(initializer, localBindings);
        const trackedInitializerBinding = (() => {
          if (literalBinding || helperReturnBinding || depth !== 0) {
            return undefined;
          }
          try {
            return resolveTrackedObjectAccess(
              project,
              initializer,
              localBindings,
              functionReturnSummaries,
              trackedObjectsById,
            );
          } catch {
            return undefined;
          }
        })();
        const resolvedBinding = literalBinding
          ? undefined
          : helperReturnBinding
            ? {
                binding: helperReturnBinding,
                segments: [],
                dynamic: false as const,
              }
            : trackedInitializerBinding;
        if (literalBinding) {
          setLocalHelperBinding(
            localBindings,
            candidate.name,
            literalBinding,
          );
        } else if (resolvedBinding && !resolvedBinding.dynamic) {
          setLocalHelperBinding(
            localBindings,
            candidate.name,
            extendTrackedBinding(resolvedBinding.binding, resolvedBinding.segments),
          );
        }
      }

      if (
        ts.isBinaryExpression(candidate)
        && candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isArrowFunction(candidate.right) || ts.isFunctionExpression(candidate.right))
      ) {
        const callable = getAnalyzableCallableBindingFromDeclaration(project, candidate.right);
        if (callable) {
          const staticAccessPath = getStaticAccessPath(candidate.left);
          if (staticAccessPath && ts.isIdentifier(staticAccessPath.root)) {
            const rootBinding = getLocalHelperBinding(localBindings, staticAccessPath.root);
            if (rootBinding) {
              rootBinding.trackedObject.callablePaths.set(
                serializePath([
                  ...rootBinding.prefix,
                  ...staticAccessPath.segments.map((segment) => propertySegment(segment)),
                ]),
                callable,
              );
            }
          }

          const resolved = (() => {
            try {
              return resolveTrackedObjectAccess(
                project,
                candidate.left,
                localBindings,
                functionReturnSummaries,
                trackedObjectsById,
              );
            } catch {
              return undefined;
            }
          })();
          if (resolved && !resolved.dynamic) {
            resolved.binding.trackedObject.callablePaths.set(
              serializePath([...resolved.binding.prefix, ...resolved.segments]),
              callable,
            );
          }
        }
      }

      if (ts.isCallExpression(candidate)) {
        const capturedCallable = resolveCapturedHigherOrderCallable(
            callNode,
            callable,
            candidate.expression,
            localBindings,
          );
        const nestedCallables = capturedCallable
          ? [capturedCallable]
          : resolveBoundedHelperCallables(candidate, localBindings);

        for (const nestedCallable of nestedCallables) {
          const nestedLocalBindings = getBoundedHelperCallBindings(candidate, nestedCallable.declaration, localBindings);
          populateHelperLocalLiteralBindings(candidate, nestedCallable.declaration, nestedLocalBindings, visitedCallables, depth + 1);
        }
      }

      ts.forEachChild(candidate, visit);
    };

    ts.forEachChild(callable.body, visit);
    if (callableBinding) {
      visitedCallables.delete(callableBinding.symbolKey);
    }
  };

  const getBoundedHelperCallBindings = (
    node: ts.CallExpression,
    callable: ts.FunctionLikeDeclaration,
    scopeBindings: Map<string, TrackedObjectBinding>,
  ): Map<string, TrackedObjectBinding> => {
    const localBindings = new Map(scopeBindings);

    node.arguments.forEach((argument, index) => {
      const parameter = callable.parameters[index];
      if (!parameter || !ts.isIdentifier(parameter.name)) {
        return;
      }

      const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
      if (!parameterSymbol) {
        return;
      }

      const baseBinding = trackedBySymbolId.get(getSymbolKey(parameterSymbol));
      const binding = (() => {
        try {
          const resolved = resolveTrackedObjectAccess(
            project,
            argument,
            localBindings,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (resolved && !resolved.dynamic) {
            return extendTrackedBinding(resolved.binding, resolved.segments);
          }

          const structuredBinding = baseBinding
            ? getCallSiteStructuredArgumentBinding(
                project,
                node,
                argument,
                baseBinding,
                localBindings,
                functionReturnSummaries,
                trackedObjectsById,
              )
            : undefined;
          if (structuredBinding) {
            return structuredBinding;
          }
          const unwrappedArg = unwrapExpression(argument);
          if (
            ts.isObjectLiteralExpression(unwrappedArg)
            && unwrappedArg.properties.some((p) => ts.isSpreadAssignment(p))
          ) {
            return undefined;
          }
          return getCallSiteLiteralArgumentBinding(
            project,
            node,
            argument,
            localBindings,
            functionReturnSummaries,
            trackedObjectsById,
          );
        } catch {
          return undefined;
        }
      })();
      if (binding) {
        setLocalHelperBinding(localBindings, parameter.name, binding);
      }
    });

    bindBinaryAssignedClosureLocals(node, callable, localBindings);

    return localBindings;
  };

  let executeBoundedHelperCall = (
    _node: ts.CallExpression,
    _scopeBindings: Map<string, TrackedObjectBinding>,
  ): void => {};

  const resolveBoundedHelperCallables = (
    node: ts.CallExpression,
    scopeBindings: Map<string, TrackedObjectBinding>,
  ): AnalyzableCallableBinding[] => {
    const callee = unwrapExpression(node.expression);
    const direct = (() => {
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        return undefined;
      }
      try {
        return resolveAnalyzableCallableBinding(
          project,
          node.expression,
          scopeBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
      } catch {
        return undefined;
      }
    })();
    if (direct) {
      return [direct];
    }

    return resolveHelperMemberCallCandidates(project, node.expression, {
      trackedBySymbolId: scopeBindings,
      specializedBindings: scopeBindings,
      functionReturnSummaries,
      trackedObjectsById,
      allowUnboundInternalMemberFallback: true,
      unboundInternalMemberFallbackSuffixes: carrierLookups.getCarrierMemberSuffixKeys(),
    }).callables ?? [];
  };

  const sameBoundedHelperReturnBinding = (
    left: TrackedObjectBinding,
    right: TrackedObjectBinding,
  ): boolean => (
    sameTrackedBinding(left, right)
    && serializePath(left.prefix) === serializePath(right.prefix)
  );

  type KnownBoundedReturnValue = {
    known: boolean;
    value?: string | number | boolean | null | undefined;
  };

  const getKnownBoundedReturnValue = (
    expression: ts.Expression,
    localBindings: Map<string, TrackedObjectBinding>,
  ): KnownBoundedReturnValue => {
    const candidate = unwrapExpression(expression);

    if (candidate.kind === ts.SyntaxKind.TrueKeyword) {
      return { known: true, value: true };
    }

    if (candidate.kind === ts.SyntaxKind.FalseKeyword) {
      return { known: true, value: false };
    }

    if (candidate.kind === ts.SyntaxKind.NullKeyword) {
      return { known: true, value: null };
    }

    if (ts.isIdentifier(candidate) && candidate.text === "undefined") {
      return { known: true, value: undefined };
    }

    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) {
      return { known: true, value: candidate.text };
    }

    if (ts.isNumericLiteral(candidate)) {
      return { known: true, value: Number(candidate.text) };
    }

    const segment = ts.isPropertyAccessExpression(candidate)
      ? propertySegment(candidate.name.text)
      : ts.isElementAccessExpression(candidate)
        && candidate.argumentExpression
        && (ts.isStringLiteral(candidate.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(candidate.argumentExpression))
        ? propertySegment(candidate.argumentExpression.text)
        : ts.isElementAccessExpression(candidate)
          && candidate.argumentExpression
          && ts.isNumericLiteral(candidate.argumentExpression)
          ? indexSegment(Number(candidate.argumentExpression.text))
          : undefined;
    const receiverExpression = ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)
      ? candidate.expression
      : undefined;
    if (!segment || !receiverExpression) {
      return { known: false };
    }

    const receiver = (() => {
      try {
        return resolveTrackedObjectAccess(
          project,
          receiverExpression,
          localBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
      } catch {
        return undefined;
      }
    })();
    if (!receiver || receiver.dynamic) {
      return { known: false };
    }

    const fullPath = [...receiver.binding.prefix, ...receiver.segments, segment];
    const joinedPath = serializePath(fullPath);
    if (
      receiver.binding.trackedObject.nodes.has(joinedPath)
      || receiver.binding.trackedObject.collections.has(joinedPath)
      || receiver.binding.trackedObject.exactPathAliases.has(joinedPath)
      || receiver.binding.trackedObject.callablePaths.has(joinedPath)
      || hasTrackedChildren(receiver.binding.trackedObject, fullPath)
    ) {
      return { known: false };
    }

    return { known: true, value: undefined };
  };

  const evaluateBoundedReturnCondition = (
    expression: ts.Expression,
    localBindings: Map<string, TrackedObjectBinding>,
  ): boolean | undefined => {
    const candidate = unwrapExpression(expression);

    if (
      ts.isPrefixUnaryExpression(candidate)
      && candidate.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const nested = evaluateBoundedReturnCondition(candidate.operand, localBindings);
      return nested === undefined ? undefined : !nested;
    }

    if (
      ts.isBinaryExpression(candidate)
      && (
        candidate.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || candidate.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      )
    ) {
      const left = getKnownBoundedReturnValue(candidate.left, localBindings);
      const right = getKnownBoundedReturnValue(candidate.right, localBindings);
      if (!left.known || !right.known) {
        return undefined;
      }

      const isEqual = left.value === right.value;
      return candidate.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        ? isEqual
        : !isEqual;
    }

    const direct = getKnownBoundedReturnValue(candidate, localBindings);
    return direct.known ? Boolean(direct.value) : undefined;
  };

  const resolveBoundedReturnedExpressionBinding = (
    expression: ts.Expression,
    localBindings: Map<string, TrackedObjectBinding>,
    visitedCallables: Set<string>,
  ): TrackedObjectBinding | undefined => {
    const returned = unwrapExpression(expression);

    if (ts.isAwaitExpression(returned)) {
      return resolveBoundedReturnedExpressionBinding(returned.expression, localBindings, visitedCallables);
    }

    if (ts.isIdentifier(returned)) {
      const localBinding = getLocalHelperBinding(localBindings, returned);
      if (localBinding) {
        return localBinding;
      }

      const resolved = (() => {
        try {
          return resolveTrackedObjectAccess(
            project,
            returned,
            localBindings,
            functionReturnSummaries,
            trackedObjectsById,
          );
        } catch {
          return undefined;
        }
      })();
      return resolved && !resolved.dynamic
        ? extendTrackedBinding(resolved.binding, resolved.segments)
        : undefined;
    }

    if (ts.isConditionalExpression(returned)) {
      const whenTrue = resolveBoundedReturnedExpressionBinding(returned.whenTrue, localBindings, visitedCallables);
      const whenFalse = resolveBoundedReturnedExpressionBinding(returned.whenFalse, localBindings, visitedCallables);
      return whenTrue && whenFalse && sameBoundedHelperReturnBinding(whenTrue, whenFalse)
        ? whenTrue
        : undefined;
    }

    if (
      ts.isBinaryExpression(returned)
      && (
        returned.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || returned.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || returned.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
    ) {
      const left = resolveBoundedReturnedExpressionBinding(returned.left, localBindings, visitedCallables);
      const right = resolveBoundedReturnedExpressionBinding(returned.right, localBindings, visitedCallables);
      return left && right && sameBoundedHelperReturnBinding(left, right)
        ? left
        : left ?? right;
    }

    if (ts.isCallExpression(returned)) {
      if (
        ts.isPropertyAccessExpression(returned.expression)
        && (returned.expression.name.text === "then" || returned.expression.name.text === "catch")
      ) {
        const callbackInputBinding = (() => {
          const receiverExpression = returned.expression.expression;
          if (ts.isCallExpression(receiverExpression)) {
            const nestedBinding = resolveBoundedHelperReturnBinding(
              receiverExpression,
              localBindings,
              visitedCallables,
            );
            if (nestedBinding) {
              return nestedBinding;
            }
          }

          const resolvedReceiver = (() => {
            try {
              return resolveTrackedObjectAccess(
                project,
                receiverExpression,
                localBindings,
                functionReturnSummaries,
                trackedObjectsById,
              );
            } catch {
              return undefined;
            }
          })();
          return resolvedReceiver && !resolvedReceiver.dynamic
            ? extendTrackedBinding(resolvedReceiver.binding, resolvedReceiver.segments)
            : undefined;
        })();
        let callbackBinding: TrackedObjectBinding | undefined;

        for (const argument of returned.arguments) {
          const callback = unwrapExpression(argument);
          if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
            continue;
          }

          const callbackBindings = new Map(localBindings);
          const callbackParameter = callback.parameters[0];
          if (
            callbackInputBinding
            && callbackParameter
            && ts.isIdentifier(callbackParameter.name)
          ) {
            setLocalHelperBinding(callbackBindings, callbackParameter.name, callbackInputBinding);
          }

          const nextBinding = ts.isBlock(callback.body)
            ? (() => {
                let binding: TrackedObjectBinding | undefined;
                let sawReturn = false;
                let conflict = false;

                const visitCallbackReturn = (candidate: ts.Node): void => {
                  if (conflict || (ts.isFunctionLike(candidate) && candidate !== callback)) {
                    return;
                  }

                  if (ts.isReturnStatement(candidate) && candidate.expression) {
                    sawReturn = true;
                    const next = resolveBoundedReturnedExpressionBinding(
                      candidate.expression,
                      callbackBindings,
                      visitedCallables,
                    );
                    if (!next) {
                      conflict = true;
                      return;
                    }

                    if (!binding) {
                      binding = next;
                      return;
                    }

                    if (!sameBoundedHelperReturnBinding(binding, next)) {
                      conflict = true;
                    }
                  }

                  ts.forEachChild(candidate, visitCallbackReturn);
                };

                ts.forEachChild(callback.body, visitCallbackReturn);
                return sawReturn && !conflict ? binding : undefined;
              })()
            : resolveBoundedReturnedExpressionBinding(callback.body, callbackBindings, visitedCallables);
          if (!nextBinding) {
            return undefined;
          }

          if (!callbackBinding) {
            callbackBinding = nextBinding;
            continue;
          }

          if (!sameBoundedHelperReturnBinding(callbackBinding, nextBinding)) {
            return undefined;
          }
        }

        if (callbackBinding) {
          return callbackBinding;
        }
      }

      executeBoundedHelperCall(returned, localBindings);
      const nestedBinding = resolveBoundedHelperReturnBinding(returned, localBindings, visitedCallables);
      if (nestedBinding) {
        return nestedBinding;
      }

      const resolved = (() => {
        try {
          return resolveTrackedObjectAccess(
            project,
            returned,
            localBindings,
            functionReturnSummaries,
            trackedObjectsById,
          );
        } catch {
          return undefined;
        }
      })();
      return resolved && !resolved.dynamic
        ? extendTrackedBinding(resolved.binding, resolved.segments)
        : undefined;
    }

    return undefined;
  };

  const resolveBoundedHelperReturnBinding = (
    node: ts.CallExpression,
    scopeBindings: Map<string, TrackedObjectBinding> = trackedBySymbolId,
    visitedCallables = new Set<string>(),
  ): TrackedObjectBinding | undefined => {
    const callables = resolveBoundedHelperCallables(node, scopeBindings);
    if (callables.length === 0) {
      return undefined;
    }

    let binding: TrackedObjectBinding | undefined;
    let sawUnknownBinding = false;
    for (const callable of callables) {
      const nextBinding = resolveBoundedHelperReturnBindingForCallable(
        node,
        callable,
        scopeBindings,
        visitedCallables,
      );
      if (!nextBinding) {
        sawUnknownBinding = true;
        continue;
      }

      if (!binding) {
        binding = nextBinding;
        continue;
      }

      if (!sameBoundedHelperReturnBinding(binding, nextBinding)) {
        sawUnknownBinding = true;
      }
    }

    if (!sawUnknownBinding && binding) {
      return binding;
    }

    return getCarrierPreservingMemberReturnBinding(node, scopeBindings);
  };

  const getCarrierPreservingMemberReturnBinding = (
    node: ts.CallExpression,
    scopeBindings: Map<string, TrackedObjectBinding>,
  ): TrackedObjectBinding | undefined => {
    const path = getStaticAccessPath(node.expression);
    const pathKey = path ? serializePath(path.segments.map((segment) => propertySegment(segment))) : undefined;
    if (!pathKey || !carrierLookups.pathEndsWithCarrierSuffix(pathKey)) {
      return undefined;
    }

    const argument = node.arguments[0];
    if (!argument) {
      return undefined;
    }

    try {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        scopeBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        return extendTrackedBinding(resolved.binding, resolved.segments);
      }

      return getCallSiteLiteralArgumentBinding(
        project,
        node,
        argument,
        scopeBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
    } catch {
      return undefined;
    }
  };

  const resolveBoundedHelperReturnBindingForCallable = (
    node: ts.CallExpression,
    callable: AnalyzableCallableBinding,
    scopeBindings: Map<string, TrackedObjectBinding>,
    visitedCallables: Set<string>,
  ): TrackedObjectBinding | undefined => {
    if (visitedCallables.has(callable.symbolKey)) {
      return undefined;
    }

    const returnExpression = getSingleReturnExpression(callable.declaration);

    visitedCallables.add(callable.symbolKey);
    try {
      const localBindings = getBoundedHelperCallBindings(node, callable.declaration, scopeBindings);
      const localPopulationVisited = new Set(visitedCallables);
      populateHelperLocalLiteralBindings(node, callable.declaration, localBindings, localPopulationVisited);

      if (returnExpression) {
        if (callable.declaration.body && ts.isBlock(callable.declaration.body)) {
          const returnStart = returnExpression.getStart(returnExpression.getSourceFile());
          const visitPreReturnCall = (candidate: ts.Node): void => {
            if (ts.isTypeNode(candidate)) {
              return;
            }

            if (ts.isFunctionLike(candidate) && candidate !== callable.declaration) {
              return;
            }

            if (candidate.getStart(candidate.getSourceFile()) >= returnStart) {
              return;
            }

            if (ts.isCallExpression(candidate)) {
              executeBoundedHelperCall(candidate, localBindings);
            }

            ts.forEachChild(candidate, visitPreReturnCall);
          };

          ts.forEachChild(callable.declaration.body, visitPreReturnCall);
        }

        return resolveBoundedReturnedExpressionBinding(returnExpression, localBindings, visitedCallables);
      }

      if (!callable.declaration.body || !ts.isBlock(callable.declaration.body)) {
        return undefined;
      }

      let binding: TrackedObjectBinding | undefined;
      let sawReturn = false;
      let conflict = false;

      const visitReturn = (candidate: ts.Node): void => {
        if (conflict || (ts.isFunctionLike(candidate) && candidate !== callable.declaration)) {
          return;
        }

        if (ts.isIfStatement(candidate)) {
          const condition = evaluateBoundedReturnCondition(candidate.expression, localBindings);
          if (condition === true) {
            visitReturn(candidate.thenStatement);
            return;
          }

          if (condition === false) {
            if (candidate.elseStatement) {
              visitReturn(candidate.elseStatement);
            }
            return;
          }
        }

        if (ts.isReturnStatement(candidate) && candidate.expression) {
          sawReturn = true;
          const nextBinding = resolveBoundedReturnedExpressionBinding(
            candidate.expression,
            localBindings,
            visitedCallables,
          );
          if (!nextBinding) {
            conflict = true;
            return;
          }

          if (!binding) {
            binding = nextBinding;
            return;
          }

          if (!sameBoundedHelperReturnBinding(binding, nextBinding)) {
            conflict = true;
          }
        }

        ts.forEachChild(candidate, visitReturn);
      };

      ts.forEachChild(callable.declaration.body, visitReturn);
      return sawReturn && !conflict ? binding : undefined;
    } finally {
      visitedCallables.delete(callable.symbolKey);
    }
  };

  const returnedStructureHandler = createReturnedStructureHandler({
    project,
    publicSurfaceIds,
    publiclyReachableCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    markObservedSubtree,
    markEscaped,
    resolveBoundedHelperReturnBinding,
  });

  const markProjectionChildReads = (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix: PathSegment[] = [],
  ): void => {
    markObjectPathProjectionChildReads(overlayState, projection, projectionTrackedObjectsById, suffix);
  };

  const markProjectionElementRead = (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    index: number,
    observeSubtree = false,
  ): void => {
    markObjectPathProjectionElementRead(overlayState, projection, projectionTrackedObjectsById, index, observeSubtree);
  };

  const markProjectionReads = (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix: PathSegment[] = [],
    observeSubtree = false,
  ): void => {
    markObjectPathProjectionReads(overlayState, projection, projectionTrackedObjectsById, suffix, observeSubtree);
  };

  const markProjectionWrites = (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    suffix: PathSegment[],
  ): void => {
    markObjectPathProjectionWrites(overlayState, projection, projectionTrackedObjectsById, suffix);
  };

  const markRead = (trackedObject: TrackedObject, segments: PathSegment[]): void => {
    markObjectPathRead(overlayState, trackedObject, segments);
  };

  const markWrite = (trackedObject: TrackedObject, segments: PathSegment[]): void => {
    markObjectPathWrite(overlayState, trackedObject, segments);
  };

  const getAssignedAccessSegment = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): PathSegment | undefined => {
    if (ts.isPropertyAccessExpression(node)) {
      return propertySegment(node.name.text);
    }

    const argument = node.argumentExpression;
    if (!argument) {
      return undefined;
    }

    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return propertySegment(argument.text);
    }

    if (ts.isNumericLiteral(argument)) {
      return indexSegment(Number(argument.text));
    }

    if (
      ts.isPrefixUnaryExpression(argument)
      && argument.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(argument.operand)
    ) {
      return indexSegment(-Number(argument.operand.text));
    }

    return undefined;
  };

  const shouldMaterializeAssignedPath = (operatorKind: ts.SyntaxKind): boolean => (
    operatorKind === ts.SyntaxKind.EqualsToken
    || operatorKind === ts.SyntaxKind.QuestionQuestionEqualsToken
    || operatorKind === ts.SyntaxKind.BarBarEqualsToken
    || operatorKind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );

  const materializeAssignedPath = (trackedObject: TrackedObject, fullPath: PathSegment[], anchor: ts.Node): void => {
    if (fullPath.length === 0) {
      return;
    }

    const joinedPath = serializePath(fullPath);
    if (
      trackedObject.nodes.has(joinedPath)
      || trackedObject.collections.has(joinedPath)
      || trackedObject.exactPathAliases.has(joinedPath)
      || hasTrackedChildren(trackedObject, fullPath)
    ) {
      trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
      return;
    }

    const parentPath = fullPath.slice(0, -1);
    ensureCollectionChildPath(trackedObject, parentPath, fullPath);

    const segment = fullPath[fullPath.length - 1];
    if (!segment) {
      return;
    }

    const entity = makeEntity(
      project.rootPath,
      segment.kind === "index"
        ? fullPath.length === 1
          ? ENTITY_KIND.arrayElement
          : ENTITY_KIND.nestedPath
        : fullPath.length === 1
          ? ENTITY_KIND.objectKey
          : ENTITY_KIND.nestedPath,
      sourceFile,
      anchor,
      segment.kind === "property" && fullPath.length === 1 ? segment.value : renderPath(fullPath),
      trackedObject.rootName,
    );
    trackedObject.nodes.set(joinedPath, {
      entity,
      fullPath,
      origin: segment.kind === "index"
        ? TRACKED_OBJECT_NODE_ORIGIN.arrayElement
        : TRACKED_OBJECT_NODE_ORIGIN.property,
    });
    trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
    indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
  };

  const recordArrayBoundary = (
    _project: typeof project,
    trackedObject: TrackedObject,
    boundarySourceFile: ts.SourceFile,
    node: ts.Node,
    collectionPath: PathSegment[],
    affectedPath: PathSegment[],
    category: SkipCategory,
    reason: string,
    invalidate = false,
    detailHint?: string,
  ): void => {
    registerBoundaryCapabilityFact(trackedObject, boundarySourceFile, node, affectedPath, category, reason, detailHint);
    recordArrayBoundaryEffect(
      project,
      overlayState,
      trackedObject,
      boundarySourceFile,
      node,
      collectionPath,
      affectedPath,
      category,
      reason,
      invalidate,
    );
  };

  const destructuringHandler = createDestructuringHandler({
    project,
    sourceFile,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    projectionBindings,
    markAliasObserved,
    markProjectionElementRead,
    markRead,
    markEscaped,
    recordArrayBoundary,
  });

  const projectionTraversalHandler = createProjectionTraversalHandler({
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
  });

  const maybeReportInvalidatedRead = (
    readSourceFile: ts.SourceFile,
    trackedObject: TrackedObject,
    node: ts.Node,
    fullPath: PathSegment[],
  ): void => {
    maybeReportInvalidatedReadEffect(
      project,
      readSourceFile,
      state,
      suppressionContext,
      overlayState,
      trackedObject,
      node,
      fullPath,
    );
  };

  const handleTrackedArrayMutation = (
    _project: typeof project,
    trackedObject: TrackedObject,
    mutationSourceFile: ts.SourceFile,
    node: ts.CallExpression,
    collectionPath: PathSegment[],
    methodName: string,
  ): void => {
    handleTrackedArrayMutationEffect(project, overlayState, trackedObject, mutationSourceFile, node, collectionPath, methodName);
  };

  const handleSupportedValueFateCall = (
    _project: typeof project,
    valueSourceFile: ts.SourceFile,
    node: ts.CallExpression,
    valueTrackedBySymbolId: typeof trackedBySymbolId,
    valueReturnSummaries: typeof functionReturnSummaries,
    valueTrackedObjectsById: typeof trackedObjectsById,
    spreadAppendStarts: typeof handledSpreadAppendStarts,
  ): Set<number> => {
    return handleSupportedValueFateCallEffect(
      project,
      overlayState,
      valueSourceFile,
      node,
      valueTrackedBySymbolId,
      valueReturnSummaries,
      valueTrackedObjectsById,
      spreadAppendStarts,
    );
  };

  const maybeInvalidateReplacedTrackedPath = (
    _project: typeof project,
    trackedObject: TrackedObject,
    replacementSourceFile: ts.SourceFile,
    node: ts.Node,
    fullPath: PathSegment[],
  ): void => {
    maybeInvalidateReplacedTrackedPathEffect(project, overlayState, trackedObject, replacementSourceFile, node, fullPath);
  };

  const visitProjectedArrayUsage = (
    _project: typeof project,
    node: ts.Node,
    context: typeof projectionContext,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    projectionTrackedBySymbolId?: Map<string, TrackedObjectBinding>,
  ): void => {
    visitProjectedArrayUsageEffect(
      project,
      node,
      context,
      projectionTrackedObjectsById,
      overlayState,
      projectionTrackedBySymbolId ?? trackedBySymbolId,
    );
  };

  const collectionHandler = createCollectionOperationHandler({
    project,
    sourceFile,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    handledExactCallbackBodies,
    handledSpreadAppendStarts,
    projectionContext,
    getPublicReturnBinding: returnedStructureHandler.getPublicReturnBinding,
    markObservedAggregateLiteralBindings: returnedStructureHandler.markObservedAggregateLiteralBindings,
    markObservedSubtree,
    markEscaped,
    handleTrackedArrayMutation,
    recordArrayBoundary,
    visitProjectedArrayUsage,
  });

  const hasExactTrackedPath = (binding: TrackedObjectBinding, segments: PathSegment[]): boolean => {
    const fullPath = [...binding.prefix, ...segments];
    const serialized = serializePath(fullPath);
    return binding.trackedObject.nodes.has(serialized)
      || binding.trackedObject.callablePaths.has(serialized)
      || binding.trackedObject.exactPathAliases.has(serialized)
      || Boolean(getCollectionInfo(binding.trackedObject, fullPath))
      || hasTrackedChildren(binding.trackedObject, fullPath);
  };

  const collapseExactBindingPrefix = (binding: TrackedObjectBinding): TrackedObjectBinding => {
    let current = binding;

    while (current.prefix.length > 0) {
      const baseBinding: TrackedObjectBinding = {
        trackedObject: current.trackedObject,
        prefix: [],
      };
      const aliased = resolveExactPathAlias(baseBinding, current.prefix, trackedObjectsById);
      if (sameTrackedBinding(aliased.binding, baseBinding)) {
        break;
      }

      current = aliased.binding;
    }

    return current;
  };

  const {
    getHelperFiniteReturnPlan,
    resolveFiniteLookupRead,
  } = createFiniteLookupPlanner({
    project,
    reachableFiles,
    publiclyReachableCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    finiteLookupBindings,
    helperFiniteReturnCache,
    hasExactTrackedPath,
    collapseExactBindingPrefix,
  });

  const markExactHelperReadPath = (
    binding: TrackedObjectBinding,
    segments: PathSegment[],
  ): void => {
    const collapseExactAliasPrefix = (candidate: TrackedObjectBinding): TrackedObjectBinding => {
      let current = candidate;

      while (current.prefix.length > 0) {
        const baseBinding: TrackedObjectBinding = {
          trackedObject: current.trackedObject,
          prefix: [],
        };
        const aliased = resolveExactPathAlias(baseBinding, current.prefix, trackedObjectsById);
        if (sameTrackedBinding(aliased.binding, baseBinding)) {
          break;
        }

        if (aliased.viaAliasObjectId && aliased.viaAliasPath) {
          markAliasObserved({
            binding: aliased.binding,
            segments: [],
            dynamic: false,
            viaAliasObjectId: aliased.viaAliasObjectId,
            viaAliasPath: aliased.viaAliasPath,
          }, trackedObjectsById);
        }

        current = aliased.binding;
      }

      return current;
    };

    let currentBinding = collapseExactAliasPrefix(binding);

    for (const segment of segments) {
      const aliased = resolveExactPathAlias(currentBinding, [segment], trackedObjectsById);
      if (aliased.viaAliasObjectId && aliased.viaAliasPath) {
        markAliasObserved({
          binding: aliased.binding,
          segments: [],
          dynamic: false,
          viaAliasObjectId: aliased.viaAliasObjectId,
          viaAliasPath: aliased.viaAliasPath,
        }, trackedObjectsById);
      }

      currentBinding = sameTrackedBinding(aliased.binding, currentBinding)
        ? extendTrackedBinding(currentBinding, [segment])
        : aliased.binding;
      currentBinding = collapseExactAliasPrefix(currentBinding);
    }

    markRead(currentBinding.trackedObject, currentBinding.prefix);
  };

  const shouldReplayExactHelperReadPaths = (binding: TrackedObjectBinding): boolean => (
    !isTrackingProtectedStructuralRole(binding.trackedObject.structuralRole)
  );

  const {
    getHigherOrderCallableReturnSummary,
    resolveCallableArgumentBinding,
    getBoundedHelperExecutionSnapshot,
  } = createHelperPlanningHelpers({
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    parameterMeaningfulUse,
    parameterSummaryCache,
    helperExecutionSnapshotCache,
    helperExactAppendPlanCache,
    helperProjectedUsagePlanCache,
    higherOrderCallableReturnSummaryCache,
  });

  const replayHelperExactAppendPlans = (
    callNode: ts.CallExpression,
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
    providedLocalBindings?: Map<string, TrackedObjectBinding>,
    specializedBindings?: Map<string, TrackedObjectBinding>,
  ): void => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    if (!parameterSymbol) {
      return;
    }

    const snapshot = getBoundedHelperExecutionSnapshot(callable, parameter, specializedBindings);
    if (!snapshot) {
      return;
    }

    const localBindings = new Map(providedLocalBindings ?? trackedBySymbolId);
    localBindings.set(getSymbolKey(parameterSymbol), binding);
    const callableBinding = getAnalyzableCallableBindingFromDeclaration(project, callable);
    populateHelperLocalLiteralBindings(
      callNode,
      callable,
      localBindings,
      callableBinding ? new Set([callableBinding.symbolKey]) : new Set(),
    );

    for (const step of snapshot.steps) {
      if (step.kind !== "exact-append-mutation") {
        continue;
      }

      const stepCallable = ts.findAncestor(
        step.call,
        (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
      );
      if (stepCallable && stepCallable !== callable) {
        populateHelperLocalLiteralBindings(step.call, stepCallable, localBindings);
      }

      tryRegisterExactArrayInsertion(
        project,
        binding.trackedObject,
        step.sourceFile,
        step.call,
        [...binding.prefix, ...step.relativeCollectionPath],
        step.methodName,
        step.slotPlans,
        localBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
    }
  };

  const replayHelperProjectedUsages = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
    localBindings?: Map<string, TrackedObjectBinding>,
    specializedBindings?: Map<string, TrackedObjectBinding>,
  ): void => {
    const snapshot = getBoundedHelperExecutionSnapshot(callable, parameter, specializedBindings);
    if (!snapshot) {
      return;
    }

    for (const step of snapshot.steps) {
      if (step.kind !== "projected-iteration-binding") {
        continue;
      }

      const projection = getProjectionBinding(
        binding.trackedObject,
        [...binding.prefix, ...step.relativeCollectionPath],
      );
      if (!projection) {
        continue;
      }

      visitProjectedArrayUsage(
        project,
        step.statement,
        {
          elementBindings: new Map([[step.elementSymbolKey, projection]]),
          receiverBindings: new Map(),
          indexBindings: new Map(),
        },
        trackedObjectsById,
        localBindings,
      );
    }
  };

  const helperTransportHandler = createHelperTransportHandler({
    project,
    sourceFile,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    parameterMeaningfulUse,
    parameterSummaryCache,
    getBoundedHelperExecutionSnapshot,
    markExactHelperReadPath,
    shouldReplayExactHelperReadPaths,
    replayHelperExactAppendPlans,
    replayHelperProjectedUsages,
    capabilityFacts: state.runState.capabilityFacts,
    recordArrayBoundary,
    markEscaped,
  });

  executeBoundedHelperCall = (
    node: ts.CallExpression,
    scopeBindings: Map<string, TrackedObjectBinding>,
  ): void => {
    for (const analyzableCallable of resolveBoundedHelperCallables(node, scopeBindings)) {
      for (const [index, argument] of node.arguments.entries()) {
        const parameter = analyzableCallable.declaration.parameters[index];
        const resolved = resolveTrackedObjectAccess(
          project,
          argument,
          scopeBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
        helperTransportHandler.handleStructuredHelperArgument(
          node,
          argument,
          resolved,
          parameter,
          analyzableCallable.declaration,
          scopeBindings,
        );
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (handledExactCallbackBodies.has(node)) {
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const target = project.checker.getSymbolAtLocation(node.name);
      const helperReturnBinding = ts.isCallExpression(node.initializer)
        ? resolveBoundedHelperReturnBinding(node.initializer)
        : undefined;
      const resolved = helperReturnBinding
        ? {
          binding: helperReturnBinding,
          segments: [],
          dynamic: false as const,
        }
        : resolveTrackedObjectAccess(
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

      if (target && ts.isCallExpression(node.initializer)) {
        const callable = resolveAnalyzableCallableBinding(
          project,
          node.initializer.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        )?.declaration;
        const plan = callable ? getHelperFiniteReturnPlan(callable) : undefined;
        if (plan?.suffix.length === 0) {
          finiteLookupBindings.set(getCanonicalSymbolKey(project, target), plan.candidates);
        }
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
      } else if (
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && resolved
        && !resolved.dynamic
      ) {
        const slotKey = getObjectBackedRetainedBindingSlotKeyFromAccess(project, node.left);
        if (slotKey) {
          mergeTrackedBinding(
            trackedBySymbolId,
            retainedContainerConflicts,
            slotKey,
            extendTrackedBinding(resolved.binding, resolved.segments),
          );
        }
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      returnedStructureHandler.handleReturnStatement(node);
    }

    if (ts.isCallExpression(node)) {
      const handledRetainedContainerIndices = new Set<number>();
      if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === TRACKING_RETAINED_BINDING_WRITE_METHOD
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
          } else {
            markEscaped(
              resolvedValue.binding.trackedObject,
              resolvedValue.segments,
              SKIP_CATEGORY.externalContainerStore,
              "value stored in external container; reads are not traceable from this scope",
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
      collectionHandler.handleReceiverCall(node, valueFateHandledIndices);

      const calleeText = node.expression.getText(sourceFile);
      const analyzableCallable = resolveAnalyzableCallableBinding(
        project,
        node.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      )?.declaration;
      for (const [index, argument] of node.arguments.entries()) {
        const finiteLookupRead = resolveFiniteLookupRead(argument);
        if (finiteLookupRead) {
          for (const candidate of finiteLookupRead.candidates) {
            const fullPath = [...candidate.binding.prefix, ...candidate.segments, ...finiteLookupRead.suffix];
            registerLiveFiniteKeyedAccessFact(capabilityFacts, candidate.binding.trackedObject, fullPath);
            maybeReportInvalidatedRead(
              sourceFile,
              candidate.binding.trackedObject,
              node,
              fullPath,
            );
            markRead(candidate.binding.trackedObject, fullPath);
          }
          continue;
        }

        const parameter = analyzableCallable?.parameters[index];
        const callableArgumentBinding = parameter && ts.isIdentifier(parameter.name)
          ? resolveCallableArgumentBinding(argument)
          : undefined;
        if (parameter && ts.isIdentifier(parameter.name) && analyzableCallable && callableArgumentBinding) {
          const callableReturnBinding = getCallableReturnBinding(
            functionReturnSummaries.get(callableArgumentBinding.symbolKey),
          );
          if (callableReturnBinding) {
            const higherOrderSummary = getHigherOrderCallableReturnSummary(analyzableCallable, parameter.name);
            if (higherOrderSummary.exactReadPaths.length > 0) {
              higherOrderSummary.exactReadPaths.forEach((readPath) => {
                markExactHelperReadPath(callableReturnBinding, readPath);
              });
            } else if (higherOrderSummary.boundaryReason) {
              markEscaped(
                callableReturnBinding.trackedObject,
                callableReturnBinding.prefix,
                "opaque-object-call",
                higherOrderSummary.boundaryReason,
                "same-project helper escape",
              );
            }
          }
        }

        const resolved = resolveTrackedObjectAccess(
          project,
          argument,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (!resolved) {
          if (helperTransportHandler.handleStructuredHelperArgument(node, argument, undefined, parameter, analyzableCallable)) {
            continue;
          }
          continue;
        }

        if (handledRetainedContainerIndices.has(index)) {
          continue;
        }

        const fullPath = [...resolved.binding.prefix, ...resolved.segments];
        if (resolved.dynamic) {
          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          if (collectionInfo?.kind === TRACKING_COLLECTION_KIND.array && resolved.boundaryCategory) {
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

        const supportedArgumentUse = classifySupportedCallArgumentUse(calleeText, index);
        if (supportedArgumentUse) {
          if (supportedArgumentUse.kind === "observe-subtree") {
            markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
          } else if (
            supportedArgumentUse.kind === "observe-keys"
            || supportedArgumentUse.kind === "observe-values"
          ) {
            markObservedChildPaths(resolved.binding.trackedObject, fullPath, trackedObjectsById);
          }
          continue;
        }

        const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);

        if (helperTransportHandler.handleStructuredHelperArgument(node, argument, resolved, parameter, analyzableCallable)) {
          continue;
        }

        if (valueFateHandledIndices.has(index)) {
          continue;
        }

        if (collectionInfo?.kind === TRACKING_COLLECTION_KIND.array) {
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
      projectionTraversalHandler.handleForOfStatement(node);
    }

    if (ts.isSpreadAssignment(node)) {
      collectionHandler.handleSpreadAssignment(node);
    }

    if (ts.isSpreadElement(node)) {
      if (collectionHandler.handleSpreadElement(node)) {
        return;
      }
    }

    if (ts.isIdentifier(node)) {
      projectionTraversalHandler.handleProjectedIdentifierRead(node);

      if (ts.isCallExpression(node.parent)) {
        const argumentIndex = node.parent.arguments.findIndex((argument) => argument === node);
        const callable = argumentIndex >= 0
          ? resolveAnalyzableCallableBinding(
            project,
            node.parent.expression,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          )?.declaration
          : undefined;
        const resolved = argumentIndex >= 0
          ? resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById)
          : undefined;
        if (callable && resolved && !resolved.dynamic) {
          const fullPath = [...resolved.binding.prefix, ...resolved.segments];
          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          const parameter = callable.parameters[argumentIndex];
          if (
            collectionInfo?.kind === TRACKING_COLLECTION_KIND.array
            && parameter
            && ts.isIdentifier(parameter.name)
          ) {
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
              helperTransportHandler.getHelperTransportDetailHint(summary),
            );
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isAssignmentLeft(node)) {
        const finiteLookupRead = resolveFiniteLookupRead(node);
        if (finiteLookupRead) {
          if (ts.isElementAccessExpression(node)) {
            if (
              ts.isVariableDeclaration(node.parent)
              && node.parent.initializer === node
              && ts.isIdentifier(node.parent.name)
              && ts.isVariableDeclarationList(node.parent.parent)
              && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0
            ) {
              const symbolKey = getBindingSymbolKey(project, node.parent.name);
              if (symbolKey) {
                finiteLookupBindings.set(symbolKey, finiteLookupRead.candidates);
              }
            }
          }

          for (const candidate of finiteLookupRead.candidates) {
            const fullPath = [...candidate.binding.prefix, ...candidate.segments, ...finiteLookupRead.suffix];
            registerLiveFiniteKeyedAccessFact(capabilityFacts, candidate.binding.trackedObject, fullPath);
            maybeReportInvalidatedRead(
              sourceFile,
              candidate.binding.trackedObject,
              node,
              fullPath,
            );
            markRead(candidate.binding.trackedObject, fullPath);
          }
          return;
        }
      }

      const resolved = resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
      if (!resolved) {
        if (
          isAssignmentLeft(node)
          && ts.isBinaryExpression(node.parent)
          && node.parent.left === node
          && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const assignedSegment = getAssignedAccessSegment(node);
          const receiver = resolveTrackedObjectAccess(
            project,
            node.expression,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          const right = resolveTrackedObjectAccess(
            project,
            node.parent.right,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (assignedSegment && receiver && !receiver.dynamic && right && !right.dynamic) {
            const receiverPath = [...receiver.binding.prefix, ...receiver.segments];
            const fullPath = [...receiverPath, assignedSegment];
            registerExactPathAlias(
              receiver.binding.trackedObject,
              fullPath,
              extendTrackedBinding(right.binding, right.segments),
              "same-project exact property assignment keeps this nested binding exact",
            );
            maybeInvalidateReplacedTrackedPath(project, receiver.binding.trackedObject, sourceFile, node, fullPath);
            markWrite(receiver.binding.trackedObject, fullPath);
            return ts.forEachChild(node, visit);
          }
        }

        if (!projectionTraversalHandler.handleProjectedAccess(node)) {
          return ts.forEachChild(node, visit);
        }
        return ts.forEachChild(node, visit);
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      if (resolved.dynamic) {
        if (!isAssignmentLeft(node)) {
          markAliasObserved(resolved, trackedObjectsById);
          markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
        }

        const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
        if (collectionInfo?.kind === TRACKING_COLLECTION_KIND.array && resolved.boundaryCategory) {
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
        if (!isAssignmentLeft(node)) {
          markAliasObserved(resolved, trackedObjectsById);
          if (
            ts.isSpreadElement(node.parent)
            || (ts.isBinaryExpression(node.parent)
              && node.parent.right === node
              && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          ) {
            markObservedSubtree(
              resolved.binding.trackedObject,
              [...resolved.binding.prefix, ...resolved.segments],
              trackedObjectsById,
            );
          }
        }
        return ts.forEachChild(node, visit);
      }

      if (isAssignmentLeft(node)) {
        if (
          ts.isBinaryExpression(node.parent)
          && node.parent.left === node
          && shouldMaterializeAssignedPath(node.parent.operatorToken.kind)
        ) {
          materializeAssignedPath(resolved.binding.trackedObject, fullPath, node);
        }

        if (fullPath.length > 1) {
          markAliasObserved(resolved, trackedObjectsById);
          markRead(resolved.binding.trackedObject, fullPath.slice(0, -1));
        }
        maybeInvalidateReplacedTrackedPath(project, resolved.binding.trackedObject, sourceFile, node, fullPath);
        markWrite(resolved.binding.trackedObject, fullPath);
      } else {
        maybeReportInvalidatedRead(
          sourceFile,
          resolved.binding.trackedObject,
          node,
          fullPath,
        );
        markAliasObserved(resolved, trackedObjectsById);
        markRead(resolved.binding.trackedObject, fullPath);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) {
      destructuringHandler.handleArrayBindingPattern(node);
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      destructuringHandler.handleObjectBindingPattern(node);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
}
