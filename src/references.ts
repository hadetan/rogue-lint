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

export function summarizeNonDeclarationReferences(
  languageService: ts.LanguageService,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  allowedFiles?: Set<string>,
): {
  references: number;
  sameFileReferences: number;
  crossFileReferences: number;
} {
  const references = languageService.findReferences(sourceFile.fileName, node.getStart(sourceFile)) ?? [];
  const summary = {
    references: 0,
    sameFileReferences: 0,
    crossFileReferences: 0,
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
      if (reference.fileName === sourceFile.fileName) {
        summary.sameFileReferences += 1;
      } else {
        summary.crossFileReferences += 1;
      }
    }
  }

  return summary;
}

export function hasNonDeclarationReferences(
  languageService: ts.LanguageService,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  allowedFiles?: Set<string>,
): boolean {
  return summarizeNonDeclarationReferences(languageService, sourceFile, node, allowedFiles).references > 0;
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
