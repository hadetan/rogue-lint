import path from "node:path";

import ts from "typescript";

import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "./module-graph.js";
import { loadProject } from "./project.js";
import {
  hasNonDeclarationReferences,
  summarizeReferenceUsage,
} from "./references.js";
import { buildSuppressionContext, getSuppressionAudit } from "./suppressions.js";
import type {
  AnalysisResult,
  AuditRecord,
  CliOptions,
  DiagnosticRecord,
  EntityKind,
  EntityRecord,
  FindingKind,
  FindingRecord,
  ProjectContext,
  TrackedObject,
} from "./types.js";
import {
  getDeclarationNameNode,
  getNodeName,
  isReadLikeUse,
  getSymbolKey,
  getVersion,
  hasModifier,
  kindToFinding,
  makeEntity,
  toRelative,
  uniqueById,
} from "./utils.js";

interface AnalysisState {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
  diagnostics: DiagnosticRecord[];
}

interface ReferenceCaches {
  hasReference: Map<string, boolean>;
  usage: Map<string, ReturnType<typeof summarizeReferenceUsage>>;
}

interface AnalysisStage {
  enabled: boolean;
  run: () => void;
}

type ValueAccessKind = "write" | "read" | "read-write" | "escape";

interface ValueAccess {
  entity: EntityRecord;
  position: number;
  kind: ValueAccessKind;
  declarationWrite: boolean;
  nestedWrite: boolean;
  escapeReason?: string;
}

interface TrackedObjectBinding {
  trackedObject: TrackedObject;
  prefix: string[];
}

interface ForwardedParameterBinding {
  index: number;
  paramSymbolKey: string;
  binding: TrackedObjectBinding;
}

function createState(): AnalysisState {
  return {
    findings: [],
    kept: [],
    skipped: [],
    diagnostics: [],
  };
}

function isDeepAnalysisEnabled(project: ProjectContext): boolean {
  return project.config.value.analysisDepth === "deep";
}

function getFunctionDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current)) {
      depth += 1;
    }
    current = current.parent;
  }
  return depth;
}

function addFinding(
  state: AnalysisState,
  entity: EntityRecord,
  kind: FindingKind,
  reason: string,
  message: string,
): void {
  state.findings.push({
    id: entity.id,
    kind,
    entity,
    reason,
    message,
    suggestion: "remove",
  });
}

function addAudit(target: AuditRecord[], record: AuditRecord | undefined): boolean {
  if (!record) {
    return false;
  }

  target.push(record);
  return true;
}

function createReferenceKey(sourceFile: ts.SourceFile, node: ts.Node): string {
  return `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
}

function buildFileEntity(project: ProjectContext, sourceFile: ts.SourceFile): EntityRecord {
  return {
    id: `file:${toRelative(project.rootPath, sourceFile.fileName)}`,
    kind: "file",
    name: path.basename(sourceFile.fileName),
    location: {
      file: toRelative(project.rootPath, sourceFile.fileName),
      line: 1,
      column: 1,
    },
  };
}

function collectPublicSurfaceIds(project: ProjectContext, entrypoints: string[]): Set<string> {
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

function findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (position < node.getFullStart() || position > node.getEnd()) {
      return undefined;
    }

    return ts.forEachChild(node, visit) ?? node;
  };

  return visit(sourceFile);
}

function analyzeUnusedFiles(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const entity = buildFileEntity(project, sourceFile);
    const suppression = getSuppressionAudit(project, suppressionContext, entity);
    if (addAudit(state.kept, suppression)) {
      continue;
    }

    addFinding(
      state,
      entity,
      "unused-file",
      "file is unreachable from configured entrypoints",
      `Unused file ${entity.location.file}`,
    );
  }
}

function collectExportCandidates(project: ProjectContext, sourceFile: ts.SourceFile): Array<{
  entity: EntityRecord;
  node: ts.Node;
  exportedKind: EntityKind;
}> {
  const candidates = new Map<string, { entity: EntityRecord; node: ts.Node; exportedKind: EntityKind }>();

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
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

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
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
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
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

function analyzeUnusedExports(
  project: ProjectContext,
  reachableFiles: Set<string>,
  publicSurfaceIds: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
  caches: ReferenceCaches,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    for (const candidate of collectExportCandidates(project, sourceFile)) {
      const keepReason =
        publicSurfaceIds.has(candidate.entity.id)
          ? {
              id: candidate.entity.id,
              kind: candidate.entity.kind,
              name: candidate.entity.name,
              reason: "kept as public library surface",
              location: candidate.entity.location,
            }
          : getSuppressionAudit(project, suppressionContext, candidate.entity, candidate.node);

      if (addAudit(state.kept, keepReason)) {
        continue;
      }

      const cacheKey = createReferenceKey(sourceFile, candidate.node);
      let hasReferences = caches.hasReference.get(cacheKey);
      if (hasReferences === undefined) {
        hasReferences = hasNonDeclarationReferences(
          project.languageService,
          sourceFile,
          candidate.node,
          project.analyzableFiles,
        );
        caches.hasReference.set(cacheKey, hasReferences);
      }

      if (hasReferences) {
        continue;
      }

      const findingKind = kindToFinding(candidate.exportedKind);
      if (!findingKind) {
        continue;
      }

      addFinding(
        state,
        candidate.entity,
        findingKind,
        "exported declaration has no non-declaration references",
        `Unused exported ${candidate.entity.name}`,
      );
    }
  }
}

function analyzeUnusedLocals(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    for (const diagnostic of project.program.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.code !== 6133 || !diagnostic.file || diagnostic.start === undefined) {
        continue;
      }

      const node = findNodeAtPosition(diagnostic.file, diagnostic.start);
      const declarationNode = node ? ts.findAncestor(node, (candidate) => Boolean(getDeclarationNameNode(candidate))) : undefined;
      const nameNode = declarationNode ? getDeclarationNameNode(declarationNode) : node;
      const name = declarationNode ? getNodeName(declarationNode) : node?.getText(sourceFile);

      if (!nameNode || !name) {
        continue;
      }

      const entity = makeEntity(project.rootPath, "local", sourceFile, nameNode, name);
      const suppression = getSuppressionAudit(project, suppressionContext, entity, declarationNode ?? nameNode);
      if (addAudit(state.kept, suppression)) {
        continue;
      }

      addFinding(
        state,
        entity,
        "unused-local",
        "TypeScript semantic diagnostics reported this declaration as unused",
        diagnostic.messageText.toString(),
      );
    }
  }
}

function analyzeClassMembers(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
  caches: ReferenceCaches,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classHasDecorators = ts.canHaveDecorators(node)
          ? Boolean(ts.getDecorators(node)?.length)
          : false;

        for (const member of node.members) {
          const memberName = getNodeName(member);
          const memberNameNode = getDeclarationNameNode(member);
          if (!memberName || !memberNameNode) {
            continue;
          }

          const entity = makeEntity(
            project.rootPath,
            "class-member",
            sourceFile,
            memberNameNode,
            memberName,
            className,
          );

          const suppression = getSuppressionAudit(project, suppressionContext, entity, member);
          if (addAudit(state.kept, suppression)) {
            continue;
          }

          const memberHasDecorators = ts.canHaveDecorators(member)
            ? Boolean(ts.getDecorators(member)?.length)
            : false;

          if (classHasDecorators || memberHasDecorators) {
            state.skipped.push({
              id: entity.id,
              kind: entity.kind,
              name: entity.name,
              reason: "member skipped because decorators can make it externally visible",
              location: entity.location,
            });
            continue;
          }

          if (ts.isPropertyDeclaration(member) && member.name && ts.isComputedPropertyName(member.name)) {
            state.skipped.push({
              id: entity.id,
              kind: entity.kind,
              name: entity.name,
              reason: "member skipped because computed property names are dynamic",
              location: entity.location,
            });
            continue;
          }

          const cacheKey = createReferenceKey(sourceFile, memberNameNode);
          const usage =
            caches.usage.get(cacheKey) ??
            summarizeReferenceUsage(
              project.languageService,
              project.program,
              sourceFile,
              memberNameNode,
              project.analyzableFiles,
            );
          caches.usage.set(cacheKey, usage);

          if (usage.reads > 0) {
            continue;
          }

          addFinding(
            state,
            entity,
            "unused-class-member",
            usage.writes > 0
              ? "eligible class member is written but never read"
              : "eligible class member has no non-declaration references",
            `Unused class member ${className}.${memberName}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}

function analyzeInterfaceMembers(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
  caches: ReferenceCaches,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name) {
        const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        if (project.config.value.mode === "library" && isExported) {
          return ts.forEachChild(node, visit);
        }

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
          const suppression = getSuppressionAudit(project, suppressionContext, entity, member);
          if (addAudit(state.kept, suppression)) {
            continue;
          }

          const cacheKey = createReferenceKey(sourceFile, memberNameNode);
          let hasReferences = caches.hasReference.get(cacheKey);
          if (hasReferences === undefined) {
            hasReferences = hasNonDeclarationReferences(
              project.languageService,
              sourceFile,
              memberNameNode,
              project.analyzableFiles,
            );
            caches.hasReference.set(cacheKey, hasReferences);
          }

          if (hasReferences) {
            continue;
          }

          addFinding(
            state,
            entity,
            "unused-interface-member",
            "eligible interface member has no non-declaration references",
            `Unused interface member ${node.name.text}.${memberName}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}

function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent)
    && ts.isVariableStatement(node.parent.parent)
    && hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword);
}

function isTrackablePureExpression(expression: ts.Expression): boolean {
  if (
    ts.isNumericLiteral(expression)
    || ts.isStringLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword
    || expression.kind === ts.SyntaxKind.BigIntLiteral
    || ts.isIdentifier(expression)
  ) {
    return true;
  }

  if (ts.isParenthesizedExpression(expression)) {
    return isTrackablePureExpression(expression.expression);
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    return ![
      ts.SyntaxKind.PlusPlusToken,
      ts.SyntaxKind.MinusMinusToken,
      ts.SyntaxKind.DeleteKeyword,
    ].includes(expression.operator)
      && isTrackablePureExpression(expression.operand);
  }

  if (ts.isConditionalExpression(expression)) {
    return isTrackablePureExpression(expression.condition)
      && isTrackablePureExpression(expression.whenTrue)
      && isTrackablePureExpression(expression.whenFalse);
  }

  if (ts.isBinaryExpression(expression)) {
    const disallowedOperators = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
      ts.SyntaxKind.CommaToken,
    ]);
    return !disallowedOperators.has(expression.operatorToken.kind)
      && isTrackablePureExpression(expression.left)
      && isTrackablePureExpression(expression.right);
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every((element) =>
      !ts.isSpreadElement(element) && isTrackablePureExpression(element as ts.Expression),
    );
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return true;
      }
      if (ts.isPropertyAssignment(property)) {
        return isTrackablePureExpression(property.initializer);
      }
      return false;
    });
  }

  return false;
}

function getUnsupportedEscapeReason(node: ts.Identifier): string | undefined {
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }

  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    if ((parent.arguments ?? []).some((argument) => argument === node)) {
      return "value passed to unsupported call boundary";
    }
  }

  return undefined;
}

function analyzeValueLiveness(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const trackedBindings = new Map<
      string,
      { declaration: ts.Identifier; name: string; declarationDepth: number }
    >();
    const accesses = new Map<string, ValueAccess[]>();

    const pushAccess = (symbolKey: string, access: ValueAccess): void => {
      const entries = accesses.get(symbolKey) ?? [];
      entries.push(access);
      accesses.set(symbolKey, entries);
    };

    const trackBinding = (identifier: ts.Identifier): void => {
      const symbol = project.checker.getSymbolAtLocation(identifier);
      if (!symbol) {
        return;
      }

      trackedBindings.set(getSymbolKey(symbol), {
        declaration: identifier,
        name: identifier.text,
        declarationDepth: getFunctionDepth(identifier),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !isExportedVariableDeclaration(node)) {
        trackBinding(node.name);
        const symbol = project.checker.getSymbolAtLocation(node.name);
        if (symbol && node.initializer) {
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.name, node.name.text),
            position: node.name.getStart(sourceFile),
            kind: "write",
            declarationWrite: true,
            nestedWrite: false,
          });
        }
      }

      if (
        ts.isBinaryExpression(node)
        && ts.isIdentifier(node.left)
        && ts.isIdentifier(node.left)
      ) {
        const symbol = project.checker.getSymbolAtLocation(node.left);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (symbol && tracked) {
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.left, tracked.name),
            position: node.left.getStart(sourceFile),
            kind: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "write" : "read-write",
            declarationWrite: false,
            nestedWrite: getFunctionDepth(node) > tracked.declarationDepth,
          });
        }
      }

      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
        const symbol = project.checker.getSymbolAtLocation(node.operand);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (
          symbol
          && tracked
          && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.operand, tracked.name),
            position: node.operand.getStart(sourceFile),
            kind: "read-write",
            declarationWrite: false,
            nestedWrite: getFunctionDepth(node) > tracked.declarationDepth,
          });
        }
      }

      if (ts.isExpressionStatement(node) && isTrackablePureExpression(node.expression)) {
        const entity = makeEntity(
          project.rootPath,
          "expression",
          sourceFile,
          node.expression,
          node.expression.getText(sourceFile),
        );
        const suppression = getSuppressionAudit(project, suppressionContext, entity, node.expression);
        if (addAudit(state.kept, suppression)) {
          return ts.forEachChild(node, visit);
        }

        addFinding(
          state,
          entity,
          "unused-value",
          "side-effect-neutral expression result is discarded",
          `Unused value ${entity.name}`,
        );
      }

      if (ts.isIdentifier(node)) {
        const symbol = project.checker.getSymbolAtLocation(node);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (!symbol || !tracked || tracked.declaration === node) {
          return ts.forEachChild(node, visit);
        }

        if (
          (ts.isBinaryExpression(node.parent) && node.parent.left === node)
          || ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
            && node.parent.operand === node)
        ) {
          return ts.forEachChild(node, visit);
        }

        const symbolKey = getSymbolKey(symbol);
        const escapeReason = getUnsupportedEscapeReason(node);
        if (escapeReason) {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "escape",
            declarationWrite: false,
            nestedWrite: false,
            escapeReason,
          });
          return ts.forEachChild(node, visit);
        }

        if (isReadLikeUse(node)) {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "read",
            declarationWrite: false,
            nestedWrite: false,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    for (const [symbolKey, symbolAccesses] of accesses) {
      const binding = trackedBindings.get(symbolKey);
      if (!binding) {
        continue;
      }

      const ordered = symbolAccesses.sort((left, right) => left.position - right.position);
      let pendingWrite: ValueAccess | undefined;
      let hasAnyRead = false;

      for (const access of ordered) {
        if (access.kind === "read" || access.kind === "read-write") {
          hasAnyRead = true;
        }

        if (access.kind === "write" || access.kind === "read-write") {
          if (pendingWrite) {
            const suppression = getSuppressionAudit(
              project,
              suppressionContext,
              pendingWrite.entity,
              binding.declaration,
            );
            if (!addAudit(state.kept, suppression)) {
              addFinding(
                state,
                pendingWrite.entity,
                "dead-store",
                "assigned value is overwritten before any supported read occurs",
                `Dead store for ${binding.name}`,
              );
            }
          }
          pendingWrite = access;
          if (access.kind === "read-write") {
            hasAnyRead = true;
            pendingWrite = undefined;
          }
          continue;
        }

        if (access.kind === "read") {
          pendingWrite = undefined;
          continue;
        }

        if (access.kind === "escape" && pendingWrite) {
          state.skipped.push({
            id: pendingWrite.entity.id,
            kind: pendingWrite.entity.kind,
            name: pendingWrite.entity.name,
            reason: access.escapeReason ?? "value escaped exact analysis",
            location: pendingWrite.entity.location,
          });
          pendingWrite = undefined;
        }
      }

      if (pendingWrite && pendingWrite.nestedWrite && !hasAnyRead) {
        const suppression = getSuppressionAudit(
          project,
          suppressionContext,
          pendingWrite.entity,
          binding.declaration,
        );
        if (!addAudit(state.kept, suppression)) {
          addFinding(
            state,
            pendingWrite.entity,
            "write-only-state",
            "outer-scope write never becomes observable through a supported read",
            `Write-only state for ${binding.name}`,
          );
        }
      }
    }
  }
}

function addTrackedObjectNode(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  rootName: string,
  owner: string,
  segments: string[],
  maxDepth: number,
): void {
  if (segments.length > maxDepth) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        markEscaped(trackedObject, segments, "object spread introduces opaque properties");
        continue;
      }

      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }

      const propertyName = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;

      if (!propertyName) {
        markEscaped(trackedObject, segments, "computed property names are not eligible for exact analysis");
        continue;
      }

      const fullPath = [...segments, propertyName];
      const joinedPath = fullPath.join(".");
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? "object-key" : "nested-path",
        sourceFile,
        property.name,
        fullPath.length === 1 ? propertyName : joinedPath,
        owner,
      );
      trackedObject.nodes.set(joinedPath, { entity, fullPath });

      const initializer = ts.isShorthandPropertyAssignment(property) ? undefined : property.initializer;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, rootName, owner, fullPath, maxDepth);
      }
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, rootName, owner, fullPath, maxDepth);
      }
    }
  } else {
    node.elements.forEach((element, index) => {
      if (!element || ts.isSpreadElement(element)) {
        markEscaped(trackedObject, segments, "array spread introduces opaque values");
        return;
      }

      const fullPath = [...segments, String(index)];
      const joinedPath = fullPath.join(".");
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? "object-key" : "nested-path",
        sourceFile,
        element,
        joinedPath,
        owner,
      );
      trackedObject.nodes.set(joinedPath, { entity, fullPath });

      if (ts.isObjectLiteralExpression(element)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, element, rootName, owner, fullPath, maxDepth);
      }
      if (ts.isArrayLiteralExpression(element)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, element, rootName, owner, fullPath, maxDepth);
      }
    });
  }
}

function getRootIdentifier(node: ts.Node): ts.Identifier | undefined {
  if (ts.isIdentifier(node)) {
    return node;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return getRootIdentifier(node.expression);
  }
  return undefined;
}

function getAccessPath(node: ts.Node): { root: ts.Identifier; segments: string[]; dynamic: boolean } | undefined {
  if (ts.isIdentifier(node)) {
    return { root: node, segments: [], dynamic: false };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    return { root: nested.root, segments: [...nested.segments, node.name.text], dynamic: nested.dynamic };
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        root: nested.root,
        segments: [...nested.segments, node.argumentExpression.text],
        dynamic: nested.dynamic,
      };
    }
    return { root: nested.root, segments: nested.segments, dynamic: true };
  }

  return undefined;
}

function markRead(trackedObject: TrackedObject, segments: string[]): void {
  for (let index = 1; index <= segments.length; index += 1) {
    trackedObject.reads.add(segments.slice(0, index).join("."));
  }
}

function markWrite(trackedObject: TrackedObject, segments: string[]): void {
  trackedObject.writes.add(segments.join("."));
}

function markEscaped(trackedObject: TrackedObject, segments: string[], reason: string): void {
  trackedObject.escapedPaths.set(segments.join("."), reason);
}

function getEscapedReason(trackedObject: TrackedObject, segments: string[]): string | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const key = segments.slice(0, index).join(".");
    const reason = trackedObject.escapedPaths.get(key);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function getForwardedParameterBindings(
  project: ProjectContext,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
): ForwardedParameterBinding[] {
  if (!ts.isIdentifier(node.expression)) {
    return [];
  }

  const calleeSymbol = project.checker.getSymbolAtLocation(node.expression);
  const declaration = calleeSymbol?.declarations?.[0];
  if (
    !declaration
    || (!ts.isFunctionDeclaration(declaration)
      && !ts.isFunctionExpression(declaration)
      && !ts.isArrowFunction(declaration))
  ) {
    return [];
  }

  if (!declaration.getSourceFile().fileName.startsWith(project.rootPath)) {
    return [];
  }

  const forwarded: ForwardedParameterBinding[] = [];

  node.arguments.forEach((argument, index) => {
    const parameter = declaration.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return;
    }

    const accessPath = getAccessPath(argument);
    if (!accessPath || accessPath.dynamic) {
      return;
    }

    const sourceSymbol = project.checker.getSymbolAtLocation(accessPath.root);
    const existing = sourceSymbol ? trackedBySymbolId.get(getSymbolKey(sourceSymbol)) : undefined;
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    if (!existing || !parameterSymbol) {
      return;
    }

    forwarded.push({
      index,
      paramSymbolKey: getSymbolKey(parameterSymbol),
      binding: {
        trackedObject: existing.trackedObject,
        prefix: [...existing.prefix, ...accessPath.segments],
      },
    });
  });

  return forwarded;
}

function isAssignmentLeft(node: ts.Node): boolean {
  return ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function buildTrackedObjects(
  project: ProjectContext,
  reachableFiles: Set<string>,
): Map<string, TrackedObjectBinding> {
  const trackedBySymbolId = new Map<string, TrackedObjectBinding>();

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const symbol = project.checker.getSymbolAtLocation(node.name);
        if (!symbol) {
          return;
        }

        if (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer)) {
          const rootEntity = makeEntity(project.rootPath, "local", sourceFile, node.name, node.name.text);
          const trackedObject: TrackedObject = {
            id: rootEntity.id,
            rootName: node.name.text,
            sourceFile: sourceFile.fileName,
            rootEntity,
            nodes: new Map(),
            escapedPaths: new Map(),
            reads: new Set(),
            writes: new Set(),
          };
          addTrackedObjectNode(
            project,
            trackedObject,
            sourceFile,
            node.initializer,
            node.name.text,
              node.name.text,
              [],
              project.config.value.objectAnalysis.maxPathDepth,
            );
          trackedBySymbolId.set(getSymbolKey(symbol), {
            trackedObject,
            prefix: [],
          });
        } else {
          const accessPath = getAccessPath(node.initializer);
          if (accessPath && !accessPath.dynamic) {
            const sourceSymbol = project.checker.getSymbolAtLocation(accessPath.root);
            if (sourceSymbol) {
              const existing = trackedBySymbolId.get(getSymbolKey(sourceSymbol));
              if (existing) {
                trackedBySymbolId.set(getSymbolKey(symbol), {
                  trackedObject: existing.trackedObject,
                  prefix: [...existing.prefix, ...accessPath.segments],
                });
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        for (const forwarded of getForwardedParameterBindings(project, node, trackedBySymbolId)) {
          trackedBySymbolId.set(forwarded.paramSymbolKey, forwarded.binding);
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  return trackedBySymbolId;
}

function analyzeObjectPaths(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  if (!project.config.value.objectAnalysis.enabled) {
    return;
  }

  const trackedBySymbolId = buildTrackedObjects(project, reachableFiles);
  const trackedObjects = new Set<TrackedObject>(
    [...trackedBySymbolId.values()].map((binding) => binding.trackedObject),
  );

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer ?? ts.factory.createIdentifier(""))) {
        const target = project.checker.getSymbolAtLocation(node.name);
        const source = project.checker.getSymbolAtLocation(node.initializer as ts.Identifier);
        if (target && source) {
          const existing = trackedBySymbolId.get(getSymbolKey(source));
          if (existing) {
            trackedBySymbolId.set(getSymbolKey(target), existing);
          }
        }
      }

      if (ts.isReturnStatement(node) && node.expression) {
        const accessPath = getAccessPath(node.expression);
        if (accessPath && !accessPath.dynamic) {
          const symbol = project.checker.getSymbolAtLocation(accessPath.root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          if (tracked) {
            markEscaped(
              tracked.trackedObject,
              [...tracked.prefix, ...accessPath.segments],
              "returned object escapes local analysis",
            );
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(sourceFile);
        const forwardedIndices = new Set(
          getForwardedParameterBindings(project, node, trackedBySymbolId).map((forwarded) => forwarded.index),
        );
        for (const [index, argument] of node.arguments.entries()) {
          const accessPath = getAccessPath(argument);
          if (!accessPath) {
            continue;
          }

          const symbol = project.checker.getSymbolAtLocation(accessPath.root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          if (!tracked) {
            continue;
          }

          const fullPath = [...tracked.prefix, ...accessPath.segments];
          if (accessPath.dynamic) {
            markEscaped(tracked.trackedObject, tracked.prefix, "computed property access prevents exact path analysis");
            continue;
          }

          if (
            calleeText === "Object.keys" ||
            calleeText === "Object.values" ||
            calleeText === "Object.entries" ||
            calleeText === "Reflect.ownKeys" ||
            calleeText === "JSON.stringify"
          ) {
            markEscaped(tracked.trackedObject, fullPath, `${calleeText} makes object properties externally observable`);
            continue;
          }

          if (forwardedIndices.has(index)) {
            continue;
          }

          markEscaped(
            tracked.trackedObject,
            fullPath,
            accessPath.segments.length === 0
              ? "object passed to call expression escapes exact local analysis"
              : "object path passed to call expression escapes exact local analysis",
          );
        }
      }

      if (ts.isSpreadElement(node)) {
        const root = getRootIdentifier(node.expression);
        const symbol = root ? project.checker.getSymbolAtLocation(root) : undefined;
        const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
        if (tracked) {
          markEscaped(tracked.trackedObject, tracked.prefix, "spread element escapes exact local analysis");
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const accessPath = getAccessPath(node);
        if (!accessPath) {
          return ts.forEachChild(node, visit);
        }

        const symbol = project.checker.getSymbolAtLocation(accessPath.root);
        const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
        if (!tracked) {
          return ts.forEachChild(node, visit);
        }

        const fullPath = [...tracked.prefix, ...accessPath.segments];
        if (accessPath.dynamic) {
          markEscaped(tracked.trackedObject, tracked.prefix, "computed property access prevents exact path analysis");
          return ts.forEachChild(node, visit);
        }

        if (fullPath.length === 0) {
          return ts.forEachChild(node, visit);
        }

        if (isAssignmentLeft(node)) {
          if (fullPath.length > 1) {
            markRead(tracked.trackedObject, fullPath.slice(0, -1));
          }
          markWrite(tracked.trackedObject, fullPath);
        } else {
          markRead(tracked.trackedObject, fullPath);
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        const symbol = project.checker.getSymbolAtLocation(node.initializer);
        const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
        if (!tracked) {
          return ts.forEachChild(node, visit);
        }

        for (const element of node.name.elements) {
          if (element.dotDotDotToken) {
            markEscaped(tracked.trackedObject, tracked.prefix, "object rest pattern escapes remaining properties");
            continue;
          }

          const keyNode = element.propertyName ?? element.name;
          if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
            markRead(tracked.trackedObject, [...tracked.prefix, keyNode.text]);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  for (const tracked of trackedObjects) {
    for (const [joinedPath, objectNode] of tracked.nodes) {
      const escapedReason = getEscapedReason(tracked, objectNode.fullPath);
      if (escapedReason) {
        state.skipped.push({
          id: objectNode.entity.id,
          kind: objectNode.entity.kind,
          name: objectNode.entity.name,
          reason: escapedReason,
          location: objectNode.entity.location,
        });
        continue;
      }

      const suppression = getSuppressionAudit(project, suppressionContext, objectNode.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }

      const hasRead = tracked.reads.has(joinedPath);
      const hasWrite = tracked.writes.has(joinedPath) || objectNode.fullPath.length >= 1;

      if (!hasRead && hasWrite) {
        const findingKind = objectNode.entity.kind === "object-key" ? "unused-object-key" : "unused-nested-path";
        addFinding(
          state,
          objectNode.entity,
          findingKind,
          "eligible object path is declared or written but never read",
          `Unused object path ${tracked.rootName}.${joinedPath}`,
        );
      }
    }
  }
}

export async function analyzeProject(cliOptions: CliOptions): Promise<AnalysisResult> {
  const project = loadProject(cliOptions);
  const state = createState();
  const suppressionContext = buildSuppressionContext(project);
  const graph = buildModuleGraph(project);
  const entrypointDiscovery = discoverEntrypoints(project);
  const reachableFiles = computeReachableFiles(entrypointDiscovery.entrypoints, graph);
  const publicSurfaceIds = collectPublicSurfaceIds(project, entrypointDiscovery.entrypoints);
  const caches: ReferenceCaches = {
    hasReference: new Map(),
    usage: new Map(),
  };

  state.diagnostics.push(...entrypointDiscovery.diagnostics);
  state.diagnostics.push(...graph.unresolved);

  const stages: AnalysisStage[] = [
    {
      enabled: true,
      run: () => analyzeUnusedFiles(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: true,
      run: () =>
        analyzeUnusedExports(project, reachableFiles, publicSurfaceIds, state, suppressionContext, caches),
    },
    {
      enabled: true,
      run: () => analyzeUnusedLocals(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: isDeepAnalysisEnabled(project),
      run: () => analyzeValueLiveness(project, reachableFiles, state, suppressionContext),
    },
    {
      enabled: isDeepAnalysisEnabled(project),
      run: () => analyzeInterfaceMembers(project, reachableFiles, state, suppressionContext, caches),
    },
    {
      enabled: isDeepAnalysisEnabled(project),
      run: () => analyzeClassMembers(project, reachableFiles, state, suppressionContext, caches),
    },
    {
      enabled: isDeepAnalysisEnabled(project),
      run: () => analyzeObjectPaths(project, reachableFiles, state, suppressionContext),
    },
  ];

  for (const stage of stages) {
    if (stage.enabled) {
      stage.run();
    }
  }

  const includeKinds = project.config.value.includeKinds;
  const filteredFindings =
    includeKinds.length > 0
      ? state.findings.filter((finding) => includeKinds.includes(finding.kind))
      : state.findings;

  const findings = uniqueById(filteredFindings);
  const kept = uniqueById(state.kept);
  const skipped = uniqueById(state.skipped);
  const diagnostics = uniqueById(
    state.diagnostics.map((diagnostic, index) => ({ ...diagnostic, id: `${diagnostic.kind}:${index}` })),
  ).map(({ id: _id, ...diagnostic }) => diagnostic);

  const byKind: Partial<Record<FindingKind, number>> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

  return {
    tool: "dead-lint",
    version: getVersion(),
    target: project.rootPath,
    mode: project.config.value.mode,
    exitCodes: {
      findings: project.config.value.findingsExitCode,
      failure: project.config.value.failureExitCode,
    },
    generatedAt: new Date().toISOString(),
    summary: {
      filesAnalyzed: project.sourceFiles.length,
      reachableFiles: reachableFiles.size,
      findings: findings.length,
      kept: kept.length,
      skipped: skipped.length,
      byKind,
    },
    findings,
    kept,
    skipped,
    diagnostics,
  };
}
