import ts from "typescript";

import type { AuditRecord, EntityRecord, EntityKind, ProjectContext } from "../../types.js";
import { summarizeNonDeclarationReferences, summarizeReferenceUsage } from "../../references.js";
import { getDeclarationNameNode, getNodeName, getSymbolKey } from "../../compiler/ast-utils.js";
import { makeEntity } from "../../shared/entity-utils.js";

/**
 * Shared reference caches used by multiple low-coupling analyzer stages in one run.
 */
export interface ReferenceCaches {
  hasReference: Map<string, boolean>;
  exportReferences: Map<string, ReturnType<typeof summarizeNonDeclarationReferences>>;
  usage: Map<string, ReturnType<typeof summarizeReferenceUsage>>;
}

interface PublicSurface {
  ids: Set<string>;
  callableIds: Set<string>;
}

function getCanonicalPublicSurfaceSymbol(project: ProjectContext, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const visited = new Set<string>();

  while (current.flags & ts.SymbolFlags.Alias) {
    const symbolKey = getSymbolKey(current);
    if (visited.has(symbolKey)) {
      break;
    }
    visited.add(symbolKey);

    const aliased = project.checker.getAliasedSymbol(current);
    if (!aliased || aliased === current) {
      break;
    }

    current = aliased;
  }

  return current;
}

function getCanonicalPublicSurfaceSymbolKey(project: ProjectContext, symbol: ts.Symbol): string {
  return getSymbolKey(getCanonicalPublicSurfaceSymbol(project, symbol));
}

function isExternallyVisibleClassMember(member: ts.ClassElement): boolean {
  if (!member.name) {
    return false;
  }

  if (ts.isPrivateIdentifier(member.name)) {
    return false;
  }

  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) {
    return false;
  }

  return true;
}

/**
 * Creates a stable cache key for per-node reference lookups.
 */
export function createReferenceKey(sourceFile: ts.SourceFile, node: ts.Node): string {
  return `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
}

/**
 * Builds the audit entry used when a declaration stays live only because it belongs to the package surface.
 */
export function buildPublicSurfaceAudit(entity: EntityRecord): AuditRecord {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    reason: "kept as public package surface",
    location: entity.location,
  };
}

function addEnumMemberIds(project: ProjectContext, ids: Set<string>, declaration: ts.EnumDeclaration, owner: string): void {
  for (const member of declaration.members) {
    const memberNameNode = getDeclarationNameNode(member);
    const memberName = getNodeName(member);
    if (!memberNameNode || !memberName) {
      continue;
    }

    ids.add(
      makeEntity(
        project.rootPath,
        "enum-member",
        declaration.getSourceFile(),
        memberNameNode,
        memberName,
        owner,
      ).id,
    );
  }
}

function addCallableIdFromDeclaration(
  project: ProjectContext,
  callableIds: Set<string>,
  declaration: ts.Declaration,
): void {
  if (ts.isFunctionDeclaration(declaration) && declaration.name) {
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    if (symbol) {
      callableIds.add(getCanonicalPublicSurfaceSymbolKey(project, symbol));
    }
    return;
  }

  if (
    (ts.isMethodDeclaration(declaration)
      || ts.isGetAccessorDeclaration(declaration)
      || ts.isSetAccessorDeclaration(declaration))
    && !ts.isPrivateIdentifier(declaration.name)
  ) {
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    if (symbol) {
      callableIds.add(getCanonicalPublicSurfaceSymbolKey(project, symbol));
    }
    return;
  }

  if (
    ts.isVariableDeclaration(declaration)
    && ts.isIdentifier(declaration.name)
    && declaration.initializer
    && (
      ts.isFunctionExpression(declaration.initializer)
      || ts.isArrowFunction(declaration.initializer)
      || (
        ts.isConditionalExpression(declaration.initializer)
        && (
          ts.isFunctionExpression(declaration.initializer.whenFalse)
          || ts.isArrowFunction(declaration.initializer.whenFalse)
        )
      )
    )
  ) {
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    if (symbol) {
      callableIds.add(getCanonicalPublicSurfaceSymbolKey(project, symbol));
    }
  }
}

function addClassMemberIds(
  project: ProjectContext,
  ids: Set<string>,
  callableIds: Set<string>,
  declaration: ts.ClassDeclaration,
  owner: string,
): void {
  for (const member of declaration.members) {
    const memberNameNode = getDeclarationNameNode(member);
    const memberName = getNodeName(member);
    if (!memberNameNode || !memberName || !isExternallyVisibleClassMember(member)) {
      continue;
    }

    ids.add(
      makeEntity(
        project.rootPath,
        "class-member",
        declaration.getSourceFile(),
        memberNameNode,
        memberName,
        owner,
      ).id,
    );

    addCallableIdFromDeclaration(project, callableIds, member);
  }
}

function addDeclarationIds(
  project: ProjectContext,
  ids: Set<string>,
  callableIds: Set<string>,
  declaration: ts.Declaration,
  name: string,
): void {
  const nameNode = getDeclarationNameNode(declaration);
  if (!nameNode) {
    return;
  }

  ids.add(makeEntity(project.rootPath, "export", declaration.getSourceFile(), nameNode, name).id);
  ids.add(makeEntity(project.rootPath, "type", declaration.getSourceFile(), nameNode, name).id);

  if (ts.isEnumDeclaration(declaration)) {
    addEnumMemberIds(project, ids, declaration, name);
  }

  if (ts.isClassDeclaration(declaration)) {
    addClassMemberIds(project, ids, callableIds, declaration, name);
  }
}

function unwrapTrackedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function collectPrototypeAliasClassDeclarations(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  classes: Map<string, ts.ClassDeclaration>,
  visitedSymbols: Set<string>,
  depth = 0,
): void {
  if (depth > 4) {
    return;
  }

  const current = unwrapTrackedExpression(expression);
  if (
    ts.isPropertyAccessExpression(current)
    && current.name.text === "prototype"
    && ts.isIdentifier(current.expression)
  ) {
    const classSymbol = project.checker.getSymbolAtLocation(current.expression);
    const classDeclaration = classSymbol?.declarations?.find(ts.isClassDeclaration);
    const className = classDeclaration ? getNodeName(classDeclaration) : undefined;
    if (classDeclaration && className) {
      classes.set(className, classDeclaration);
    }
    return;
  }

  if (!ts.isIdentifier(current)) {
    return;
  }

  const symbol = project.checker.getSymbolAtLocation(current);
  const underlying = symbol && (symbol.flags & ts.SymbolFlags.Alias)
    ? project.checker.getAliasedSymbol(symbol)
    : symbol;
  if (!underlying) {
    return;
  }

  const symbolKey = getSymbolKey(underlying);
  if (visitedSymbols.has(symbolKey)) {
    return;
  }
  visitedSymbols.add(symbolKey);

  for (const declaration of underlying.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration)
      && ts.isIdentifier(declaration.name)
      && declaration.initializer
      && declaration.getSourceFile() === sourceFile
    ) {
      collectPrototypeAliasClassDeclarations(
        project,
        sourceFile,
        declaration.initializer,
        classes,
        visitedSymbols,
        depth + 1,
      );
    }
  }
}

function collectFactoryPrototypeClassDeclarations(
  project: ProjectContext,
  declaration: ts.VariableDeclaration,
): ts.ClassDeclaration[] {
  if (!ts.isIdentifier(declaration.name)) {
    return [];
  }

  const exportedName = declaration.name.text;
  const classes = new Map<string, ts.ClassDeclaration>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === exportedName
      && node.left.name.text === "prototype"
    ) {
      collectPrototypeAliasClassDeclarations(
        project,
        declaration.getSourceFile(),
        node.right,
        classes,
        new Set<string>(),
      );
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(declaration.getSourceFile(), visit);
  return [...classes.values()];
}

function collectPublicSurfaceFromSymbol(
  project: ProjectContext,
  ids: Set<string>,
  callableIds: Set<string>,
  symbol: ts.Symbol,
  visited: Set<string>,
): void {
  const underlying = getCanonicalPublicSurfaceSymbol(project, symbol);
  const symbolKey = getSymbolKey(underlying);
  if (visited.has(symbolKey)) {
    return;
  }
  visited.add(symbolKey);

  let visitedNamedDeclaration = false;
  for (const declaration of underlying.declarations ?? []) {
    const name = getNodeName(declaration);
    if (name) {
      visitedNamedDeclaration = true;
      addDeclarationIds(project, ids, callableIds, declaration, name);
      addCallableIdFromDeclaration(project, callableIds, declaration);

      if (ts.isVariableDeclaration(declaration)) {
        for (const linkedClass of collectFactoryPrototypeClassDeclarations(project, declaration)) {
          const linkedClassName = getNodeName(linkedClass);
          if (!linkedClassName) {
            continue;
          }
          addClassMemberIds(project, ids, callableIds, linkedClass, linkedClassName);
        }
      }

      if (ts.isClassDeclaration(declaration)) {
        addClassMemberIds(project, ids, callableIds, declaration, name);
      }
    }
  }

  if (visitedNamedDeclaration) {
    return;
  }

  const moduleExports = project.checker.getExportsOfModule(underlying);
  for (const exportedSymbol of moduleExports) {
    collectPublicSurfaceFromSymbol(project, ids, callableIds, exportedSymbol, visited);
  }
}

export function collectPublicSurface(project: ProjectContext, entrypoints: string[]): PublicSurface {
  const ids = new Set<string>();
  const callableIds = new Set<string>();

  if (project.config.value.mode !== "library") {
    return { ids, callableIds };
  }

  const visitedSymbols = new Set<string>();

  for (const entrypoint of entrypoints) {
    const sourceFile = project.sourceFiles.find((candidate) => candidate.fileName === entrypoint);
    if (!sourceFile) {
      continue;
    }

    const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      continue;
    }

    for (const exportedSymbol of project.checker.getExportsOfModule(moduleSymbol)) {
      collectPublicSurfaceFromSymbol(project, ids, callableIds, exportedSymbol, visitedSymbols);
    }
  }

  return { ids, callableIds };
}

/**
 * Enumerates export-like declarations in a source file so unused-export analysis can reason about them uniformly.
 */
export function collectExportCandidates(project: ProjectContext, sourceFile: ts.SourceFile): Array<{
  entity: EntityRecord;
  node: ts.Node;
  exportedKind: EntityKind;
}> {
  const candidates = new Map<string, { entity: EntityRecord; node: ts.Node; exportedKind: EntityKind }>();

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement))
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const nameNode = getDeclarationNameNode(statement);
      const name = getNodeName(statement);
      if (!nameNode || !name) {
        continue;
      }
      const exportedKind: EntityKind =
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
          ? "type"
          : "export";

      const entity = makeEntity(project.rootPath, exportedKind, sourceFile, nameNode, name);
      candidates.set(entity.id, { entity, node: nameNode, exportedKind });

      if (ts.isEnumDeclaration(statement)) {
        for (const member of statement.members) {
          const memberName = getNodeName(member);
          const memberNameNode = getDeclarationNameNode(member);
          if (!memberName || !memberNameNode) {
            continue;
          }
          const memberEntity = makeEntity(
            project.rootPath,
            "enum-member",
            sourceFile,
            memberNameNode,
            memberName,
            name,
          );
          candidates.set(memberEntity.id, {
            entity: memberEntity,
            node: memberNameNode,
            exportedKind: "enum-member",
          });
        }
      }
    }

    if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        const nameNode = getDeclarationNameNode(declaration);
        const name = getNodeName(declaration);
        if (!nameNode || !name) {
          continue;
        }
        const entity = makeEntity(project.rootPath, "export", sourceFile, nameNode, name);
        candidates.set(entity.id, { entity, node: nameNode, exportedKind: "export" });
      }
    }

    if (
      ts.isExportDeclaration(statement)
      && !statement.moduleSpecifier
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName ?? element.name;
        const symbol = project.checker.getSymbolAtLocation(localName);
        const declaration = symbol?.declarations?.[0];
        const nameNode = declaration ? getDeclarationNameNode(declaration) : undefined;
        const name = declaration ? getNodeName(declaration) : undefined;
        if (!declaration || !nameNode || !name) {
          continue;
        }

        const exportedKind: EntityKind =
          ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
            ? "type"
            : "export";
        const entity = makeEntity(project.rootPath, exportedKind, sourceFile, nameNode, name);
        candidates.set(entity.id, { entity, node: nameNode, exportedKind });
      }
    }
  }

  return [...candidates.values()];
}
