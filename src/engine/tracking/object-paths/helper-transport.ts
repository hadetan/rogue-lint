import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { getSymbolKey } from "../../../compiler/ast-utils.js";
import { getCallSiteStructuredArgumentBinding } from "../access.js";
import { extendTrackedBinding } from "../bindings.js";
import type {
  CallableReturnSummary,
  HelperParameterSummary,
  ResolvedTrackedObjectAccess,
  TrackedObjectBinding,
} from "../model.js";
import {
  buildHelperBoundaryReason,
  summarizeHelperParameterUse,
} from "../semantics.js";
import {
  getCollectionInfo,
  hasTrackedChildren,
} from "../state.js";

type HelperTransportCapabilityId = "helper-transport";

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
      return "same-project helper retained storage";
    }

    if (summary.effectKinds.has("retained-binding")) {
      return "same-project helper retained storage";
    }

    if (summary.effectKinds.has("opaque-escape")) {
      return "same-project helper escape";
    }

    return "same-project helper transport";
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
      || hasTrackedChildren(resolved.binding.trackedObject, fullPath);
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
        "helper-transport",
        getHelperTransportDetailHint(summary),
      );
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
          getHelperTransportDetailHint(summary),
        );
      }
      return true;
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
