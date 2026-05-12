import type ts from "typescript";

import type { ProjectContext } from "../types.js";
import type { ReferenceCaches } from "./analyzers/support.js";
import { buildTrackedObjects } from "./tracking/graph.js";

type TrackingArtifacts = ReturnType<typeof buildTrackedObjects>;

export interface AnalysisArtifacts {
  publicSurfaceIds: Set<string>;
  referenceCaches: ReferenceCaches;
  getSemanticDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[];
  getTrackingArtifacts(): TrackingArtifacts;
}

export function createAnalysisArtifacts(
  project: ProjectContext,
  reachableFiles: Set<string>,
  publicSurfaceIds: Set<string>,
): AnalysisArtifacts {
  const semanticDiagnosticsByFile = new Map<string, readonly ts.Diagnostic[]>();
  const referenceCaches: ReferenceCaches = {
    hasReference: new Map(),
    exportReferences: new Map(),
    usage: new Map(),
  };
  let trackingArtifacts: TrackingArtifacts | undefined;

  return {
    publicSurfaceIds,
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
    getTrackingArtifacts(): TrackingArtifacts {
      if (!trackingArtifacts) {
        trackingArtifacts = buildTrackedObjects(project, reachableFiles);
      }
      return trackingArtifacts;
    },
  };
}
