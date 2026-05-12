import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { summarizeReferenceUsage } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { getDeclarationNameNode, getNodeName } from "../../compiler/ast-utils.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addAudit, addFinding, addSkipped, type AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { buildPublicSurfaceAudit, createReferenceKey } from "./support.js";

/**
 * Reports class members that are provably unread while recording decorator and computed-name boundaries conservatively.
 */
export function analyzeClassMembers(
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

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classHasDecorators = ts.canHaveDecorators(node)
          ? Boolean(ts.getDecorators(node)?.length)
          : false;

        for (const member of node.members) {
          const memberName = getNodeName(member);
          const memberNameNode = getDeclarationNameNode(member);
          if (!memberName || !memberNameNode) {
            continue;
          }

          const entity = makeEntity(
            project.rootPath,
            "class-member",
            sourceFile,
            memberNameNode,
            memberName,
            className,
          );

          if (artifacts.publicSurfaceIds.has(entity.id)) {
            addAudit(state.kept, buildPublicSurfaceAudit(entity));
            continue;
          }

          const suppression = getSuppressionAudit(project, suppressionContext, entity, member);
          if (addAudit(state.kept, suppression)) {
            continue;
          }

          const memberHasDecorators = ts.canHaveDecorators(member)
            ? Boolean(ts.getDecorators(member)?.length)
            : false;

          if (classHasDecorators || memberHasDecorators) {
            addSkipped(state, entity, "decorator-visibility", "member skipped because decorators can make it externally visible");
            continue;
          }

          if (ts.isPropertyDeclaration(member) && member.name && ts.isComputedPropertyName(member.name)) {
            addSkipped(state, entity, "computed-member-name", "member skipped because computed property names are dynamic");
            continue;
          }

          const cacheKey = createReferenceKey(sourceFile, memberNameNode);
          const usage =
            artifacts.referenceCaches.usage.get(cacheKey)
            ?? summarizeReferenceUsage(
              project.languageService,
              project.program,
              sourceFile,
              memberNameNode,
              project.analyzableFiles,
            );
          artifacts.referenceCaches.usage.set(cacheKey, usage);

          if (usage.reads > 0) {
            continue;
          }

          addFinding(
            state,
            entity,
            "unused-class-member",
            usage.writes > 0
              ? "eligible class member is written but never read"
              : "eligible class member has no non-declaration references",
            `Unused class member ${className}.${memberName}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}
