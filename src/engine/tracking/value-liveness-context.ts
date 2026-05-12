import type ts from "typescript";

import type {
  ProjectContext,
  SuppressionContext,
} from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import type {
  CallableReturnSummary,
  TrackedValueBinding,
  ValueAccess,
} from "./model.js";

interface ValueLivenessSourceFileContext {
  trackedBindings: Map<string, TrackedValueBinding>;
  accesses: Map<string, ValueAccess[]>;
  parameterMeaningfulUse: Map<string, boolean | null>;
  callablePurity: Map<string, boolean | null>;
}

interface ValueLivenessStageContext {
  project: ProjectContext;
  reachableFiles: Set<string>;
  state: AnalysisState;
  suppressionContext: SuppressionContext;
  functionReturnSummaries: Map<string, CallableReturnSummary>;
  createSourceFileContext(sourceFile: ts.SourceFile): ValueLivenessSourceFileContext;
}

export function createValueLivenessStageContext(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): ValueLivenessStageContext {
  const trackingStageArtifacts = artifacts.getTrackingStageArtifacts("value-liveness");

  return {
    project,
    reachableFiles,
    state,
    suppressionContext,
    functionReturnSummaries: trackingStageArtifacts.returnSummaries.byCallableId,
    createSourceFileContext(_sourceFile: ts.SourceFile): ValueLivenessSourceFileContext {
      return {
        trackedBindings: new Map<string, TrackedValueBinding>(),
        accesses: new Map<string, ValueAccess[]>(),
        parameterMeaningfulUse: new Map(),
        callablePurity: new Map(),
      };
    },
  };
}
