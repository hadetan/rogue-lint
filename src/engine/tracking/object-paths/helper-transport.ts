import ts from "typescript";

import type { PathSegment, ProjectContext, SkipCategory, TrackedObject } from "../../../types.js";
import { getSymbolKey } from "../../../compiler/ast-utils.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { getCallSiteStructuredArgumentBinding } from "../access.js";
import { extendTrackedBinding } from "../bindings.js";
import { getAnalyzableCallableBindingFromDeclaration, getCallableReturnBinding } from "../callables.js";
import type { CallableReturnSummary, HelperParameterSummary, ResolvedTrackedObjectAccess, TrackedObjectBinding } from "../model.js";
import { buildHelperBoundaryReason, summarizeHelperParameterUse } from "../semantics.js";
import { getCollectionInfo, hasTrackedChildren } from "../state.js";
import { ANALYSIS_CAPABILITY_DETAIL_LABEL, ANALYSIS_CAPABILITY_ID } from "../../capabilities/vocabulary.js";
import { TRACKING_COLLECTION_KIND, TRACKING_HELPER_PARAMETER_EFFECT_KIND } from "../vocabulary.js";

type HelperTransportCapabilityId = typeof ANALYSIS_CAPABILITY_ID.helperTransport;

interface HelperTransportHandlerOptions {
  project: ProjectContext;
  sourceFile: ts.SourceFile;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  parameterMeaningfulUse: Map<string, boolean | null>;
  parameterSummaryCache: Map<string, HelperParameterSummary | null>;
  markExactHelperReadPath: (binding: TrackedObjectBinding, segments: PathSegment[]) => void;
  shouldReplayExactHelperReadPaths: (binding: TrackedObjectBinding) => boolean;
  replayHelperExactAppendPlans: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
  ) => void;
  replayHelperProjectedUsages: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
  ) => void;
  registerLiveCapabilityFact: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    capabilityId: HelperTransportCapabilityId,
    detailHint: string,
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
  markEscaped: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ) => void;
}

/**
 * Creates the same-project helper transport handler used by object-path analysis.
 */
export function createHelperTransportHandler(options: HelperTransportHandlerOptions): {
  getHelperTransportDetailHint: (summary: ReturnType<typeof summarizeHelperParameterUse>) => string;
  handleStructuredHelperArgument: (
    node: ts.CallExpression,
    argument: ts.Expression,
    resolved: ResolvedTrackedObjectAccess,
    parameter: ts.ParameterDeclaration | undefined,
    analyzableCallable: ts.FunctionLikeDeclaration | undefined,
  ) => boolean;
} {
  const {
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
  } = options;

  const getHelperTransportDetailHint = (
    summary: ReturnType<typeof summarizeHelperParameterUse>,
  ): string => {
    if (
      summary.boundaryReason?.includes("stores this value by reference")
      || summary.boundaryReason?.includes("stores this value inside an aggregate literal")
      || summary.boundaryReason?.includes("unsupported retained location")
    ) {
      return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperRetainedStorage;
    }

    if (summary.effectKinds.has(TRACKING_HELPER_PARAMETER_EFFECT_KIND.retainedBinding)) {
      return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperRetainedStorage;
    }

    if (summary.effectKinds.has(TRACKING_HELPER_PARAMETER_EFFECT_KIND.opaqueEscape)) {
      return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperEscape;
    }

    return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperTransport;
  };

  const handleStructuredHelperArgument = (
    node: ts.CallExpression,
    argument: ts.Expression,
    resolved: ResolvedTrackedObjectAccess,
    parameter: ts.ParameterDeclaration | undefined,
    analyzableCallable: ts.FunctionLikeDeclaration | undefined,
  ): boolean => {
    if (!parameter || !ts.isIdentifier(parameter.name) || !analyzableCallable) {
      return false;
    }

    const fullPath = [...resolved.binding.prefix, ...resolved.segments];
    const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
    const helperHasStructuredChildren = collectionInfo !== undefined
      || hasTrackedChildren(resolved.binding.trackedObject, fullPath)
      || Boolean(resolved.viaAliasObjectId);
    if (!helperHasStructuredChildren) {
      return false;
    }

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
    if (!summary.boundaryReason && (summary.effectKinds.size > 0 || summary.exactReadPaths.length > 0)) {
      registerLiveCapabilityFact(
        resolved.binding.trackedObject,
        fullPath,
        ANALYSIS_CAPABILITY_ID.helperTransport,
        getHelperTransportDetailHint(summary),
      );
    }
    if (collectionInfo?.kind === TRACKING_COLLECTION_KIND.array) {
      if (summary.boundaryReason) {
        recordArrayBoundary(
          project,
          resolved.binding.trackedObject,
          sourceFile,
          argument,
          fullPath,
          fullPath,
          SKIP_CATEGORY.arrayOpaqueMutation,
          buildHelperBoundaryReason(
            project,
            summary,
            "same-project helper receives this collection beyond exact local analysis",
          ),
          true,
          getHelperTransportDetailHint(summary),
        );
      }
      return true;
    }

    if (summary.boundaryReason) {
      const callableBinding = getAnalyzableCallableBindingFromDeclaration(project, analyzableCallable);
      const helperReturnBinding = callableBinding
        ? getCallableReturnBinding(functionReturnSummaries.get(callableBinding.symbolKey))
        : undefined;
      const boundaryCategory: SkipCategory = summary.boundaryReason.includes("stores this value by reference")
        && helperReturnBinding
        ? SKIP_CATEGORY.returnedObject
        : SKIP_CATEGORY.opaqueObjectCall;
      markEscaped(
        resolved.binding.trackedObject,
        fullPath,
        boundaryCategory,
        buildHelperBoundaryReason(
          project,
          summary,
          resolved.segments.length === 0
            ? "same-project helper receives this object beyond exact local analysis"
            : "same-project helper receives this object path beyond exact local analysis",
        ),
        getHelperTransportDetailHint(summary),
      );
    }

    return true;
  };

  return {
    getHelperTransportDetailHint,
    handleStructuredHelperArgument,
  };
}
