import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { summarizeNonDeclarationReferences } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addAudit, type AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { createReferenceKey } from "./support.js";

function hasLocalImportUsage(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  nameNode: ts.Identifier,
): boolean {
  return summarizeNonDeclarationReferences(
    project.languageService,
    sourceFile,
    nameNode,
    project.analyzableFiles,
    project.rootPath,
  ).sameFileReferences > 0;
}

function analyzeImportBinding(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  nameNode: ts.Identifier,
  declarationNode: ts.Node,
  findings: AnalysisState["findings"],
  kept: AnalysisState["kept"],
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  const entity = makeEntity(project.rootPath, ENTITY_KIND.import, sourceFile, nameNode, nameNode.text);
  const suppression = getSuppressionAudit(project, suppressionContext, entity, declarationNode);
  if (addAudit(kept, suppression)) {
    return;
  }

  const cacheKey = createReferenceKey(sourceFile, nameNode);
  let hasReferences = artifacts.referenceCaches.hasReference.get(cacheKey);
  if (hasReferences === undefined) {
    hasReferences = hasLocalImportUsage(project, sourceFile, nameNode);
    artifacts.referenceCaches.hasReference.set(cacheKey, hasReferences);
  }

  if (hasReferences) {
    return;
  }

  findings.push({
    id: entity.id,
    kind: "unused-import",
    entity,
    reason: "imported binding has no non-declaration references",
    message: `Unused import ${nameNode.text}`,
    suggestion: "remove",
  });
}

export function analyzeUnusedImports(
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

    const findings = state.findings;
    const kept = state.kept;

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const { importClause } = node;

        if (importClause.name) {
          analyzeImportBinding(
            project,
            sourceFile,
            importClause.name,
            importClause,
            findings,
            kept,
            suppressionContext,
            artifacts,
          );
        }

        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            analyzeImportBinding(
              project,
              sourceFile,
              importClause.namedBindings.name,
              importClause.namedBindings,
                findings,
                kept,
              suppressionContext,
              artifacts,
            );
          } else {
            for (const element of importClause.namedBindings.elements) {
              analyzeImportBinding(
                project,
                sourceFile,
                element.name,
                element,
                findings,
                kept,
                suppressionContext,
                artifacts,
              );
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}
