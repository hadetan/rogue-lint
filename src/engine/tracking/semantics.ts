import ts from "typescript";

import type { PathSegment, ProjectContext, TrackedObject } from "../../types.js";
import { getSymbolKey, hasModifier, isReadLikeUse } from "../../compiler/ast-utils.js";
import { toRelative } from "../../shared/path-utils.js";
import { indexSegment, propertySegment, serializePath } from "../../shared/path-utils.js";
import { HelperParameterSummaryState } from "./model.js";
import type { AnalyzableCallableBinding, CallableReturnSummary, HelperParameterSummary, ProjectedArrayUsageContext, TrackedObjectBinding, ValueAnalysisCaches } from "./model.js";
import {
  getBindingSymbolKey,
  resolveTrackedObjectAccess,
} from "./access.js";
import { resolveProjectionAccess } from "./projection-access.js";
import { extendTrackedBinding, getCanonicalSymbol, getCanonicalSymbolKey, getStaticGlobalThisPropertyName } from "./bindings.js";
import { getAnalyzableCallableBinding, getAnalyzableCallableBindingFromDeclaration, resolveAnalyzableFunctionDeclaration } from "./callables.js";
import { getObjectBackedRetainedBindingSlotKeyFromAccess, isSupportedRetainedBindingContainerType } from "./retained-bindings.js";
import { getConcreteProjectionPaths, getProjectionBinding, resolveExactPathAlias } from "./state.js";
import { isTrackablePureExpression } from "./trackable-structures.js";
import { ASSIGNMENT_OPERATORS, getStaticObjectLiteralPropertyName, isPureObjectConstructorExpression, unwrapExpression } from "./syntax.js";
import {
  ARRAY_APPEND_METHODS, ARRAY_REORDER_METHODS, ARRAY_REPLACEMENT_METHODS, ARRAY_TRUNCATE_METHODS, TRACKING_RETAINED_BINDING_WRITE_METHOD, TRACKING_RETAINED_BINDING_OBSERVER_METHODS,
  TRACKING_ACCESS_KIND, TRACKING_HELPER_PARAMETER_EFFECT_KIND, TRACKING_ARRAY_INDEX_ACCESS_METHOD, WHOLE_ARRAY_CONSUMPTION_METHODS, isExactArrayCallbackMethod,
} from "./vocabulary.js";

export { ARRAY_APPEND_METHODS, ARRAY_REORDER_METHODS, ARRAY_REPLACEMENT_METHODS, ARRAY_TRUNCATE_METHODS, WHOLE_ARRAY_CONSUMPTION_METHODS } from "./vocabulary.js";

/**
 * Shared exactness semantics for helper lifecycles and call/mutation classification.
 *
 * This module centralizes the exactness-sensitive rules that both heavy stages reuse
 * when deciding whether calls, helper forwarding, and ignored results remain analyzable.
 */

const OBSERVATION_ONLY_CALLS = new Set([
  "console.log",
  "console.info",
  "console.debug",
  "console.warn",
  "console.error",
  "console.dir",
]);

type SupportedCallArgumentUseKind =
  | "observe-subtree"
  | "observe-keys"
  | "observe-values"
  | "clone-shallow"
  | "clone-deep"
  | "opaque-escape";

interface SupportedCallArgumentUse {
  kind: SupportedCallArgumentUseKind;
  reason: string;
}

export interface HelperParameterSummaryContext {
  trackedBySymbolId?: Map<string, TrackedObjectBinding>;
  specializedBindings?: Map<string, TrackedObjectBinding>;
  functionReturnSummaries?: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById?: Map<string, TrackedObject>;
  projectionContext?: ProjectedArrayUsageContext;
  allowUnboundInternalMemberFallback?: boolean;
  unboundInternalMemberFallbackSuffixes?: readonly string[];
}

interface HelperMemberCallResolution {
  callables?: AnalyzableCallableBinding[];
  boundaryReason?: string;
}

export function classifySupportedCallArgumentUse(
  calleeText: string,
  argumentIndex: number,
): SupportedCallArgumentUse | undefined {
  if (argumentIndex !== 0) {
    return undefined;
  }

  if (OBSERVATION_ONLY_CALLS.has(calleeText)) {
    return {
      kind: "observe-subtree",
      reason: `${calleeText} meaningfully observes this value`,
    };
  }

  switch (calleeText) {
    case "Object.keys":
    case "Reflect.ownKeys":
      return {
        kind: "observe-keys",
        reason: `${calleeText} observes the immediate keys of this value`,
      };
    case "Object.values":
    case "Object.entries":
      return {
        kind: "observe-values",
        reason: `${calleeText} observes the immediate values of this value`,
      };
    case "JSON.stringify":
      return {
        kind: "observe-subtree",
        reason: "JSON.stringify serializes this value",
      };
    default:
      return undefined;
  }
}

function getHelperLocationText(project: ProjectContext, sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  return `${toRelative(project.rootPath, sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function mergeHelperParameterSummary(
  summary: HelperParameterSummary,
  nested: HelperParameterSummary,
): void {
  nested.effectKinds.forEach((effect) => summary.effectKinds.add(effect));
  for (const path of nested.exactReadPaths) {
    const serialized = serializePath(path);
    if (summary.exactReadPaths.some((candidate) => serializePath(candidate) === serialized)) {
      continue;
    }

    summary.exactReadPaths.push(path);
  }
}

function pathStartsWith(path: PathSegment[], prefix: PathSegment[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => {
    const candidate = path[index];
    return candidate !== undefined && candidate.kind === segment.kind && candidate.value === segment.value;
  });
}

function getAggregateForwardingPath(node: ts.Node): {
  literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
  path: PathSegment[];
} | undefined {
  if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
    return {
      literal: node.parent,
      path: [propertySegment(node.name.text)],
    };
  }

  if (
    ts.isIdentifier(node)
    && ts.isPropertyAssignment(node.parent)
    && node.parent.initializer === node
    && ts.isObjectLiteralExpression(node.parent.parent)
  ) {
    const property: ts.PropertyAssignment = node.parent;
    const propertyName = getStaticObjectLiteralPropertyName(property);
    if (!propertyName) {
      return undefined;
    }

    return {
      literal: node.parent.parent,
      path: [propertySegment(propertyName)],
    };
  }

  if (ts.isIdentifier(node) && ts.isArrayLiteralExpression(node.parent)) {
    const index = node.parent.elements.indexOf(node);
    if (index < 0) {
      return undefined;
    }

    return {
      literal: node.parent,
      path: [indexSegment(index)],
    };
  }

  return undefined;
}

function trySummarizeAggregateLiteralForwarding(
  project: ProjectContext,
  forwardingNode: ts.Node,
  cache: Map<string, boolean | null>,
  summaryCache: Map<string, HelperParameterSummary | null>,
): HelperParameterSummary | undefined {
  const forwarding = getAggregateForwardingPath(forwardingNode);
  if (!forwarding) {
    return undefined;
  }

  const parent = forwarding.literal.parent;
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) {
    return undefined;
  }

  const argumentIndex = (parent.arguments ?? []).findIndex((argument) => argument === forwarding.literal);
  if (argumentIndex < 0) {
    return undefined;
  }

  const callable = resolveAnalyzableFunctionDeclaration(project, parent.expression);
  if (!callable) {
    return undefined;
  }

  const nestedParameter = callable.parameters[argumentIndex];
  if (!nestedParameter || !ts.isIdentifier(nestedParameter.name)) {
    return undefined;
  }

  const nestedSummary = summarizeHelperParameterUse(project, callable, nestedParameter.name, cache, summaryCache);
  if (nestedSummary.boundaryReason) {
    return undefined;
  }

  const remapped = new HelperParameterSummaryState();
  let matched = false;

  for (const path of nestedSummary.exactReadPaths) {
    if (!pathStartsWith(path, forwarding.path)) {
      continue;
    }

    matched = true;
    const remappedPath = path.slice(forwarding.path.length);
    const serialized = serializePath(remappedPath);
    if (remapped.exactReadPaths.some((candidate) => serializePath(candidate) === serialized)) {
      continue;
    }

    remapped.exactReadPaths.push(remappedPath);
  }

  if (!matched) {
    return undefined;
  }

  remapped.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.read);
  if (nestedSummary.effectKinds.has(TRACKING_HELPER_PARAMETER_EFFECT_KIND.returnedAlias)) {
    remapped.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.returnedAlias);
  }

  return remapped;
}

function markHelperParameterBoundary(
  summary: HelperParameterSummary,
  node: ts.Node,
  reason: string,
): void {
  summary.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.opaqueEscape);
  if (!summary.boundaryReason) {
    summary.boundaryNode = node;
    summary.boundaryReason = reason;
  }
}

function getSummarySpecializationSignature(bindings: Map<string, TrackedObjectBinding> | undefined): string {
  if (!bindings || bindings.size === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const [symbolKey, binding] of bindings) {
    parts.push(`${symbolKey}:${binding.trackedObject.id}:${serializePath(binding.prefix)}`);
  }

  parts.sort();
  return parts.join("|");
}

function getHelperParameterSummaryCacheKey(
  parameterKey: string,
  context?: HelperParameterSummaryContext,
): string {
  const signature = getSummarySpecializationSignature(context?.specializedBindings);
  return signature ? `${parameterKey}::${signature}` : parameterKey;
}

function splitMemberCallExpression(expression: ts.Expression): {
  receiver: ts.Expression;
  member: PathSegment;
} | undefined {
  const candidate = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(candidate)) {
    return {
      receiver: candidate.expression,
      member: propertySegment(candidate.name.text),
    };
  }

  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const argument = unwrapExpression(candidate.argumentExpression);
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return {
        receiver: candidate.expression,
        member: propertySegment(argument.text),
      };
    }
    if (ts.isNumericLiteral(argument)) {
      return {
        receiver: candidate.expression,
        member: indexSegment(Number(argument.text)),
      };
    }
  }

  return undefined;
}

function isNodeWithin(parent: ts.Node, child: ts.Node): boolean {
  return child.getStart(child.getSourceFile()) >= parent.getStart(parent.getSourceFile())
    && child.getEnd() <= parent.getEnd();
}

function isGuardedOptionalMemberCall(call: ts.CallExpression): boolean {
  const sourceFile = call.getSourceFile();
  const calleeText = call.expression.getText(sourceFile);
  let current: ts.Node | undefined = call.parent;

  while (current) {
    if (
      ts.isIfStatement(current)
      && isNodeWithin(current.thenStatement, call)
      && unwrapExpression(current.expression).getText(sourceFile) === calleeText
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

const UNBOUND_INTERNAL_MEMBER_CANDIDATE_LIMIT = 64;
const unboundInternalMemberCandidateCache = new WeakMap<ProjectContext, Map<string, HelperMemberCallResolution>>();

function getStaticMemberSegments(expression: ts.Expression): PathSegment[] | undefined {
  const segments: PathSegment[] = [];
  let current = unwrapExpression(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(propertySegment(current.name.text));
      current = unwrapExpression(current.expression);
      continue;
    }

    if (
      ts.isElementAccessExpression(current)
      && current.argumentExpression
      && (
        ts.isStringLiteral(current.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
        || ts.isNumericLiteral(current.argumentExpression)
      )
    ) {
      const argument = current.argumentExpression;
      segments.unshift(
        ts.isNumericLiteral(argument)
          ? indexSegment(Number(argument.text))
          : propertySegment(argument.text),
      );
      current = unwrapExpression(current.expression);
      continue;
    }

    return segments.length > 0 ? segments : undefined;
  }
}

function getStaticMemberRoot(expression: ts.Expression): ts.Expression {
  let current = unwrapExpression(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }

    if (
      ts.isElementAccessExpression(current)
      && current.argumentExpression
      && (
        ts.isStringLiteral(current.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
        || ts.isNumericLiteral(current.argumentExpression)
      )
    ) {
      current = unwrapExpression(current.expression);
      continue;
    }

    return current;
  }
}

function resolveUnboundInternalMemberCandidates(
  project: ProjectContext,
  expression: ts.Expression,
  trackedObjectsById: Map<string, TrackedObject>,
): HelperMemberCallResolution {
  const segments = getStaticMemberSegments(expression);
  if (!segments || !segments.some((segment) => segment.kind === "property" && String(segment.value).startsWith("_"))) {
    return {};
  }

  const suffixKey = serializePath(segments);
  let projectCache = unboundInternalMemberCandidateCache.get(project);
  if (!projectCache) {
    projectCache = new Map();
    unboundInternalMemberCandidateCache.set(project, projectCache);
  }

  const cached = projectCache.get(suffixKey);
  if (cached) {
    return cached;
  }

  const callables = new Map<string, AnalyzableCallableBinding>();
  let exceededLimit = false;

  const appendCallable = (callable: AnalyzableCallableBinding): void => {
    callables.set(callable.symbolKey, callable);
    if (callables.size > UNBOUND_INTERNAL_MEMBER_CANDIDATE_LIMIT) {
      exceededLimit = true;
    }
  };

  for (const trackedObject of trackedObjectsById.values()) {
    for (const [callablePath, callable] of trackedObject.callablePaths.entries()) {
      if (callablePath !== suffixKey && !callablePath.endsWith(`/${suffixKey}`)) {
        continue;
      }

      appendCallable(callable);
      if (exceededLimit) {
        break;
      }
    }

    if (exceededLimit) {
      break;
    }
  }

  if (!exceededLimit) {
    const visit = (candidate: ts.Node): void => {
      if (exceededLimit) {
        return;
      }

      if (
        ts.isBinaryExpression(candidate)
        && candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isArrowFunction(candidate.right) || ts.isFunctionExpression(candidate.right))
      ) {
        const assignmentSegments = getStaticMemberSegments(candidate.left);
        if (assignmentSegments) {
          const assignmentKey = serializePath(assignmentSegments);
          if (assignmentKey === suffixKey || assignmentKey.endsWith(`/${suffixKey}`)) {
            const callable = getAnalyzableCallableBindingFromDeclaration(project, candidate.right);
            if (callable) {
              appendCallable(callable);
            }
          }
        }
      }

      ts.forEachChild(candidate, visit);
    };

    for (const sourceFile of project.sourceFiles) {
      if (exceededLimit) {
        break;
      }

      ts.forEachChild(sourceFile, visit);
    }
  }

  if (exceededLimit) {
    const result = {
      boundaryReason: "unbound internal member callback candidate set exceeds bounded analysis limit",
    };
    projectCache.set(suffixKey, result);
    return result;
  }

  const result = callables.size > 0 ? { callables: [...callables.values()] } : {};
  projectCache.set(suffixKey, result);
  return result;
}

function createForOfProjectionContext(
  project: ProjectContext,
  node: ts.ForOfStatement,
  context?: HelperParameterSummaryContext,
): ProjectedArrayUsageContext | undefined {
  if (!context?.trackedBySymbolId || !context.functionReturnSummaries || !context.trackedObjectsById) {
    return undefined;
  }

  const resolved = resolveTrackedObjectAccess(
    project,
    node.expression,
    context.trackedBySymbolId,
    context.functionReturnSummaries,
    context.trackedObjectsById,
  );
  if (!resolved || resolved.dynamic) {
    return undefined;
  }

  const projection = getProjectionBinding(
    resolved.binding.trackedObject,
    [...resolved.binding.prefix, ...resolved.segments],
  );
  const elementSymbolKey = getBindingSymbolKey(project, node.initializer);
  if (!projection || !elementSymbolKey) {
    return undefined;
  }

  return {
    elementBindings: new Map([[elementSymbolKey, projection]]),
    receiverBindings: new Map(),
    indexBindings: new Map(),
  };
}

export function resolveHelperMemberCallCandidates(
  project: ProjectContext,
  expression: ts.Expression,
  context?: HelperParameterSummaryContext,
): HelperMemberCallResolution {
  const memberCall = splitMemberCallExpression(expression);

  if (context?.projectionContext && context.trackedObjectsById) {
    if (memberCall) {
      const projectedReceiver = resolveProjectionAccess(project, memberCall.receiver, context.projectionContext);
      if (projectedReceiver) {
        if (projectedReceiver.dynamic) {
          return {
            boundaryReason: projectedReceiver.boundaryReason ?? "projected member callback receiver escapes exact local analysis",
          };
        }

        const receiverPaths = getConcreteProjectionPaths(projectedReceiver.projection, projectedReceiver.suffix);
        if (receiverPaths.length > 0) {
          const callables = new Map<string, AnalyzableCallableBinding>();
          let missingCandidate = false;

          for (const receiverPath of receiverPaths) {
            const aliasResolved = resolveExactPathAlias(
              {
                trackedObject: projectedReceiver.projection.trackedObject,
                prefix: receiverPath,
              },
              [],
              context.trackedObjectsById,
            ).binding;
            const callable = aliasResolved.trackedObject.callablePaths.get(
              serializePath([...aliasResolved.prefix, memberCall.member]),
            );
            if (!callable) {
              missingCandidate = true;
              continue;
            }

            callables.set(callable.symbolKey, callable);
          }

          if (callables.size === 0) {
            return missingCandidate
              ? { boundaryReason: "projected member callback has no exact same-project callable candidates" }
              : {};
          }

          if (missingCandidate && !(ts.isCallExpression(expression.parent) && isGuardedOptionalMemberCall(expression.parent))) {
            return {
              boundaryReason: "projected member callback candidate set crosses unsupported or unresolved receivers",
            };
          }

          return { callables: [...callables.values()] };
        }
      }
    }
  }

  if (memberCall && context?.trackedBySymbolId && context.functionReturnSummaries && context.trackedObjectsById) {
    const receiverRoot = getStaticMemberRoot(memberCall.receiver);
    const receiverRootKey = ts.isIdentifier(receiverRoot)
      ? (() => {
          try {
            return getBindingSymbolKey(project, receiverRoot);
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const resolvedReceiver = receiverRootKey && context.trackedBySymbolId.has(receiverRootKey)
      ? resolveTrackedObjectAccess(
          project,
          memberCall.receiver,
          context.trackedBySymbolId,
          context.functionReturnSummaries,
          context.trackedObjectsById,
        )
      : undefined;
    if (resolvedReceiver) {
      if (resolvedReceiver.dynamic) {
        return {
          boundaryReason: "member callback receiver escapes exact local analysis",
        };
      }

      const aliasResolved = resolveExactPathAlias(
        extendTrackedBinding(resolvedReceiver.binding, resolvedReceiver.segments),
        [],
        context.trackedObjectsById,
      ).binding;
      const callable = aliasResolved.trackedObject.callablePaths.get(
        serializePath([...aliasResolved.prefix, memberCall.member]),
      );
      if (callable) {
        return { callables: [callable] };
      }

      if (ts.isCallExpression(expression.parent) && isGuardedOptionalMemberCall(expression.parent)) {
        return {};
      }

      return {
        boundaryReason: "member callback has no exact same-project callable candidate",
      };
    }
  }

  if (context?.allowUnboundInternalMemberFallback && context.trackedObjectsById) {
    const allowedSuffixes = context.unboundInternalMemberFallbackSuffixes;
    if (allowedSuffixes?.length) {
      const segments = getStaticMemberSegments(expression);
      const key = segments ? serializePath(segments) : undefined;
      if (!key || !allowedSuffixes.some((suffix) => key === suffix || key.endsWith(`/${suffix}`))) {
        return {};
      }
    }

    return resolveUnboundInternalMemberCandidates(project, expression, context.trackedObjectsById);
  }

  return {};
}

function extractFiniteAccessSegments(project: ProjectContext, argument: ts.Expression): PathSegment[] | undefined {
  const node = unwrapExpression(argument);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [propertySegment(node.text)];
  }

  if (ts.isNumericLiteral(node)) {
    return [indexSegment(Number(node.text))];
  }

  if (
    ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand)
  ) {
    return [indexSegment(-Number(node.operand.text))];
  }

  const type = project.checker.getTypeAtLocation(node);
  const candidates = type.isUnion() ? type.types : [type];
  const segments: PathSegment[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let segment: PathSegment | undefined;
    if (candidate.flags & ts.TypeFlags.StringLiteral) {
      segment = propertySegment((candidate as ts.StringLiteralType).value);
    } else if (candidate.flags & ts.TypeFlags.NumberLiteral) {
      segment = indexSegment((candidate as ts.NumberLiteralType).value);
    } else {
      return undefined;
    }

    const key = serializePath([segment]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    segments.push(segment);
  }

  return segments.length > 0 ? segments : undefined;
}

function getExactHelperReadPaths(project: ProjectContext, node: ts.Identifier): PathSegment[][] | undefined {
  let current: ts.Expression = node;
  let paths: PathSegment[][] = [[]];
  let sawPath = false;

  while (true) {
    const parent = current.parent;
    if (
      ts.isPropertyAccessExpression(parent)
      && parent.expression === current
    ) {
      if (
        ts.isCallExpression(parent.parent)
        && parent.parent.expression === parent
      ) {
        break;
      }

      paths = paths.map((path) => [...path, propertySegment(parent.name.text)]);
      current = parent;
      sawPath = true;
      continue;
    }

    if (
      ts.isElementAccessExpression(parent)
      && parent.expression === current
      && parent.argumentExpression
    ) {
      const segments = extractFiniteAccessSegments(project, parent.argumentExpression);
      if (!segments) {
        return undefined;
      }

      paths = paths.flatMap((path) => segments.map((segment) => [...path, segment]));
      current = parent;
      sawPath = true;
      continue;
    }

    break;
  }

  if (!sawPath) {
    return undefined;
  }

  const parent = current.parent;
  if (
    ts.isPropertyAccessExpression(parent)
    && parent.expression === current
    && ts.isCallExpression(parent.parent)
    && parent.parent.expression === parent
    && TRACKING_RETAINED_BINDING_OBSERVER_METHODS.has(parent.name.text)
    && isSupportedRetainedBindingContainerType(project, current)
  ) {
    return paths;
  }

  return isReadLikeUse(current) ? paths : undefined;
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

export function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent)
    && ts.isVariableStatement(node.parent.parent)
    && hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword);
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

export function getIgnoredResultReason(
  project: ProjectContext,
  expression: ts.Expression,
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>,
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

  const rememberBindingName = (name: ts.BindingName): boolean => {
    return ts.isIdentifier(name);
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

function isUpdateRead(node: ts.Identifier): boolean {
  return (ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken);
}

export function getCallArgumentUse(
  project: ProjectContext,
  node: ts.Identifier,
  caches: ValueAnalysisCaches,
): typeof TRACKING_ACCESS_KIND.read | "ignore" | undefined {
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
    return TRACKING_ACCESS_KIND.read;
  }

  const parameter = callable.parameters[argumentIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return TRACKING_ACCESS_KIND.read;
  }

  return hasMeaningfulParameterUse(project, callable, parameter.name, caches) ? TRACKING_ACCESS_KIND.read : "ignore";
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
  if (!isExactArrayCallbackMethod(methodName)) {
    return false;
  }

  const receiver = unwrapExpression(parent.expression.expression);
  if (!ts.isIdentifier(receiver)) {
    return false;
  }

  const receiverSymbol = project.checker.getSymbolAtLocation(receiver);
  return receiverSymbol ? trackedAliasKeys.has(getCanonicalSymbolKey(project, receiverSymbol)) : false;
}

const SUPPORTED_PROMISE_CALLBACK_METHODS = new Set([
  "then",
  "catch",
  "finally",
]);

function trySummarizeSupportedPromiseCallbackBoundary(
  project: ProjectContext,
  node: ts.FunctionLikeDeclaration,
  trackedAliasKeys: Set<string>,
  cache: Map<string, boolean | null>,
  summaryCache: Map<string, HelperParameterSummary | null>,
): HelperParameterSummary | undefined {
  if (!node.body) {
    return undefined;
  }

  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || !ts.isPropertyAccessExpression(parent.expression)) {
    return undefined;
  }

  const callbackIndex = parent.arguments.findIndex((argument) => argument === node);
  if (callbackIndex < 0 || !SUPPORTED_PROMISE_CALLBACK_METHODS.has(parent.expression.name.text)) {
    return undefined;
  }

  const isTrackedAliasIdentifier = (candidate: ts.Node): candidate is ts.Identifier => {
    if (!ts.isIdentifier(candidate)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(candidate);
    return Boolean(symbol && trackedAliasKeys.has(getCanonicalSymbolKey(project, symbol)));
  };

  const containsTrackedAlias = (candidate: ts.Node): boolean => {
    let found = false;
    const visit = (nested: ts.Node): void => {
      if (found || (ts.isFunctionLike(nested) && nested !== node)) {
        return;
      }

      if (isTrackedAliasIdentifier(nested)) {
        found = true;
        return;
      }

      ts.forEachChild(nested, visit);
    };

    visit(candidate);
    return found;
  };

  const forwardedSummary = new HelperParameterSummaryState();
  let capturedTrackedAlias = false;

  const trySummarizeForwardedHelperCall = (expression: ts.Expression): boolean => {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call)) {
      return false;
    }

    const consumer = resolveAnalyzableFunctionDeclaration(project, call.expression);
    if (!consumer) {
      return false;
    }

    let matchedTrackedArgument = false;

    for (const [index, argument] of call.arguments.entries()) {
      const currentArgument = unwrapExpression(argument);
      if (!isTrackedAliasIdentifier(currentArgument)) {
        continue;
      }

      matchedTrackedArgument = true;
      capturedTrackedAlias = true;

      const consumerParameter = consumer.parameters[index];
      if (!consumerParameter || !ts.isIdentifier(consumerParameter.name)) {
        return false;
      }

      const nestedSummary = summarizeHelperParameterUse(
        project,
        consumer,
        consumerParameter.name,
        cache,
        summaryCache,
      );
      if (nestedSummary.boundaryReason) {
        return false;
      }

      mergeHelperParameterSummary(forwardedSummary, nestedSummary);
    }

    return matchedTrackedArgument;
  };

  const isSupportedCapturedExpression = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);

    if (isTrackedAliasIdentifier(current)) {
      capturedTrackedAlias = true;
      forwardedSummary.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.returnedAlias);
      return true;
    }

    return trySummarizeForwardedHelperCall(current);
  };

  const statements = ts.isBlock(node.body)
    ? [...node.body.statements]
    : [ts.factory.createExpressionStatement(node.body)];

  for (const statement of statements) {
    if (ts.isReturnStatement(statement)) {
      if (!statement.expression || !containsTrackedAlias(statement.expression)) {
        continue;
      }

      if (!isSupportedCapturedExpression(statement.expression)) {
        return undefined;
      }

      continue;
    }

    if (ts.isExpressionStatement(statement)) {
      if (!containsTrackedAlias(statement.expression)) {
        continue;
      }

      if (!isSupportedCapturedExpression(statement.expression)) {
        return undefined;
      }

      continue;
    }

    if (containsTrackedAlias(statement)) {
      return undefined;
    }
  }

  return capturedTrackedAlias ? forwardedSummary : undefined;
}

function getStaticCallableAccessPath(
  expression: ts.Expression,
): { root: ts.Identifier; segments: string[] } | undefined {
  const segments: string[] = [];
  let current = unwrapExpression(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = unwrapExpression(current.expression);
      continue;
    }

    if (
      ts.isElementAccessExpression(current)
      && current.argumentExpression
      && (
        ts.isStringLiteral(current.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)
        || ts.isNumericLiteral(current.argumentExpression)
      )
    ) {
      segments.unshift(current.argumentExpression.text);
      current = unwrapExpression(current.expression);
      continue;
    }

    return ts.isIdentifier(current) && segments.length > 0
      ? {
          root: current,
          segments,
        }
      : undefined;
    }
}

function resolveSameEnclosingLocalFunctionDeclaration(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  const accessPath = getStaticCallableAccessPath(expression);
  if (!accessPath) {
    return undefined;
  }

  const rootSymbol = project.checker.getSymbolAtLocation(accessPath.root);
  const enclosingFunction = ts.findAncestor(
    declaration,
    (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor) && ancestor !== declaration,
  );
  if (!rootSymbol || !enclosingFunction?.body) {
    return undefined;
  }

  const rootKey = getCanonicalSymbolKey(project, rootSymbol);
  let match: ts.FunctionLikeDeclaration | undefined;
  let multiple = false;

  const visit = (node: ts.Node): void => {
    if (multiple || (ts.isFunctionLike(node) && node !== enclosingFunction)) {
      return;
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right))
    ) {
      const candidatePath = getStaticCallableAccessPath(node.left);
      const candidateRootSymbol = candidatePath ? project.checker.getSymbolAtLocation(candidatePath.root) : undefined;
      if (
        candidatePath
        && candidateRootSymbol
        && getCanonicalSymbolKey(project, candidateRootSymbol) === rootKey
        && candidatePath.segments.length === accessPath.segments.length
        && candidatePath.segments.every((segment, index) => segment === accessPath.segments[index])
      ) {
        if (match) {
          multiple = true;
          return;
        }

        match = node.right;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(enclosingFunction.body, visit);
  return multiple ? undefined : match;
}

export function summarizeHelperParameterUse(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  parameterName: ts.Identifier,
  cache: Map<string, boolean | null>,
  summaryCache: Map<string, HelperParameterSummary | null>,
  context?: HelperParameterSummaryContext,
): HelperParameterSummary {
  const parameterSymbol = project.checker.getSymbolAtLocation(parameterName);
  if (!parameterSymbol || !declaration.body) {
    const summary = new HelperParameterSummaryState(
      parameterName,
      "helper parameter cannot be resolved for exact analysis",
    );
    summary.effectKinds.add("opaque-escape");
    return summary;
  }

  const body = declaration.body;
  const parameterKey = getCanonicalSymbolKey(project, parameterSymbol);
  const cacheKey = getHelperParameterSummaryCacheKey(parameterKey, context);
  const cached = summaryCache.get(cacheKey);
  if (cached === null) {
    const summary = new HelperParameterSummaryState(
      parameterName,
      "recursive same-project helper forwarding prevents exact helper lifecycle analysis",
    );
    summary.effectKinds.add("opaque-escape");
    return summary;
  }
  if (cached !== undefined) {
    return cached;
  }

  summaryCache.set(cacheKey, null);
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
    if (getStaticGlobalThisPropertyName(left)) {
      summary.effectKinds.add("retained-binding");
      return true;
    }

    if (
      (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
      && getObjectBackedRetainedBindingSlotKeyFromAccess(project, left)
    ) {
      summary.effectKinds.add("retained-binding");
      return true;
    }

    const target = getHelperAssignmentTargetSymbol(project, left);
    if (!target) {
      return false;
    }

    summary.effectKinds.add("retained-binding");
    if (isSymbolDeclaredWithinFunction(target, declaration)) {
      if (ts.isIdentifier(left)) {
        addAliasSymbol(left);
      }
      return true;
    }

    return true;
  };

  const visit = (node: ts.Node, projectionContext = context?.projectionContext): void => {
    if (ts.isTypeNode(node)) {
      return;
    }

    if (summary.boundaryReason) {
      return;
    }

    if (ts.isFunctionLike(node) && node !== declaration) {
      if (isSupportedTrackedArrayCallbackBoundary(project, node as ts.FunctionLikeDeclaration, trackedAliasKeys)) {
        return;
      }

      const supportedPromiseCallbackSummary = trySummarizeSupportedPromiseCallbackBoundary(
        project,
        node as ts.FunctionLikeDeclaration,
        trackedAliasKeys,
        cache,
        summaryCache,
      );
      if (supportedPromiseCallbackSummary) {
        mergeHelperParameterSummary(summary, supportedPromiseCallbackSummary);
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
          const parent = candidate.parent;
          capturesTrackedAlias = !ts.isPropertyAccessExpression(parent) || parent.expression !== candidate;
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

    if (ts.isForOfStatement(node)) {
      const nestedProjectionContext = createForOfProjectionContext(project, node, context);
      if (nestedProjectionContext) {
        visit(node.statement, nestedProjectionContext);
        return;
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer && isTrackedAliasIdentifier(node.initializer)) {
      if (!ts.isIdentifier(node.name)) {
        markHelperParameterBoundary(summary, node, "helper rebinds this value through an unsupported pattern");
        return;
      }
      summary.effectKinds.add("retained-binding");
      addAliasSymbol(node.name);
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(node);
      if (valueSymbol && trackedAliasKeys.has(getCanonicalSymbolKey(project, valueSymbol))) {
        const forwardedSummary = trySummarizeAggregateLiteralForwarding(project, node, cache, summaryCache);
        if (forwardedSummary) {
          mergeHelperParameterSummary(summary, forwardedSummary);
          return;
        }

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
        summary.effectKinds.add("returned-alias");
      }
      if (
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
        && isTrackedAliasIdentifier(node.expression.expression)
      ) {
        summary.effectKinds.add("returned-alias");
      }
    }

    if (ts.isIdentifier(node) && isTrackedAliasIdentifier(node)) {
      const parent = node.parent;

      const exactReadPaths = getExactHelperReadPaths(project, node);
      if (exactReadPaths) {
        for (const path of exactReadPaths) {
          const serialized = serializePath(path);
          if (summary.exactReadPaths.some((candidate) => serializePath(candidate) === serialized)) {
            continue;
          }

          summary.exactReadPaths.push(path);
        }
      }

      if (
        ts.isShorthandPropertyAssignment(parent)
        || (ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isObjectLiteralExpression(parent.parent))
        || (ts.isArrayLiteralExpression(parent) && parent.elements.includes(node))
      ) {
        const forwardedSummary = trySummarizeAggregateLiteralForwarding(project, node, cache, summaryCache);
        if (forwardedSummary) {
          mergeHelperParameterSummary(summary, forwardedSummary);
          return;
        }

        markHelperParameterBoundary(summary, parent, "helper stores this value inside an aggregate literal beyond exact local analysis");
        return;
      }

      if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
        const argumentIndex = (parent.arguments ?? []).findIndex((argument) => argument === node);
        if (argumentIndex >= 0) {
          if (
            ts.isCallExpression(parent)
            && ts.isPropertyAccessExpression(parent.expression)
            && parent.expression.name.text === TRACKING_RETAINED_BINDING_WRITE_METHOD
            && argumentIndex === 1
            && isSupportedRetainedBindingContainerType(project, parent.expression.expression)
          ) {
            summary.effectKinds.add("retained-binding");
            return;
          }

          const directCallable = resolveAnalyzableFunctionDeclaration(project, parent.expression)
            ?? resolveSameEnclosingLocalFunctionDeclaration(project, declaration, parent.expression);
          const memberResolution = directCallable
            ? undefined
            : resolveHelperMemberCallCandidates(project, parent.expression, {
                ...context,
                projectionContext,
              });
          const callables = directCallable
            ? [directCallable]
            : memberResolution?.callables?.map((callable) => callable.declaration) ?? [];
          if (memberResolution?.boundaryReason) {
            markHelperParameterBoundary(summary, parent, memberResolution.boundaryReason);
            return;
          }
          if (callables.length === 0) {
            markHelperParameterBoundary(summary, parent, "helper forwards this value into a call boundary beyond exact local analysis");
            return;
          }

          for (const callable of callables) {
            const nestedParameter = callable.parameters[argumentIndex];
            if (!nestedParameter || !ts.isIdentifier(nestedParameter.name)) {
              markHelperParameterBoundary(summary, parent, "helper forwards this value into an unsupported parameter shape");
              return;
            }

            const nestedSummary = summarizeHelperParameterUse(project, callable, nestedParameter.name, cache, summaryCache);
            nestedSummary.effectKinds.forEach((effect) => summary.effectKinds.add(effect));
            for (const readPath of nestedSummary.exactReadPaths) {
              const serialized = serializePath(readPath);
              if (summary.exactReadPaths.some((candidate) => serializePath(candidate) === serialized)) {
                continue;
              }

              summary.exactReadPaths.push(readPath);
            }
            if (nestedSummary.boundaryReason) {
              markHelperParameterBoundary(summary, nestedSummary.boundaryNode ?? parent, nestedSummary.boundaryReason);
              return;
            }
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
          || isExactArrayCallbackMethod(methodName)
          || ARRAY_APPEND_METHODS.has(methodName)
          || ARRAY_TRUNCATE_METHODS.has(methodName)
          || ARRAY_REPLACEMENT_METHODS.has(methodName)
          || ARRAY_REORDER_METHODS.has(methodName)
          || methodName === TRACKING_ARRAY_INDEX_ACCESS_METHOD
        ) {
          summary.effectKinds.add(WHOLE_ARRAY_CONSUMPTION_METHODS.has(methodName) ? "read" : "mutation");
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
        summary.effectKinds.add("mutation");
        return;
      }

      if (
        ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && ts.isBinaryExpression(parent.parent)
        && parent.parent.left === parent
        && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        summary.effectKinds.add("mutation");
        return;
      }

      const callArgumentUse = getCallArgumentUse(project, node, {
        parameterMeaningfulUse: cache,
        callablePurity: new Map(),
      });
      if (callArgumentUse === TRACKING_ACCESS_KIND.read) {
        summary.effectKinds.add("read");
      } else if (isUpdateRead(node) || isReadLikeUse(node)) {
        summary.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.read);
      }
    }

    ts.forEachChild(node, (child) => visit(child, projectionContext));
  };

  ts.forEachChild(body, (child) => visit(child));
  const directStorageNode = findDirectReferenceStorageParameterUse(project, declaration, parameterName);
  const supportedAggregateForwarding = directStorageNode
    ? trySummarizeAggregateLiteralForwarding(
        project,
        ts.isShorthandPropertyAssignment(directStorageNode.parent) ? directStorageNode.parent : directStorageNode,
        cache,
        summaryCache,
      )
    : undefined;
  if (
    directStorageNode
    && !supportedAggregateForwarding
    && (
      !summary.boundaryReason
      || summary.boundaryReason === "helper stores this value inside an aggregate literal beyond exact local analysis"
      || summary.boundaryReason === "helper stores this value in an unsupported retained location"
    )
  ) {
    summary.effectKinds.add(TRACKING_HELPER_PARAMETER_EFFECT_KIND.opaqueEscape);
    summary.boundaryNode = directStorageNode;
    summary.boundaryReason = "helper stores this value by reference beyond exact local analysis";
  }
  summaryCache.set(cacheKey, summary);
  return summary;
}

export function buildHelperBoundaryReason(
  project: ProjectContext,
  summary: Pick<HelperParameterSummary, "boundaryNode" | "boundaryReason">,
  fallback: string,
): string {
  if (!summary.boundaryReason || !summary.boundaryNode) {
    return fallback;
  }

  const causeSourceFile = summary.boundaryNode.getSourceFile();
  return `${summary.boundaryReason} (helper cause at ${getHelperLocationText(project, causeSourceFile, summary.boundaryNode)})`;
}
