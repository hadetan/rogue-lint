import path from "node:path";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { addFinding, type AnalysisState } from "../analysis-state.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { toRelative } from "../../shared/path-utils.js";
import { isPreserved } from "./preservation-gate.js";

function buildFileEntity(project: ProjectContext, sourceFile: ProjectContext["sourceFiles"][number]) {
  return {
    id: `file:${toRelative(project.rootPath, sourceFile.fileName)}`,
    kind: ENTITY_KIND.file,
    name: path.basename(sourceFile.fileName),
    location: {
      file: toRelative(project.rootPath, sourceFile.fileName),
      line: 1,
      column: 1,
    },
  };
}

/**
 * Reports analyzable files that are unreachable from the current entrypoint set.
 */
export function analyzeUnusedFiles(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const entity = buildFileEntity(project, sourceFile);
    if (isPreserved(project, state, suppressionContext, entity)) {
      continue;
    }

    addFinding(
      state,
      entity,
      "unused-file",
      "file is unreachable from configured entrypoints",
      `Unused file ${entity.location.file}`,
    );
  }
}
