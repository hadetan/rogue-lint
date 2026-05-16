import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { summarizeNonDeclarationReferences } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addAudit, addFinding, type AnalysisState } from "../analysis-state.js";
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
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  const entity = makeEntity(project.rootPath, ENTITY_KIND.import, sourceFile, nameNode, nameNode.text);
  const suppression = getSuppressionAudit(project, suppressionContext, entity, declarationNode);
  if (addAudit(state.kept, suppression)) {
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

  addFinding(
    state,
    entity,
    "unused-import",
    "imported binding has no non-declaration references",
    `Unused import ${nameNode.text}`,
  );
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

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const { importClause } = node;

        if (importClause.name) {
          analyzeImportBinding(
            project,
            sourceFile,
            importClause.name,
            importClause,
            state,
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
              state,
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
                state,
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
