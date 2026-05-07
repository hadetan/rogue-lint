import ts from "typescript";

import { buildSuppressionContext, getSuppressionAudit } from "../../suppressions.js";
import type {
  AuditRecord,
  CollectionBoundaryRecord,
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
  TrackedObjectStructuralRole,
} from "../../types.js";
import {
  getSymbolKey,
  hasModifier,
  isReadLikeUse,
} from "../../compiler/ast-utils.js";
import {
  makeEntity,
  kindToFinding,
} from "../../shared/entity-utils.js";
import {
  indexSegment,
  isSerializedPathWithin,
  propertySegment,
  renderPath,
  renderPathWithRoot,
  samePath,
  serializePath,
  toRelative,
} from "../../shared/path-utils.js";

/**
 * Shared tracking kernel for the heavy analyzer stages.
 *
 * This module owns the tracked-object graph, helper-summary propagation, and the exactness gates used by
 * value-liveness and object-path analysis. When an access path, helper boundary, or mutation stops being
 * provably exact, callers must record a conservative skip or audit instead of continuing to infer structure.
 */

interface AnalysisState {
  findings: FindingRecord[];
  kept: AuditRecord[];
  skipped: AuditRecord[];
}

type TrackedValueFate =
  | "observed"
  | "inserted-by-reference"
  | "shallow-cloned"
  | "deep-cloned"
  | "resource-transferred"
  | "escaped-opaquely"
  | "overwritten"
  | "invalidated";

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
  callablePurity: Map<string, boolean | null>;
}

interface TrackedObjectBinding {
  trackedObject: TrackedObject;
  prefix: PathSegment[];
}

type CallableReturnSummary =
  | { kind: "value" }
  | { kind: "structured"; binding: TrackedObjectBinding }
  | { kind: "returned-alias"; binding: TrackedObjectBinding }
  | { kind: "opaque" };

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
  viaAliasObjectId?: string;
  viaAliasPath?: PathSegment[];
}

interface ArrayProjectionBinding {
  trackedObject: TrackedObject;
  sourcePath: PathSegment[];
  elementPaths: PathSegment[][];
}

interface ProjectedArrayUsageContext {
  elementBindings: Map<string, ArrayProjectionBinding>;
  receiverBindings: Map<string, ArrayProjectionBinding>;
  indexBindings: Map<string, ArrayProjectionBinding>;
}

interface ExactAppendAliasSlotPlan {
  kind: "alias";
  binding: TrackedObjectBinding;
  observeSourceAtInsert: boolean;
  insertReason: string;
  sourceObservationReason?: string;
}

interface ExactAppendValueSlotPlan {
  kind: "value";
  insertReason: string;
}

type ExactAppendSlotPlan = ExactAppendAliasSlotPlan | ExactAppendValueSlotPlan;

const STRUCTURAL_RECORD_FIELD_NAMES = new Set([
  "binding",
  "crossFileReferences",
  "dynamic",
  "findingKind",
  "kind",
  "reads",
  "reason",
  "references",
  "root",
  "sameFileReferences",
  "segments",
  "value",
  "viaAliasObjectId",
  "viaAliasPath",
  "writes",
]);

const STRUCTURAL_STATE_FIELD_NAMES = new Set([
  "diagnostics",
  "findings",
  "kept",
  "outgoing",
  "skipped",
  "unresolved",
]);

interface ResolvedProjectionAccess {
  projection: ArrayProjectionBinding;
  suffix: PathSegment[];
  dynamic: boolean;
  boundaryCategory?: SkipCategory;
  boundaryReason?: string;
}

type HelperParameterEffectKind =
  | "read"
  | "mutation"
  | "returned-alias"
  | "retained-binding"
  | "opaque-escape";

interface HelperParameterSummary {
  effectKinds: Set<HelperParameterEffectKind>;
  boundaryNode?: ts.Node;
  boundaryReason?: string;
}

class HelperParameterSummaryState implements HelperParameterSummary {
  readonly effectKinds = new Set<HelperParameterEffectKind>();

  constructor(
    public boundaryNode?: ts.Node,
    public boundaryReason?: string,
  ) {}
}

class CollectionInfoRecord implements TrackedCollectionInfo {
  readonly childPaths: PathSegment[][] = [];

  constructor(
    public kind: "object" | "array",
    public path: PathSegment[],
    public arrayLength?: number,
  ) {}
}

class CollectionState implements TrackedCollectionState {
  constructor(
    public path: PathSegment[],
    public epoch = 0,
    public arrayLength?: number,
  ) {}
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function getStaticObjectLiteralPropertyName(
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

function isPureObjectConstructorExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  if (!["Map", "Set", "WeakMap", "WeakSet"].includes(node.expression.text)) {
    return false;
  }
  return (node.arguments ?? []).every((argument) => isStructurallySimpleExpression(argument));
}

function isStructurallySimpleExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (
    ts.isIdentifier(node)
    || ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node)
    || ts.isNumericLiteral(node)
    || ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.BigIntLiteral
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    return isStructurallySimpleExpression(node.operand);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => !ts.isSpreadElement(element) && isStructurallySimpleExpression(element));
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      const propertyName = getStaticObjectLiteralPropertyName(property);
      if (!propertyName) {
        return false;
      }
      return ts.isShorthandPropertyAssignment(property)
        || (ts.isPropertyAssignment(property) && isStructurallySimpleExpression(property.initializer));
    });
  }

  if (ts.isConditionalExpression(node)) {
    return isStructurallySimpleExpression(node.condition)
      && isStructurallySimpleExpression(node.whenTrue)
      && isStructurallySimpleExpression(node.whenFalse);
  }

  if (ts.isBinaryExpression(node)) {
    return node.operatorToken.kind !== ts.SyntaxKind.CommaToken
      && !ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
      && isStructurallySimpleExpression(node.left)
      && isStructurallySimpleExpression(node.right);
  }

  return isPureObjectConstructorExpression(node);
}

function classifyTrackedObjectStructuralRole(
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): TrackedObjectStructuralRole | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  const fieldNames: string[] = [];
  let allSimple = true;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      return undefined;
    }
    const propertyName = getStaticObjectLiteralPropertyName(property);
    if (!propertyName) {
      return undefined;
    }
    fieldNames.push(propertyName);
    if (ts.isPropertyAssignment(property) && !isStructurallySimpleExpression(property.initializer)) {
      allSimple = false;
    }
  }

  if (fieldNames.length === 0) {
    return undefined;
  }

  if (fieldNames.some((fieldName) => STRUCTURAL_STATE_FIELD_NAMES.has(fieldName))) {
    return "state-holder";
  }

  if (
    fieldNames.includes("kind")
    || fieldNames.includes("state")
    || (fieldNames.length <= 4 && allSimple)
  ) {
    return "record";
  }

  return undefined;
}

function getLeadingStructuralFieldName(segments: PathSegment[]): string | undefined {
  const [firstSegment] = segments;
  return firstSegment?.kind === "property" ? firstSegment.value : undefined;
}

function shouldSuppressStructuralPath(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  const fieldName = getLeadingStructuralFieldName(segments);
  if (!fieldName) {
    return false;
  }

  if (trackedObject.structuralRole === "record") {
    return STRUCTURAL_RECORD_FIELD_NAMES.has(fieldName);
  }

  if (trackedObject.structuralRole === "state-holder") {
    return STRUCTURAL_STATE_FIELD_NAMES.has(fieldName);
  }

  return false;
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

const OBSERVATION_ONLY_CALLS = new Set([
  "console.log",
  "console.info",
  "console.debug",
  "console.warn",
  "console.error",
  "console.dir",
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

function sameCallableReturnSummaryMap(
  left: Map<string, CallableReturnSummary>,
  right: Map<string, CallableReturnSummary>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [symbolKey, summary] of left) {
    const other = right.get(symbolKey);
    if (other === undefined) {
      return false;
    }

    if (!sameCallableReturnSummary(summary, other)) {
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

function getCanonicalSymbol(project: ProjectContext, symbol: ts.Symbol): ts.Symbol {
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

function getCanonicalSymbolKey(project: ProjectContext, symbol: ts.Symbol): string {
  return getSymbolKey(getCanonicalSymbol(project, symbol));
}

function getGlobalThisBindingKey(propertyName: string): string {
  return `globalThis:${propertyName}`;
}

function isGlobalThisIdentifier(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === "globalThis";
}

function getStaticGlobalThisPropertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isGlobalThisIdentifier(node.expression)) {
    return node.name.text;
  }

  if (
    ts.isElementAccessExpression(node)
    && isGlobalThisIdentifier(node.expression)
    && ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }

  return undefined;
}

function getHelperLocationText(project: ProjectContext, sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  return `${toRelative(project.rootPath, sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function addHelperParameterEffect(summary: HelperParameterSummary, effect: HelperParameterEffectKind): void {
  summary.effectKinds.add(effect);
}

function markHelperParameterBoundary(
  summary: HelperParameterSummary,
  node: ts.Node,
  reason: string,
): void {
  addHelperParameterEffect(summary, "opaque-escape");
  if (!summary.boundaryReason) {
    summary.boundaryNode = node;
    summary.boundaryReason = reason;
  }
}

function isSymbolDeclaredWithinFunction(symbol: ts.Symbol, declaration: ts.FunctionLikeDeclaration): boolean {
  return (symbol.declarations ?? []).some((candidate) => ts.findAncestor(candidate, (ancestor) => ancestor === declaration));
}

function getHelperAssignmentTargetSymbol(
  project: ProjectContext,
  node: ts.Node,
): ts.Symbol | undefined {
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  return symbol ? getCanonicalSymbol(project, symbol) : undefined;
}

function isWholeValueReferenceStorageUse(node: ts.Identifier): boolean {
  return (
    (ts.isShorthandPropertyAssignment(node.parent)
      && node.parent.name === node
      && ts.isObjectLiteralExpression(node.parent.parent))
    || (ts.isPropertyAssignment(node.parent)
      && node.parent.initializer === node
      && ts.isObjectLiteralExpression(node.parent.parent))
    || (ts.isArrayLiteralExpression(node.parent) && node.parent.elements.includes(node))
  );
}

function findDirectReferenceStorageParameterUse(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  parameterName: ts.Identifier,
): ts.Identifier | undefined {
  const parameterSymbol = project.checker.getSymbolAtLocation(parameterName);
  if (!parameterSymbol || !declaration.body) {
    return undefined;
  }

  const parameterKey = getSymbolKey(parameterSymbol);
  let storageNode: ts.Identifier | undefined;

  const visit = (node: ts.Node): void => {
    if (storageNode) {
      return;
    }

    if (ts.isFunctionLike(node) && node !== declaration) {
      return;
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(node);
      if (valueSymbol && getSymbolKey(valueSymbol) === parameterKey) {
        storageNode = node.name;
        return;
      }
    }

    if (ts.isIdentifier(node) && node !== parameterName) {
      const symbol = project.checker.getSymbolAtLocation(node);
      if (symbol && getSymbolKey(symbol) === parameterKey && isWholeValueReferenceStorageUse(node)) {
        storageNode = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(declaration.body, visit);
  return storageNode;
}

function getBindingByNode(
  project: ProjectContext,
  node: ts.Node,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
): TrackedObjectBinding | undefined {
  if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(node.parent);
    if (valueSymbol) {
      return trackedBySymbolId.get(getCanonicalSymbolKey(project, valueSymbol));
    }
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }
  return trackedBySymbolId.get(getCanonicalSymbolKey(project, symbol));
}

function addValueFate(
  trackedObject: TrackedObject,
  fate: TrackedValueFate,
  path: PathSegment[],
  reason: string,
  relatedObjectId?: string,
  relatedPath?: PathSegment[],
): void {
  const exists = trackedObject.valueFates.some((record) =>
    record.fate === fate
    && record.reason === reason
    && samePath(record.path, path)
    && record.relatedObjectId === relatedObjectId
    && samePath(record.relatedPath ?? [], relatedPath ?? []),
  );
  if (!exists) {
    trackedObject.valueFates.push({
      fate,
      path,
      reason,
      relatedObjectId,
      relatedPath,
    });
  }
}

function clearExactAliasesWithin(trackedObject: TrackedObject, segments: PathSegment[]): void {
  const prefix = serializePath(segments);
  for (const key of [...trackedObject.exactPathAliases.keys()]) {
    if (isSerializedPathWithin(key, prefix)) {
      trackedObject.exactPathAliases.delete(key);
    }
  }
}

function registerExactPathAlias(
  receiver: TrackedObject,
  receiverPath: PathSegment[],
  sourceBinding: TrackedObjectBinding,
  reason: string,
): void {
  receiver.exactPathAliases.set(serializePath(receiverPath), {
    fate: "inserted-by-reference",
    sourceObjectId: sourceBinding.trackedObject.id,
    sourcePath: sourceBinding.prefix,
    observed: false,
  });
  addValueFate(
    receiver,
    "inserted-by-reference",
    receiverPath,
    reason,
    sourceBinding.trackedObject.id,
    sourceBinding.prefix,
  );
  addValueFate(
    sourceBinding.trackedObject,
    "inserted-by-reference",
    sourceBinding.prefix,
    reason,
    receiver.id,
    receiverPath,
  );
}

function materializeExactAppendSlot(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  receiverPath: PathSegment[],
  slotPlan: ExactAppendSlotPlan,
): void {
  ensureTrackedArraySlotNode(project, trackedObject, sourceFile, node, receiverPath);
  clearExactAliasesWithin(trackedObject, receiverPath);
  if (slotPlan.kind === "alias") {
    registerExactPathAlias(trackedObject, receiverPath, slotPlan.binding, slotPlan.insertReason);
    if (slotPlan.observeSourceAtInsert) {
      markRead(slotPlan.binding.trackedObject, slotPlan.binding.prefix);
      if (slotPlan.sourceObservationReason) {
        addValueFate(
          slotPlan.binding.trackedObject,
          "observed",
          slotPlan.binding.prefix,
          slotPlan.sourceObservationReason,
          trackedObject.id,
          receiverPath,
        );
      }
    }
  }
  markWrite(trackedObject, receiverPath);
}

function resolveExactPathAlias(
  binding: TrackedObjectBinding,
  nextSegments: PathSegment[],
  trackedObjectsById: Map<string, TrackedObject>,
): { binding: TrackedObjectBinding; viaAliasObjectId?: string; viaAliasPath?: PathSegment[] } {
  const fullPath = [...binding.prefix, ...nextSegments];
  const alias = binding.trackedObject.exactPathAliases.get(serializePath(fullPath));
  if (!alias) {
    return { binding, viaAliasObjectId: undefined, viaAliasPath: undefined };
  }

  const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
  if (!sourceTrackedObject) {
    return { binding, viaAliasObjectId: undefined, viaAliasPath: undefined };
  }

  return {
    binding: {
      trackedObject: sourceTrackedObject,
      prefix: alias.sourcePath,
    },
    viaAliasObjectId: binding.trackedObject.id,
    viaAliasPath: fullPath,
  };
}

function markAliasObserved(
  resolved: ResolvedTrackedObjectAccess,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  if (!resolved.viaAliasObjectId || !resolved.viaAliasPath) {
    return;
  }

  const receiver = trackedObjectsById.get(resolved.viaAliasObjectId);
  const alias = receiver?.exactPathAliases.get(serializePath(resolved.viaAliasPath));
  if (alias) {
    alias.observed = true;
  }
  if (receiver) {
    markRead(receiver, resolved.viaAliasPath);
  }
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
  arrayLength?: number,
): TrackedCollectionInfo {
  const info = new CollectionInfoRecord(kind, segments, arrayLength);
  trackedObject.collections.set(serializePath(segments), info);
  ensureCollectionState(trackedObject, segments, arrayLength);
  return info;
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

function ensureCollectionChildPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  childPath: PathSegment[],
): void {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.childPaths.some((existing) => samePath(existing, childPath))) {
    return;
  }

  collection.childPaths.push(childPath);
}

function ensureTrackedArraySlotNode(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  const joinedPath = serializePath(fullPath);
  if (!trackedObject.nodes.has(joinedPath)) {
    const entity = makeEntity(
      project.rootPath,
      fullPath.length === 1 ? "array-element" : "nested-path",
      sourceFile,
      node,
      renderPath(fullPath),
      trackedObject.rootName,
    );
    trackedObject.nodes.set(joinedPath, { entity, fullPath });
    indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
  }

  trackedObject.placeStates.set(joinedPath, "initialized");
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
        findingKind: "invalidated-read",
        reason,
      };
    case "array-truncate-mutation":
    case "array-reorder-mutation":
      return {
        findingKind: "stale-read-after-mutation",
        reason,
      };
    default:
      return {
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
  addValueFate(trackedObject, "escaped-opaquely", record.path, record.reason);
  clearExactAliasesWithin(trackedObject, record.path);
  if (invalidatePath) {
    const joinedPath = serializePath(invalidatePath);
    trackedObject.invalidatedCollectionPaths.add(joinedPath);
    setPlaceState(trackedObject, invalidatePath, "invalidated");
    addValueFate(trackedObject, "invalidated", invalidatePath, record.reason);
    clearExactAliasesWithin(trackedObject, invalidatePath);
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
  addValueFate(
    trackedObject,
    "invalidated",
    affectedPath,
    invalidatedRecord?.reason ?? "collection mutation invalidated the previously tracked path",
  );
  clearExactAliasesWithin(trackedObject, affectedPath);
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
  if (shouldSuppressStructuralPath(trackedObject, segments)) {
    return false;
  }

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
        || projection.trackedObject.exactPathAliases.has(serializedPath)
        || hasTrackedChildren(projection.trackedObject, fullPath);
    });
}

function markProjectionReads(
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[] = [],
  observeSubtree = false,
): void {
  const concretePaths = getConcreteProjectionPaths(projection, suffix);
  for (const fullPath of concretePaths) {
    const alias = projection.trackedObject.exactPathAliases.get(serializePath(fullPath));
    if (alias) {
      const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
      if (sourceTrackedObject) {
        alias.observed = true;
        if (observeSubtree) {
          markObservedSubtree(sourceTrackedObject, alias.sourcePath, trackedObjectsById);
        } else {
          markRead(sourceTrackedObject, alias.sourcePath);
        }
        continue;
      }
    }

    if (observeSubtree) {
      markObservedSubtree(projection.trackedObject, fullPath, trackedObjectsById);
    } else {
      markRead(projection.trackedObject, fullPath);
    }
  }
}

function markProjectionWrites(
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  suffix: PathSegment[],
): void {
  const concretePaths = getConcreteProjectionPaths(projection, suffix);
  for (const fullPath of concretePaths) {
    const alias = projection.trackedObject.exactPathAliases.get(serializePath(fullPath));
    if (alias) {
      const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
      if (sourceTrackedObject) {
        markWrite(sourceTrackedObject, alias.sourcePath);
        continue;
      }
    }

    markWrite(projection.trackedObject, fullPath);
  }
}

function markProjectionElementRead(
  projection: ArrayProjectionBinding,
  trackedObjectsById: Map<string, TrackedObject>,
  index: number,
  observeSubtree = false,
): void {
  const elementPath = projection.elementPaths[index];
  if (!elementPath) {
    return;
  }

  const alias = projection.trackedObject.exactPathAliases.get(serializePath(elementPath));
  if (alias) {
    const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
    if (sourceTrackedObject) {
      alias.observed = true;
      if (observeSubtree) {
        markObservedSubtree(sourceTrackedObject, alias.sourcePath, trackedObjectsById);
      } else {
        markRead(sourceTrackedObject, alias.sourcePath);
      }
      return;
    }
  }

  if (observeSubtree) {
    markObservedSubtree(projection.trackedObject, elementPath, trackedObjectsById);
  } else {
    markRead(projection.trackedObject, elementPath);
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

function getSupportedArrayCallbackIndexParamIndex(methodName: string): number | undefined {
  const valueParamIndex = getSupportedArrayCallbackParamIndex(methodName);
  return valueParamIndex === undefined ? undefined : valueParamIndex + 1;
}

function getContainerTypeName(project: ProjectContext, expression: ts.Expression): string | undefined {
  const typeSymbol = project.checker.getTypeAtLocation(expression).getSymbol();
  return typeSymbol?.getName();
}

function isSupportedRetainedBindingContainerType(project: ProjectContext, expression: ts.Expression): boolean {
  const typeName = getContainerTypeName(project, expression);
  return typeName === "Map" || typeName === "WeakMap";
}

function isLocallyOwnedRetainedBindingContainer(project: ProjectContext, expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (!ts.isIdentifier(node)) {
    return false;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }

  return getCanonicalSymbol(project, symbol).declarations?.some((declaration) =>
    ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && ts.isNewExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression)
      && ["Map", "WeakMap"].includes(declaration.initializer.expression.text)
  ) ?? false;
}

function getRetainedBindingContainerSlotToken(project: ProjectContext, expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `string:${node.text}`;
  }
  if (ts.isNumericLiteral(node)) {
    return `number:${node.text}`;
  }
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? `symbol:${getCanonicalSymbolKey(project, symbol)}` : undefined;
  }
  return undefined;
}

function getRetainedBindingContainerSlotKey(
  project: ProjectContext,
  receiver: ts.Expression,
  slot: ts.Expression,
): string | undefined {
  const node = unwrapExpression(receiver);
  if (!ts.isIdentifier(node) || !isSupportedRetainedBindingContainerType(project, node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  const slotToken = getRetainedBindingContainerSlotToken(project, slot);
  if (!symbol || !slotToken) {
    return undefined;
  }

  return `container:${getCanonicalSymbolKey(project, symbol)}:${slotToken}`;
}

function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent)
    && ts.isVariableStatement(node.parent.parent)
    && hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword);
}

function isTrackablePureExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (
    ts.isNumericLiteral(node)
    || ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.BigIntLiteral
    || ts.isIdentifier(node)
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    return ![
      ts.SyntaxKind.PlusPlusToken,
      ts.SyntaxKind.MinusMinusToken,
      ts.SyntaxKind.DeleteKeyword,
    ].includes(node.operator)
      && isTrackablePureExpression(node.operand);
  }

  if (ts.isConditionalExpression(node)) {
    return isTrackablePureExpression(node.condition)
      && isTrackablePureExpression(node.whenTrue)
      && isTrackablePureExpression(node.whenFalse);
  }

  if (ts.isBinaryExpression(node)) {
    return node.operatorToken.kind !== ts.SyntaxKind.CommaToken
      && !ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
      && isTrackablePureExpression(node.left)
      && isTrackablePureExpression(node.right);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) =>
      !ts.isSpreadElement(element) && isTrackablePureExpression(element as ts.Expression),
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
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

function getAllowlistedIgnoredResultReason(expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    if (methodName === "slice" || methodName === "concat") {
      return `${methodName} returns a new value; ignoring the result is usually a bug`;
    }
  }

  if (ts.isIdentifier(node.expression) && node.expression.text === "structuredClone") {
    return "structuredClone returns a new cloned value; ignoring the result is usually a bug";
  }

  return undefined;
}

function isExplicitlyPureIgnoredResultCall(expression: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(expression.expression)) {
    const methodName = expression.expression.name.text;
    if (methodName === "slice" || methodName === "concat") {
      return isTrackablePureExpression(expression.expression.expression)
        && expression.arguments.every((argument) => isTrackablePureExpression(argument));
    }
  }

  return ts.isIdentifier(expression.expression)
    && expression.expression.text === "structuredClone"
    && expression.arguments.every((argument) => isTrackablePureExpression(argument));
}

function getCallableReturnBinding(summary: CallableReturnSummary | undefined): TrackedObjectBinding | undefined {
  if (!summary || summary.kind === "value" || summary.kind === "opaque") {
    return undefined;
  }

  return summary.binding;
}

function sameCallableReturnSummary(left: CallableReturnSummary, right: CallableReturnSummary): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  const leftBinding = getCallableReturnBinding(left);
  const rightBinding = getCallableReturnBinding(right);
  if (!leftBinding || !rightBinding) {
    return true;
  }

  return sameTrackedBinding(leftBinding, rightBinding);
}

function getIgnoredResultReason(
  project: ProjectContext,
  expression: ts.Expression,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  caches: ValueAnalysisCaches,
): string | undefined {
  const node = unwrapExpression(expression);
  if (ts.isCallExpression(node)) {
    const callable = getAnalyzableCallableBinding(project, node.expression);
    const summary = callable ? functionReturnSummaries.get(callable.symbolKey) : undefined;
    if (callable && summary && summary.kind !== "opaque" && (
      isExplicitlyPureIgnoredResultCall(node)
      || isSideEffectNeutralCallable(project, callable.declaration, caches)
    )) {
      return "analyzable function return value is discarded";
    }
  }

  return getAllowlistedIgnoredResultReason(node);
}

function isSideEffectNeutralCallable(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  caches: ValueAnalysisCaches,
): boolean {
  const callable = getAnalyzableCallableBindingFromDeclaration(project, declaration);
  if (!callable?.declaration.body) {
    return false;
  }

  const cached = caches.callablePurity.get(callable.symbolKey);
  if (cached === null) {
    return false;
  }
  if (cached !== undefined) {
    return cached;
  }

  caches.callablePurity.set(callable.symbolKey, null);
  const localSymbolKeys = new Set<string>();
  for (const parameter of callable.declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      caches.callablePurity.set(callable.symbolKey, false);
      return false;
    }
    const symbol = project.checker.getSymbolAtLocation(parameter.name);
    if (symbol) {
      localSymbolKeys.add(getCanonicalSymbolKey(project, symbol));
    }
  }

  const rememberBindingName = (name: ts.BindingName): boolean => {
    if (!ts.isIdentifier(name)) {
      return false;
    }
    const symbol = project.checker.getSymbolAtLocation(name);
    if (symbol) {
      localSymbolKeys.add(getCanonicalSymbolKey(project, symbol));
    }
    return true;
  };

  const isPureExpressionInCallable = (expression: ts.Expression): boolean => {
    const node = unwrapExpression(expression);
    if (
      ts.isNumericLiteral(node)
      || ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword
      || node.kind === ts.SyntaxKind.FalseKeyword
      || node.kind === ts.SyntaxKind.NullKeyword
      || node.kind === ts.SyntaxKind.BigIntLiteral
      || ts.isIdentifier(node)
    ) {
      return true;
    }

    if (ts.isPrefixUnaryExpression(node)) {
      return ![
        ts.SyntaxKind.PlusPlusToken,
        ts.SyntaxKind.MinusMinusToken,
        ts.SyntaxKind.DeleteKeyword,
      ].includes(node.operator)
        && isPureExpressionInCallable(node.operand);
    }

    if (ts.isConditionalExpression(node)) {
      return isPureExpressionInCallable(node.condition)
        && isPureExpressionInCallable(node.whenTrue)
        && isPureExpressionInCallable(node.whenFalse);
    }

    if (ts.isBinaryExpression(node)) {
      return node.operatorToken.kind !== ts.SyntaxKind.CommaToken
        && !ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
        && isPureExpressionInCallable(node.left)
        && isPureExpressionInCallable(node.right);
    }

    if (ts.isPropertyAccessExpression(node)) {
      return isPureExpressionInCallable(node.expression);
    }

    if (ts.isElementAccessExpression(node)) {
      return isPureExpressionInCallable(node.expression)
        && (!node.argumentExpression || isPureExpressionInCallable(node.argumentExpression));
    }

    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((element) => !ts.isSpreadElement(element) && isPureExpressionInCallable(element));
    }

    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every((property) => {
        if (ts.isSpreadAssignment(property)) {
          return false;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return isPureExpressionInCallable(property.name);
        }
        return ts.isPropertyAssignment(property)
          && !!getStaticObjectLiteralPropertyName(property)
          && isPureExpressionInCallable(property.initializer);
      });
    }

    if (isPureObjectConstructorExpression(node)) {
      return true;
    }

    if (!ts.isCallExpression(node)) {
      return false;
    }

    if (isExplicitlyPureIgnoredResultCall(node)) {
      return true;
    }

    const nestedCallable = getAnalyzableCallableBinding(project, node.expression);
    return !!nestedCallable
      && node.arguments.every((argument) => isPureExpressionInCallable(argument))
      && isSideEffectNeutralCallable(project, nestedCallable.declaration, caches);
  };

  const isPureStatement = (statement: ts.Statement): boolean => {
    if (ts.isBlock(statement)) {
      return statement.statements.every((nestedStatement) => isPureStatement(nestedStatement));
    }

    if (ts.isReturnStatement(statement)) {
      return !statement.expression || isPureExpressionInCallable(statement.expression);
    }

    if (ts.isVariableStatement(statement)) {
      for (const declarationNode of statement.declarationList.declarations) {
        if (!rememberBindingName(declarationNode.name)) {
          return false;
        }
        if (declarationNode.initializer && !isPureExpressionInCallable(declarationNode.initializer)) {
          return false;
        }
      }
      return true;
    }

    if (ts.isIfStatement(statement)) {
      return isPureExpressionInCallable(statement.expression)
        && isPureStatement(statement.thenStatement)
        && (!statement.elseStatement || isPureStatement(statement.elseStatement));
    }

    if (ts.isEmptyStatement(statement)) {
      return true;
    }

    return false;
  };

  const result = ts.isBlock(callable.declaration.body)
    ? callable.declaration.body.statements.every((statement) => isPureStatement(statement))
    : isPureExpressionInCallable(callable.declaration.body);

  caches.callablePurity.set(callable.symbolKey, result);
  return result;
}

function getFunctionLikeDeclarationFromSymbol(symbol: ts.Symbol): ts.FunctionLikeDeclaration | undefined {
  const declaration = symbol.declarations?.[0];
  if (
    declaration
    && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration))
  ) {
    return declaration;
  }

  if (
    declaration
    && ts.isVariableDeclaration(declaration)
    && declaration.initializer
    && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
  ) {
    return declaration.initializer;
  }

  return undefined;
}

function getAnalyzableCallableName(callable: AnalyzableCallableBinding): string {
  const declaration = callable.declaration;
  if (declaration.name && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }

  if ((ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && ts.isVariableDeclaration(declaration.parent)) {
    const parentName = declaration.parent.name;
    if (ts.isIdentifier(parentName)) {
      return parentName.text;
    }
  }

  return "returnedValue";
}

function getAnalyzableCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): AnalyzableCallableBinding | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const calleeSymbol = project.checker.getSymbolAtLocation(expression);
  if (!calleeSymbol) {
    return undefined;
  }

  const callable = getFunctionLikeDeclarationFromSymbol(getCanonicalSymbol(project, calleeSymbol));

  if (!callable?.body) {
    return undefined;
  }

  return callable.getSourceFile().fileName.startsWith(project.rootPath)
    ? {
        declaration: callable,
        symbolKey: getCanonicalSymbolKey(project, calleeSymbol),
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
        symbolKey: getCanonicalSymbolKey(project, symbol),
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
          symbolKey: getCanonicalSymbolKey(project, symbol),
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

  const body = declaration.body;
  const parameterKey = getCanonicalSymbolKey(project, parameterSymbol);
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
      if (!symbol || getCanonicalSymbolKey(project, symbol) !== parameterKey || node === parameterName) {
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

  ts.forEachChild(body, visit);
  caches.parameterMeaningfulUse.set(parameterKey, meaningful);
  return meaningful;
}

function isSupportedTrackedArrayCallbackBoundary(
  project: ProjectContext,
  node: ts.FunctionLikeDeclaration,
  trackedAliasKeys: Set<string>,
): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }

  const callbackIndex = parent.arguments.findIndex((argument) => argument === node);
  if (callbackIndex !== 0 || !ts.isPropertyAccessExpression(parent.expression)) {
    return false;
  }

  const methodName = parent.expression.name.text;
  if (!EXACT_ARRAY_CALLBACK_METHODS.has(methodName)) {
    return false;
  }

  const receiver = unwrapExpression(parent.expression.expression);
  if (!ts.isIdentifier(receiver)) {
    return false;
  }

  const receiverSymbol = project.checker.getSymbolAtLocation(receiver);
  return receiverSymbol ? trackedAliasKeys.has(getCanonicalSymbolKey(project, receiverSymbol)) : false;
}

function summarizeHelperParameterUse(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  parameterName: ts.Identifier,
  cache: Map<string, boolean | null>,
  summaryCache: Map<string, HelperParameterSummary | null>,
): HelperParameterSummary {
  const parameterSymbol = project.checker.getSymbolAtLocation(parameterName);
  if (!parameterSymbol || !declaration.body) {
    const summary = new HelperParameterSummaryState(
      parameterName,
      "helper parameter cannot be resolved for exact analysis",
    );
    addHelperParameterEffect(summary, "opaque-escape");
    return summary;
  }

  const body = declaration.body;
  const parameterKey = getCanonicalSymbolKey(project, parameterSymbol);
  const cached = summaryCache.get(parameterKey);
  if (cached === null) {
    const summary = new HelperParameterSummaryState(
      parameterName,
      "recursive same-project helper forwarding prevents exact helper lifecycle analysis",
    );
    addHelperParameterEffect(summary, "opaque-escape");
    return summary;
  }
  if (cached !== undefined) {
    return cached;
  }

  summaryCache.set(parameterKey, null);
  const trackedAliasKeys = new Set<string>([parameterKey]);
  const summary = new HelperParameterSummaryState();

  const isTrackedAliasIdentifier = (node: ts.Node): node is ts.Identifier => {
    if (!ts.isIdentifier(node)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? trackedAliasKeys.has(getCanonicalSymbolKey(project, symbol)) : false;
  };

  const addAliasSymbol = (name: ts.BindingName): void => {
    if (!ts.isIdentifier(name)) {
      return;
    }

    const symbol = project.checker.getSymbolAtLocation(name);
    if (symbol) {
      trackedAliasKeys.add(getCanonicalSymbolKey(project, symbol));
    }
  };

  const handleTrackedAssignment = (left: ts.Expression): boolean => {
    const globalThisProperty = getStaticGlobalThisPropertyName(left);
    if (globalThisProperty) {
      addHelperParameterEffect(summary, "retained-binding");
      return true;
    }

    const target = getHelperAssignmentTargetSymbol(project, left);
    if (!target) {
      return false;
    }

    addHelperParameterEffect(summary, "retained-binding");
    if (isSymbolDeclaredWithinFunction(target, declaration)) {
      if (ts.isIdentifier(left)) {
        addAliasSymbol(left);
      }
      return true;
    }

    return true;
  };

  const visit = (node: ts.Node): void => {
    if (summary.boundaryReason) {
      return;
    }

    if (ts.isFunctionLike(node) && node !== declaration) {
      if (isSupportedTrackedArrayCallbackBoundary(project, node as ts.FunctionLikeDeclaration, trackedAliasKeys)) {
        return;
      }

      let capturesTrackedAlias = false;
      const inspectNestedCapture = (candidate: ts.Node): void => {
        if (capturesTrackedAlias) {
          return;
        }

        if (candidate !== node && ts.isFunctionLike(candidate)) {
          return;
        }

        if (isTrackedAliasIdentifier(candidate)) {
          capturesTrackedAlias = true;
          return;
        }

        ts.forEachChild(candidate, inspectNestedCapture);
      };

      const nestedBody = "body" in node ? node.body : undefined;
      if (nestedBody) {
        ts.forEachChild(nestedBody, inspectNestedCapture);
      }
      if (capturesTrackedAlias) {
        markHelperParameterBoundary(summary, node, "helper captures this value in a nested function beyond exact local analysis");
      }
      return;
    }

    if (ts.isVariableDeclaration(node) && node.initializer && isTrackedAliasIdentifier(node.initializer)) {
      if (!ts.isIdentifier(node.name)) {
        markHelperParameterBoundary(summary, node, "helper rebinds this value through an unsupported pattern");
        return;
      }
      addHelperParameterEffect(summary, "retained-binding");
      addAliasSymbol(node.name);
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(node);
      if (valueSymbol && trackedAliasKeys.has(getCanonicalSymbolKey(project, valueSymbol))) {
        markHelperParameterBoundary(summary, node.name, "helper stores this value inside an aggregate literal beyond exact local analysis");
        return;
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isTrackedAliasIdentifier(node.right)) {
      if (!handleTrackedAssignment(node.left)) {
        markHelperParameterBoundary(summary, node, "helper stores this value in an unsupported retained location");
        return;
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      if (isTrackedAliasIdentifier(node.expression)) {
        addHelperParameterEffect(summary, "returned-alias");
      }
      if (
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
        && isTrackedAliasIdentifier(node.expression.expression)
      ) {
        addHelperParameterEffect(summary, "returned-alias");
      }
    }

    if (ts.isIdentifier(node) && isTrackedAliasIdentifier(node)) {
      const parent = node.parent;

      if (
        ts.isShorthandPropertyAssignment(parent)
        || (ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isObjectLiteralExpression(parent.parent))
        || (ts.isArrayLiteralExpression(parent) && parent.elements.includes(node))
      ) {
        markHelperParameterBoundary(summary, parent, "helper stores this value inside an aggregate literal beyond exact local analysis");
        return;
      }

      if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        const argumentIndex = (parent.arguments ?? []).findIndex((argument) => argument === node);
        if (argumentIndex >= 0) {
          if (
            ts.isCallExpression(parent)
            && ts.isPropertyAccessExpression(parent.expression)
            && parent.expression.name.text === "set"
            && argumentIndex === 1
            && isSupportedRetainedBindingContainerType(project, parent.expression.expression)
          ) {
            addHelperParameterEffect(summary, "retained-binding");
            return;
          }

          const callable = resolveAnalyzableFunctionDeclaration(project, parent.expression);
          if (!callable) {
            markHelperParameterBoundary(summary, parent, "helper forwards this value into a call boundary beyond exact local analysis");
            return;
          }

          const nestedParameter = callable.parameters[argumentIndex];
          if (!nestedParameter || !ts.isIdentifier(nestedParameter.name)) {
            markHelperParameterBoundary(summary, parent, "helper forwards this value into an unsupported parameter shape");
            return;
          }

          const nestedSummary = summarizeHelperParameterUse(project, callable, nestedParameter.name, cache, summaryCache);
          nestedSummary.effectKinds.forEach((effect) => addHelperParameterEffect(summary, effect));
          if (nestedSummary.boundaryReason) {
            markHelperParameterBoundary(summary, nestedSummary.boundaryNode ?? parent, nestedSummary.boundaryReason);
          }
          return;
        }
      }

      if (
        ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && ts.isCallExpression(parent.parent)
        && parent.parent.expression === parent
      ) {
        const methodName = parent.name.text;
        if (
          WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)
          || EXACT_ARRAY_CALLBACK_METHODS.has(methodName)
          || ARRAY_APPEND_METHODS.has(methodName)
          || ARRAY_TRUNCATE_METHODS.has(methodName)
          || ARRAY_REPLACEMENT_METHODS.has(methodName)
          || ARRAY_REORDER_METHODS.has(methodName)
          || methodName === "at"
        ) {
          addHelperParameterEffect(summary, WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName) ? "read" : "mutation");
          return;
        }
      }

      if (
        ts.isElementAccessExpression(parent)
        && parent.expression === node
        && ts.isBinaryExpression(parent.parent)
        && parent.parent.left === parent
        && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        addHelperParameterEffect(summary, "mutation");
        return;
      }

      if (
        ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && ts.isBinaryExpression(parent.parent)
        && parent.parent.left === parent
        && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        addHelperParameterEffect(summary, "mutation");
        return;
      }

      const callArgumentUse = getCallArgumentUse(project, node, {
        parameterMeaningfulUse: cache,
        callablePurity: new Map(),
      });
      if (callArgumentUse === "read") {
        addHelperParameterEffect(summary, "read");
      } else if (isUpdateRead(node) || isReadLikeUse(node)) {
        addHelperParameterEffect(summary, "read");
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(body, visit);
  if (!summary.boundaryReason) {
    const directStorageNode = findDirectReferenceStorageParameterUse(project, declaration, parameterName);
    if (directStorageNode) {
      markHelperParameterBoundary(
        summary,
        directStorageNode,
        "helper stores this value by reference beyond exact local analysis",
      );
    }
  }
  summaryCache.set(parameterKey, summary);
  return summary;
}

function buildHelperBoundaryReason(
  project: ProjectContext,
  summary: HelperParameterSummary,
  fallback: string,
): string {
  if (!summary.boundaryReason || !summary.boundaryNode) {
    return fallback;
  }

  const causeSourceFile = summary.boundaryNode.getSourceFile();
  return `${summary.boundaryReason} (helper cause at ${getHelperLocationText(project, causeSourceFile, summary.boundaryNode)})`;
}

/**
 * Evaluates local value fates after the shared tracked-object graph has summarized helper and return behavior.
 *
 * Exact results only survive while bindings, helper summaries, and access paths stay analyzable. When the
 * kernel encounters dynamic or opaque behavior, it records conservative boundaries instead of guessing.
 */
export function analyzeValueLiveness(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  const { functionReturnSummaries } = buildTrackedObjects(project, reachableFiles);

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const trackedBindings = new Map<string, TrackedValueBinding>();
    const accesses = new Map<string, ValueAccess[]>();
    const valueAnalysisCaches: ValueAnalysisCaches = {
      parameterMeaningfulUse: new Map(),
      callablePurity: new Map(),
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

      const ignoredResultReason = ts.isExpressionStatement(node)
        ? getIgnoredResultReason(project, node.expression, functionReturnSummaries, valueAnalysisCaches)
        : undefined;
      if (
        ts.isExpressionStatement(node)
        && (isTrackablePureExpression(node.expression) || ignoredResultReason)
      ) {
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
          ignoredResultReason ?? "side-effect-neutral expression result is discarded",
          ignoredResultReason ? `Ignored result ${entity.name}` : `Unused value ${entity.name}`,
          "review",
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
    const childPaths = setCollectionInfo(trackedObject, segments, "object").childPaths;

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
    const childPaths = setCollectionInfo(trackedObject, segments, "array", node.elements.length).childPaths;

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
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): ResolvedTrackedObjectAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
  }

  if (ts.isIdentifier(node)) {
    const binding = getBindingByNode(project, node, trackedBySymbolId);
    return binding ? { binding, segments: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.name.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (nested?.dynamic) {
      return nested;
    }
    if (!nested) {
      return undefined;
    }
    const aliased = resolveExactPathAlias(nested.binding, [...nested.segments, propertySegment(node.name.text)], trackedObjectsById);
    return nested
      ? {
          binding: aliased.binding,
          segments: sameTrackedBinding(aliased.binding, nested.binding) ? [...nested.segments, propertySegment(node.name.text)] : [],
          dynamic: nested.dynamic,
          boundaryCategory: nested.boundaryCategory,
          boundaryReason: nested.boundaryReason,
          viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
          viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.argumentExpression.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      const nextSegment = ts.isNumericLiteral(node.argumentExpression)
        ? indexSegment(Number(node.argumentExpression.text))
        : propertySegment(node.argumentExpression.text);
      const aliased = resolveExactPathAlias(nested.binding, [...nested.segments, nextSegment], trackedObjectsById);
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, nested.binding) ? [...nested.segments, nextSegment] : [],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
        viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
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
      const receiver = resolveTrackedObjectAccess(project, node.expression.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
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
          viaAliasObjectId: receiver.viaAliasObjectId,
          viaAliasPath: receiver.viaAliasPath,
        };
      }

      const aliased = resolveExactPathAlias(
        receiver.binding,
        [...receiver.segments, indexSegment(resolvedIndex)],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, receiver.binding)
          ? [...receiver.segments, indexSegment(resolvedIndex)]
          : [],
        dynamic: false,
        viaAliasObjectId: aliased.viaAliasObjectId ?? receiver.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? receiver.viaAliasPath,
        };
    }

    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "get"
      && node.arguments.length === 1
      && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)
    ) {
      const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
      const binding = slotKey ? trackedBySymbolId.get(slotKey) : undefined;
      if (binding) {
        return {
          binding,
          segments: [],
          dynamic: false,
        };
      }
    }

    const callable = getAnalyzableCallableBinding(project, node.expression);
    const binding = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
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
    const left = resolveTrackedObjectAccess(project, node.left, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const right = resolveTrackedObjectAccess(project, node.right, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
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
    const whenTrue = resolveTrackedObjectAccess(project, node.whenTrue, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const whenFalse = resolveTrackedObjectAccess(project, node.whenFalse, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
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

function markObservedSubtree(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  trackedObjectsById?: Map<string, TrackedObject>,
  visited = new Set<string>(),
): void {
  const joinedPrefix = serializePath(segments);
  const visitKey = `${trackedObject.id}:${joinedPrefix}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);

  trackedObject.observedSubtrees.add(joinedPrefix);
  trackedObject.reads.add(joinedPrefix);

  const descendantKeys = trackedObject.descendantNodeKeys.get(joinedPrefix);
  if (descendantKeys) {
    for (const joinedPath of descendantKeys) {
      if (isSerializedPathWithin(joinedPath, joinedPrefix)) {
        trackedObject.reads.add(joinedPath);
      }
    }
  }

  if (!trackedObjectsById || trackedObject.exactPathAliases.size === 0) {
    return;
  }

  for (const [aliasPath, alias] of trackedObject.exactPathAliases.entries()) {
    if (!isSerializedPathWithin(aliasPath, joinedPrefix)) {
      continue;
    }
    alias.observed = true;
    const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
    if (sourceTrackedObject) {
      markObservedSubtree(sourceTrackedObject, alias.sourcePath, trackedObjectsById, visited);
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
  addValueFate(trackedObject, "escaped-opaquely", segments, reason);
  clearExactAliasesWithin(trackedObject, segments);
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

function isSupportedExactAppendValue(argument: ts.Expression): boolean {
  return (
    ts.isIdentifier(argument)
    || ts.isStringLiteralLike(argument)
    || ts.isNumericLiteral(argument)
    || argument.kind === ts.SyntaxKind.TrueKeyword
    || argument.kind === ts.SyntaxKind.FalseKeyword
    || argument.kind === ts.SyntaxKind.NullKeyword
    || ts.isNoSubstitutionTemplateLiteral(argument)
  );
}

function tryRegisterExactArrayInsertion(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  collectionPath: PathSegment[],
  methodName: string,
  slotPlans: ExactAppendSlotPlan[],
): boolean {
  const arrayLength = getTrackedArrayLength(trackedObject, collectionPath);
  if (arrayLength === undefined) {
    return false;
  }

  if (methodName === "unshift" && arrayLength > 0) {
    return false;
  }

  const startIndex = methodName === "unshift" ? 0 : arrayLength;
  slotPlans.forEach((slotPlan, index) => {
    const receiverPath = [...collectionPath, indexSegment(startIndex + index)];
    ensureCollectionChildPath(trackedObject, collectionPath, receiverPath);
    materializeExactAppendSlot(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      receiverPath,
      slotPlan,
    );
  });
  setTrackedArrayLength(trackedObject, collectionPath, arrayLength + slotPlans.length);
  return true;
}

function handleSupportedValueFateCall(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
  handledSpreadAppendStarts: Set<number>,
): Set<number> {
  const handledIndices = new Set<number>();
  const calleeText = node.expression.getText(sourceFile);
  const calleeAccessPath = getAccessPath(node.expression);
  const methodName = calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0
    ? calleeAccessPath.segments.at(-1)?.kind === "property"
      ? calleeAccessPath.segments.at(-1)?.value
      : undefined
    : undefined;
  const trackedReceiver = calleeAccessPath
    ? getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId)
    : undefined;
  const receiverPath = trackedReceiver ? [...trackedReceiver.prefix, ...calleeAccessPath!.segments.slice(0, -1)] : undefined;
  const receiverCollection = trackedReceiver && receiverPath
    ? getCollectionInfo(trackedReceiver.trackedObject, receiverPath)
    : undefined;

  if (trackedReceiver && receiverPath && receiverCollection?.kind === "array" && methodName === "slice") {
    markObservedSubtree(trackedReceiver.trackedObject, receiverPath, trackedObjectsById);
    addValueFate(
      trackedReceiver.trackedObject,
      "shallow-cloned",
      receiverPath,
      "slice reads the receiver to create a shallow-cloned array",
    );
  }

  if (trackedReceiver && receiverPath && receiverCollection?.kind === "array" && methodName === "concat") {
    markObservedSubtree(trackedReceiver.trackedObject, receiverPath, trackedObjectsById);
    addValueFate(
      trackedReceiver.trackedObject,
      "shallow-cloned",
      receiverPath,
      "concat reads the receiver to create a shallow-cloned array",
    );
    node.arguments.forEach((argument, index) => {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        return;
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "shallow-cloned",
        fullPath,
        "concat reads this value to create a shallow-cloned array",
        trackedReceiver.trackedObject.id,
        receiverPath,
      );
      handledIndices.add(index);
    });
  }

  if (
    trackedReceiver
    && receiverPath
    && receiverCollection?.kind === "array"
    && (methodName === "push" || methodName === "unshift")
  ) {
    const slotPlans: ExactAppendSlotPlan[] = [];
    let exactAppendSupported = node.arguments.length > 0;
    let sawSpreadArgument = false;
    node.arguments.forEach((argument, index) => {
      if (!exactAppendSupported) {
        return;
      }

      if (ts.isSpreadElement(argument)) {
        sawSpreadArgument = true;
        const resolvedSpread = resolveTrackedObjectAccess(
          project,
        argument.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
        if (!resolvedSpread || resolvedSpread.dynamic) {
          exactAppendSupported = false;
          return;
        }

        const spreadPath = [...resolvedSpread.binding.prefix, ...resolvedSpread.segments];
        const spreadCollection = getCollectionInfo(resolvedSpread.binding.trackedObject, spreadPath);
        if (!spreadCollection || spreadCollection.kind !== "array") {
          exactAppendSupported = false;
          return;
        }

        spreadCollection.childPaths.forEach((childPath) => {
          slotPlans.push({
            kind: "alias",
            binding: {
              trackedObject: resolvedSpread.binding.trackedObject,
              prefix: childPath,
            },
            observeSourceAtInsert: true,
            insertReason: `${methodName} inserts ${renderPathWithRoot(resolvedSpread.binding.trackedObject.rootName, childPath)} by reference`,
            sourceObservationReason: `${methodName} spread observes this source slot before appending`,
          });
        });
        handledIndices.add(index);
        handledSpreadAppendStarts.add(argument.getStart(sourceFile));
        return;
      }

      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        const binding = extendTrackedBinding(resolved.binding, resolved.segments);
        slotPlans.push({
          kind: "alias",
          binding,
          observeSourceAtInsert: false,
          insertReason: `${methodName} inserts ${renderPathWithRoot(binding.trackedObject.rootName, binding.prefix)} by reference`,
        });
        handledIndices.add(index);
        return;
      }

      if (isSupportedExactAppendValue(argument)) {
        slotPlans.push({
          kind: "value",
          insertReason: `${methodName} appends a scalar value into an exact receiver slot`,
        });
        handledIndices.add(index);
        return;
      }

      exactAppendSupported = false;
    });

    if (exactAppendSupported) {
      if (
        !tryRegisterExactArrayInsertion(
          project,
          trackedReceiver.trackedObject,
          sourceFile,
          node,
          receiverPath,
          methodName,
          slotPlans,
        )
      ) {
        if (sawSpreadArgument) {
          recordArrayBoundary(
            project,
            trackedReceiver.trackedObject,
            sourceFile,
            node.expression,
            receiverPath,
            receiverPath,
            "array-append-mutation",
            methodName === "unshift"
              ? "unshift cannot preserve exact slot remapping once the receiver already contains elements"
              : `${methodName} spreads a source beyond exact local analysis`,
          );
          node.arguments.forEach((_argument, index) => handledIndices.add(index));
        } else {
          handledIndices.clear();
        }
      }
    } else {
      handledIndices.clear();
      if (sawSpreadArgument) {
        recordArrayBoundary(
          project,
          trackedReceiver.trackedObject,
          sourceFile,
          node.expression,
          receiverPath,
          receiverPath,
          "array-append-mutation",
          `${methodName} spreads a source beyond exact local analysis`,
        );
        node.arguments.forEach((_argument, index) => handledIndices.add(index));
        node.arguments.forEach((argument) => {
          if (ts.isSpreadElement(argument)) {
            handledSpreadAppendStarts.delete(argument.getStart(sourceFile));
          }
        });
      }
    }
  }

  if (calleeText === "structuredClone" && node.arguments[0]) {
    const resolved = resolveTrackedObjectAccess(
      project,
      node.arguments[0],
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "deep-cloned",
        fullPath,
        "structuredClone reads this value to create a deep-cloned copy",
      );
      handledIndices.add(0);
    }
  }

  if (calleeText === "Object.assign" && node.arguments.length > 0) {
    const target = resolveTrackedObjectAccess(
      project,
      node.arguments[0]!,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (target && !target.dynamic) {
      const targetPath = [...target.binding.prefix, ...target.segments];
      markEscaped(
        target.binding.trackedObject,
        targetPath,
        "object-spread",
        "Object.assign merges properties beyond exact local analysis",
      );
      handledIndices.add(0);
    }

    node.arguments.slice(1).forEach((argument, offset) => {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        return;
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "shallow-cloned",
        fullPath,
        "Object.assign reads this value to copy properties into another object",
      );
      handledIndices.add(offset + 1);
    });
  }

  return handledIndices;
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
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
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

    const resolved = resolveTrackedObjectAccess(project, argument, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
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
  context: ProjectedArrayUsageContext,
): ResolvedProjectionAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveProjectionAccess(project, node.expression, context);
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    const projection = symbol ? context.elementBindings.get(getSymbolKey(symbol)) : undefined;
    return projection ? { projection, suffix: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, context);
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
    const nested = resolveProjectionAccess(project, node.expression, context);
    if (!nested) {
      const receiver = unwrapExpression(node.expression);
      const index = unwrapExpression(node.argumentExpression);
      if (!ts.isIdentifier(receiver) || !ts.isIdentifier(index)) {
        return undefined;
      }

      const receiverSymbol = project.checker.getSymbolAtLocation(receiver);
      const indexSymbol = project.checker.getSymbolAtLocation(index);
      const receiverProjection = receiverSymbol ? context.receiverBindings.get(getSymbolKey(receiverSymbol)) : undefined;
      const indexProjection = indexSymbol ? context.indexBindings.get(getSymbolKey(indexSymbol)) : undefined;
      if (!receiverProjection || !indexProjection) {
        return undefined;
      }

      const sameProjection = receiverProjection.trackedObject.id === indexProjection.trackedObject.id
        && samePath(receiverProjection.sourcePath, indexProjection.sourcePath);
      return sameProjection
        ? {
            projection: receiverProjection,
            suffix: [],
            dynamic: false,
          }
        : {
            projection: receiverProjection,
            suffix: [],
            dynamic: true,
            boundaryCategory: "dynamic-array-index",
            boundaryReason: "callback index cannot yet be correlated across different tracked arrays",
          };
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
    const receiver = resolveProjectionAccess(project, node.expression.expression, context);
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
  context: ProjectedArrayUsageContext,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }

    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) {
        const projected = resolveProjectionAccess(project, argument, context);
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
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
        }
      }
    }

    if (ts.isIdentifier(current)) {
      const projected = resolveProjectionAccess(project, current, context);
      if (
        projected
        && !projected.dynamic
        && isReadLikeUse(current)
        && !ts.isPropertyAccessExpression(current.parent)
        && !ts.isElementAccessExpression(current.parent)
      ) {
        markProjectionReads(projected.projection, trackedObjectsById, [], true);
      }
    }

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const projected = resolveProjectionAccess(project, current, context);
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
            markProjectionReads(projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
          }
          for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
            maybeInvalidateReplacedTrackedPath(project, projected.projection.trackedObject, current.getSourceFile(), current, fullPath);
          }
          markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
        } else {
          markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
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
  functionReturnSummaries: Map<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
} {
  const trackedBySymbolId = new Map<string, TrackedObjectBinding>();
  const functionReturnSummaries = new Map<string, CallableReturnSummary>();
  const trackedLiteralBindings = new Map<string, TrackedObjectBinding>();
  const trackedReturnLiteralBindings = new Map<string, TrackedObjectBinding>();
  const trackedObjectsById = new Map<string, TrackedObject>();

  const createTrackedBindingForLiteral = (
    symbolKey: string,
    sourceFile: ts.SourceFile,
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    name: string,
    kind: EntityKind,
    anchor: ts.Node,
  ): TrackedObjectBinding => {
    const existing = trackedLiteralBindings.get(symbolKey) ?? trackedReturnLiteralBindings.get(symbolKey);
    if (existing) {
      return existing;
    }

    const rootEntity = makeEntity(project.rootPath, kind, sourceFile, anchor, name);
    const trackedObject: TrackedObject = {
      id: rootEntity.id,
      canonicalSymbolKey: symbolKey,
      rootName: name,
      sourceFile: sourceFile.fileName,
      rootEntity,
      structuralRole: classifyTrackedObjectStructuralRole(node),
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
      exactPathAliases: new Map(),
      valueFates: [],
      reads: new Set(),
      writes: new Set(),
    };
    trackedObjectsById.set(trackedObject.id, trackedObject);
    addTrackedObjectNode(
      project,
      trackedObject,
      sourceFile,
      node,
      name,
      name,
      [],
      project.config.value.objectAnalysis.maxPathDepth,
    );

    const binding = {
      trackedObject,
      prefix: [],
    };

    if (kind === "local") {
      trackedLiteralBindings.set(symbolKey, binding);
    } else {
      trackedReturnLiteralBindings.set(symbolKey, binding);
    }

    return binding;
  };

  const summarizeReturnExpression = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
  ): CallableReturnSummary | undefined => {
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) {
      return summarizeReturnExpression(callable, expression.expression);
    }

    if ((ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) && isTrackableObjectStructure(expression)) {
      return {
        kind: "structured",
        binding: createTrackedBindingForLiteral(
          `${callable.symbolKey}:return:${expression.getStart(expression.getSourceFile())}`,
          expression.getSourceFile(),
          expression,
          `${getAnalyzableCallableName(callable)}()`,
          "expression",
          expression,
        ),
      };
    }

    if (ts.isCallExpression(expression)) {
      const nestedCallable = getAnalyzableCallableBinding(project, expression.expression);
      const summary = nestedCallable ? functionReturnSummaries.get(nestedCallable.symbolKey) : undefined;
      return summary && summary.kind !== "opaque" ? summary : undefined;
    }

    if (
      ts.isBinaryExpression(expression)
      && (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      const left = summarizeReturnExpression(callable, expression.left);
      const right = summarizeReturnExpression(callable, expression.right);
      if (!left) {
        return right;
      }
      if (!right) {
        return left;
      }
      if (left.kind === "value" && right.kind === "value") {
        return left;
      }

      const leftBinding = getCallableReturnBinding(left);
      const rightBinding = getCallableReturnBinding(right);
      if (!leftBinding) {
        return right;
      }
      if (!rightBinding) {
        return left;
      }

      if (sameTrackedBinding(leftBinding, rightBinding)) {
        return left.kind === "structured" && right.kind === "structured"
          ? left
          : { kind: "returned-alias", binding: leftBinding };
      }

      return undefined;
    }

    if (ts.isConditionalExpression(expression)) {
      const whenTrue = summarizeReturnExpression(callable, expression.whenTrue);
      const whenFalse = summarizeReturnExpression(callable, expression.whenFalse);
      if (!whenTrue) {
        return whenFalse;
      }
      if (!whenFalse) {
        return whenTrue;
      }
      if (whenTrue.kind === "value" && whenFalse.kind === "value") {
        return whenTrue;
      }

      const whenTrueBinding = getCallableReturnBinding(whenTrue);
      const whenFalseBinding = getCallableReturnBinding(whenFalse);
      if (!whenTrueBinding) {
        return whenFalse;
      }
      if (!whenFalseBinding) {
        return whenTrue;
      }

      if (sameTrackedBinding(whenTrueBinding, whenFalseBinding)) {
        return whenTrue.kind === "structured" && whenFalse.kind === "structured"
          ? whenTrue
          : { kind: "returned-alias", binding: whenTrueBinding };
      }

      return undefined;
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      return {
        kind: "returned-alias",
        binding: extendTrackedBinding(resolved.binding, resolved.segments),
      };
    }

    if (isTrackablePureExpression(expression)) {
      return { kind: "value" };
    }

    return undefined;
  };

  const collectFunctionReturnSummary = (declaration: ts.FunctionLikeDeclaration): CallableReturnSummary | undefined => {
    const callable = getAnalyzableCallableBindingFromDeclaration(project, declaration);
    if (!callable?.declaration.body) {
      return undefined;
    }

    let summary: CallableReturnSummary | undefined;
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
        const nextSummary = summarizeReturnExpression(callable, node.expression);
        if (!nextSummary) {
          unsupported = true;
          return;
        }

        if (!summary) {
          summary = nextSummary;
          return;
        }

        if (summary.kind === "value" && nextSummary.kind === "value") {
          return;
        }

        const summaryBinding = getCallableReturnBinding(summary);
        const nextBinding = getCallableReturnBinding(nextSummary);
        if (!summaryBinding) {
          summary = nextSummary;
          return;
        }
        if (!nextBinding) {
          return;
        }

        if (!sameTrackedBinding(summaryBinding, nextBinding)) {
          unsupported = true;
          return;
        }

        if (summary.kind !== nextSummary.kind && !(summary.kind === "returned-alias" && nextSummary.kind === "returned-alias")) {
          summary = { kind: "returned-alias", binding: summaryBinding };
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(callable.declaration.body, visit);

    if (!sawReturn) {
      return undefined;
    }

    return unsupported ? { kind: "opaque" } : summary ?? { kind: "opaque" };
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
            const symbolKey = getCanonicalSymbolKey(project, symbol);
            const binding = createTrackedBindingForLiteral(
              symbolKey,
              sourceFile,
              node.initializer,
              node.name.text,
              "local",
              node.name,
            );

            mergeTrackedBinding(nextTrackedBySymbolId, conflictedTrackedSymbolIds, symbolKey, binding);
          } else {
            const resolved = resolveTrackedObjectAccess(
              project,
              node.initializer,
              trackedBySymbolId,
              functionReturnSummaries,
              trackedObjectsById,
            );
            if (resolved && !resolved.dynamic) {
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                getCanonicalSymbolKey(project, symbol),
                extendTrackedBinding(resolved.binding, resolved.segments),
              );
            }
          }
        }

        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const resolved = resolveTrackedObjectAccess(
              project,
              node.right,
              trackedBySymbolId,
              functionReturnSummaries,
              trackedObjectsById,
            );
          const globalThisProperty = getStaticGlobalThisPropertyName(node.left);
          if (globalThisProperty && (!resolved || resolved.dynamic)) {
            conflictedTrackedSymbolIds.add(getGlobalThisBindingKey(globalThisProperty));
            nextTrackedBySymbolId.delete(getGlobalThisBindingKey(globalThisProperty));
          } else if (globalThisProperty && resolved && !resolved.dynamic) {
            mergeTrackedBinding(
              nextTrackedBySymbolId,
              conflictedTrackedSymbolIds,
              getGlobalThisBindingKey(globalThisProperty),
              extendTrackedBinding(resolved.binding, resolved.segments),
            );
          } else if (ts.isIdentifier(node.left)) {
            const target = project.checker.getSymbolAtLocation(node.left);
            if (target && resolved && !resolved.dynamic) {
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                getCanonicalSymbolKey(project, target),
                extendTrackedBinding(resolved.binding, resolved.segments),
              );
            }
          }
        }

        if (ts.isCallExpression(node)) {
          if (
            ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === "set"
            && node.arguments.length >= 2
            && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)
          ) {
            const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
            const resolved = resolveTrackedObjectAccess(
              project,
              node.arguments[1]!,
              trackedBySymbolId,
              functionReturnSummaries,
              trackedObjectsById,
            );
            if (slotKey && resolved && !resolved.dynamic) {
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                slotKey,
                extendTrackedBinding(resolved.binding, resolved.segments),
              );
            }
          }

          for (const forwarded of getForwardedParameterBindings(
            project,
            node,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          )) {
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

    const nextFunctionReturnSummaries = new Map<string, CallableReturnSummary>();
    for (const sourceFile of project.sourceFiles) {
      if (!reachableFiles.has(sourceFile.fileName)) {
        continue;
      }

      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
          const callable = getAnalyzableCallableBindingFromDeclaration(project, node);
          if (callable) {
            const summary = collectFunctionReturnSummary(node);
            if (summary !== undefined) {
              nextFunctionReturnSummaries.set(callable.symbolKey, summary);
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sourceFile, visit);
    }

    changed =
      !sameTrackedBindingMap(trackedBySymbolId, nextTrackedBySymbolId)
      || !sameCallableReturnSummaryMap(functionReturnSummaries, nextFunctionReturnSummaries);
    trackedBySymbolId.clear();
    nextTrackedBySymbolId.forEach((binding, symbolKey) => {
      trackedBySymbolId.set(symbolKey, binding);
    });
    functionReturnSummaries.clear();
    nextFunctionReturnSummaries.forEach((summary, symbolKey) => {
      functionReturnSummaries.set(symbolKey, summary);
    });
  }

  return {
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  };
}

/**
 * Reports unused object paths, array slots, and collection boundaries from the shared tracked-object graph.
 *
 * This stage reuses the same exactness rules as value-liveness. Any dynamic property access, unsupported
 * mutation, or opaque helper interaction must degrade into a documented skip or boundary instead of an exact
 * structural claim.
 */
export function analyzeObjectPaths(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: ReturnType<typeof buildSuppressionContext>,
): void {
  if (!project.config.value.objectAnalysis.enabled) {
    return;
  }

  const { trackedBySymbolId, functionReturnSummaries, trackedObjectsById } = buildTrackedObjects(project, reachableFiles);
  const trackedObjects = new Set<TrackedObject>(trackedObjectsById.values());

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const projectionBindings = new Map<string, ArrayProjectionBinding>();
    const projectionContext: ProjectedArrayUsageContext = {
      elementBindings: projectionBindings,
      receiverBindings: new Map(),
      indexBindings: new Map(),
    };
    const handledExactCallbackBodies = new Set<ts.Node>();
    const retainedContainerConflicts = new Set<string>();
    const handledSpreadAppendStarts = new Set<number>();
    const parameterMeaningfulUse = new Map<string, boolean | null>();
    const parameterSummaryCache = new Map<string, HelperParameterSummary | null>();

    const visit = (node: ts.Node): void => {
        if (handledExactCallbackBodies.has(node)) {
          return;
        }

        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const target = project.checker.getSymbolAtLocation(node.name);
          const resolved = resolveTrackedObjectAccess(
            project,
            node.initializer,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (target && resolved && !resolved.dynamic) {
            trackedBySymbolId.set(
              getCanonicalSymbolKey(project, target),
              extendTrackedBinding(resolved.binding, resolved.segments),
            );
          }
        }

        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const resolved = resolveTrackedObjectAccess(
            project,
            node.right,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          const globalThisProperty = getStaticGlobalThisPropertyName(node.left);
          if (globalThisProperty && resolved && !resolved.dynamic) {
            trackedBySymbolId.set(
              getGlobalThisBindingKey(globalThisProperty),
              extendTrackedBinding(resolved.binding, resolved.segments),
            );
          } else if (globalThisProperty) {
            trackedBySymbolId.delete(getGlobalThisBindingKey(globalThisProperty));
          }
        }

        if (ts.isReturnStatement(node) && node.expression) {
          const resolved = resolveTrackedObjectAccess(
            project,
            node.expression,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (resolved && !resolved.dynamic) {
            const returnBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
          const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
          const propagated = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
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
        const handledRetainedContainerIndices = new Set<number>();
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "set"
          && node.arguments.length >= 2
          && isSupportedRetainedBindingContainerType(project, node.expression.expression)
        ) {
          const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
          const resolvedValue = resolveTrackedObjectAccess(
            project,
            node.arguments[1]!,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (resolvedValue && !resolvedValue.dynamic) {
            handledRetainedContainerIndices.add(1);
            if (slotKey && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)) {
              mergeTrackedBinding(
                trackedBySymbolId,
                retainedContainerConflicts,
                slotKey,
                extendTrackedBinding(resolvedValue.binding, resolvedValue.segments),
              );
            }
          }
        }

        const valueFateHandledIndices = handleSupportedValueFateCall(
          project,
          sourceFile,
          node,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
          handledSpreadAppendStarts,
        );
        const calleeAccessPath = getAccessPath(node.expression);
        if (calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0) {
          const methodSegment = calleeAccessPath.segments.at(-1);
          const methodName = methodSegment?.kind === "property" ? methodSegment.value : undefined;
          const tracked = getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId);
          const targetPath = tracked ? [...tracked.prefix, ...calleeAccessPath.segments.slice(0, -1)] : undefined;
          if (tracked && methodName && targetPath) {
            const targetCollection = getCollectionInfo(tracked.trackedObject, targetPath);
            if (WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName)) {
              markObservedSubtree(tracked.trackedObject, targetPath, trackedObjectsById);
            }
            if (
              targetCollection?.kind === "array"
              && (
                ARRAY_APPEND_METHODS.has(methodName)
                || ARRAY_TRUNCATE_METHODS.has(methodName)
                || ARRAY_REPLACEMENT_METHODS.has(methodName)
                || ARRAY_REORDER_METHODS.has(methodName)
              )
              && !(valueFateHandledIndices.size === node.arguments.length
                && (methodName === "push" || methodName === "unshift"))
            ) {
              handleTrackedArrayMutation(project, tracked.trackedObject, sourceFile, node, targetPath, methodName);
            }
            if (
              targetCollection?.kind === "array"
              && EXACT_ARRAY_CALLBACK_METHODS.has(methodName)
              && node.arguments[0]
              && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
            ) {
              const callee = node.expression;
              const callback = node.arguments[0];
              const paramIndex = getSupportedArrayCallbackParamIndex(methodName);
              const parameter = paramIndex === undefined ? undefined : callback.parameters[paramIndex];
              const indexParamIndex = getSupportedArrayCallbackIndexParamIndex(methodName);
              const indexParameter = indexParamIndex === undefined ? undefined : callback.parameters[indexParamIndex];
              const symbolKey = parameter ? getBindingSymbolKey(project, parameter) : undefined;
              const indexSymbolKey = indexParameter ? getBindingSymbolKey(project, indexParameter) : undefined;
              const receiverSymbolKey = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
                ? getBindingSymbolKey(project, callee.expression)
                : undefined;
              const projection = getProjectionBinding(tracked.trackedObject, targetPath);
              if (symbolKey && projection && callback.body) {
                handledExactCallbackBodies.add(callback.body);
                visitProjectedArrayUsage(
                  project,
                  callback.body,
                  {
                    elementBindings: new Map([[symbolKey, projection]]),
                    receiverBindings: receiverSymbolKey ? new Map([[receiverSymbolKey, projection]]) : new Map(),
                    indexBindings: indexSymbolKey ? new Map([[indexSymbolKey, projection]]) : new Map(),
                  },
                  trackedObjectsById,
                );
              }
            }
          }
        }

        const calleeText = node.expression.getText(sourceFile);
        const analyzableCallable = resolveAnalyzableFunctionDeclaration(project, node.expression);
        for (const [index, argument] of node.arguments.entries()) {
          const resolved = resolveTrackedObjectAccess(
            project,
            argument,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (!resolved) {
            continue;
          }

          if (handledRetainedContainerIndices.has(index)) {
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

          const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
          const parameter = analyzableCallable?.parameters[index];
          const helperHasStructuredChildren = collectionInfo !== undefined
            || hasTrackedChildren(resolved.binding.trackedObject, fullPath);
          if (parameter && ts.isIdentifier(parameter.name) && analyzableCallable && helperHasStructuredChildren) {
            const summary = summarizeHelperParameterUse(
              project,
              analyzableCallable,
              parameter.name,
              parameterMeaningfulUse,
              parameterSummaryCache,
            );
            const directStorageNode = findDirectReferenceStorageParameterUse(project, analyzableCallable, parameter.name);
            if (collectionInfo?.kind === "array") {
              if (summary.boundaryReason || directStorageNode) {
                recordArrayBoundary(
                  project,
                  resolved.binding.trackedObject,
                  sourceFile,
                  argument,
                  fullPath,
                  fullPath,
                  "array-opaque-mutation",
                  directStorageNode
                    ? `helper stores this value by reference beyond exact local analysis (helper cause at ${getHelperLocationText(project, directStorageNode.getSourceFile(), directStorageNode)})`
                    : buildHelperBoundaryReason(
                        project,
                        summary,
                        "same-project helper receives this collection beyond exact local analysis",
                      ),
                  true,
                );
              }
              continue;
            }

            if (summary.boundaryReason || directStorageNode) {
              markEscaped(
                resolved.binding.trackedObject,
                fullPath,
                "opaque-object-call",
                directStorageNode
                  ? `helper stores this value by reference beyond exact local analysis (helper cause at ${getHelperLocationText(project, directStorageNode.getSourceFile(), directStorageNode)})`
                  : buildHelperBoundaryReason(
                      project,
                      summary,
                      resolved.segments.length === 0
                        ? "same-project helper receives this object beyond exact local analysis"
                        : "same-project helper receives this object path beyond exact local analysis",
                    ),
              );
            }
            continue;
          }

          if (valueFateHandledIndices.has(index)) {
            continue;
          }

          if (OBSERVATION_ONLY_CALLS.has(calleeText)) {
            markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
            continue;
          }

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
            markAliasObserved(resolved, trackedObjectsById);
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
        const resolved = resolveTrackedObjectAccess(
          project,
          node.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved && !resolved.dynamic) {
          const projection = getProjectionBinding(
            resolved.binding.trackedObject,
            [...resolved.binding.prefix, ...resolved.segments],
          );
          const symbolKey = getBindingSymbolKey(project, node.initializer);
          if (projection && symbolKey) {
            visitProjectedArrayUsage(
              project,
              node.statement,
              {
                elementBindings: new Map([[symbolKey, projection]]),
                receiverBindings: new Map(),
                indexBindings: new Map(),
              },
              trackedObjectsById,
            );
          } else {
            markObservedSubtree(
              resolved.binding.trackedObject,
              [...resolved.binding.prefix, ...resolved.segments],
              trackedObjectsById,
            );
          }
        }
      }

      if (ts.isSpreadAssignment(node)) {
        const resolved = resolveTrackedObjectAccess(
          project,
          node.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved && !resolved.dynamic) {
          const fullPath = [...resolved.binding.prefix, ...resolved.segments];
          markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
          addValueFate(
            resolved.binding.trackedObject,
            "shallow-cloned",
            fullPath,
            "object spread reads this value to create a shallow-cloned object",
          );
        }
      }

      if (ts.isSpreadElement(node)) {
        if (
          ts.isCallExpression(node.parent)
          && handledSpreadAppendStarts.has(node.getStart(sourceFile))
        ) {
          return;
        }
        if (ts.isCallExpression(node.parent)) {
          const calleeAccessPath = getAccessPath(node.parent.expression);
          const methodName = calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0
            && calleeAccessPath.segments.at(-1)?.kind === "property"
            ? calleeAccessPath.segments.at(-1)?.value
            : undefined;
          const trackedReceiver = calleeAccessPath
            ? getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId)
            : undefined;
          const receiverPath = trackedReceiver && calleeAccessPath
            ? [...trackedReceiver.prefix, ...calleeAccessPath.segments.slice(0, -1)]
            : undefined;
          const receiverCollection = trackedReceiver && receiverPath
            ? getCollectionInfo(trackedReceiver.trackedObject, receiverPath)
            : undefined;
          if (
            trackedReceiver
            && receiverPath
            && receiverCollection?.kind === "array"
            && (methodName === "push" || methodName === "unshift")
          ) {
            recordArrayBoundary(
              project,
              trackedReceiver.trackedObject,
              sourceFile,
              node.parent.expression,
              receiverPath,
              receiverPath,
              "array-append-mutation",
              `${methodName} spreads a source beyond exact local analysis`,
            );
            return;
          }
        }
        const resolved = resolveTrackedObjectAccess(
          project,
          node.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved) {
          if (ts.isArrayLiteralExpression(node.parent) && !resolved.dynamic) {
            const fullPath = [...resolved.binding.prefix, ...resolved.segments];
            markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
            addValueFate(
              resolved.binding.trackedObject,
              "shallow-cloned",
              fullPath,
              "array spread reads this value to create a shallow-cloned array",
            );
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

      if (ts.isIdentifier(node)) {
        const projected = resolveProjectionAccess(project, node, projectionContext);
        if (
          projected
          && !projected.dynamic
          && !ts.isBindingElement(node.parent)
          && isReadLikeUse(node)
          && !ts.isPropertyAccessExpression(node.parent)
          && !ts.isElementAccessExpression(node.parent)
        ) {
          markProjectionReads(projected.projection, trackedObjectsById, [], true);
        }

        if (ts.isCallExpression(node.parent)) {
          const argumentIndex = node.parent.arguments.findIndex((argument) => argument === node);
          const callable = argumentIndex >= 0 ? resolveAnalyzableFunctionDeclaration(project, node.parent.expression) : undefined;
          const resolved = argumentIndex >= 0
            ? resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById)
            : undefined;
          if (callable && resolved && !resolved.dynamic) {
            const fullPath = [...resolved.binding.prefix, ...resolved.segments];
            const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
            const parameter = callable.parameters[argumentIndex];
            if (collectionInfo?.kind === "array" && parameter && ts.isIdentifier(parameter.name)) {
              const summary = summarizeHelperParameterUse(
                project,
                callable,
                parameter.name,
                parameterMeaningfulUse,
                parameterSummaryCache,
              );
              const directStorageNode = findDirectReferenceStorageParameterUse(project, callable, parameter.name);
              if (!summary.boundaryReason && !directStorageNode) {
                return;
              }
              recordArrayBoundary(
                project,
                resolved.binding.trackedObject,
                sourceFile,
                node,
                fullPath,
                fullPath,
                "array-opaque-mutation",
                directStorageNode
                  ? `helper stores this value by reference beyond exact local analysis (helper cause at ${getHelperLocationText(project, directStorageNode.getSourceFile(), directStorageNode)})`
                  : buildHelperBoundaryReason(
                      project,
                      summary,
                      "same-project helper receives this collection beyond exact local analysis",
                    ),
                true,
              );
            }
          }
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const resolved = resolveTrackedObjectAccess(project, node, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
        if (!resolved) {
          const projected = resolveProjectionAccess(project, node, projectionContext);
          if (!projected) {
            return ts.forEachChild(node, visit);
          }

          if (projected.dynamic) {
            recordArrayBoundary(
              project,
              projected.projection.trackedObject,
              sourceFile,
              node,
              projected.projection.sourcePath,
              projected.projection.sourcePath,
              projected.boundaryCategory ?? "array-callback-escape",
              projected.boundaryReason ?? "array projection escapes exact local analysis",
              true,
            );
            return ts.forEachChild(node, visit);
          }

          if (isAssignmentLeft(node)) {
            if (projected.suffix.length > 1) {
              markProjectionReads(projected.projection, trackedObjectsById, projected.suffix.slice(0, -1));
            }
            for (const fullPath of getConcreteProjectionPaths(projected.projection, projected.suffix)) {
              maybeInvalidateReplacedTrackedPath(project, projected.projection.trackedObject, sourceFile, node, fullPath);
            }
            markProjectionWrites(projected.projection, trackedObjectsById, projected.suffix);
          } else {
            markProjectionReads(projected.projection, trackedObjectsById, projected.suffix);
          }
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
            markAliasObserved(resolved, trackedObjectsById);
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
          markAliasObserved(resolved, trackedObjectsById);
          markRead(resolved.binding.trackedObject, fullPath);
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isArrayBindingPattern(node.name) &&
        node.initializer
      ) {
        const resolved = resolveTrackedObjectAccess(
          project,
          node.initializer,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
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
            const symbolKey = getBindingSymbolKey(project, element.name);
            if (symbolKey) {
              const elementPath = projection.elementPaths[index];
              if (elementPath) {
                projectionBindings.set(symbolKey, {
                  trackedObject: projection.trackedObject,
                  sourcePath: elementPath,
                  elementPaths: [elementPath],
                });
              }
            }
            markProjectionElementRead(projection, trackedObjectsById, index);
            return;
          }

          markProjectionElementRead(projection, trackedObjectsById, index, true);
        });
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const resolved = resolveTrackedObjectAccess(
          project,
          node.initializer,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
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
            markAliasObserved(resolved, trackedObjectsById);
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
      if (shouldSuppressStructuralPath(tracked, boundary.path)) {
        continue;
      }
      if (!shouldReportCollectionBoundary(tracked, boundary.path)) {
        continue;
      }
      const suppression = getSuppressionAudit(project, suppressionContext, boundary.entity);
      if (addAudit(state.kept, suppression)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    if (tracked.exactPathAliases.size > 0) {
      const aliases = [...tracked.exactPathAliases.values()];
      if (aliases.every((alias) => !alias.observed) && !tracked.collectionBoundaries.has(serializePath([]))) {
        const suppression = getSuppressionAudit(project, suppressionContext, tracked.rootEntity);
        if (!addAudit(state.kept, suppression)) {
          addFinding(
            state,
            tracked.rootEntity,
            "write-only-state",
            "tracked values are accumulated here but never meaningfully observed through an exact supported path",
            `Write-only accumulation in ${tracked.rootName}`,
            "review",
          );
        }
      }
    }

    for (const [joinedPath, objectNode] of tracked.nodes) {
      if (shouldSuppressStructuralPath(tracked, objectNode.fullPath)) {
        continue;
      }
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

