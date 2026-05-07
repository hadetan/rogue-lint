import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { hasNonDeclarationReferences } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { getDeclarationNameNode, getNodeName, hasModifier } from "../../compiler/ast-utils.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addAudit, addFinding, type AnalysisState } from "../analysis-state.js";
import { createReferenceKey, type ReferenceCaches } from "./support.js";

/**
 * Reports internal interface members that have no proven non-declaration references.
 */
export function analyzeInterfaceMembers(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  caches: ReferenceCaches,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name) {
        const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        if (project.config.value.mode === "library" && isExported) {
          return ts.forEachChild(node, visit);
        }

        for (const member of node.members) {
          if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) {
            continue;
          }

          const memberName = getNodeName(member);
          const memberNameNode = getDeclarationNameNode(member);
          if (!memberName || !memberNameNode) {
            continue;
          }

          const entity = makeEntity(
            project.rootPath,
            "interface-member",
            sourceFile,
            memberNameNode,
            memberName,
            node.name.text,
          );
          const suppression = getSuppressionAudit(project, suppressionContext, entity, member);
          if (addAudit(state.kept, suppression)) {
            continue;
          }

          const cacheKey = createReferenceKey(sourceFile, memberNameNode);
          let hasReferences = caches.hasReference.get(cacheKey);
          if (hasReferences === undefined) {
            hasReferences = hasNonDeclarationReferences(
              project.languageService,
              sourceFile,
              memberNameNode,
              project.analyzableFiles,
            );
            caches.hasReference.set(cacheKey, hasReferences);
          }

          if (hasReferences) {
            continue;
          }

          addFinding(
            state,
            entity,
            "unused-interface-member",
            "eligible interface member has no non-declaration references",
            `Unused interface member ${node.name.text}.${memberName}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}
