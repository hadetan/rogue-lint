import ts from "typescript";

function findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (position < node.getFullStart() || position > node.getEnd()) {
      return undefined;
    }

    return ts.forEachChild(node, visit) ?? node;
  };

  return visit(sourceFile);
}

function isDeclarationReference(reference: ts.ReferenceEntry, position: number): boolean {
  return reference.textSpan.start === position;
}

function isAllowedReference(reference: ts.ReferenceEntry, allowedFiles?: Set<string>): boolean {
  return !allowedFiles || allowedFiles.has(reference.fileName);
}

function countNonDeclarationReferences(
  languageService: ts.LanguageService,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  allowedFiles?: Set<string>,
): number {
  const references = languageService.findReferences(sourceFile.fileName, node.getStart(sourceFile)) ?? [];
  let count = 0;

  for (const group of references) {
    for (const reference of group.references) {
      if (!isAllowedReference(reference, allowedFiles)) {
        continue;
      }
      if (reference.fileName !== sourceFile.fileName || !isDeclarationReference(reference, node.getStart(sourceFile))) {
        count += 1;
      }
    }
  }

  return count;
}

export function hasNonDeclarationReferences(
  languageService: ts.LanguageService,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  allowedFiles?: Set<string>,
): boolean {
  return countNonDeclarationReferences(languageService, sourceFile, node, allowedFiles) > 0;
}

interface ReferenceUsageSummary {
  references: number;
  reads: number;
  writes: number;
}

export function summarizeReferenceUsage(
  languageService: ts.LanguageService,
  program: ts.Program,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  allowedFiles?: Set<string>,
): ReferenceUsageSummary {
  const references = languageService.findReferences(sourceFile.fileName, node.getStart(sourceFile)) ?? [];
  const summary: ReferenceUsageSummary = {
    references: 0,
    reads: 0,
    writes: 0,
  };

  for (const group of references) {
    for (const reference of group.references) {
      if (!isAllowedReference(reference, allowedFiles)) {
        continue;
      }
      if (reference.fileName === sourceFile.fileName && isDeclarationReference(reference, node.getStart(sourceFile))) {
        continue;
      }

      summary.references += 1;
      const referenceSourceFile = program.getSourceFile(reference.fileName);
      const referenceNode = referenceSourceFile
        ? findNodeAtPosition(referenceSourceFile, reference.textSpan.start)
        : undefined;

      if (
        referenceNode &&
        ts.isBinaryExpression(referenceNode.parent) &&
        referenceNode.parent.left === referenceNode
      ) {
        if (referenceNode.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          summary.writes += 1;
        } else {
          summary.reads += 1;
          summary.writes += 1;
        }
        continue;
      }

      if (
        referenceNode &&
        (ts.isPrefixUnaryExpression(referenceNode.parent) || ts.isPostfixUnaryExpression(referenceNode.parent))
      ) {
        summary.reads += 1;
        summary.writes += 1;
        continue;
      }

      summary.reads += 1;
    }
  }

  return summary;
}
