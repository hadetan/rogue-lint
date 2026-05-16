import ts from "typescript";

import type { ProjectContext, SuppressionContext } from "../../types.js";
import { findNodeAtPosition } from "../../references.js";
import { getSuppressionAudit } from "../../suppressions.js";
import { getDeclarationNameNode, getNodeName } from "../../compiler/ast-utils.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { addAudit, addFinding, type AnalysisState } from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";

interface CompilerSafetyDiagnosticSpec {
  findingKind: "use-before-init";
  reason: string;
}

const COMPILER_SAFETY_DIAGNOSTICS = new Map<number, CompilerSafetyDiagnosticSpec>([
  [
    2454,
    {
      findingKind: "use-before-init",
      reason: "TypeScript semantic diagnostics reported this value is used before being assigned",
    },
  ],
]);

function buildCompilerSafetyEntity(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { entity: ReturnType<typeof makeEntity>; targetNode: ts.Node } | undefined {
  const declarationNode = ts.findAncestor(node, (candidate) => Boolean(getDeclarationNameNode(candidate)));
  const nameNode = declarationNode ? getDeclarationNameNode(declarationNode) : undefined;
  const name = declarationNode ? getNodeName(declarationNode) : undefined;

  if (declarationNode && nameNode && name) {
    if (ts.isPropertyDeclaration(declarationNode) || ts.isPropertySignature(declarationNode)) {
      const classDeclaration = ts.findAncestor(
        declarationNode,
        (candidate): candidate is ts.ClassLikeDeclaration => ts.isClassLike(candidate),
      );
      return {
        entity: makeEntity(
          project.rootPath,
          ENTITY_KIND.classMember,
          sourceFile,
          nameNode,
          name,
          classDeclaration?.name?.text,
        ),
        targetNode: declarationNode,
      };
    }

    if (ts.isVariableDeclaration(declarationNode) && ts.isIdentifier(declarationNode.name)) {
      return {
        entity: makeEntity(project.rootPath, ENTITY_KIND.local, sourceFile, node, declarationNode.name.text),
        targetNode: node,
      };
    }
  }

  if (ts.isIdentifier(node)) {
    return {
      entity: makeEntity(project.rootPath, ENTITY_KIND.local, sourceFile, node, node.text),
      targetNode: node,
    };
  }

  const text = node.getText(sourceFile).trim();
  if (!text) {
    return undefined;
  }

  return {
    entity: makeEntity(project.rootPath, ENTITY_KIND.expression, sourceFile, node, text),
    targetNode: node,
  };
}

/**
 * Promotes selected compiler diagnostics into rogue-lint findings when the target entity is identifiable.
 */
export function analyzeCompilerSafetyDiagnostics(
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

    for (const diagnostic of artifacts.getSemanticDiagnostics(sourceFile)) {
      const spec = COMPILER_SAFETY_DIAGNOSTICS.get(diagnostic.code);
      if (!spec || !diagnostic.file || diagnostic.start === undefined) {
        continue;
      }

      const node = findNodeAtPosition(diagnostic.file, diagnostic.start);
      if (!node) {
        continue;
      }

      const target = buildCompilerSafetyEntity(project, sourceFile, node);
      if (!target) {
        continue;
      }

      const suppression = getSuppressionAudit(project, suppressionContext, target.entity, target.targetNode);
      if (addAudit(state.kept, suppression)) {
        continue;
      }

      addFinding(
        state,
        target.entity,
        spec.findingKind,
        spec.reason,
        diagnostic.messageText.toString(),
        "review",
      );
    }
  }
}
