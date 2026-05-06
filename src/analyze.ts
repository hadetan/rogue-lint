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
  CollectionBoundaryRecord,
  DiagnosticRecord,
  EscapedPathRecord,
  EntityKind,
  EntityRecord,
  FindingKind,
  FindingRecord,
  InvalidatedPathRecord,
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedCollectionInfo,
  TrackedCollectionState,
  TrackedPlaceState,
  TrackedObject,
} from "./types.js";
import {
  getDeclarationNameNode,
  getNodeName,
  indexSegment,
  isSerializedPathWithin,
  isReadLikeUse,
  getSymbolKey,
  getVersion,
  hasModifier,
  kindToFinding,
  makeEntity,
  propertySegment,
  renderPath,
  renderPathWithRoot,
  samePath,
  serializePath,
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

interface CompilerSafetyDiagnosticSpec {
  findingKind: Extract<FindingKind, "use-before-init">;
  reason: string;
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
  prefix: PathSegment[];
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
  segments: PathSegment[];
  boundaryCategory?: SkipCategory;
  boundaryReason?: string;
}

interface ArrayProjectionBinding {
  trackedObject: TrackedObject;
  sourcePath: PathSegment[];
  elementPaths: PathSegment[][];
}

interface ResolvedProjectionAccess {
  projection: ArrayProjectionBinding;
  suffix: PathSegment[];
  dynamic: boolean;
  boundaryCategory?: SkipCategory;
  boundaryReason?: string;
}

class CollectionState implements TrackedCollectionState {
  constructor(
    public path: PathSegment[],
    public epoch = 0,
    public arrayLength?: number,
  ) {}
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
  "entries",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "slice",
  "with",
  "values",
]);

const EXACT_ARRAY_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

const ARRAY_APPEND_METHODS = new Set(["push"]);
const ARRAY_TRUNCATE_METHODS = new Set(["pop"]);
const ARRAY_REPLACEMENT_METHODS = new Set(["fill"]);
const ARRAY_REORDER_METHODS = new Set(["copyWithin", "reverse", "shift", "sort", "splice", "unshift"]);
// Initial allow-list of compiler-backed safety diagnostics promoted into dead-lint findings.
const COMPILER_SAFETY_DIAGNOSTICS = new Map<number, CompilerSafetyDiagnosticSpec>([
  [
    2454,
    {
      findingKind: "use-before-init",
      reason: "TypeScript semantic diagnostics reported this value is used before being assigned",
    },
  ],
]);

function addFinding(
  state: AnalysisState,
  entity: EntityRecord,
  kind: FindingKind,
  reason: string,
  message: string,
  suggestion: FindingRecord["suggestion"] = "remove",
): void {
  state.findings.push({
    id: entity.id,
    kind,
    entity,
    reason,
    message,
    suggestion,
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
  return left.trackedObject.id === right.trackedObject.id && samePath(left.prefix, right.prefix);
}

function extendTrackedBinding(binding: TrackedObjectBinding, segments: PathSegment[]): TrackedObjectBinding {
  return {
    trackedObject: binding.trackedObject,
    prefix: [...binding.prefix, ...segments],
  };
}

function sameTrackedBindingMap(
  left: Map<string, TrackedObjectBinding>,
  right: Map<string, TrackedObjectBinding>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [symbolKey, binding] of left) {
    const other = right.get(symbolKey);
    if (!other || !sameTrackedBinding(binding, other)) {
      return false;
    }
  }

  return true;
}

function sameFunctionReturnBindingMap(
  left: Map<string, TrackedObjectBinding | null>,
  right: Map<string, TrackedObjectBinding | null>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [symbolKey, binding] of left) {
    const other = right.get(symbolKey);
    if (other === undefined) {
      return false;
    }

    if (binding === null || other === null) {
      if (binding !== other) {
        return false;
      }
      continue;
    }

    if (!sameTrackedBinding(binding, other)) {
      return false;
    }
  }

  return true;
}

function mergeTrackedBinding(
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  conflictedSymbolIds: Set<string>,
  symbolKey: string,
  binding: TrackedObjectBinding,
): void {
  if (conflictedSymbolIds.has(symbolKey)) {
    return;
  }

  const existing = trackedBySymbolId.get(symbolKey);
  if (!existing) {
    trackedBySymbolId.set(symbolKey, binding);
    return;
  }

  if (sameTrackedBinding(existing, binding)) {
    return;
  }

  trackedBySymbolId.delete(symbolKey);
  conflictedSymbolIds.add(symbolKey);
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

function buildCollectionBoundaryEntity(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  segments: PathSegment[],
): EntityRecord {
  return makeEntity(
    project.rootPath,
    "collection-boundary",
    sourceFile,
    node,
    renderPathWithRoot(trackedObject.rootName, segments),
    trackedObject.rootName,
  );
}

function getCollectionInfo(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): TrackedCollectionInfo | undefined {
  return trackedObject.collections.get(serializePath(segments));
}

function getCollectionState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): TrackedCollectionState | undefined {
  return trackedObject.collectionStates.get(serializePath(segments));
}

function ensureCollectionState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  arrayLength?: number,
): TrackedCollectionState {
  const joinedPath = serializePath(segments);
  const existing = trackedObject.collectionStates.get(joinedPath);
  if (existing) {
    if (arrayLength !== undefined) {
      existing.arrayLength = arrayLength;
    }
    return existing;
  }

  const created = new CollectionState(segments, 0, arrayLength);
  trackedObject.collectionStates.set(joinedPath, created);
  return created;
}

function setCollectionInfo(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  kind: "object" | "array",
  childPaths: PathSegment[][],
  arrayLength?: number,
): void {
  trackedObject.collections.set(serializePath(segments), {
    kind,
    path: segments,
    childPaths,
    arrayLength,
  });
  ensureCollectionState(trackedObject, segments, arrayLength);
}

function getTrackedArrayLength(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): number | undefined {
  const state = getCollectionState(trackedObject, segments);
  if (state?.arrayLength !== undefined) {
    return state.arrayLength;
  }

  return getCollectionInfo(trackedObject, segments)?.arrayLength;
}

function setTrackedArrayLength(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  arrayLength: number,
): void {
  const state = ensureCollectionState(trackedObject, segments, Math.max(arrayLength, 0));
  state.arrayLength = Math.max(arrayLength, 0);
  const collection = getCollectionInfo(trackedObject, segments);
  if (collection) {
    collection.arrayLength = state.arrayLength;
  }
}

function setPlaceState(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  placeState: TrackedPlaceState,
): void {
  trackedObject.placeStates.set(serializePath(segments), placeState);
}

function getInvalidatedPathRecord(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): InvalidatedPathRecord | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const invalidated = trackedObject.invalidatedPaths.get(serializePath(segments.slice(0, index)));
    if (invalidated) {
      return invalidated;
    }
  }

  return undefined;
}

function createInvalidatedPathRecord(
  category: SkipCategory,
  reason: string,
): InvalidatedPathRecord {
  switch (category) {
    case "array-replacement-mutation":
      return {
        state: "invalidated",
        findingKind: "invalidated-read",
        reason,
      };
    case "array-truncate-mutation":
    case "array-reorder-mutation":
      return {
        state: "invalidated",
        findingKind: "stale-read-after-mutation",
        reason,
      };
    default:
      return {
        state: "invalidated",
        reason,
      };
  }
}

function bumpCollectionEpoch(trackedObject: TrackedObject, segments: PathSegment[]): void {
  ensureCollectionState(trackedObject, segments).epoch += 1;
}

function recordCollectionBoundary(
  trackedObject: TrackedObject,
  collectionPath: PathSegment[],
  record: CollectionBoundaryRecord,
  invalidatePath?: PathSegment[],
  invalidatedRecord?: InvalidatedPathRecord,
): void {
  bumpCollectionEpoch(trackedObject, collectionPath);
  trackedObject.collectionBoundaries.set(record.entity.id, record);
  if (invalidatePath) {
    const joinedPath = serializePath(invalidatePath);
    trackedObject.invalidatedCollectionPaths.add(joinedPath);
    setPlaceState(trackedObject, invalidatePath, "invalidated");
    if (invalidatedRecord) {
      trackedObject.invalidatedPaths.set(joinedPath, invalidatedRecord);
    }
  }
}

function invalidateCollectionPath(
  trackedObject: TrackedObject,
  collectionPath: PathSegment[],
  affectedPath: PathSegment[],
  invalidatedRecord?: InvalidatedPathRecord,
): void {
  bumpCollectionEpoch(trackedObject, collectionPath);
  const joinedPath = serializePath(affectedPath);
  trackedObject.invalidatedCollectionPaths.add(joinedPath);
  setPlaceState(trackedObject, affectedPath, "invalidated");
  if (invalidatedRecord) {
    trackedObject.invalidatedPaths.set(joinedPath, invalidatedRecord);
  }
}

function isCollectionPathInvalidated(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  for (let index = segments.length; index >= 0; index -= 1) {
    if (trackedObject.invalidatedCollectionPaths.has(serializePath(segments.slice(0, index)))) {
      return true;
    }
  }
  return false;
}

function shouldReportCollectionBoundary(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  const joinedPath = serializePath(segments);
  const collection = getCollectionInfo(trackedObject, segments);
  const hasExactCoverage = trackedObject.nodes.has(joinedPath)
    || hasTrackedChildren(trackedObject, segments)
    || (collection?.childPaths.length ?? 0) > 0;

  if (!hasExactCoverage) {
    return false;
  }

  return !trackedObject.observedSubtrees.has(joinedPath) || isCollectionPathInvalidated(trackedObject, segments);
}

function getNearestArrayCollectionPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): PathSegment[] | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const candidate = segments.slice(0, index);
    if (getCollectionInfo(trackedObject, candidate)?.kind === "array") {
      return candidate;
    }
  }

  return undefined;
}

function hasTrackedChildren(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  return (trackedObject.descendantNodeKeys.get(serializePath(segments))?.length ?? 0) > 0;
}

function indexTrackedObjectNode(trackedObject: TrackedObject, serializedPath: string, fullPath: PathSegment[]): void {
  for (let index = 0; index < fullPath.length; index += 1) {
    const prefix = serializePath(fullPath.slice(0, index));
    const descendantKeys = trackedObject.descendantNodeKeys.get(prefix);
    if (descendantKeys) {
      descendantKeys.push(serializedPath);
    } else {
      trackedObject.descendantNodeKeys.set(prefix, [serializedPath]);
    }
  }
}

function getProjectionBinding(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): ArrayProjectionBinding | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== "array") {
    return undefined;
  }

  return {
    trackedObject,
    sourcePath: segments,
    elementPaths: collection.childPaths,
  };
}

function getConcreteProjectionPaths(
  projection: ArrayProjectionBinding,
  suffix: PathSegment[] = [],
): PathSegment[][] {
  return projection.elementPaths
    .map((elementPath) => [...elementPath, ...suffix])
    .filter((fullPath) => {
      const serializedPath = serializePath(fullPath);
      return projection.trackedObject.nodes.has(serializedPath)
        || projection.trackedObject.collections.has(serializedPath)
        || hasTrackedChildren(projection.trackedObject, fullPath);
    });
}

function markProjectionReads(
  projection: ArrayProjectionBinding,
  suffix: PathSegment[] = [],
  observeSubtree = false,
): void {
  const concretePaths = getConcreteProjectionPaths(projection, suffix);
  for (const fullPath of concretePaths) {
    if (observeSubtree) {
      markObservedSubtree(projection.trackedObject, fullPath);
    } else {
      markRead(projection.trackedObject, fullPath);
    }
  }
}

function markProjectionWrites(
  projection: ArrayProjectionBinding,
  suffix: PathSegment[],
): void {
  const concretePaths = getConcreteProjectionPaths(projection, suffix);
  for (const fullPath of concretePaths) {
    markWrite(projection.trackedObject, fullPath);
  }
}

function resolveLiteralArrayIndex(argument: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(argument)) {
    return Number(argument.text);
  }

  if (
    ts.isPrefixUnaryExpression(argument)
    && argument.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(argument.operand)
  ) {
    return -Number(argument.operand.text);
  }

  return undefined;
}

function resolveArrayAtIndex(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  argument: ts.Expression,
): number | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== "array") {
    return undefined;
  }

  const literalIndex = resolveLiteralArrayIndex(argument);
  if (literalIndex === undefined) {
    return undefined;
  }

  const arrayLength = getTrackedArrayLength(trackedObject, segments) ?? 0;

  if (literalIndex >= 0) {
    return literalIndex < arrayLength ? literalIndex : undefined;
  }

  const normalized = arrayLength + literalIndex;
  return normalized >= 0 ? normalized : undefined;
}

function getSupportedArrayCallbackParamIndex(methodName: string): number | undefined {
  if (!EXACT_ARRAY_CALLBACK_METHODS.has(methodName)) {
    return undefined;
  }

  return methodName === "reduce" || methodName === "reduceRight" ? 1 : 0;
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

function buildCompilerSafetyEntity(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { entity: EntityRecord; targetNode: ts.Node } | undefined {
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
          "class-member",
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
        entity: makeEntity(project.rootPath, "local", sourceFile, node, declarationNode.name.text),
        targetNode: node,
      };
    }
  }

  if (ts.isIdentifier(node)) {
    return {
      entity: makeEntity(project.rootPath, "local", sourceFile, node, node.text),
      targetNode: node,
    };
  }

  const text = node.getText(sourceFile).trim();
  if (!text) {
    return undefined;
  }

  return {
    entity: makeEntity(project.rootPath, "expression", sourceFile, node, text),
    targetNode: node,
  };
}

function analyzeCompilerSafetyDiagnostics(
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
  segments: PathSegment[],
  maxDepth: number,
): void {
  if (segments.length > maxDepth) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const childPaths: PathSegment[][] = [];
    setCollectionInfo(trackedObject, segments, "object", childPaths);

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

      const fullPath = [...segments, propertySegment(propertyName)];
      const joinedPath = serializePath(fullPath);
      childPaths.push(fullPath);
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? "object-key" : "nested-path",
        sourceFile,
        property.name,
        fullPath.length === 1 ? propertyName : renderPath(fullPath),
        owner,
      );
      trackedObject.nodes.set(joinedPath, { entity, fullPath });
      trackedObject.placeStates.set(joinedPath, "initialized");
      indexTrackedObjectNode(trackedObject, joinedPath, fullPath);

      const initializer = ts.isShorthandPropertyAssignment(property) ? undefined : property.initializer;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, rootName, owner, fullPath, maxDepth);
      }
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, rootName, owner, fullPath, maxDepth);
      }
    }
  } else {
    const childPaths: PathSegment[][] = [];
    setCollectionInfo(trackedObject, segments, "array", childPaths, node.elements.length);

    node.elements.forEach((element, index) => {
      if (!element || ts.isSpreadElement(element)) {
        markEscaped(trackedObject, segments, "array-spread", "array spread introduces opaque values");
        return;
      }

      const fullPath = [...segments, indexSegment(index)];
      const joinedPath = serializePath(fullPath);
      childPaths.push(fullPath);
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? "array-element" : "nested-path",
        sourceFile,
        element,
        renderPath(fullPath),
        owner,
      );
      trackedObject.nodes.set(joinedPath, { entity, fullPath });
      trackedObject.placeStates.set(joinedPath, "initialized");
      indexTrackedObjectNode(trackedObject, joinedPath, fullPath);

      if (ts.isObjectLiteralExpression(element)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, element, rootName, owner, fullPath, maxDepth);
      }
      if (ts.isArrayLiteralExpression(element)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, element, rootName, owner, fullPath, maxDepth);
      }
    });
  }
}

function getAccessPath(node: ts.Node): { root: ts.Identifier; segments: PathSegment[]; dynamic: boolean } | undefined {
  if (ts.isIdentifier(node)) {
    return { root: node, segments: [], dynamic: false };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    return { root: nested.root, segments: [...nested.segments, propertySegment(node.name.text)], dynamic: nested.dynamic };
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        root: nested.root,
        segments: [
          ...nested.segments,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
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
    if (nested?.dynamic) {
      return nested;
    }
    return nested
      ? {
          binding: nested.binding,
          segments: [...nested.segments, propertySegment(node.name.text)],
          dynamic: nested.dynamic,
          boundaryCategory: nested.boundaryCategory,
          boundaryReason: nested.boundaryReason,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnBindings);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        binding: nested.binding,
        segments: [
          ...nested.segments,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
      };
    }

    const targetPath = [...nested.binding.prefix, ...nested.segments];
    const isArrayIndex = getCollectionInfo(nested.binding.trackedObject, targetPath)?.kind === "array";
    return {
      binding: nested.binding,
      segments: nested.segments,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "at"
      && node.arguments.length === 1
    ) {
      const receiver = resolveTrackedObjectAccess(project, node.expression.expression, trackedBySymbolId, functionReturnBindings);
      if (!receiver) {
        return undefined;
      }

      if (receiver.dynamic) {
        return receiver;
      }

      const receiverPath = [...receiver.binding.prefix, ...receiver.segments];
      const collection = getCollectionInfo(receiver.binding.trackedObject, receiverPath);
      if (collection?.kind !== "array") {
        return undefined;
      }

      const resolvedIndex = resolveArrayAtIndex(receiver.binding.trackedObject, receiverPath, node.arguments[0]!);
      if (resolvedIndex === undefined) {
        return {
          binding: receiver.binding,
          segments: receiver.segments,
          dynamic: true,
          boundaryCategory: "array-at-call",
          boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
        };
      }

      return {
        binding: receiver.binding,
        segments: [...receiver.segments, indexSegment(resolvedIndex)],
        dynamic: false,
      };
    }

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
          boundaryCategory: left.boundaryCategory ?? right.boundaryCategory,
          boundaryReason: left.boundaryReason ?? right.boundaryReason,
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
          boundaryCategory: whenTrue.boundaryCategory ?? whenFalse.boundaryCategory,
          boundaryReason: whenTrue.boundaryReason ?? whenFalse.boundaryReason,
        }
      : undefined;
  }

  return undefined;
}

function markRead(trackedObject: TrackedObject, segments: PathSegment[]): void {
  for (let index = 1; index <= segments.length; index += 1) {
    trackedObject.reads.add(serializePath(segments.slice(0, index)));
  }
}

function markObservedSubtree(trackedObject: TrackedObject, segments: PathSegment[]): void {
  const joinedPrefix = serializePath(segments);
  trackedObject.observedSubtrees.add(joinedPrefix);
  trackedObject.reads.add(joinedPrefix);

  const descendantKeys = trackedObject.descendantNodeKeys.get(joinedPrefix);
  if (!descendantKeys) {
    return;
  }

  for (const joinedPath of descendantKeys) {
    if (isSerializedPathWithin(joinedPath, joinedPrefix)) {
      trackedObject.reads.add(joinedPath);
    }
  }
}

function markWrite(trackedObject: TrackedObject, segments: PathSegment[]): void {
  trackedObject.writes.add(serializePath(segments));
  setPlaceState(trackedObject, segments, "initialized");
}

function markEscaped(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  category: SkipCategory,
  reason: string,
): void {
  trackedObject.escapedPaths.set(serializePath(segments), { category, reason });
  setPlaceState(trackedObject, segments, "escaped");
}

function getEscapedReason(trackedObject: TrackedObject, segments: PathSegment[]): EscapedPathRecord | undefined {
  for (let index = segments.length; index >= 0; index -= 1) {
    const key = serializePath(segments.slice(0, index));
    const escaped = trackedObject.escapedPaths.get(key);
    if (escaped) {
      return escaped;
    }
  }
  return undefined;
}

function recordArrayBoundary(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  collectionPath: PathSegment[],
  affectedPath: PathSegment[],
  category: SkipCategory,
  reason: string,
  invalidate = false,
): void {
  recordCollectionBoundary(
    trackedObject,
    collectionPath,
    {
      entity: buildCollectionBoundaryEntity(project, trackedObject, sourceFile, node, affectedPath),
      path: affectedPath,
      category,
      reason,
    },
    invalidate ? affectedPath : undefined,
    invalidate ? createInvalidatedPathRecord(category, reason) : undefined,
  );
}

function isNestedTrackedAccess(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    || (ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
    || (ts.isCallExpression(node.parent) && node.parent.expression === node)
  );
}

function buildReadExpressionEntity(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): EntityRecord {
  return makeEntity(
    project.rootPath,
    "expression",
    sourceFile,
    node,
    renderPathWithRoot(trackedObject.rootName, fullPath),
    trackedObject.rootName,
  );
}

function maybeReportInvalidatedRead(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
  trackedObject: TrackedObject,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  if (isNestedTrackedAccess(node)) {
    return;
  }

  const invalidated = getInvalidatedPathRecord(trackedObject, fullPath);
  if (!invalidated?.findingKind) {
    return;
  }

  if (getEscapedReason(trackedObject, fullPath)) {
    return;
  }

  const entity = buildReadExpressionEntity(project, trackedObject, sourceFile, node, fullPath);
  const suppression = getSuppressionAudit(project, suppressionContext, entity, node);
  if (addAudit(state.kept, suppression)) {
    return;
  }

  const renderedPath = renderPathWithRoot(trackedObject.rootName, fullPath);
  addFinding(
    state,
    entity,
    invalidated.findingKind,
    invalidated.reason,
    invalidated.findingKind === "invalidated-read"
      ? `Invalidated read of ${renderedPath}`
      : `Stale read after mutation of ${renderedPath}`,
    "review",
  );
}

function handleTrackedArrayMutation(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  collectionPath: PathSegment[],
  methodName: string,
): void {
  const arrayLength = getTrackedArrayLength(trackedObject, collectionPath);

  if (ARRAY_APPEND_METHODS.has(methodName)) {
    if (arrayLength !== undefined) {
      setTrackedArrayLength(trackedObject, collectionPath, arrayLength + node.arguments.length);
    }
    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-append-mutation",
      `${methodName} appends new elements beyond exact local analysis`,
    );
    return;
  }

  if (ARRAY_TRUNCATE_METHODS.has(methodName)) {
    if (arrayLength !== undefined && arrayLength > 0) {
      const removedPath = [...collectionPath, indexSegment(arrayLength - 1)];
      markRead(trackedObject, removedPath);
      invalidateCollectionPath(
        trackedObject,
        collectionPath,
        removedPath,
        createInvalidatedPathRecord("array-truncate-mutation", `${methodName} removes previously tracked elements`),
      );
      setTrackedArrayLength(trackedObject, collectionPath, arrayLength - 1);
      return;
    }

    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-truncate-mutation",
      `${methodName} removes elements beyond exact local analysis`,
      true,
    );
    return;
  }

  if (ARRAY_REPLACEMENT_METHODS.has(methodName)) {
    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-replacement-mutation",
      `${methodName} overwrites tracked array regions beyond exact local analysis`,
      true,
    );
    return;
  }

  if (ARRAY_REORDER_METHODS.has(methodName)) {
    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-reorder-mutation",
      `${methodName} changes stable array element ordering`,
      true,
    );
  }
}

function maybeInvalidateReplacedTrackedPath(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  if (!hasTrackedChildren(trackedObject, fullPath) && !getCollectionInfo(trackedObject, fullPath)) {
    return;
  }

  const arrayPath = getNearestArrayCollectionPath(trackedObject, fullPath);
  if (!arrayPath) {
    return;
  }

  recordArrayBoundary(
    project,
    trackedObject,
    sourceFile,
    node,
    arrayPath,
    fullPath,
    "array-replacement-mutation",
    `assignment replaces ${renderPathWithRoot(trackedObject.rootName, fullPath)} beyond exact local analysis`,
    true,
  );
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

function getBindingSymbolKey(
  project: ProjectContext,
  node: ts.Expression | ts.ForInitializer | ts.ParameterDeclaration,
): string | undefined {
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  if (ts.isVariableDeclarationList(node) && node.declarations.length === 1) {
    const [declaration] = node.declarations;
    if (declaration && ts.isIdentifier(declaration.name)) {
      const symbol = project.checker.getSymbolAtLocation(declaration.name);
      return symbol ? getSymbolKey(symbol) : undefined;
    }
  }

  if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
    const symbol = project.checker.getSymbolAtLocation(node.name);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  return undefined;
}

function resolveProjectionAccess(
  project: ProjectContext,
  node: ts.Node,
  projectionBindings: Map<string, ArrayProjectionBinding>,
): ResolvedProjectionAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveProjectionAccess(project, node.expression, projectionBindings);
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    const projection = symbol ? projectionBindings.get(getSymbolKey(symbol)) : undefined;
    return projection ? { projection, suffix: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, projectionBindings);
    if (nested?.dynamic) {
      return nested;
    }
    return nested
      ? {
          projection: nested.projection,
          suffix: [...nested.suffix, propertySegment(node.name.text)],
          dynamic: nested.dynamic,
          boundaryCategory: nested.boundaryCategory,
          boundaryReason: nested.boundaryReason,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, projectionBindings);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    if (ts.isNumericLiteral(node.argumentExpression) || ts.isStringLiteral(node.argumentExpression)) {
      return {
        projection: nested.projection,
        suffix: [
          ...nested.suffix,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
      };
    }

    const concreteTargets = getConcreteProjectionPaths(nested.projection, nested.suffix);
    const isArrayIndex = concreteTargets.some((path) => getCollectionInfo(nested.projection.trackedObject, path)?.kind === "array");
    return {
      projection: nested.projection,
      suffix: nested.suffix,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "at"
    && node.arguments.length === 1
  ) {
    const receiver = resolveProjectionAccess(project, node.expression.expression, projectionBindings);
    if (!receiver) {
      return undefined;
    }

    if (receiver.dynamic) {
      return receiver;
    }

    const elementPaths = getConcreteProjectionPaths(receiver.projection, receiver.suffix)
      .map((receiverPath) => {
        const resolvedIndex = resolveArrayAtIndex(receiver.projection.trackedObject, receiverPath, node.arguments[0]!);
        return resolvedIndex === undefined ? undefined : [...receiverPath, indexSegment(resolvedIndex)];
      })
      .filter((path): path is PathSegment[] => Boolean(path));

    if (elementPaths.length === 0) {
      return {
        projection: receiver.projection,
        suffix: receiver.suffix,
        dynamic: true,
        boundaryCategory: "array-at-call",
        boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
      };
    }

    return {
      projection: {
        trackedObject: receiver.projection.trackedObject,
        sourcePath: receiver.projection.sourcePath,
        elementPaths,
      },
      suffix: [],
      dynamic: false,
    };
  }

  return undefined;
}

function visitProjectedArrayUsage(
  project: ProjectContext,
  node: ts.Node,
  projectionBindings: Map<string, ArrayProjectionBinding>,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }

    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) {
        const projected = resolveProjectionAccess(project, argument, projectionBindings);
        if (!projected) {
          continue;
        }

        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            argument,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array callback escapes exact local analysis",
            true,
          );
          continue;
        }

        const concretePaths = getConcreteProjectionPaths(projected.projection, projected.suffix);
        const paths = concretePaths.length > 0 ? concretePaths : projected.projection.elementPaths;
        const shouldEscape = paths.some((path) => getCollectionInfo(projected.projection.trackedObject, path) || hasTrackedChildren(projected.projection.trackedObject, path));
        if (shouldEscape) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            argument,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            "array-callback-escape",
            "array callback escapes exact local analysis",
            true,
          );
        } else {
          markProjectionReads(projected.projection, projected.suffix);
        }
      }
    }

    if (ts.isIdentifier(current)) {
      const projected = resolveProjectionAccess(project, current, projectionBindings);
      if (
        projected
        && !projected.dynamic
        && isReadLikeUse(current)
        && !ts.isPropertyAccessExpression(current.parent)
        && !ts.isElementAccessExpression(current.parent)
      ) {
        markProjectionReads(projected.projection, [], true);
      }
    }

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const projected = resolveProjectionAccess(project, current, projectionBindings);
      if (projected) {
        if (projected.dynamic) {
          recordArrayBoundary(
            project,
            projected.projection.trackedObject,
            current.getSourceFile(),
            current,
            projected.projection.sourcePath,
            projected.projection.sourcePath,
            projected.boundaryCategory ?? "array-callback-escape",
            projected.boundaryReason ?? "array callback escapes exact local analysis",
            true,
          );
        } else if (isAssignmentLeft(current)) {
          if (projected.suffix.length > 1) {
            markProjectionReads(projected.projection, projected.suffix.slice(0, -1));
          }
          for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
            maybeInvalidateReplacedTrackedPath(project, projected.projection.trackedObject, current.getSourceFile(), current, fullPath);
          }
          markProjectionWrites(projected.projection, projected.suffix);
        } else {
          markProjectionReads(projected.projection, projected.suffix);
        }
      }
    }

    ts.forEachChild(current, visit);
  };

  visit(node);
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
  const trackedLiteralBindings = new Map<string, TrackedObjectBinding>();

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
    const nextTrackedBySymbolId = new Map<string, TrackedObjectBinding>();
    const conflictedTrackedSymbolIds = new Set<string>();

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
            const symbolKey = getSymbolKey(symbol);
            let binding = trackedLiteralBindings.get(symbolKey);
            if (!binding) {
              const rootEntity = makeEntity(project.rootPath, "local", sourceFile, node.name, node.name.text);
              const trackedObject: TrackedObject = {
                id: rootEntity.id,
                rootName: node.name.text,
                sourceFile: sourceFile.fileName,
                rootEntity,
                nodes: new Map(),
                descendantNodeKeys: new Map(),
                collections: new Map(),
                collectionStates: new Map(),
                collectionBoundaries: new Map(),
                invalidatedCollectionPaths: new Set(),
                invalidatedPaths: new Map(),
                placeStates: new Map(),
                observedSubtrees: new Set(),
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
              binding = {
                trackedObject,
                prefix: [],
              };
              trackedLiteralBindings.set(symbolKey, binding);
            }

            mergeTrackedBinding(nextTrackedBySymbolId, conflictedTrackedSymbolIds, symbolKey, binding);
          } else {
            const resolved = resolveTrackedObjectAccess(project, node.initializer, trackedBySymbolId, functionReturnBindings);
            if (resolved && !resolved.dynamic) {
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                getSymbolKey(symbol),
                extendTrackedBinding(resolved.binding, resolved.segments),
              );
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
            mergeTrackedBinding(
              nextTrackedBySymbolId,
              conflictedTrackedSymbolIds,
              getSymbolKey(target),
              extendTrackedBinding(resolved.binding, resolved.segments),
            );
          }
        }

        if (ts.isCallExpression(node)) {
          for (const forwarded of getForwardedParameterBindings(project, node, trackedBySymbolId, functionReturnBindings)) {
            mergeTrackedBinding(
              nextTrackedBySymbolId,
              conflictedTrackedSymbolIds,
              forwarded.paramSymbolKey,
              forwarded.binding,
            );
          }
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sourceFile, visit);
    }

    const nextFunctionReturnBindings = new Map<string, TrackedObjectBinding | null>();
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
              nextFunctionReturnBindings.set(callable.symbolKey, binding);
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sourceFile, visit);
    }

    changed =
      !sameTrackedBindingMap(trackedBySymbolId, nextTrackedBySymbolId)
      || !sameFunctionReturnBindingMap(functionReturnBindings, nextFunctionReturnBindings);
    trackedBySymbolId.clear();
    nextTrackedBySymbolId.forEach((binding, symbolKey) => {
      trackedBySymbolId.set(symbolKey, binding);
    });
    functionReturnBindings.clear();
    nextFunctionReturnBindings.forEach((binding, symbolKey) => {
      functionReturnBindings.set(symbolKey, binding);
    });
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
          const methodSegment = calleeAccessPath.segments.at(-1);
          const methodName = methodSegment?.kind === "property" ? methodSegment.value : undefined;
          const symbol = project.checker.getSymbolAtLocation(calleeAccessPath.root);
          const tracked = symbol ? trackedBySymbolId.get(getSymbolKey(symbol)) : undefined;
          const targetPath = tracked ? [...tracked.prefix, ...calleeAccessPath.segments.slice(0, -1)] : undefined;
          if (tracked && methodName && targetPath) {
            const targetCollection = getCollectionInfo(tracked.trackedObject, targetPath);
            if (WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
              markObservedSubtree(tracked.trackedObject, targetPath);
            }
            if (
              targetCollection?.kind === "array"
              && (
                ARRAY_APPEND_METHODS.has(methodName)
                || ARRAY_TRUNCATE_METHODS.has(methodName)
                || ARRAY_REPLACEMENT_METHODS.has(methodName)
                || ARRAY_REORDER_METHODS.has(methodName)
              )
            ) {
              handleTrackedArrayMutation(project, tracked.trackedObject, sourceFile, node, targetPath, methodName);
            }
            if (
              targetCollection?.kind === "array"
              && EXACT_ARRAY_CALLBACK_METHODS.has(methodName)
              && node.arguments[0]
              && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
            ) {
              const callback = node.arguments[0];
              const paramIndex = getSupportedArrayCallbackParamIndex(methodName);
              const parameter = paramIndex === undefined ? undefined : callback.parameters[paramIndex];
              const symbolKey = parameter ? getBindingSymbolKey(project, parameter) : undefined;
              const projection = getProjectionBinding(tracked.trackedObject, targetPath);
              if (symbolKey && projection && callback.body) {
                visitProjectedArrayUsage(project, callback.body, new Map([[symbolKey, projection]]));
              }
            }
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
            const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
            if (collectionInfo?.kind === "array" && resolved.boundaryCategory) {
              recordArrayBoundary(
                project,
                resolved.binding.trackedObject,
                sourceFile,
                argument,
                fullPath,
                fullPath,
                resolved.boundaryCategory,
                resolved.boundaryReason ?? "computed property access prevents exact path analysis",
                true,
              );
            } else {
              markEscaped(
                resolved.binding.trackedObject,
                fullPath,
                resolved.boundaryCategory ?? "computed-property-access",
                resolved.boundaryReason ?? "computed property access prevents exact path analysis",
              );
            }
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

          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          if (collectionInfo?.kind === "array") {
            recordArrayBoundary(
              project,
              resolved.binding.trackedObject,
              sourceFile,
              argument,
              fullPath,
              fullPath,
              "array-opaque-mutation",
              resolved.segments.length === 0
                ? "collection passed to call expression escapes exact local analysis"
                : "collection path passed to call expression escapes exact local analysis",
              true,
            );
            continue;
          }

          if (
            resolved.segments.length > 0
            && !hasTrackedChildren(resolved.binding.trackedObject, fullPath)
            && !collectionInfo
          ) {
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
          const projection = getProjectionBinding(
            resolved.binding.trackedObject,
            [...resolved.binding.prefix, ...resolved.segments],
          );
          const symbolKey = getBindingSymbolKey(project, node.initializer);
          if (projection && symbolKey) {
            visitProjectedArrayUsage(project, node.statement, new Map([[symbolKey, projection]]));
          } else {
            markObservedSubtree(resolved.binding.trackedObject, [...resolved.binding.prefix, ...resolved.segments]);
          }
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
            const fullPath = [...resolved.binding.prefix, ...resolved.segments];
            const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
            if (collectionInfo?.kind === "array") {
              recordArrayBoundary(
                project,
                resolved.binding.trackedObject,
                sourceFile,
                node,
                fullPath,
                fullPath,
                "array-spread",
                "array spread rebuilds collection contents beyond exact local analysis",
                true,
              );
            } else {
              markEscaped(
                resolved.binding.trackedObject,
                fullPath,
                "array-spread",
                "array spread escapes exact suffix contents",
              );
            }
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
          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          if (collectionInfo?.kind === "array" && resolved.boundaryCategory) {
            recordArrayBoundary(
              project,
              resolved.binding.trackedObject,
              sourceFile,
              node,
              fullPath,
              fullPath,
              resolved.boundaryCategory,
              resolved.boundaryReason ?? "computed property access prevents exact path analysis",
              true,
            );
          } else {
            markEscaped(
              resolved.binding.trackedObject,
              fullPath,
              resolved.boundaryCategory ?? "computed-property-access",
              resolved.boundaryReason ?? "computed property access prevents exact path analysis",
            );
          }
          return ts.forEachChild(node, visit);
        }

        if (fullPath.length === 0) {
          return ts.forEachChild(node, visit);
        }

        if (isAssignmentLeft(node)) {
          if (fullPath.length > 1) {
            markRead(resolved.binding.trackedObject, fullPath.slice(0, -1));
          }
          maybeInvalidateReplacedTrackedPath(project, resolved.binding.trackedObject, sourceFile, node, fullPath);
          markWrite(resolved.binding.trackedObject, fullPath);
        } else {
          maybeReportInvalidatedRead(
            project,
            sourceFile,
            state,
            suppressionContext,
            resolved.binding.trackedObject,
            node,
            fullPath,
          );
          markRead(resolved.binding.trackedObject, fullPath);
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isArrayBindingPattern(node.name) &&
        node.initializer
      ) {
        const resolved = resolveTrackedObjectAccess(project, node.initializer, trackedBySymbolId, functionReturnBindings);
        if (!resolved || resolved.dynamic) {
          return ts.forEachChild(node, visit);
        }

        const projection = getProjectionBinding(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
        );
        if (!projection) {
          return ts.forEachChild(node, visit);
        }

        node.name.elements.forEach((element, index) => {
          if (ts.isOmittedExpression(element)) {
            return;
          }

          if (element.dotDotDotToken) {
            recordArrayBoundary(
              project,
              projection.trackedObject,
              sourceFile,
              element,
              projection.sourcePath,
              projection.sourcePath,
              "array-rest",
              "array rest pattern escapes remaining elements",
              true,
            );
            return;
          }

          if (ts.isIdentifier(element.name)) {
            markProjectionReads(projection, [indexSegment(index)]);
            return;
          }

          markProjectionReads(projection, [indexSegment(index)], true);
        });
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
            markRead(
              resolved.binding.trackedObject,
              [...resolved.binding.prefix, ...resolved.segments, propertySegment(keyNode.text)],
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  for (const tracked of trackedObjects) {
    for (const boundary of tracked.collectionBoundaries.values()) {
      if (!shouldReportCollectionBoundary(tracked, boundary.path)) {
        continue;
      }
      const suppression = getSuppressionAudit(project, suppressionContext, boundary.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    for (const [joinedPath, objectNode] of tracked.nodes) {
      if (isCollectionPathInvalidated(tracked, objectNode.fullPath)) {
        continue;
      }

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
        const findingKind = kindToFinding(objectNode.entity.kind);
        if (!findingKind) {
          continue;
        }
        addFinding(
          state,
          objectNode.entity,
          findingKind,
          "eligible object path is declared or written but never read",
          objectNode.entity.kind === "array-element"
            ? `Unused array element ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`
            : `Unused object path ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`,
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
      run: () => analyzeCompilerSafetyDiagnostics(project, reachableFiles, state, suppressionContext),
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
