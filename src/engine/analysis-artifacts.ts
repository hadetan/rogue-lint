import type ts from "typescript";

import type { ProjectContext } from "../types.js";
import type { AnalysisRunState } from "./analysis-run-state.js";
import { createAnalysisRunState } from "./analysis-run-state.js";
import type { ReferenceCaches } from "./analyzers/support.js";
import { buildTrackedObjects } from "./tracking/graph.js";
import type { TrackingConvergenceOptions } from "./tracking/convergence.js";
import type {
  TrackingRunArtifacts,
  TrackingStage,
  TrackingStageArtifacts,
} from "./tracking/contracts.js";

export interface AnalysisArtifacts {
  publicSurfaceIds: Set<string>;
  publicCallableIds: Set<string>;
  referenceCaches: ReferenceCaches;
  getSemanticDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[];
  getTrackingRunArtifacts(): TrackingRunArtifacts;
  getTrackingStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }>;
}

export function createAnalysisArtifacts(
  project: ProjectContext,
  reachableFiles: Set<string>,
  publicSurfaceIds: Set<string>,
  publicCallableIds: Set<string> = new Set<string>(),
  trackingConvergenceOptions?: TrackingConvergenceOptions,
  runState: AnalysisRunState = createAnalysisRunState(),
): AnalysisArtifacts {
  const getTrackingRunArtifacts = (): TrackingRunArtifacts => {
    if (!runState.trackingArtifacts) {
      runState.trackingArtifacts = buildTrackedObjects(project, reachableFiles, trackingConvergenceOptions);
    }
    return runState.trackingArtifacts;
  };

  return {
    publicSurfaceIds,
    publicCallableIds,
    referenceCaches: runState.referenceCaches,
    getSemanticDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
      const cached = runState.semanticDiagnosticsByFile.get(sourceFile.fileName);
      if (cached) {
        return cached;
      }

      const diagnostics = project.program.getSemanticDiagnostics(sourceFile);
      runState.semanticDiagnosticsByFile.set(sourceFile.fileName, diagnostics);
      return diagnostics;
    },
    getTrackingRunArtifacts(): TrackingRunArtifacts {
      return getTrackingRunArtifacts();
    },
    getTrackingStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }> {
      return getTrackingRunArtifacts().getStageArtifacts(stage);
    },
  };
}
