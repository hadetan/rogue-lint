import ts from "typescript";

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind))
    : false;
}

export function getDeclarationNameNode(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name;
  }

  if (ts.isVariableDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name : undefined;
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isEnumMember(node)
  ) {
    return node.name;
  }

  return undefined;
}

export function getNodeName(node: ts.Node): string | undefined {
  const nameNode = getDeclarationNameNode(node);
  if (!nameNode) {
    return undefined;
  }

  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }

  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }

  return undefined;
}

export function isReadLikeUse(node: ts.Node): boolean {
  const parent = node.parent;

  if (!parent) {
    return true;
  }

  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return false;
  }

  if (
    (ts.isPrefixUnaryExpression(parent)
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))
    || (ts.isPostfixUnaryExpression(parent)
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))
    || ts.isDeleteExpression(parent)
  ) {
    return false;
  }

  return true;
}

export function getSymbolKey(symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.[0];
  if (declaration) {
    return `${declaration.getSourceFile().fileName.split("\\").join("/")}:${declaration.getStart()}:${String(symbol.escapedName)}`;
  }

  return String(symbol.escapedName);
}
