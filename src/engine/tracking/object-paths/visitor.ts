import ts from "typescript";

import type {
  PathSegment,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { getSymbolKey, isReadLikeUse } from "../../../compiler/ast-utils.js";
import { propertySegment, serializePath } from "../../../shared/path-utils.js";
import {
  getAccessPath,
  getBindingSymbolKey,
  getCallSiteStructuredArgumentBinding,
  getObjectBackedRetainedBindingSlotKeyFromAccess,
  getRetainedBindingContainerSlotKey,
  getSupportedArrayCallbackIndexParamIndex,
  getSupportedArrayCallbackParamIndex,
  isExactArrayCallbackMethod,
  isLocallyOwnedRetainedBindingContainer,
  resolveAnalyzableCallableBinding,
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
} from "../callables.js";
import type {
  ArrayProjectionBinding,
  ExactAppendSlotPlan,
  ResolvedTrackedObjectAccess,
  TrackedObjectBinding,
} from "../model.js";
import {
  ARRAY_APPEND_METHODS,
  ARRAY_REORDER_METHODS,
  ARRAY_REPLACEMENT_METHODS,
  ARRAY_TRUNCATE_METHODS,
  WHOLE_ARRAY_CONSUMPTION_METHODS,
  buildHelperBoundaryReason,
  classifySupportedCallArgumentUse,
  summarizeHelperParameterUse,
} from "../semantics.js";
import { unwrapExpression } from "../syntax.js";
import {
  addValueFate,
  getCollectionInfo,
  getProjectionBinding,
  hasTrackedChildren,
  resolveExactPathAlias,
} from "../state.js";
import {
  handleSupportedValueFateCall as handleSupportedValueFateCallEffect,
  handleTrackedArrayMutation as handleTrackedArrayMutationEffect,
  maybeInvalidateReplacedTrackedPath as maybeInvalidateReplacedTrackedPathEffect,
  maybeReportInvalidatedRead as maybeReportInvalidatedReadEffect,
  recordArrayBoundary as recordArrayBoundaryEffect,
  tryRegisterExactArrayInsertion,
} from "./effects.js";
import {
  markObjectPathAliasObserved,
  markObjectPathEscaped,
  markObjectPathObservedChildPaths,
  markObjectPathObservedSubtree,
  markObjectPathProjectionChildReads,
  markObjectPathProjectionElementRead,
  markObjectPathProjectionReads,
  markObjectPathProjectionWrites,
  markObjectPathRead,
  markObjectPathWrite,
} from "./overlay.js";
import type {
  FiniteLookupCandidate,
  HelperExactAppendPlan,
  HelperProjectedUsagePlan,
  ObjectPathSourceFileContext,
  ObjectPathStageContext,
} from "./context.js";
import { extractFinitePropertyUnionSegments } from "./policy.js";
import { isAssignmentLeft, visitProjectedArrayUsage as visitProjectedArrayUsageEffect } from "./projections.js";

export function visitObjectPathSourceFile(
  stageContext: ObjectPathStageContext,
  sourceFileContext: ObjectPathSourceFileContext,
): void {
  const {
    project,
    publicCallableIds,
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

  const markEscaped = (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
  ): void => {
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
  ): void => {
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
  ): void => {
    visitProjectedArrayUsageEffect(project, node, context, projectionTrackedObjectsById, overlayState);
  };

  const getProjectedNestedArrayBinding = (
    projection: ArrayProjectionBinding,
    suffix: PathSegment[],
  ): ArrayProjectionBinding | undefined => {
    const baseBinding: TrackedObjectBinding = {
      trackedObject: projection.trackedObject,
      prefix: [],
    };
    let nestedTrackedObject: TrackedObject | undefined;
    let nestedSourcePath: PathSegment[] | undefined;
    const nestedElementPaths: PathSegment[][] = [];

    for (const candidatePath of projection.elementPaths) {
      const fullPath = [...candidatePath, ...suffix];
      const resolvedAlias = resolveExactPathAlias(baseBinding, fullPath, trackedObjectsById);
      const targetTrackedObject = resolvedAlias.binding.trackedObject;
      const targetPath = sameTrackedBinding(resolvedAlias.binding, baseBinding)
        ? fullPath
        : resolvedAlias.binding.prefix;
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

  const getPublicReturnBinding = (node: ts.Node): TrackedObjectBinding | undefined => {
    if (project.config.value.mode !== "library") {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
    if (!enclosingFunction) {
      return undefined;
    }

    const callable = getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction);
    if (!callable || !publicCallableIds.has(callable.symbolKey)) {
      return undefined;
    }

    return getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey));
  };

  const isExactStructuredReturnExpression = (
    callable: ReturnType<typeof getAnalyzableCallableBindingFromDeclaration> | undefined,
    expression: ts.Expression,
  ): boolean => {
    if (!callable) {
      return false;
    }

    const summary = functionReturnSummaries.get(callable.symbolKey);
    if (summary?.kind !== "structured") {
      return false;
    }

    const unwrapped = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      return true;
    }

    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(unwrapped);
    const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
    if (!declaration?.initializer) {
      return false;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    if (enclosingFunction !== callable.declaration) {
      return false;
    }

    const initializer = unwrapExpression(declaration.initializer);
    return ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer);
  };

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

  const resolveFiniteLookupCandidates = (node: ts.ElementAccessExpression): FiniteLookupCandidate[] | undefined => {
    const nested = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (!nested || nested.dynamic) {
      return undefined;
    }

    const collapsedBinding = collapseExactBindingPrefix(extendTrackedBinding(nested.binding, nested.segments));
    if (getCollectionInfo(collapsedBinding.trackedObject, collapsedBinding.prefix)?.kind === "array") {
      return undefined;
    }

    const candidateSegments = extractFinitePropertyUnionSegments(project, node.argumentExpression);
    if (!candidateSegments) {
      return undefined;
    }

    const exactCandidateSegments = candidateSegments.filter((candidateSegment) => hasExactTrackedPath(
      collapsedBinding,
      [candidateSegment],
    ));
    if (exactCandidateSegments.length <= 1) {
      return undefined;
    }

    return exactCandidateSegments.map((candidateSegment) => {
      const aliased = resolveExactPathAlias(
        collapsedBinding,
        [candidateSegment],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, collapsedBinding) ? [candidateSegment] : [],
      };
    });
  };

  const getHelperFiniteReturnPlan = (
    callable: ts.FunctionLikeDeclaration,
  ): { candidates: FiniteLookupCandidate[]; suffix: PathSegment[] } | undefined => {
    if (!callable.body) {
      return undefined;
    }

    const helperSymbol = getAnalyzableCallableBindingFromDeclaration(project, callable)?.symbolKey;
    if (!helperSymbol) {
      return undefined;
    }

    const cached = helperFiniteReturnCache.get(helperSymbol);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    let plan: { candidates: FiniteLookupCandidate[]; suffix: PathSegment[] } | undefined;
    let unsupported = false;
    const visitReturn = (candidate: ts.Node): void => {
      if (unsupported) {
        return;
      }

      if (ts.isFunctionLike(candidate) && candidate !== callable) {
        return;
      }

      if (ts.isReturnStatement(candidate) && candidate.expression) {
        const next = resolveFiniteLookupRead(candidate.expression);
        if (!next) {
          unsupported = true;
          return;
        }

        if (!plan) {
          plan = next;
        } else if (
          plan.suffix.length !== next.suffix.length
          || serializePath(plan.suffix) !== serializePath(next.suffix)
          || plan.candidates.length !== next.candidates.length
          || plan.candidates.some((existing, index) => {
            const other = next.candidates[index];
            return !other
              || existing.binding.trackedObject.id !== other.binding.trackedObject.id
              || serializePath(existing.binding.prefix) !== serializePath(other.binding.prefix)
              || serializePath(existing.segments) !== serializePath(other.segments);
          })
        ) {
          unsupported = true;
        }
      }

      ts.forEachChild(candidate, visitReturn);
    };

    ts.forEachChild(callable.body, visitReturn);
    helperFiniteReturnCache.set(helperSymbol, !unsupported && plan ? plan : null);
    return !unsupported && plan ? plan : undefined;
  };

  const resolveFiniteLookupRead = (node: ts.Expression): { candidates: FiniteLookupCandidate[]; suffix: PathSegment[] } | undefined => {
    if (ts.isElementAccessExpression(node)) {
      const candidates = resolveFiniteLookupCandidates(node);
      return candidates ? { candidates, suffix: [] } : undefined;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const directCandidates = ts.isElementAccessExpression(node.expression)
        ? resolveFiniteLookupCandidates(node.expression)
        : undefined;
      const aliasCandidates = !directCandidates && ts.isIdentifier(node.expression)
        ? finiteLookupBindings.get(getBindingSymbolKey(project, node.expression) ?? "")
        : undefined;
      const helperCandidates = !directCandidates && !aliasCandidates && ts.isCallExpression(node.expression)
        ? (() => {
            const callable = resolveAnalyzableCallableBinding(
              project,
              node.expression.expression,
              trackedBySymbolId,
              functionReturnSummaries,
              trackedObjectsById,
            )?.declaration;
            const plan = callable ? getHelperFiniteReturnPlan(callable) : undefined;
            return plan?.suffix.length === 0 ? plan.candidates : undefined;
          })()
        : undefined;
      const candidates = directCandidates ?? aliasCandidates ?? helperCandidates;
      return candidates ? { candidates, suffix: [propertySegment(node.name.text)] } : undefined;
    }

    return undefined;
  };

  const markFiniteLookupReads = (
    node: ts.Node,
    candidates: FiniteLookupCandidate[],
    suffix: PathSegment[] = [],
  ): void => {
    for (const candidate of candidates) {
      const fullPath = [...candidate.binding.prefix, ...candidate.segments, ...suffix];
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

  const markEscapedAggregateLiteralBindings = (
    expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    category: Parameters<typeof markEscaped>[2],
    reason: string,
  ): void => {
    const visitStoredExpression = (candidate: ts.Expression): void => {
      const unwrapped = unwrapExpression(candidate);
      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        markEscaped(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          category,
          reason,
        );
        return;
      }

      if (ts.isObjectLiteralExpression(unwrapped)) {
        for (const property of unwrapped.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            visitStoredExpression(property.name);
            continue;
          }

          if (ts.isPropertyAssignment(property)) {
            visitStoredExpression(property.initializer);
          }
        }
        return;
      }

      if (ts.isArrayLiteralExpression(unwrapped)) {
        for (const element of unwrapped.elements) {
          if (!ts.isSpreadElement(element)) {
            visitStoredExpression(element);
          }
        }
      }
    };

    visitStoredExpression(expression);
  };

  const markObservedAggregateLiteralBindings = (
    expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ): void => {
    const visitStoredExpression = (candidate: ts.Expression): void => {
      const unwrapped = unwrapExpression(candidate);
      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        markObservedSubtree(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          trackedObjectsById,
        );
        return;
      }

      if (ts.isObjectLiteralExpression(unwrapped)) {
        for (const property of unwrapped.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            visitStoredExpression(property.name);
            continue;
          }

          if (ts.isPropertyAssignment(property)) {
            visitStoredExpression(property.initializer);
          }
        }
        return;
      }

      if (ts.isArrayLiteralExpression(unwrapped)) {
        for (const element of unwrapped.elements) {
          if (!ts.isSpreadElement(element)) {
            visitStoredExpression(element);
          }
        }
      }
    };

    visitStoredExpression(expression);
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
    binding.trackedObject.structuralRole !== "structural-record"
    && binding.trackedObject.structuralRole !== "structural-record-array"
    && binding.trackedObject.structuralRole !== "state-holder"
  );

  const getHelperExactAppendPlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): HelperExactAppendPlan[] => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey) {
      return [];
    }

    const cached = helperExactAppendPlanCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? [];
    }

    const baseBinding = trackedBySymbolId.get(parameterSymbolKey);
    if (!baseBinding || !callable.body) {
      helperExactAppendPlanCache.set(parameterSymbolKey, null);
      return [];
    }

    const basePrefix = serializePath(baseBinding.prefix);
    const plans: HelperExactAppendPlan[] = [];
    const helperSourceFile = callable.getSourceFile();

    const visitHelper = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      if (
        ts.isCallExpression(candidate)
        && ts.isPropertyAccessExpression(candidate.expression)
        && (candidate.expression.name.text === "push" || candidate.expression.name.text === "unshift")
      ) {
        const resolvedReceiver = resolveTrackedObjectAccess(
          project,
          candidate.expression.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolvedReceiver && !resolvedReceiver.dynamic) {
          const receiverBinding = extendTrackedBinding(resolvedReceiver.binding, resolvedReceiver.segments);
          const receiverPrefix = serializePath(receiverBinding.prefix.slice(0, baseBinding.prefix.length));
          const receiverCollection = getCollectionInfo(receiverBinding.trackedObject, receiverBinding.prefix);
          if (
            receiverBinding.trackedObject.id === baseBinding.trackedObject.id
            && receiverPrefix === basePrefix
            && receiverCollection?.kind === "array"
          ) {
            const slotPlans: ExactAppendSlotPlan[] = [];
            let exactStructuredAppend = candidate.arguments.length > 0;

            for (const argument of candidate.arguments) {
              const structuredLiteral = unwrapExpression(argument);
              if (ts.isObjectLiteralExpression(structuredLiteral) || ts.isArrayLiteralExpression(structuredLiteral)) {
                slotPlans.push({
                  kind: "structured",
                  literal: structuredLiteral,
                  insertReason: `${candidate.expression.name.text} appends a structured value into an exact receiver slot`,
                });
                continue;
              }

              exactStructuredAppend = false;
              break;
            }

            if (exactStructuredAppend) {
              plans.push({
                call: candidate,
                sourceFile: helperSourceFile,
                methodName: candidate.expression.name.text,
                relativeCollectionPath: receiverBinding.prefix.slice(baseBinding.prefix.length),
                slotPlans,
              });
            }
          }
        }
      }

      ts.forEachChild(candidate, visitHelper);
    };

    visitHelper(callable.body);
    helperExactAppendPlanCache.set(parameterSymbolKey, plans.length > 0 ? plans : null);
    return plans;
  };

  const replayHelperExactAppendPlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
  ): void => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    if (!parameterSymbol) {
      return;
    }

    const plans = getHelperExactAppendPlans(callable, parameter);
    if (plans.length === 0) {
      return;
    }

    const localBindings = new Map(trackedBySymbolId);
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

  const getHelperProjectedUsagePlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): HelperProjectedUsagePlan[] => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey) {
      return [];
    }

    const cached = helperProjectedUsagePlanCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? [];
    }

    const baseBinding = trackedBySymbolId.get(parameterSymbolKey);
    if (!baseBinding || !callable.body) {
      helperProjectedUsagePlanCache.set(parameterSymbolKey, null);
      return [];
    }

    const basePrefix = serializePath(baseBinding.prefix);
    const plans: HelperProjectedUsagePlan[] = [];

    const visitHelper = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      if (ts.isForOfStatement(candidate)) {
        const resolved = resolveTrackedObjectAccess(
          project,
          candidate.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        const elementSymbolKey = getBindingSymbolKey(project, candidate.initializer);
        if (resolved && !resolved.dynamic && elementSymbolKey) {
          const receiverBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          const receiverPrefix = serializePath(receiverBinding.prefix.slice(0, baseBinding.prefix.length));
          const receiverCollection = getCollectionInfo(receiverBinding.trackedObject, receiverBinding.prefix);
          if (
            receiverBinding.trackedObject.id === baseBinding.trackedObject.id
            && receiverPrefix === basePrefix
            && receiverCollection?.kind === "array"
          ) {
            plans.push({
              statement: candidate.statement,
              relativeCollectionPath: receiverBinding.prefix.slice(baseBinding.prefix.length),
              elementSymbolKey,
            });
          }
        }
      }

      ts.forEachChild(candidate, visitHelper);
    };

    visitHelper(callable.body);
    helperProjectedUsagePlanCache.set(parameterSymbolKey, plans.length > 0 ? plans : null);
    return plans;
  };

  const replayHelperProjectedUsages = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
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
      );
    }
  };

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
      const resolved = resolveTrackedObjectAccess(
        project,
        node.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
      const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
      const propagated = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
      const returnBinding = resolved && !resolved.dynamic
        ? extendTrackedBinding(resolved.binding, resolved.segments)
        : undefined;
      const publicReturnBinding = getPublicReturnBinding(node);
      const returnedExpression = unwrapExpression(node.expression);
      const returnedStructureStaysExact = Boolean(
        (returnBinding && propagated && sameTrackedBinding(propagated, returnBinding))
        || isExactStructuredReturnExpression(callable, returnedExpression),
      );
      if (publicReturnBinding) {
        markObservedSubtree(publicReturnBinding.trackedObject, publicReturnBinding.prefix, trackedObjectsById);
      }
      if (ts.isObjectLiteralExpression(returnedExpression) || ts.isArrayLiteralExpression(returnedExpression)) {
        if (publicReturnBinding) {
          markObservedAggregateLiteralBindings(returnedExpression);
        } else if (!returnedStructureStaysExact) {
          markEscapedAggregateLiteralBindings(
            returnedExpression,
            "returned-object",
            "stored inside returned aggregate literal beyond exact local analysis",
          );
        }
      }

      if (returnBinding && !returnedStructureStaysExact) {
        markEscaped(
          returnBinding.trackedObject,
          returnBinding.prefix,
          "returned-object",
          "returned object escapes local analysis",
        );
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
      if (ts.isPropertyAccessExpression(node.expression)) {
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
        if (resolvedReceiver && !resolvedReceiver.dynamic) {
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
        }
      }

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
          const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
          const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
          const baseBinding = parameterSymbolKey ? trackedBySymbolId.get(parameterSymbolKey) : undefined;
          const specializedArgumentBinding = baseBinding
            ? getCallSiteStructuredArgumentBinding(
                project,
                node,
                argument,
                baseBinding,
                trackedBySymbolId,
                functionReturnSummaries,
                trackedObjectsById,
              )
            : undefined;
          const helperReplayBinding = specializedArgumentBinding ?? extendTrackedBinding(resolved.binding, resolved.segments);
          if (shouldReplayExactHelperReadPaths(helperReplayBinding)) {
            summary.exactReadPaths.forEach((readPath) => {
              markExactHelperReadPath(helperReplayBinding, readPath);
            });
            replayHelperExactAppendPlans(analyzableCallable, parameter.name, helperReplayBinding);
            replayHelperProjectedUsages(analyzableCallable, parameter.name, helperReplayBinding);
          }
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
      } else {
        const projected = resolveProjectionAccess(project, node.expression, projectionContext);
        if (projected?.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            sourceFile,
            node.expression,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array projection escapes exact local analysis",
            true,
          );
        } else if (projected) {
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
            );
          } else {
            markProjectionReads(projected.projection, trackedObjectsById, projected.suffix, true);
          }
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
          markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
        } else {
          const parentCall = ts.isCallExpression(node.parent) ? node.parent : undefined;
          const argumentIndex = parentCall
            ? parentCall.arguments.findIndex((argument) => argument === node)
            : -1;
          const supportedArgumentUse = parentCall && argumentIndex >= 0
            ? classifySupportedCallArgumentUse(parentCall.expression.getText(sourceFile), argumentIndex)
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
