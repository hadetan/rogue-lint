import ts from "typescript";

import type { PathSegment, TrackedObject, TrackedObjectStructuralRole } from "../../types.js";
import { PATH_SEGMENT_KIND } from "../../shared/path-vocabulary.js";
import { TRACKING_STRUCTURAL_ROLE } from "./ownership.js";
import { TRACKING_CALL_SITE_SPECIALIZATION_KIND, TRACKING_PURE_OBJECT_CONSTRUCTOR_TYPE_NAMES } from "./vocabulary.js";

/**
 * Syntax and control-flow helpers shared across the tracking kernel.
 *
 * These helpers intentionally stay pure so stage logic can reuse the same structural
 * classification and flow-signature rules without mutating tracked state.
 */

export const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
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

const STRUCTURAL_RECORD_FIELD_NAMES = new Set([
  "aliases",
  "boundaries",
  "bindings",
  "byCallableId",
  "bySymbolId",
  "binding",
  "crossFileReferences",
  "dynamic",
  "facts",
  "findingKind",
  "functionReturnSummaries",
  "getStageArtifacts",
  "recordStageTiming",
  "kind",
  "owner",
  "reads",
  "reason",
  "references",
  "root",
  "sameFileReferences",
  "segments",
  "stage",
  "trackedBySymbolId",
  "trackedObjectsById",
  "value",
  "viaAliasObjectId",
  "viaAliasPath",
  "writes",
]);

const STRUCTURAL_HELPER_FIELD_NAMES = new Set([
  ...STRUCTURAL_RECORD_FIELD_NAMES,
  "acceptedFindings",
  TRACKING_CALL_SITE_SPECIALIZATION_KIND.call,
  "capabilityObligations",
  "callablePurity",
  "candidates",
  "cleanup",
  "code",
  "convergence",
  "directoryExists",
  "elementBindings",
  "elementPaths",
  "elementSymbolKey",
  "externalLines",
  "file",
  "fileExists",
  "from",
  "getCompilationSettings",
  "getCurrentDirectory",
  "getDefaultLibFileName",
  "getScriptFileNames",
  "getScriptSnapshot",
  "getScriptVersion",
  "id",
  "ignoredLines",
  "ignoredRanges",
  "includeKinds",
  "indexBindings",
  "insertReason",
  "keep",
  "knownSkips",
  "literal",
  "location",
  "maxCount",
  "message",
  "maxPassCallSiteSpecializationGrowth",
  "maxPassElapsedMs",
  "maxPassLiteralBindingCacheGrowth",
  "maxPassReturnLiteralBindingCacheGrowth",
  "maxPassTrackedObjectRegistryGrowth",
  "methodName",
  "minCount",
  "mode",
  "mustDiagnose",
  "mustFind",
  "mustNotDiagnose",
  "mustNotFind",
  "mustNotSkip",
  "mustSkip",
  "passes",
  "name",
  "observeSourceAtInsert",
  "objectAnalysis",
  "parameterMeaningfulUse",
  "prefix",
  "callSiteSpecializations",
  "readDirectory",
  "readFile",
  "relativeCollectionPath",
  "receiverPath",
  "receiverBindings",
  "receiverTrackedObject",
  "returnSummaries",
  "runtimeSummary",
  "seed",
  "solverState",
  "sourceObservationReason",
  "sourceFile",
  "sourcePath",
  "specifier",
  "statement",
  "stageRequests",
  "stageTimingsMs",
  "slotPlans",
  "suffix",
  "to",
  "totals",
  "trackedObjectRegistryEntries",
  "trackedObject",
  "trackedObjectRegistryGrowth",
  "literalBindingCacheEntries",
  "literalBindingCacheGrowth",
  "returnLiteralBindingCacheEntries",
  "returnLiteralBindingCacheGrowth",
  "warned",
  "warningPassThreshold",
  "maxPasses",
]);

const STRUCTURAL_STATE_FIELD_NAMES = new Set([
  "aliases",
  "bindings",
  "boundaries",
  "capabilityObligations",
  "capabilityCandidates",
  "diagnostics",
  "findings",
  "kept",
  "literalBindingCacheEntries",
  "literalBindingCacheGrowth",
  "outgoing",
  "returnSummaries",
  "returnLiteralBindingCacheEntries",
  "returnLiteralBindingCacheGrowth",
  "runtimeSummary",
  "solverState",
  "stage",
  "stageTimingsMs",
  "skipped",
  "trackedObjectRegistryEntries",
  "trackedObjectRegistryGrowth",
  "callSiteSpecializations",
  "callSiteSpecializationGrowth",
  "unresolved",
]);

/**
 * Removes wrapper syntax that does not change runtime identity for exactness-sensitive analysis.
 */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
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

export function getStaticObjectLiteralPropertyName(
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

export function isPureObjectConstructorExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  if (!TRACKING_PURE_OBJECT_CONSTRUCTOR_TYPE_NAMES.has(node.expression.text)) {
    return false;
  }
  return (node.arguments ?? []).every((argument) => isStructurallySimpleExpression(argument));
}

export function isStructurallySimpleExpression(expression: ts.Expression): boolean {
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

export function classifyTrackedObjectStructuralRole(
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): TrackedObjectStructuralRole | undefined {
  const classifyObjectLiteralRole = (
    objectLiteral: ts.ObjectLiteralExpression,
  ): TrackedObjectStructuralRole | undefined => {
    const fieldNames: string[] = [];
    let allSimple = true;
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        allSimple = false;
        continue;
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
      return TRACKING_STRUCTURAL_ROLE.stateHolder;
    }

    if (fieldNames.every((fieldName) => STRUCTURAL_HELPER_FIELD_NAMES.has(fieldName))) {
      return TRACKING_STRUCTURAL_ROLE.structuralRecord;
    }

    if (
      fieldNames.includes("kind")
      || fieldNames.includes("state")
      || (fieldNames.length <= 4 && allSimple)
    ) {
      return TRACKING_STRUCTURAL_ROLE.record;
    }

    return undefined;
  };

  if (ts.isObjectLiteralExpression(node)) {
    return classifyObjectLiteralRole(node);
  }

  const concreteElements = node.elements.filter((element): element is ts.Expression => !ts.isSpreadElement(element));
  if (concreteElements.length === 0) {
    return undefined;
  }

  const elementRoles = concreteElements.map((element) =>
    ts.isObjectLiteralExpression(element) ? classifyObjectLiteralRole(element) : undefined,
  );
  if (
    elementRoles.every((role) =>
      role === TRACKING_STRUCTURAL_ROLE.structuralRecord || role === TRACKING_STRUCTURAL_ROLE.stateHolder,
    )
  ) {
    return TRACKING_STRUCTURAL_ROLE.structuralRecordArray;
  }

  return undefined;
}

function getLeadingStructuralFieldName(segments: PathSegment[]): string | undefined {
  const [firstSegment] = segments;
  return firstSegment?.kind === PATH_SEGMENT_KIND.property ? firstSegment.value : undefined;
}

export function shouldSuppressStructuralPath(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  if (trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecordArray) {
    return segments[0]?.kind === PATH_SEGMENT_KIND.index;
  }

  const fieldName = getLeadingStructuralFieldName(segments);
  if (!fieldName) {
    return false;
  }

  if (trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecord) {
    return STRUCTURAL_HELPER_FIELD_NAMES.has(fieldName);
  }

  if (trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.record) {
    return STRUCTURAL_RECORD_FIELD_NAMES.has(fieldName);
  }

  if (trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.stateHolder) {
    return STRUCTURAL_STATE_FIELD_NAMES.has(fieldName);
  }

  return false;
}

export function shouldSuppressStructuralRoot(trackedObject: TrackedObject): boolean {
  return trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecord
    || trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecordArray
    || trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.stateHolder;
}

export function getFunctionDepth(node: ts.Node): number {
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

export function getControlFlowDepth(node: ts.Node): number {
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

export function getControlFlowSignature(node: ts.Node): string {
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
