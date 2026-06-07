import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { findNodeAtPosition } from "../../references.js";
import { getDeclarationNameNode, getNodeName } from "../../compiler/ast-utils.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addFinding, type AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { isPreserved } from "./preservation-gate.js";

/**
 * Converts TypeScript's unused-local diagnostics into rogue-lint findings after suppression checks.
 */
export function analyzeUnusedLocals(
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

    // TypeScript's unused-local semantic diagnostics are trustworthy for TS sources,
    // but benchmarked JS projects can surface false positives here.
    if (/\.[cm]?jsx?$/i.test(sourceFile.fileName)) {
      continue;
    }

    for (const diagnostic of artifacts.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.code !== 6133 || !diagnostic.file || diagnostic.start === undefined) {
        continue;
      }

      const node = findNodeAtPosition(diagnostic.file, diagnostic.start);
      const declarationNode = node ? ts.findAncestor(node, (candidate) => Boolean(getDeclarationNameNode(candidate))) : undefined;
      const nameNode = declarationNode ? getDeclarationNameNode(declarationNode) : node;
      const name = declarationNode ? getNodeName(declarationNode) : node?.getText(sourceFile);

      if (!nameNode || !name) {
        continue;
      }

      const entity = makeEntity(project.rootPath, ENTITY_KIND.local, sourceFile, nameNode, name);
      if (isPreserved(project, state, suppressionContext, entity, {
        declarationNode: declarationNode ?? nameNode,
      })) {
        continue;
      }

      addFinding(
        state,
        entity,
        "unused-local",
        "TypeScript semantic diagnostics reported this declaration as unused",
        diagnostic.messageText.toString(),
      );
    }
  }
}
