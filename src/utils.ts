import path from "node:path";
import { Minimatch } from "minimatch";
import ts from "typescript";

import type { EntityKind, EntityRecord, FindingKind, Location } from "./types.js";

export function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

export function toRelative(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath);
  return normalizeSlashes(relative || ".");
}

export function createEntityId(
  kind: EntityKind,
  file: string,
  position: number,
  name: string,
): string {
  return `${kind}:${normalizeSlashes(file)}:${position}:${name}`;
}

export function toLocation(
  rootPath: string,
  sourceFile: ts.SourceFile,
  position: number,
): Location {
  const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    file: toRelative(rootPath, sourceFile.fileName),
    line: lineAndCharacter.line + 1,
    column: lineAndCharacter.character + 1,
  };
}

export function makeEntity(
  rootPath: string,
  kind: EntityKind,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  owner?: string,
): EntityRecord {
  return {
    id: createEntityId(kind, toRelative(rootPath, sourceFile.fileName), node.getStart(sourceFile), name),
    kind,
    name,
    owner,
    location: toLocation(rootPath, sourceFile, node.getStart(sourceFile)),
  };
}

export function matchesPatterns(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Minimatch(pattern, { dot: true }).match(value));
}

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

  if (ts.isBinaryExpression(parent) && parent.left === node) {
    if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return false;
    }
  }

  if (
    ts.isPrefixUnaryExpression(parent) ||
    ts.isPostfixUnaryExpression(parent) ||
    ts.isDeleteExpression(parent)
  ) {
    return false;
  }

  return true;
}

export function kindToFinding(kind: EntityKind): FindingKind | undefined {
  switch (kind) {
    case "file":
      return "unused-file";
    case "export":
      return "unused-export";
    case "local":
      return "unused-local";
    case "type":
      return "unused-type";
    case "enum-member":
      return "unused-enum-member";
    case "class-member":
      return "unused-class-member";
    case "object-key":
      return "unused-object-key";
    case "nested-path":
      return "unused-nested-path";
    default:
      return undefined;
  }
}

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

export function getVersion(): string {
  return "0.0.1";
}

export function getSymbolKey(symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.[0];
  if (declaration) {
    return `${normalizeSlashes(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${String(symbol.escapedName)}`;
  }

  return String(symbol.escapedName);
}
