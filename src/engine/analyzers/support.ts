import ts from "typescript";

import type { AuditRecord, EntityRecord, EntityKind, ProjectContext } from "../../types.js";
import { summarizeNonDeclarationReferences, summarizeReferenceUsage } from "../../references.js";
import { getDeclarationNameNode, getNodeName } from "../../compiler/ast-utils.js";
import { makeEntity } from "../../shared/entity-utils.js";

/**
 * Shared reference caches used by multiple low-coupling analyzer stages in one run.
 */
export interface ReferenceCaches {
  hasReference: Map<string, boolean>;
  exportReferences: Map<string, ReturnType<typeof summarizeNonDeclarationReferences>>;
  usage: Map<string, ReturnType<typeof summarizeReferenceUsage>>;
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

/**
 * Collects exported entity ids that should be preserved in library mode as package-facing surface.
 *
 * Only package entrypoints participate here. Bin roots remain reachable roots, but their exports are not
 * automatically promoted to public API.
 */
export function collectPublicSurfaceIds(project: ProjectContext, entrypoints: string[]): Set<string> {
  if (project.config.value.mode !== "library") {
    return new Set<string>();
  }

  const ids = new Set<string>();

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
      const underlying = exportedSymbol.flags & ts.SymbolFlags.Alias
        ? project.checker.getAliasedSymbol(exportedSymbol)
        : exportedSymbol;

      for (const declaration of underlying.declarations ?? []) {
        const nameNode = getDeclarationNameNode(declaration);
        const name = getNodeName(declaration);
        if (!nameNode || !name) {
          continue;
        }

        ids.add(makeEntity(project.rootPath, "export", declaration.getSourceFile(), nameNode, name).id);
        ids.add(makeEntity(project.rootPath, "type", declaration.getSourceFile(), nameNode, name).id);
      }
    }
  }

  return ids;
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
