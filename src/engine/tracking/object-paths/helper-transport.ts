import ts from "typescript";

import type { PathSegment, ProjectContext, SkipCategory, TrackedObject } from "../../../types.js";
import { getSymbolKey } from "../../../compiler/ast-utils.js";
import { serializePath } from "../../../shared/path-utils.js";
import { getCallSiteStructuredArgumentBinding, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding } from "../bindings.js";
import { getAnalyzableCallableBindingFromDeclaration, getCallableReturnBinding } from "../callables.js";
import type { AnalysisCapabilityFactRecord } from "../../capabilities/types.js";
import type { CallableReturnSummary, HelperParameterSummary, ResolvedTrackedObjectAccess, TrackedObjectBinding } from "../model.js";
import { buildHelperBoundaryReason, summarizeHelperParameterUse } from "../semantics.js";
import { getCollectionInfo, hasTrackedChildren } from "../state.js";
import { createCapabilityFactRecordId } from "../../capabilities/types.js";
import {
  ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_ESCAPE,
  ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_RETAINED_STORAGE,
  ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_TRANSPORT,
  ANALYSIS_CAPABILITY_FACT_FAMILY,
  ANALYSIS_CAPABILITY_FACT_OUTCOME,
  ANALYSIS_CAPABILITY_ID,
} from "../../capabilities/vocabulary.js";
import { TRACKING_COLLECTION_KIND, TRACKING_HELPER_PARAMETER_EFFECT_KIND } from "../vocabulary.js";
import type { BoundedHelperExecutionSnapshot } from "./types.js";

interface HelperTransportHandlerOptions {
  project: ProjectContext;
  sourceFile: ts.SourceFile;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  parameterMeaningfulUse: Map<string, boolean | null>;
  parameterSummaryCache: Map<string, HelperParameterSummary | null>;
  getBoundedHelperExecutionSnapshot: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ) => BoundedHelperExecutionSnapshot | undefined;
  markExactHelperReadPath: (binding: TrackedObjectBinding, segments: PathSegment[]) => void;
  shouldReplayExactHelperReadPaths: (binding: TrackedObjectBinding) => boolean;
  replayHelperExactAppendPlans: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
    localBindings?: Map<string, TrackedObjectBinding>,
  ) => void;
  replayHelperProjectedUsages: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
    binding: TrackedObjectBinding,
    localBindings?: Map<string, TrackedObjectBinding>,
  ) => void;
  capabilityFacts: Map<string, AnalysisCapabilityFactRecord>;
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
    resolved: ResolvedTrackedObjectAccess | undefined,
    parameter: ts.ParameterDeclaration | undefined,
    analyzableCallable: ts.FunctionLikeDeclaration | undefined,
    bindingScope?: Map<string, TrackedObjectBinding>,
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
    getBoundedHelperExecutionSnapshot,
    markExactHelperReadPath,
    shouldReplayExactHelperReadPaths,
    replayHelperExactAppendPlans,
    replayHelperProjectedUsages,
    capabilityFacts,
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
      return ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_RETAINED_STORAGE;
    }

    if (summary.effectKinds.has(TRACKING_HELPER_PARAMETER_EFFECT_KIND.retainedBinding)) {
      return ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_RETAINED_STORAGE;
    }

    if (summary.effectKinds.has(TRACKING_HELPER_PARAMETER_EFFECT_KIND.opaqueEscape)) {
      return ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_ESCAPE;
    }

    return ANALYSIS_CAPABILITY_DETAIL_LABEL_SAME_PROJECT_HELPER_TRANSPORT;
  };

  const handleStructuredHelperArgument = (
    node: ts.CallExpression,
    argument: ts.Expression,
    resolved: ResolvedTrackedObjectAccess | undefined,
    parameter: ts.ParameterDeclaration | undefined,
    analyzableCallable: ts.FunctionLikeDeclaration | undefined,
    bindingScope?: Map<string, TrackedObjectBinding>,
  ): boolean => {
    if (!parameter || !ts.isIdentifier(parameter.name) || !analyzableCallable) {
      return false;
    }

    const activeBindings = bindingScope ?? trackedBySymbolId;

    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    const baseBinding = parameterSymbolKey
      ? activeBindings.get(parameterSymbolKey) ?? trackedBySymbolId.get(parameterSymbolKey)
      : undefined;
    const resolvedBinding = resolved && !resolved.dynamic
      ? extendTrackedBinding(resolved.binding, resolved.segments)
      : undefined;
    const specializedArgumentBinding = baseBinding
      ? getCallSiteStructuredArgumentBinding(
          project,
          node,
          argument,
          baseBinding,
          activeBindings,
          functionReturnSummaries,
          trackedObjectsById,
        )
      : undefined;
    const helperReplayBinding = resolvedBinding ?? specializedArgumentBinding;
    if (!helperReplayBinding) {
      return false;
    }

    const fullPath = helperReplayBinding.prefix;
    const collectionInfo = getCollectionInfo(helperReplayBinding.trackedObject, fullPath);
    const helperHasStructuredChildren = collectionInfo !== undefined
      || hasTrackedChildren(helperReplayBinding.trackedObject, fullPath)
      || Boolean(resolved?.viaAliasObjectId);
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
    const snapshot = getBoundedHelperExecutionSnapshot(analyzableCallable, parameter.name);
    const exactReadPaths = snapshot?.exactReadPaths ?? summary.exactReadPaths;
    const boundaryReason = snapshot?.boundaryReason ?? summary.boundaryReason;

    if (shouldReplayExactHelperReadPaths(helperReplayBinding)) {
      const localBindings = new Map(activeBindings);
      const helperParameterBindings = new Map<ts.Identifier, TrackedObjectBinding>();

      analyzableCallable.parameters.forEach((candidateParameter, index) => {
        if (!ts.isIdentifier(candidateParameter.name)) {
          return;
        }

        const candidateArgument = node.arguments[index];
        if (!candidateArgument) {
          return;
        }

        const candidateResolved = resolveTrackedObjectAccess(
          project,
          candidateArgument,
          activeBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (!candidateResolved || candidateResolved.dynamic) {
          return;
        }

        const candidateFullPath = [...candidateResolved.binding.prefix, ...candidateResolved.segments];
        const candidateCollectionInfo = getCollectionInfo(candidateResolved.binding.trackedObject, candidateFullPath);
        const candidateHasStructuredChildren = candidateCollectionInfo !== undefined
          || hasTrackedChildren(candidateResolved.binding.trackedObject, candidateFullPath)
          || Boolean(candidateResolved.viaAliasObjectId);
        if (!candidateHasStructuredChildren) {
          return;
        }

        const candidateParameterSymbol = project.checker.getSymbolAtLocation(candidateParameter.name);
        const candidateParameterSymbolKey = candidateParameterSymbol ? getSymbolKey(candidateParameterSymbol) : undefined;
        const candidateBaseBinding = candidateParameterSymbolKey
          ? activeBindings.get(candidateParameterSymbolKey) ?? trackedBySymbolId.get(candidateParameterSymbolKey)
          : undefined;
        const candidateResolvedBinding = extendTrackedBinding(
          candidateResolved.binding,
          candidateResolved.segments,
        );
        const candidateSpecializedBinding = candidateBaseBinding
          ? getCallSiteStructuredArgumentBinding(
              project,
              node,
              candidateArgument,
              candidateBaseBinding,
              activeBindings,
              functionReturnSummaries,
              trackedObjectsById,
            )
          : undefined;
        const candidateReplayBinding = candidateResolvedBinding ?? candidateSpecializedBinding;
        if (candidateParameterSymbolKey) {
          localBindings.set(candidateParameterSymbolKey, candidateReplayBinding);
        }
        helperParameterBindings.set(candidateParameter.name, candidateReplayBinding);
      });

      exactReadPaths.forEach((readPath) => {
        markExactHelperReadPath(helperReplayBinding, readPath);
      });
      helperParameterBindings.forEach((candidateBinding, candidateParameter) => {
        if (!shouldReplayExactHelperReadPaths(candidateBinding)) {
          return;
        }

        replayHelperProjectedUsages(analyzableCallable, candidateParameter, candidateBinding, localBindings);
      });
      replayHelperExactAppendPlans(analyzableCallable, parameter.name, helperReplayBinding, localBindings);
    }
    if (!boundaryReason && (summary.effectKinds.size > 0 || exactReadPaths.length > 0)) {
      const entity = helperReplayBinding.trackedObject.nodes.get(serializePath(fullPath))?.entity
        ?? helperReplayBinding.trackedObject.rootEntity;
      const detailHint = getHelperTransportDetailHint(summary);
      const recordId = createCapabilityFactRecordId(
        ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport,
        entity,
        ANALYSIS_CAPABILITY_ID.helperTransport,
        detailHint,
      );
      if (!capabilityFacts.has(recordId)) {
        capabilityFacts.set(recordId, {
          id: recordId,
          family: ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport,
          capabilityId: ANALYSIS_CAPABILITY_ID.helperTransport,
          entity,
          outcome: ANALYSIS_CAPABILITY_FACT_OUTCOME.live,
          detailHint,
        });
      }
    }
    if (collectionInfo?.kind === TRACKING_COLLECTION_KIND.array) {
      if (boundaryReason) {
        recordArrayBoundary(
          project,
          helperReplayBinding.trackedObject,
          sourceFile,
          argument,
          fullPath,
          fullPath,
          "array-opaque-mutation",
          buildHelperBoundaryReason(
            project,
            {
              boundaryNode: summary.boundaryNode,
              boundaryReason,
            },
            "same-project helper receives this collection beyond exact local analysis",
          ),
          true,
          getHelperTransportDetailHint(summary),
        );
      }
      return true;
    }

    if (boundaryReason) {
      const callableBinding = getAnalyzableCallableBindingFromDeclaration(project, analyzableCallable);
      const helperReturnBinding = callableBinding
        ? getCallableReturnBinding(functionReturnSummaries.get(callableBinding.symbolKey))
        : undefined;
      const boundaryCategory: SkipCategory = boundaryReason.includes("stores this value by reference")
        && helperReturnBinding
        ? "returned-object"
        : "opaque-object-call";
      markEscaped(
        helperReplayBinding.trackedObject,
        fullPath,
        boundaryCategory,
        buildHelperBoundaryReason(
          project,
          {
            boundaryNode: summary.boundaryNode,
            boundaryReason,
          },
          helperReplayBinding.prefix.length === 0
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
