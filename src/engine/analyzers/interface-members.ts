import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { summarizeNonDeclarationReferences } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { getDeclarationNameNode, getNodeName, hasModifier } from "../../compiler/ast-utils.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import {
  addAudit,
  addFinding,
  registerCapabilityObligation,
  resolveCapabilityObligation,
  type AnalysisState,
} from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import {
  ANALYSIS_CAPABILITY_ID,
  ANALYSIS_CAPABILITY_OBLIGATION_FAMILY,
  ANALYSIS_CAPABILITY_OUTCOME,
} from "../capabilities/vocabulary.js";
import { buildPublicSurfaceAudit, createReferenceKey } from "./support.js";

/**
 * Reports internal interface members that have no proven non-declaration references.
 */
export function analyzeInterfaceMembers(
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
      if (ts.isInterfaceDeclaration(node) && node.name) {
        const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        const interfaceEntity = makeEntity(project.rootPath, ENTITY_KIND.type, sourceFile, node.name, node.name.text);
        const isPublicSurface = project.config.value.mode === "library" && artifacts.publicSurfaceIds.has(interfaceEntity.id);

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

          if (isExported) {
            registerCapabilityObligation(
              state,
              ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember,
              entity,
              ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
            );
          }

          if (isPublicSurface) {
            addAudit(state.kept, buildPublicSurfaceAudit(entity));
            resolveCapabilityObligation(
              state,
              ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember,
              entity,
              ANALYSIS_CAPABILITY_OUTCOME.kept,
              ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
            );
            continue;
          }

          const suppression = getSuppressionAudit(project, suppressionContext, entity, member);
          if (addAudit(state.kept, suppression)) {
            resolveCapabilityObligation(
              state,
              ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember,
              entity,
              ANALYSIS_CAPABILITY_OUTCOME.kept,
              ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
            );
            continue;
          }

          const cacheKey = createReferenceKey(sourceFile, memberNameNode);
          let referenceSummary = artifacts.referenceCaches.referenceSummaries.get(cacheKey);
          if (!referenceSummary) {
            referenceSummary = summarizeNonDeclarationReferences(
              project.languageService,
              sourceFile,
              memberNameNode,
              project.analyzableFiles,
              project.rootPath,
            );
            artifacts.referenceCaches.referenceSummaries.set(cacheKey, referenceSummary);
          }

          const hasLiveReferences = isExported
            ? referenceSummary.trustedRuntimeReferences > 0
            : referenceSummary.references > 0;

          if (hasLiveReferences) {
            resolveCapabilityObligation(
              state,
              ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember,
              entity,
              ANALYSIS_CAPABILITY_OUTCOME.live,
              ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
            );
            continue;
          }

          addFinding(
            state,
            entity,
            "unused-interface-member",
            isExported && referenceSummary.references > 0
              ? "eligible exported interface member is only referenced by non-runtime consumers"
              : isExported
                ? "eligible exported interface member has no trusted runtime consumers"
                : "eligible interface member has no non-declaration references",
            `Unused interface member ${node.name.text}.${memberName}`,
          );
          resolveCapabilityObligation(
            state,
            ANALYSIS_CAPABILITY_OBLIGATION_FAMILY.internalExportedInterfaceMember,
            entity,
            ANALYSIS_CAPABILITY_OUTCOME.finding,
            ANALYSIS_CAPABILITY_ID.libraryPublicSurfaceAliasing,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}
