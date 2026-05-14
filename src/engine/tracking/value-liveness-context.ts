import type ts from "typescript";

import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { VALUE_LIVENESS_TRACKING_STAGE } from "./contracts.js";
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
  reachableFiles: Set<string>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  createSourceFileContext(sourceFile: ts.SourceFile): ValueLivenessSourceFileContext;
}

export function createValueLivenessStageContext(
  reachableFiles: Set<string>,
  artifacts: AnalysisArtifacts,
): ValueLivenessStageContext {
  const trackingStageArtifacts = artifacts.getTrackingStageArtifacts(VALUE_LIVENESS_TRACKING_STAGE);

  return {
    reachableFiles,
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
