import path from "node:path";

import ts from "typescript";

import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "./module-graph.js";
import { loadProject } from "./project.js";
import {
  countNonDeclarationReferences,
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

function createState(): AnalysisState {
  return {
    findings: [],
    kept: [],
    skipped: [],
    diagnostics: [],
  };
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
        hasReferences = hasNonDeclarationReferences(project.languageService, sourceFile, candidate.node);
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
        trackedObject.escaped = true;
        trackedObject.escapeReason = "object spread introduces opaque properties";
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
        trackedObject.escaped = true;
        trackedObject.escapeReason = "computed property names are not eligible for exact analysis";
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
        trackedObject.escaped = true;
        trackedObject.escapeReason = "array spread introduces opaque values";
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

function markEscaped(trackedObject: TrackedObject, reason: string): void {
  trackedObject.escaped = true;
  trackedObject.escapeReason ??= reason;
}

function isAssignmentLeft(node: ts.Node): boolean {
  return ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function buildTrackedObjects(
  project: ProjectContext,
  reachableFiles: Set<string>,
): Map<string, TrackedObject> {
  const trackedBySymbolId = new Map<string, TrackedObject>();

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
            escaped: false,
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
          trackedBySymbolId.set(getSymbolKey(symbol), trackedObject);
        } else if (ts.isIdentifier(node.initializer)) {
          const sourceSymbol = project.checker.getSymbolAtLocation(node.initializer);
          if (sourceSymbol) {
            const existing = trackedBySymbolId.get(getSymbolKey(sourceSymbol));
            if (existing) {
              trackedBySymbolId.set(getSymbolKey(symbol), existing);
            }
          }
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
  const trackedObjects = new Set<TrackedObject>(trackedBySymbolId.values());

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
        const root = getRootIdentifier(node.expression);
        if (root) {
          const symbol = project.checker.getSymbolAtLocation(root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          if (tracked) {
            markEscaped(tracked, "returned object escapes local analysis");
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = node.expression.getText(sourceFile);
        for (const argument of node.arguments) {
          const accessPath = getAccessPath(argument);
          if (!accessPath) {
            continue;
          }

          const symbol = project.checker.getSymbolAtLocation(accessPath.root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          if (!tracked) {
            continue;
          }

          if (accessPath.dynamic) {
            markEscaped(tracked, "computed property access prevents exact path analysis");
            continue;
          }

          if (
            calleeText === "Object.keys" ||
            calleeText === "Object.values" ||
            calleeText === "Object.entries" ||
            calleeText === "Reflect.ownKeys" ||
            calleeText === "JSON.stringify"
          ) {
            markEscaped(tracked, `${calleeText} makes object properties externally observable`);
            continue;
          }

          if (accessPath.segments.length === 0) {
            markEscaped(tracked, "object passed to call expression escapes exact local analysis");
          } else {
            markRead(tracked, accessPath.segments);
          }
        }
      }

      if (ts.isSpreadElement(node)) {
        const root = getRootIdentifier(node.expression);
        const symbol = root ? project.checker.getSymbolAtLocation(root) : undefined;
        const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
        if (tracked) {
          markEscaped(tracked, "spread element escapes exact local analysis");
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

        if (accessPath.dynamic) {
          markEscaped(tracked, "computed property access prevents exact path analysis");
          return ts.forEachChild(node, visit);
        }

        if (accessPath.segments.length === 0) {
          return ts.forEachChild(node, visit);
        }

        if (isAssignmentLeft(node)) {
          if (accessPath.segments.length > 1) {
            markRead(tracked, accessPath.segments.slice(0, -1));
          }
          markWrite(tracked, accessPath.segments);
        } else {
          markRead(tracked, accessPath.segments);
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
            markEscaped(tracked, "object rest pattern escapes remaining properties");
            continue;
          }

          const keyNode = element.propertyName ?? element.name;
          if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
            markRead(tracked, [keyNode.text]);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  for (const tracked of trackedObjects) {
    if (tracked.escaped) {
      for (const objectNode of tracked.nodes.values()) {
        state.skipped.push({
          id: objectNode.entity.id,
          kind: objectNode.entity.kind,
          name: objectNode.entity.name,
          reason: tracked.escapeReason ?? "object path escaped exact analysis",
          location: objectNode.entity.location,
        });
      }
      continue;
    }

    for (const [joinedPath, objectNode] of tracked.nodes) {
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

function collectEntityInventory(
  project: ProjectContext,
  reachableFiles: Set<string>,
): EntityRecord[] {
  const entities: EntityRecord[] = [];

  for (const sourceFile of project.sourceFiles) {
    entities.push(buildFileEntity(project, sourceFile));

    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      const nameNode = getDeclarationNameNode(node);
      const name = getNodeName(node);
      if (nameNode && name) {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isClassDeclaration(node)
        ) {
          entities.push(makeEntity(project.rootPath, "local", sourceFile, nameNode, name));
        } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
          entities.push(makeEntity(project.rootPath, "type", sourceFile, nameNode, name));
        } else if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
          const owner = ts.isInterfaceDeclaration(node.parent) && node.parent.name ? node.parent.name.text : undefined;
          entities.push(makeEntity(project.rootPath, "interface-member", sourceFile, nameNode, name, owner));
        } else if (
          ts.isMethodDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)
        ) {
          const owner = ts.isClassDeclaration(node.parent) && node.parent.name ? node.parent.name.text : undefined;
          entities.push(makeEntity(project.rootPath, "class-member", sourceFile, nameNode, name, owner));
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  return uniqueById(entities);
}

export async function analyzeProject(cliOptions: CliOptions): Promise<AnalysisResult> {
  const project = loadProject(cliOptions);
  const state = createState();
  const suppressionContext = buildSuppressionContext(project);
  const graph = buildModuleGraph(project);
  const entrypoints = discoverEntrypoints(project);
  const reachableFiles = computeReachableFiles(entrypoints, graph);
  const publicSurfaceIds = collectPublicSurfaceIds(project, entrypoints);
  const inventory = collectEntityInventory(project, reachableFiles);
  const caches: ReferenceCaches = {
    hasReference: new Map(),
    usage: new Map(),
  };

  state.diagnostics.push(...graph.unresolved);

  for (const entity of inventory) {
    if (entity.kind === "interface-member") {
      state.skipped.push({
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        reason: "interface members are inventoried but not yet eligible for exact dead-code reporting",
        location: entity.location,
      });
    }
  }

  analyzeUnusedFiles(project, reachableFiles, state, suppressionContext);
  analyzeUnusedExports(project, reachableFiles, publicSurfaceIds, state, suppressionContext, caches);
  analyzeUnusedLocals(project, reachableFiles, state, suppressionContext);
  analyzeClassMembers(project, reachableFiles, state, suppressionContext, caches);
  analyzeObjectPaths(project, reachableFiles, state, suppressionContext);

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
  ).map(({ id, ...diagnostic }) => diagnostic);

  const byKind: Partial<Record<FindingKind, number>> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

  return {
    tool: "dead-lint",
    version: getVersion(),
    target: project.rootPath,
    mode: project.config.value.mode,
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
