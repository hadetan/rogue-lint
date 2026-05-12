import type { ProjectContext, SuppressionContext } from "../../types.js";
import type { AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { analyzeClassMembers } from "./class-members.js";
import { analyzeInterfaceMembers } from "./interface-members.js";
import { analyzeUnusedExports } from "./unused-exports.js";
import { analyzeUnusedImports } from "./unused-imports.js";
import { analyzeUnusedLocals } from "./unused-locals.js";

export function analyzeSymbolLiveness(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  analyzeUnusedImports(project, reachableFiles, state, suppressionContext, artifacts);
  analyzeUnusedExports(project, reachableFiles, state, suppressionContext, artifacts);
  analyzeUnusedLocals(project, reachableFiles, state, suppressionContext, artifacts);
  analyzeClassMembers(project, reachableFiles, state, suppressionContext, artifacts);
  analyzeInterfaceMembers(project, reachableFiles, state, suppressionContext, artifacts);
}
