import type ts from "typescript";

import type { ProjectContext } from "../types.js";
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
): AnalysisArtifacts {
  const semanticDiagnosticsByFile = new Map<string, readonly ts.Diagnostic[]>();
  const referenceCaches: ReferenceCaches = {
    hasReference: new Map(),
    exportReferences: new Map(),
    usage: new Map(),
  };
  let trackingArtifacts: TrackingRunArtifacts | undefined;

  const getTrackingRunArtifacts = (): TrackingRunArtifacts => {
    if (!trackingArtifacts) {
      trackingArtifacts = buildTrackedObjects(project, reachableFiles, trackingConvergenceOptions);
    }
    return trackingArtifacts;
  };

  return {
    publicSurfaceIds,
    publicCallableIds,
    referenceCaches,
    getSemanticDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
      const cached = semanticDiagnosticsByFile.get(sourceFile.fileName);
      if (cached) {
        return cached;
      }

      const diagnostics = project.program.getSemanticDiagnostics(sourceFile);
      semanticDiagnosticsByFile.set(sourceFile.fileName, diagnostics);
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
