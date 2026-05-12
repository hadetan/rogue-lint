import type { ProjectContext, SuppressionContext } from "../../types.js";
import { summarizeNonDeclarationReferences } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { kindToFinding } from "../../shared/entity-utils.js";
import { addAudit, addFinding, type AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import {
  buildPublicSurfaceAudit,
  collectExportCandidates,
  createReferenceKey,
} from "./support.js";

/**
 * Reports exported declarations that have no proven non-declaration references outside their declaring file.
 */
export function analyzeUnusedExports(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    for (const candidate of collectExportCandidates(project, sourceFile)) {
      const cacheKey = createReferenceKey(sourceFile, candidate.node);
      let referenceSummary = artifacts.referenceCaches.exportReferences.get(cacheKey);
      if (!referenceSummary) {
        referenceSummary = summarizeNonDeclarationReferences(
          project.languageService,
          sourceFile,
          candidate.node,
          project.analyzableFiles,
        );
        artifacts.referenceCaches.exportReferences.set(cacheKey, referenceSummary);
      }

      if (referenceSummary.crossFileReferences > 0) {
        continue;
      }

      const keepReason = artifacts.publicSurfaceIds.has(candidate.entity.id)
        ? buildPublicSurfaceAudit(candidate.entity)
        : getSuppressionAudit(project, suppressionContext, candidate.entity, candidate.node);

      if (addAudit(state.kept, keepReason)) {
        continue;
      }

      const findingKind = kindToFinding(candidate.exportedKind);
      if (!findingKind) {
        continue;
      }

      addFinding(
        state,
        candidate.entity,
        findingKind,
        referenceSummary.sameFileReferences > 0
          ? "exported declaration is only referenced within its declaring file"
          : "exported declaration has no non-declaration references outside its declaring file",
        referenceSummary.sameFileReferences > 0
          ? `Exported ${candidate.entity.name} is only used within ${candidate.entity.location.file}`
          : `Unused exported ${candidate.entity.name}`,
      );
    }
  }
}
