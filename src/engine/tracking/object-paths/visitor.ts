import ts from "typescript";

import type { PathSegment, SkipCategory, TrackedObject } from "../../../types.js";
import type { AnalysisCapabilityFactFamily } from "../../capabilities/vocabulary.js";
import { getSymbolKey } from "../../../compiler/ast-utils.js";
import { ENTITY_KIND } from "../../../shared/entity-vocabulary.js";
import { makeEntity } from "../../../shared/entity-utils.js";
import { TRACKED_OBJECT_NODE_ORIGIN } from "../../../shared/path-vocabulary.js";
import { indexSegment, propertySegment, renderPath, serializePath } from "../../../shared/path-utils.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { registerCapabilityFact } from "../../analysis-state.js";
import { ANALYSIS_CAPABILITY_DETAIL_LABEL, ANALYSIS_CAPABILITY_FACT_FAMILY, ANALYSIS_CAPABILITY_FACT_OUTCOME, ANALYSIS_CAPABILITY_ID } from "../../capabilities/vocabulary.js";
import { isTrackingProtectedStructuralRole } from "../ownership.js";
import { TRACKING_COLLECTION_KIND, TRACKING_PLACE_STATE, TRACKING_RETAINED_BINDING_WRITE_METHOD } from "../vocabulary.js";
import { getObjectBackedRetainedBindingSlotKeyFromAccess, getRetainedBindingContainerSlotKey, isLocallyOwnedRetainedBindingContainer, isSupportedRetainedBindingContainerType } from "../retained-bindings.js";
import { getBindingSymbolKey, resolveAnalyzableCallableBinding, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, getCanonicalSymbolKey, getGlobalThisBindingKey, getStaticGlobalThisPropertyName, mergeTrackedBinding, sameTrackedBinding } from "../bindings.js";
import { getCallableReturnBinding } from "../callables.js";
import type { ArrayProjectionBinding, ResolvedTrackedObjectAccess, TrackedObjectBinding } from "../model.js";
import { buildHelperBoundaryReason, classifySupportedCallArgumentUse, summarizeHelperParameterUse } from "../semantics.js";
import { buildCollectionBoundaryEntity, ensureCollectionChildPath, getCollectionInfo, getProjectionBinding, hasTrackedChildren, indexTrackedObjectNode, registerExactPathAlias, resolveExactPathAlias } from "../state.js";
import {
  handleSupportedValueFateCall as handleSupportedValueFateCallEffect, handleTrackedArrayMutation as handleTrackedArrayMutationEffect, maybeInvalidateReplacedTrackedPath as maybeInvalidateReplacedTrackedPathEffect,
  maybeReportInvalidatedRead as maybeReportInvalidatedReadEffect, recordArrayBoundary as recordArrayBoundaryEffect, tryRegisterExactArrayInsertion,
} from "./effects.js";
import {
  markObjectPathAliasObserved, markObjectPathEscaped, markObjectPathObservedChildPaths, markObjectPathObservedSubtree, markObjectPathProjectionChildReads,
  markObjectPathProjectionElementRead, markObjectPathProjectionReads, markObjectPathProjectionWrites, markObjectPathRead, markObjectPathWrite,
} from "./overlay.js";
import type { FiniteLookupCandidate, ObjectPathSourceFileContext, ObjectPathStageContext } from "./types.js";
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
  sourceFileContext: ObjectPathSourceFileContext,
): void {
  const {
    project,
    reachableFiles,
    publicSurfaceIds,
    publiclyReachableCallableIds,
    overlayState,
    trackedBindingRegistry: trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectRegistry: trackedObjectsById,
    state,
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
    helperExactAppendPlanCache,
    helperProjectedUsagePlanCache,
    higherOrderCallableReturnSummaryCache,
  } = sourceFileContext;
  const projectionContext = {
    elementBindings: projectionBindings,
    receiverBindings: projectionReceiverBindings,
    indexBindings: projectionIndexBindings,
  };

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

  const getTrackedEntityAtPath = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
  ) => trackedObject.nodes.get(serializePath(segments))?.entity ?? trackedObject.rootEntity;

  const registerBoundaryCapabilityFact = (
    trackedObject: TrackedObject,
    boundarySourceFile: ts.SourceFile,
    node: ts.Node,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ): void => {
    if (
      category === SKIP_CATEGORY.arrayCallbackEscape
      || category === SKIP_CATEGORY.arrayOpaqueMutation
      || category === SKIP_CATEGORY.opaqueObjectCall
    ) {
      const entity = category === SKIP_CATEGORY.arrayCallbackEscape || category === SKIP_CATEGORY.arrayOpaqueMutation
        ? buildCollectionBoundaryEntity(project, trackedObject, boundarySourceFile, node, segments)
        : getTrackedEntityAtPath(trackedObject, segments);
      registerCapabilityFact(
        state,
        ANALYSIS_CAPABILITY_ID.helperTransport,
        entity,
        ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport,
        ANALYSIS_CAPABILITY_FACT_OUTCOME.boundary,
        {
        category,
        reason,
        detailHint,
        },
      );
      return;
    }

    if (
      category === SKIP_CATEGORY.arrayAtCall
      || category === SKIP_CATEGORY.computedPropertyAccess
      || category === SKIP_CATEGORY.dynamicArrayIndex
    ) {
      const entity = category === SKIP_CATEGORY.arrayAtCall || category === SKIP_CATEGORY.dynamicArrayIndex
        ? buildCollectionBoundaryEntity(project, trackedObject, boundarySourceFile, node, segments)
        : getTrackedEntityAtPath(trackedObject, segments);
      registerCapabilityFact(
        state,
        ANALYSIS_CAPABILITY_ID.finiteKeyedAccess,
        entity,
        ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
        ANALYSIS_CAPABILITY_FACT_OUTCOME.boundary,
        {
        category,
        reason,
        detailHint,
        },
      );
    }
  };

  const registerLiveCapabilityFact = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    capabilityId: AnalysisCapabilityFactFamily,
    detailHint: string,
  ): void => {
    registerCapabilityFact(
      state,
      capabilityId,
      getTrackedEntityAtPath(trackedObject, segments),
      capabilityId,
      ANALYSIS_CAPABILITY_FACT_OUTCOME.live,
      { detailHint },
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

  const returnedStructureHandler = createReturnedStructureHandler({
    project,
    publicSurfaceIds,
    publiclyReachableCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    markObservedSubtree,
    markEscaped,
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
    _project: typeof project,
    readSourceFile: ts.SourceFile,
    currentState: typeof state,
    currentSuppressionContext: typeof suppressionContext,
    trackedObject: TrackedObject,
    node: ts.Node,
    fullPath: PathSegment[],
  ): void => {
    maybeReportInvalidatedReadEffect(
      project,
      readSourceFile,
      currentState,
      currentSuppressionContext,
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

  const markFiniteLookupReads = (
    node: ts.Node,
    candidates: FiniteLookupCandidate[],
    suffix: PathSegment[] = [],
  ): void => {
    for (const candidate of candidates) {
      const fullPath = [...candidate.binding.prefix, ...candidate.segments, ...suffix];
      registerLiveCapabilityFact(
        candidate.binding.trackedObject,
        fullPath,
        ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
        ANALYSIS_CAPABILITY_DETAIL_LABEL.boundedFiniteKeyRead,
      );
      maybeReportInvalidatedRead(
        project,
        sourceFile,
        state,
        suppressionContext,
        candidate.binding.trackedObject,
        node,
        fullPath,
      );
      markRead(candidate.binding.trackedObject, fullPath);
    }
  };

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

    markObservedChildPaths(currentBinding.trackedObject, currentBinding.prefix, trackedObjectsById);
  };

  const shouldReplayExactHelperReadPaths = (binding: TrackedObjectBinding): boolean => (
    !isTrackingProtectedStructuralRole(binding.trackedObject.structuralRole)
  );

  const {
    getHigherOrderCallableReturnSummary,
    resolveCallableArgumentBinding,
    getHelperExactAppendPlans,
    getHelperProjectedUsagePlans,
  } = createHelperPlanningHelpers({
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    parameterMeaningfulUse,
    parameterSummaryCache,
    helperExactAppendPlanCache,
    helperProjectedUsagePlanCache,
    higherOrderCallableReturnSummaryCache,
  });

  const replayHelperExactAppendPlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
    providedLocalBindings?: Map<string, TrackedObjectBinding>,
  ): void => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    if (!parameterSymbol) {
      return;
    }

    const plans = getHelperExactAppendPlans(callable, parameter);
    if (plans.length === 0) {
      return;
    }

    const localBindings = new Map(providedLocalBindings ?? trackedBySymbolId);
    localBindings.set(getSymbolKey(parameterSymbol), binding);

    for (const plan of plans) {
      tryRegisterExactArrayInsertion(
        project,
        binding.trackedObject,
        plan.sourceFile,
        plan.call,
        [...binding.prefix, ...plan.relativeCollectionPath],
        plan.methodName,
        plan.slotPlans,
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
  ): void => {
    for (const plan of getHelperProjectedUsagePlans(callable, parameter)) {
      const projection = getProjectionBinding(
        binding.trackedObject,
        [...binding.prefix, ...plan.relativeCollectionPath],
      );
      if (!projection) {
        continue;
      }

      visitProjectedArrayUsage(
        project,
        plan.statement,
        {
          elementBindings: new Map([[plan.elementSymbolKey, projection]]),
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
    markExactHelperReadPath,
    shouldReplayExactHelperReadPaths,
    replayHelperExactAppendPlans,
    replayHelperProjectedUsages,
    registerLiveCapabilityFact,
    recordArrayBoundary,
    markEscaped,
  });

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
          markFiniteLookupReads(node, finiteLookupRead.candidates, finiteLookupRead.suffix);
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
                SKIP_CATEGORY.opaqueObjectCall,
                higherOrderSummary.boundaryReason,
                ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperEscape,
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
              resolved.boundaryCategory ?? SKIP_CATEGORY.computedPropertyAccess,
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
            SKIP_CATEGORY.arrayOpaqueMutation,
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
          SKIP_CATEGORY.opaqueObjectCall,
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
              SKIP_CATEGORY.arrayOpaqueMutation,
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

          markFiniteLookupReads(node, finiteLookupRead.candidates, finiteLookupRead.suffix);
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
            resolved.boundaryCategory ?? SKIP_CATEGORY.computedPropertyAccess,
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
      destructuringHandler.handleArrayBindingPattern(node);
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      destructuringHandler.handleObjectBindingPattern(node);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
}
