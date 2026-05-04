import path from "node:path";

import ts from "typescript";

import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "./module-graph.js";
import { loadProject } from "./project.js";
import {
  hasNonDeclarationReferences,
  summarizeNonDeclarationReferences,
  summarizeReferenceUsage,
} from "./references.js";
import { buildSuppressionContext, getSuppressionAudit } from "./suppressions.js";
import type {
  AnalysisResult,
  AuditRecord,
  CliOptions,
  DiagnosticRecord,
  EscapedPathRecord,
  EntityKind,
  EntityRecord,
  FindingKind,
  FindingRecord,
  ProjectContext,
  SkipCategory,
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
  exportReferences: Map<string, ReturnType<typeof summarizeNonDeclarationReferences>>;
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
  nestedWrite: boolean;
  controlFlowDepth: number;
  functionDepth: number;
  flowSignature: string;
  escapeReason?: string;
}

interface TrackedValueBinding {
  declaration: ts.Identifier;
  name: string;
  declarationDepth: number;
}

interface ValueAnalysisCaches {
  parameterMeaningfulUse: Map<string, boolean | null>;
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

interface AnalyzableCallableBinding {
  declaration: ts.FunctionLikeDeclaration;
  symbolKey: string;
}

interface ResolvedTrackedObjectAccess {
  binding: TrackedObjectBinding;
  dynamic: boolean;
  segments: string[];
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

function getControlFlowDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isIfStatement(current)
      || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current)
      || ts.isCaseClause(current)
      || ts.isDefaultClause(current)
      || ts.isTryStatement(current)
      || ts.isCatchClause(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
      || ts.isWhileStatement(current)
      || ts.isDoStatement(current)
    ) {
      depth += 1;
    }
    current = current.parent;
  }
  return depth;
}

function isWithinNode(node: ts.Node, container: ts.Node): boolean {
  return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

function getControlFlowSignature(node: ts.Node): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isIfStatement(current)) {
      const branch = isWithinNode(node, current.thenStatement)
        ? "then"
        : current.elseStatement && isWithinNode(node, current.elseStatement)
          ? "else"
          : "condition";
      parts.push(`if:${current.getStart()}:${branch}`);
    } else if (ts.isConditionalExpression(current)) {
      const branch = isWithinNode(node, current.whenTrue)
        ? "when-true"
        : isWithinNode(node, current.whenFalse)
          ? "when-false"
          : "condition";
      parts.push(`conditional:${current.getStart()}:${branch}`);
    } else if (ts.isTryStatement(current)) {
      const branch = isWithinNode(node, current.tryBlock)
        ? "try"
        : current.catchClause && isWithinNode(node, current.catchClause)
          ? "catch"
          : current.finallyBlock && isWithinNode(node, current.finallyBlock)
            ? "finally"
            : "body";
      parts.push(`try:${current.getStart()}:${branch}`);
    } else if (ts.isForStatement(current)) {
      const branch = isWithinNode(node, current.statement)
        ? "body"
        : current.initializer && isWithinNode(node, current.initializer)
          ? "initializer"
          : current.condition && isWithinNode(node, current.condition)
            ? "condition"
            : current.incrementor && isWithinNode(node, current.incrementor)
              ? "incrementor"
              : "body";
      parts.push(`for:${current.getStart()}:${branch}`);
    } else if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
      const branch = isWithinNode(node, current.statement)
        ? "body"
        : isWithinNode(node, current.initializer)
          ? "initializer"
          : "expression";
      parts.push(`loop:${current.getStart()}:${branch}`);
    } else if (ts.isWhileStatement(current) || ts.isDoStatement(current)) {
      const statement = ts.isWhileStatement(current) ? current.statement : current.statement;
      const branch = isWithinNode(node, statement) ? "body" : "condition";
      parts.push(`loop:${current.getStart()}:${branch}`);
    } else if (ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      parts.push(`case:${current.getStart()}`);
    }

    current = current.parent;
  }

  return parts.reverse().join("|");
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const WHOLE_ARRAY_CONSUMPTION_METHODS = new Set([
  "every",
  "entries",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "reduce",
  "reduceRight",
  "shift",
  "slice",
  "some",
  "values",
]);

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

function addSkipped(
  state: AnalysisState,
  entity: EntityRecord,
  category: SkipCategory,
  reason: string,
): void {
  state.skipped.push({
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    reason,
    category,
    location: entity.location,
  });
}

function sameTrackedBinding(left: TrackedObjectBinding, right: TrackedObjectBinding): boolean {
  return left.trackedObject.id === right.trackedObject.id && left.prefix.join(".") === right.prefix.join(".");
}

function extendTrackedBinding(binding: TrackedObjectBinding, segments: string[]): TrackedObjectBinding {
  return {
    trackedObject: binding.trackedObject,
    prefix: [...binding.prefix, ...segments],
  };
}

function setTrackedBinding(
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  symbolKey: string,
  binding: TrackedObjectBinding,
): boolean {
  const existing = trackedBySymbolId.get(symbolKey);
  if (existing && sameTrackedBinding(existing, binding)) {
    return false;
  }

  trackedBySymbolId.set(symbolKey, binding);
  return true;
}

function setFunctionReturnBinding(
  functionReturnBindings: Map<string, TrackedObjectBinding | null>,
  symbolKey: string,
  binding: TrackedObjectBinding | null,
): boolean {
  const existing = functionReturnBindings.get(symbolKey);
  if (existing === binding || (existing && binding && sameTrackedBinding(existing, binding))) {
    return false;
  }

  functionReturnBindings.set(symbolKey, binding);
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

function buildPublicSurfaceAudit(entity: EntityRecord): AuditRecord {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    reason: "kept as public package surface",
    location: entity.location,
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
      const cacheKey = createReferenceKey(sourceFile, candidate.node);
      let referenceSummary = caches.exportReferences.get(cacheKey);
      if (!referenceSummary) {
        referenceSummary = summarizeNonDeclarationReferences(
          project.languageService,
          sourceFile,
          candidate.node,
          project.analyzableFiles,
        );
        caches.exportReferences.set(cacheKey, referenceSummary);
      }

      if (referenceSummary.crossFileReferences > 0) {
        continue;
      }

      const keepReason = publicSurfaceIds.has(candidate.entity.id)
        ? buildPublicSurfaceAudit(candidate.entity)
        : getSuppressionAudit(project, suppressionContext, candidate.entity, candidate.node);

      if (addAudit(state.kept, keepReason)) {
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
        referenceSummary.sameFileReferences > 0
          ? "exported declaration is only referenced within its declaring file"
          : "exported declaration has no non-declaration references outside its declaring file",
        referenceSummary.sameFileReferences > 0
          ? `Exported ${candidate.entity.name} is only used within ${candidate.entity.location.file}`
          : `Unused exported ${candidate.entity.name}`,
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
            addSkipped(state, entity, "decorator-visibility", "member skipped because decorators can make it externally visible");
            continue;
          }

          if (ts.isPropertyDeclaration(member) && member.name && ts.isComputedPropertyName(member.name)) {
            addSkipped(state, entity, "computed-member-name", "member skipped because computed property names are dynamic");
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
    return expression.operatorToken.kind !== ts.SyntaxKind.CommaToken
      && !ASSIGNMENT_OPERATORS.has(expression.operatorToken.kind)
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

function getAnalyzableCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): AnalyzableCallableBinding | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const calleeSymbol = project.checker.getSymbolAtLocation(expression);
  const declaration = calleeSymbol?.declarations?.[0];
  const callable =
    declaration && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration))
      ? declaration
      : declaration
          && ts.isVariableDeclaration(declaration)
          && declaration.initializer
          && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
        ? declaration.initializer
        : undefined;

  if (!calleeSymbol || !callable?.body) {
    return undefined;
  }

  return callable.getSourceFile().fileName.startsWith(project.rootPath)
    ? {
        declaration: callable,
        symbolKey: getSymbolKey(calleeSymbol),
      }
    : undefined;
}

function getAnalyzableCallableBindingFromDeclaration(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
): AnalyzableCallableBinding | undefined {
  if (!declaration.body || !declaration.getSourceFile().fileName.startsWith(project.rootPath)) {
    return undefined;
  }

  if (declaration.name && ts.isIdentifier(declaration.name)) {
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    if (symbol) {
      return {
        declaration,
        symbolKey: getSymbolKey(symbol),
      };
    }
  }

  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const symbol = project.checker.getSymbolAtLocation(parent.name);
      if (symbol) {
        return {
          declaration,
          symbolKey: getSymbolKey(symbol),
        };
      }
    }
  }

  return undefined;
}

function resolveAnalyzableFunctionDeclaration(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): ts.FunctionLikeDeclaration | undefined {
  return getAnalyzableCallableBinding(project, expression)?.declaration;
}

function isUpdateRead(node: ts.Identifier): boolean {
  return (ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken);
}

function getCallArgumentUse(
  project: ProjectContext,
  node: ts.Identifier,
  caches: ValueAnalysisCaches,
): "read" | "ignore" | undefined {
  const parent = node.parent;
  if (!(ts.isCallExpression(parent) || ts.isNewExpression(parent))) {
    return undefined;
  }

  const argumentIndex = (parent.arguments ?? []).findIndex((argument) => argument === node);
  if (argumentIndex < 0) {
    return undefined;
  }

  const callable = resolveAnalyzableFunctionDeclaration(project, parent.expression);
  if (!callable) {
    return "read";
  }

  const parameter = callable.parameters[argumentIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return "read";
  }

  return hasMeaningfulParameterUse(project, callable, parameter.name, caches) ? "read" : "ignore";
}

function hasMeaningfulParameterUse(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  parameterName: ts.Identifier,
  caches: ValueAnalysisCaches,
): boolean {
  const parameterSymbol = project.checker.getSymbolAtLocation(parameterName);
  if (!parameterSymbol || !declaration.body) {
    return true;
  }

  const parameterKey = getSymbolKey(parameterSymbol);
  const cached = caches.parameterMeaningfulUse.get(parameterKey);
  if (cached === null) {
    return true;
  }
  if (cached !== undefined) {
    return cached;
  }

  caches.parameterMeaningfulUse.set(parameterKey, null);
  let meaningful = false;

  const visit = (node: ts.Node): void => {
    if (meaningful) {
      return;
    }

    if (ts.isIdentifier(node)) {
      const symbol = project.checker.getSymbolAtLocation(node);
      if (!symbol || getSymbolKey(symbol) !== parameterKey || node === parameterName) {
        return ts.forEachChild(node, visit);
      }

      const callArgumentUse = getCallArgumentUse(project, node, caches);
      if (callArgumentUse === "read") {
        meaningful = true;
        return;
      }
      if (callArgumentUse === "ignore") {
        return ts.forEachChild(node, visit);
      }

      if (isUpdateRead(node) || isReadLikeUse(node)) {
        meaningful = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(declaration.body, visit);
  caches.parameterMeaningfulUse.set(parameterKey, meaningful);
  return meaningful;
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

    const trackedBindings = new Map<string, TrackedValueBinding>();
    const accesses = new Map<string, ValueAccess[]>();
    const valueAnalysisCaches: ValueAnalysisCaches = {
      parameterMeaningfulUse: new Map(),
    };

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
        const functionDepth = getFunctionDepth(node);
        const controlFlowDepth = getControlFlowDepth(node);
        const flowSignature = getControlFlowSignature(node);
        if (symbol && node.initializer) {
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.name, node.name.text),
            position: node.name.getStart(sourceFile),
            kind: "write",
            nestedWrite: false,
            controlFlowDepth,
            functionDepth,
            flowSignature,
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
          const functionDepth = getFunctionDepth(node);
          const flowSignature = getControlFlowSignature(node);
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.left, tracked.name),
            position: node.left.getStart(sourceFile),
            kind: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "write" : "read-write",
            nestedWrite: functionDepth > tracked.declarationDepth,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth,
            flowSignature,
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
          const functionDepth = getFunctionDepth(node);
          const flowSignature = getControlFlowSignature(node);
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.operand, tracked.name),
            position: node.operand.getStart(sourceFile),
            kind: "read-write",
            nestedWrite: functionDepth > tracked.declarationDepth,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth,
            flowSignature,
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
          || isUpdateRead(node)
        ) {
          return ts.forEachChild(node, visit);
        }

        const symbolKey = getSymbolKey(symbol);
        const callArgumentUse = getCallArgumentUse(project, node, valueAnalysisCaches);
        if (callArgumentUse === "read") {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "read",
            nestedWrite: false,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth: getFunctionDepth(node),
            flowSignature: getControlFlowSignature(node),
          });
          return ts.forEachChild(node, visit);
        }
        if (callArgumentUse === "ignore") {
          return ts.forEachChild(node, visit);
        }

        if (isReadLikeUse(node)) {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "read",
            nestedWrite: false,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth: getFunctionDepth(node),
            flowSignature: getControlFlowSignature(node),
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
      const canProveOverwrite = (current: ValueAccess, next: ValueAccess): boolean =>
        current.functionDepth === next.functionDepth && current.flowSignature === next.flowSignature;

      for (const access of ordered) {
        if (access.kind === "read") {
          hasAnyRead = true;
          pendingWrite = undefined;
          continue;
        }

        if (access.kind === "read-write") {
          hasAnyRead = true;
          pendingWrite = access;
          continue;
        }

        if (access.kind === "write") {
          if (pendingWrite && canProveOverwrite(pendingWrite, access)) {
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
          continue;
        }

        if (access.kind === "escape" && pendingWrite) {
          addSkipped(state, pendingWrite.entity, "opaque-object-call", access.escapeReason ?? "value escaped exact analysis");
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
        markEscaped(trackedObject, segments, "object-spread", "object spread introduces opaque properties");
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
        markEscaped(
          trackedObject,
          segments,
          "computed-property-name",
          "computed property names are not eligible for exact analysis",
        );
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
        markEscaped(trackedObject, segments, "array-spread", "array spread introduces opaque values");
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

function resolveTrackedObjectAccess(
  project: ProjectContext,
  node: ts.Node,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnBindings: Map<string, TrackedObjectBinding | null>,
): ResolvedTrackedObjectAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    const binding = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
    return binding ? { binding, segments: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
    return nested
      ? {
          binding: nested.binding,
          segments: [...nested.segments, node.name.text],
          dynamic: nested.dynamic,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
    if (!nested) {
      return undefined;
    }

    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        binding: nested.binding,
        segments: [...nested.segments, node.argumentExpression.text],
        dynamic: nested.dynamic,
      };
    }

    return {
      binding: nested.binding,
      segments: nested.segments,
      dynamic: true,
    };
  }

  if (ts.isCallExpression(node)) {
    const callable = getAnalyzableCallableBinding(project, node.expression);
    const binding = callable ? functionReturnBindings.get(callable.symbolKey) : undefined;
    return binding
      ? {
          binding,
          segments: [],
          dynamic: false,
        }
      : undefined;
  }

  if (
    ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    const left = resolveTrackedObjectAccess(project, node.left, trackedBySymbolId, functionReturnBindings);
    const right = resolveTrackedObjectAccess(project, node.right, trackedBySymbolId, functionReturnBindings);
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }
    return sameTrackedBinding(extendTrackedBinding(left.binding, left.segments), extendTrackedBinding(right.binding, right.segments))
      ? {
          binding: left.binding,
          segments: left.segments,
          dynamic: left.dynamic || right.dynamic,
        }
      : undefined;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveTrackedObjectAccess(project, node.whenTrue, trackedBySymbolId, functionReturnBindings);
    const whenFalse = resolveTrackedObjectAccess(project, node.whenFalse, trackedBySymbolId, functionReturnBindings);
    if (!whenTrue) {
      return whenFalse;
    }
    if (!whenFalse) {
      return whenTrue;
    }
    return sameTrackedBinding(
      extendTrackedBinding(whenTrue.binding, whenTrue.segments),
      extendTrackedBinding(whenFalse.binding, whenFalse.segments),
    )
      ? {
          binding: whenTrue.binding,
          segments: whenTrue.segments,
          dynamic: whenTrue.dynamic || whenFalse.dynamic,
        }
      : undefined;
  }

  return undefined;
}

function markRead(trackedObject: TrackedObject, segments: string[]): void {
  for (let index = 1; index <= segments.length; index += 1) {
    trackedObject.reads.add(segments.slice(0, index).join("."));
  }
}

function markObservedSubtree(trackedObject: TrackedObject, segments: string[]): void {
  const joinedPrefix = segments.join(".");
  if (joinedPrefix) {
    trackedObject.reads.add(joinedPrefix);
  }

  for (const joinedPath of trackedObject.nodes.keys()) {
    if (!joinedPrefix || joinedPath === joinedPrefix || joinedPath.startsWith(`${joinedPrefix}.`)) {
      trackedObject.reads.add(joinedPath);
    }
  }
}

function markWrite(trackedObject: TrackedObject, segments: string[]): void {
  trackedObject.writes.add(segments.join("."));
}

function markEscaped(
  trackedObject: TrackedObject,
  segments: string[],
  category: SkipCategory,
  reason: string,
): void {
  trackedObject.escapedPaths.set(segments.join("."), { category, reason });
}

function getEscapedReason(trackedObject: TrackedObject, segments: string[]): EscapedPathRecord | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const key = segments.slice(0, index).join(".");
    const escaped = trackedObject.escapedPaths.get(key);
    if (escaped) {
      return escaped;
    }
  }
  return undefined;
}

function getForwardedParameterBindings(
  project: ProjectContext,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnBindings: Map<string, TrackedObjectBinding | null>,
): ForwardedParameterBinding[] {
  const callable = getAnalyzableCallableBinding(project, node.expression);
  if (!callable) {
    return [];
  }

  const forwarded: ForwardedParameterBinding[] = [];

  node.arguments.forEach((argument, index) => {
    const parameter = callable.declaration.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return;
    }

    const resolved = resolveTrackedObjectAccess(project, argument, trackedBySymbolId, functionReturnBindings);
    if (!resolved || resolved.dynamic) {
      return;
    }

    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) {
      return;
    }

    forwarded.push({
      index,
      paramSymbolKey: getSymbolKey(parameterSymbol),
      binding: extendTrackedBinding(resolved.binding, resolved.segments),
    });
  });

  return forwarded;
}

function isAssignmentLeft(node: ts.Node): boolean {
  return ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function isTrackableObjectValue(node: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return isTrackableObjectStructure(node);
  }

  return (
    ts.isIdentifier(node)
    || ts.isNumericLiteral(node)
    || ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.BigIntLiteral
  );
}

function isTrackableObjectStructure(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        return true;
      }

      return ts.isPropertyAssignment(property) && isTrackableObjectValue(property.initializer);
    });
  }

  return node.elements.every(
    (element) => !ts.isSpreadElement(element) && isTrackableObjectValue(element as ts.Expression),
  );
}

function buildTrackedObjects(
  project: ProjectContext,
  reachableFiles: Set<string>,
): {
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnBindings: Map<string, TrackedObjectBinding | null>;
} {
  const trackedBySymbolId = new Map<string, TrackedObjectBinding>();
  const functionReturnBindings = new Map<string, TrackedObjectBinding | null>();

  const collectFunctionReturnBinding = (declaration: ts.FunctionLikeDeclaration): TrackedObjectBinding | null | undefined => {
    const callable = getAnalyzableCallableBindingFromDeclaration(project, declaration);
    if (!callable?.declaration.body) {
      return undefined;
    }

    let binding: TrackedObjectBinding | undefined;
    let sawReturn = false;
    let unsupported = false;

    const visit = (node: ts.Node): void => {
      if (unsupported) {
        return;
      }

      if (ts.isFunctionLike(node) && node !== callable.declaration) {
        return;
      }

      if (ts.isReturnStatement(node) && node.expression) {
        sawReturn = true;
        const resolved = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
        if (!resolved || resolved.dynamic) {
          unsupported = true;
          return;
        }

        const nextBinding = extendTrackedBinding(resolved.binding, resolved.segments);
        if (!binding) {
          binding = nextBinding;
          return;
        }

        if (!sameTrackedBinding(binding, nextBinding)) {
          unsupported = true;
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(callable.declaration.body, visit);

    if (!sawReturn) {
      return undefined;
    }

    return unsupported ? null : binding ?? null;
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (const sourceFile of project.sourceFiles) {
      if (!reachableFiles.has(sourceFile.fileName)) {
        continue;
      }

      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const symbol = project.checker.getSymbolAtLocation(node.name);
          if (!symbol) {
            return ts.forEachChild(node, visit);
          }

          if (
            (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer))
            && isTrackableObjectStructure(node.initializer)
          ) {
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
            changed = setTrackedBinding(trackedBySymbolId, getSymbolKey(symbol), {
              trackedObject,
              prefix: [],
            }) || changed;
          } else {
            const resolved = resolveTrackedObjectAccess(project, node.initializer, trackedBySymbolId, functionReturnBindings);
            if (resolved && !resolved.dynamic) {
              changed = setTrackedBinding(
                trackedBySymbolId,
                getSymbolKey(symbol),
                extendTrackedBinding(resolved.binding, resolved.segments),
              ) || changed;
            }
          }
        }

        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)
        ) {
          const target = project.checker.getSymbolAtLocation(node.left);
          const resolved = resolveTrackedObjectAccess(project, node.right, trackedBySymbolId, functionReturnBindings);
          if (target && resolved && !resolved.dynamic) {
            changed = setTrackedBinding(
              trackedBySymbolId,
              getSymbolKey(target),
              extendTrackedBinding(resolved.binding, resolved.segments),
            ) || changed;
          }
        }

        if (ts.isCallExpression(node)) {
          for (const forwarded of getForwardedParameterBindings(project, node, trackedBySymbolId, functionReturnBindings)) {
            changed = setTrackedBinding(trackedBySymbolId, forwarded.paramSymbolKey, forwarded.binding) || changed;
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
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
          const callable = getAnalyzableCallableBindingFromDeclaration(project, node);
          if (callable) {
            const binding = collectFunctionReturnBinding(node);
            if (binding !== undefined) {
              changed = setFunctionReturnBinding(functionReturnBindings, callable.symbolKey, binding) || changed;
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sourceFile, visit);
    }
  }

  return {
    trackedBySymbolId,
    functionReturnBindings,
  };
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

  const { trackedBySymbolId, functionReturnBindings } = buildTrackedObjects(project, reachableFiles);
  const trackedObjects = new Set<TrackedObject>(
    [...trackedBySymbolId.values()].map((binding) => binding.trackedObject),
  );

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const target = project.checker.getSymbolAtLocation(node.name);
        const resolved = resolveTrackedObjectAccess(project, node.initializer, trackedBySymbolId, functionReturnBindings);
        if (target && resolved && !resolved.dynamic) {
          trackedBySymbolId.set(getSymbolKey(target), extendTrackedBinding(resolved.binding, resolved.segments));
        }
      }

      if (ts.isReturnStatement(node) && node.expression) {
        const resolved = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
        if (resolved && !resolved.dynamic) {
          const returnBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
          const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
          const propagated = callable ? functionReturnBindings.get(callable.symbolKey) : undefined;
          if (!propagated || !sameTrackedBinding(propagated, returnBinding)) {
            markEscaped(
              returnBinding.trackedObject,
              returnBinding.prefix,
              "returned-object",
              "returned object escapes local analysis",
            );
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeAccessPath = getAccessPath(node.expression);
        if (calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0) {
          const methodName = calleeAccessPath.segments.at(-1);
          const symbol = project.checker.getSymbolAtLocation(calleeAccessPath.root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          if (tracked && methodName && WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
            markObservedSubtree(
              tracked.trackedObject,
              [...tracked.prefix, ...calleeAccessPath.segments.slice(0, -1)],
            );
          }
        }

        const calleeText = node.expression.getText(sourceFile);
        const forwardedIndices = new Set(
          getForwardedParameterBindings(project, node, trackedBySymbolId, functionReturnBindings).map((forwarded) => forwarded.index),
        );
        for (const [index, argument] of node.arguments.entries()) {
          const resolved = resolveTrackedObjectAccess(project, argument, trackedBySymbolId, functionReturnBindings);
          if (!resolved) {
            continue;
          }

          const fullPath = [...resolved.binding.prefix, ...resolved.segments];
          if (resolved.dynamic) {
            markEscaped(
              resolved.binding.trackedObject,
              resolved.binding.prefix,
              "computed-property-access",
              "computed property access prevents exact path analysis",
            );
            continue;
          }

          if (
            calleeText === "Object.keys" ||
            calleeText === "Object.values" ||
            calleeText === "Object.entries" ||
            calleeText === "Reflect.ownKeys"
          ) {
            markEscaped(
              resolved.binding.trackedObject,
              fullPath,
              "reflective-enumeration",
              `${calleeText} makes object properties externally observable`,
            );
            continue;
          }

          if (calleeText === "JSON.stringify") {
            markEscaped(
              resolved.binding.trackedObject,
              fullPath,
              "serialization",
              "JSON.stringify makes object properties externally observable",
            );
            continue;
          }

          if (forwardedIndices.has(index)) {
            continue;
          }

          const joinedPath = fullPath.join(".");
          const hasTrackedChildren = [...resolved.binding.trackedObject.nodes.keys()].some((key) => key.startsWith(`${joinedPath}.`));
          if (resolved.segments.length > 0 && !hasTrackedChildren) {
            markRead(resolved.binding.trackedObject, fullPath);
            continue;
          }

          markEscaped(
            resolved.binding.trackedObject,
            fullPath,
            "opaque-object-call",
            resolved.segments.length === 0
              ? "object passed to call expression escapes exact local analysis"
              : "object path passed to call expression escapes exact local analysis",
          );
        }
      }

      if (ts.isForOfStatement(node)) {
        const resolved = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
        if (resolved && !resolved.dynamic) {
          markObservedSubtree(resolved.binding.trackedObject, [...resolved.binding.prefix, ...resolved.segments]);
        }
      }

      if (ts.isSpreadAssignment(node)) {
        const resolved = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
        if (resolved && !resolved.dynamic) {
          markObservedSubtree(resolved.binding.trackedObject, [...resolved.binding.prefix, ...resolved.segments]);
        }
      }

      if (ts.isSpreadElement(node)) {
        const resolved = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
        if (resolved) {
          if (ts.isArrayLiteralExpression(node.parent) && !resolved.dynamic) {
            markObservedSubtree(resolved.binding.trackedObject, [...resolved.binding.prefix, ...resolved.segments]);
          } else {
            markEscaped(
              resolved.binding.trackedObject,
              resolved.binding.prefix,
              "spread-escape",
              "spread element escapes exact local analysis",
            );
          }
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const resolved = resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnBindings);
        if (!resolved) {
          return ts.forEachChild(node, visit);
        }

        const fullPath = [...resolved.binding.prefix, ...resolved.segments];
        if (resolved.dynamic) {
          markEscaped(
            resolved.binding.trackedObject,
            resolved.binding.prefix,
            "computed-property-access",
            "computed property access prevents exact path analysis",
          );
          return ts.forEachChild(node, visit);
        }

        if (fullPath.length === 0) {
          return ts.forEachChild(node, visit);
        }

        if (isAssignmentLeft(node)) {
          if (fullPath.length > 1) {
            markRead(resolved.binding.trackedObject, fullPath.slice(0, -1));
          }
          markWrite(resolved.binding.trackedObject, fullPath);
        } else {
          markRead(resolved.binding.trackedObject, fullPath);
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const resolved = resolveTrackedObjectAccess(project, node.initializer, trackedBySymbolId, functionReturnBindings);
        if (!resolved || resolved.dynamic) {
          return ts.forEachChild(node, visit);
        }

        for (const element of node.name.elements) {
          if (element.dotDotDotToken) {
            markEscaped(
              resolved.binding.trackedObject,
              [...resolved.binding.prefix, ...resolved.segments],
              "object-rest",
              "object rest pattern escapes remaining properties",
            );
            continue;
          }

          const keyNode = element.propertyName ?? element.name;
          if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
            markRead(resolved.binding.trackedObject, [...resolved.binding.prefix, ...resolved.segments, keyNode.text]);
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
        addSkipped(state, objectNode.entity, escapedReason.category, escapedReason.reason);
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
  const publicSurfaceIds = collectPublicSurfaceIds(project, entrypointDiscovery.publicSurfaceEntrypoints);
  const caches: ReferenceCaches = {
    hasReference: new Map(),
    exportReferences: new Map(),
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
