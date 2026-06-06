import ts from "typescript";

import type { ProjectContext } from "../../types.js";
import { samePath } from "../../shared/path-utils.js";
import {
  type TrackingMapDiff,
  getCanonicalSymbol,
  getCanonicalSymbolKey,
  sameTrackedBinding,
} from "./bindings.js";
import { unwrapExpression } from "./syntax.js";
import type {
  AnalyzableCallableBinding,
  CallableReturnSummary,
  TrackedObjectBinding,
} from "./model.js";
import { TRACKING_RETURN_SUMMARY_KIND } from "./vocabulary.js";

/**
 * Callable-binding and return-summary helpers shared across the tracking kernel.
 *
 * These helpers define how same-project callable declarations are resolved and how
 * tracked return summaries are compared across fixpoint iterations.
 */

export function getCallableReturnBinding(summary: CallableReturnSummary | undefined): TrackedObjectBinding | undefined {
  if (
    !summary
    || summary.kind === TRACKING_RETURN_SUMMARY_KIND.value
    || summary.kind === TRACKING_RETURN_SUMMARY_KIND.opaque
  ) {
    return undefined;
  }

  return summary.binding;
}

function cloneTrackedBinding(binding: TrackedObjectBinding): TrackedObjectBinding {
  return {
    trackedObject: binding.trackedObject,
    prefix: [...binding.prefix],
  };
}

function sameCallableReturnBinding(left: TrackedObjectBinding, right: TrackedObjectBinding): boolean {
  if (sameTrackedBinding(left, right)) {
    return true;
  }

  if (!samePath(left.prefix, right.prefix)) {
    return false;
  }

  const leftReportingOwnerId = left.trackedObject.reportingOwnerId ?? left.trackedObject.id;
  const rightReportingOwnerId = right.trackedObject.reportingOwnerId ?? right.trackedObject.id;
  return leftReportingOwnerId === rightReportingOwnerId
    || (
      left.trackedObject.canonicalSymbolKey !== undefined
      && right.trackedObject.canonicalSymbolKey !== undefined
      && left.trackedObject.canonicalSymbolKey === right.trackedObject.canonicalSymbolKey
    );
}

export function cloneCallableReturnSummary(summary: CallableReturnSummary): CallableReturnSummary {
  if (
    summary.kind === TRACKING_RETURN_SUMMARY_KIND.value
    || summary.kind === TRACKING_RETURN_SUMMARY_KIND.opaque
  ) {
    return { kind: summary.kind };
  }

  return {
    kind: summary.kind,
    binding: cloneTrackedBinding(summary.binding),
  };
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

  return sameCallableReturnBinding(leftBinding, rightBinding);
}

export function joinCallableReturnSummaries(
  current: CallableReturnSummary | undefined,
  next: CallableReturnSummary | undefined,
): {
  summary: CallableReturnSummary | undefined;
  widened: boolean;
  reason?: string;
} {
  if (!current) {
    return {
      summary: next ? cloneCallableReturnSummary(next) : undefined,
      widened: false,
    };
  }

  if (!next) {
    if (current.kind === TRACKING_RETURN_SUMMARY_KIND.opaque) {
      return {
        summary: { kind: "opaque" },
        widened: false,
      };
    }

    return {
      summary: { kind: "opaque" },
      widened: true,
      reason: "missing follow-up summary widened to opaque",
    };
  }

  if (sameCallableReturnSummary(current, next)) {
    return {
      summary: cloneCallableReturnSummary(current),
      widened: false,
    };
  }

  if (current.kind === TRACKING_RETURN_SUMMARY_KIND.opaque) {
    return {
      summary: { kind: "opaque" },
      widened: false,
    };
  }

  if (next.kind === TRACKING_RETURN_SUMMARY_KIND.opaque) {
    return {
      summary: { kind: "opaque" },
      widened: true,
      reason: "unsupported summary widened to opaque",
    };
  }

  if (
    current.kind === TRACKING_RETURN_SUMMARY_KIND.value
    && next.kind === TRACKING_RETURN_SUMMARY_KIND.value
  ) {
    return {
      summary: { kind: "value" },
      widened: false,
    };
  }

  const currentBinding = getCallableReturnBinding(current);
  const nextBinding = getCallableReturnBinding(next);
  if (!currentBinding && nextBinding) {
    return {
      summary: cloneCallableReturnSummary(next),
      widened: false,
    };
  }

  if (currentBinding && !nextBinding) {
    return {
      summary: cloneCallableReturnSummary(current),
      widened: false,
    };
  }

  if (currentBinding && nextBinding && sameCallableReturnBinding(currentBinding, nextBinding)) {
    if (
      current.kind === TRACKING_RETURN_SUMMARY_KIND.returnedAlias
      || next.kind === TRACKING_RETURN_SUMMARY_KIND.returnedAlias
    ) {
      return {
        summary: {
          kind: "returned-alias",
          binding: cloneTrackedBinding(currentBinding),
        },
        widened:
          current.kind !== TRACKING_RETURN_SUMMARY_KIND.returnedAlias
          || next.kind !== TRACKING_RETURN_SUMMARY_KIND.returnedAlias,
        reason: current.kind !== next.kind
          ? "mixed summary kinds for the same binding widened to returned-alias"
          : undefined,
      };
    }

    return {
      summary: {
        kind: "structured",
        binding: cloneTrackedBinding(currentBinding),
      },
      widened: false,
    };
  }

  return {
    summary: { kind: "opaque" },
    widened: true,
    reason: "conflicting precise summaries widened to opaque",
  };
}

export function diffCallableReturnSummaryMaps(
  left: Map<string, CallableReturnSummary>,
  right: Map<string, CallableReturnSummary>,
  sampleLimit: number,
  heartbeat?: () => void,
): TrackingMapDiff {
  let changedCount = 0;
  const sampleKeys: string[] = [];
  const keys = new Set<string>([...left.keys(), ...right.keys()]);
  let heartbeatCounter = 0;

  for (const key of keys) {
    heartbeatCounter += 1;
    if (heartbeatCounter >= 2048) {
      heartbeatCounter = 0;
      heartbeat?.();
    }

    const current = left.get(key);
    const next = right.get(key);
    if (!current || !next || !sameCallableReturnSummary(current, next)) {
      changedCount += 1;
      if (sampleKeys.length < sampleLimit) {
        sampleKeys.push(key);
      }
    }
  }

  return {
    changedCount,
    sampleKeys,
  };
}

function getFunctionLikeDeclarationFromDeclaration(
  project: ProjectContext,
  declaration: ts.Declaration,
): ts.FunctionLikeDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(declaration)
    || ts.isFunctionExpression(declaration)
    || ts.isArrowFunction(declaration)
    || ts.isMethodDeclaration(declaration)
  ) {
    return declaration;
  }

  if (
    ts.isVariableDeclaration(declaration)
    && declaration.initializer
    && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
  ) {
    return declaration.initializer;
  }

  if (
    ts.isVariableDeclaration(declaration)
    && declaration.initializer
    && ts.isCallExpression(declaration.initializer)
  ) {
    const returnedCallable = getReturnedCallableDeclarationFromCallExpression(project, declaration.initializer);
    if (returnedCallable) {
      return returnedCallable;
    }
  }

  if (
    ts.isVariableDeclaration(declaration)
    && declaration.initializer
    && ts.isConditionalExpression(declaration.initializer)
    && (ts.isFunctionExpression(declaration.initializer.whenFalse) || ts.isArrowFunction(declaration.initializer.whenFalse))
  ) {
    return declaration.initializer.whenFalse;
  }

  if (
    ts.isPropertyAssignment(declaration)
    && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
  ) {
    return declaration.initializer;
  }

  return undefined;
}

function getFunctionLikeDeclarationFromSymbol(
  project: ProjectContext,
  symbol: ts.Symbol,
): ts.FunctionLikeDeclaration | undefined {
  let fallback: ts.FunctionLikeDeclaration | undefined;

  for (const declaration of symbol.declarations ?? []) {
    const callable = getFunctionLikeDeclarationFromDeclaration(project, declaration);
    if (!callable) {
      continue;
    }

    if (callable.body) {
      return callable;
    }

    fallback ??= callable;
  }

  return fallback;
}

function getSingleReturnExpression(callable: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!callable.body) {
    return undefined;
  }

  if (!ts.isBlock(callable.body)) {
    return callable.body;
  }

  let match: ts.Expression | undefined;
  let multiple = false;

  const visit = (candidate: ts.Node): void => {
    if (multiple || (ts.isFunctionLike(candidate) && candidate !== callable)) {
      return;
    }

    if (ts.isReturnStatement(candidate) && candidate.expression) {
      if (match) {
        multiple = true;
        return;
      }

      match = candidate.expression;
      return;
    }

    ts.forEachChild(candidate, visit);
  };

  ts.forEachChild(callable.body, visit);
  return multiple ? undefined : match;
}

function getReturnedCallableDeclarationFromCallExpression(
  project: ProjectContext,
  callExpression: ts.CallExpression,
): ts.FunctionLikeDeclaration | undefined {
  const callable = getAnalyzableCallableBinding(project, callExpression.expression);
  if (!callable) {
    return undefined;
  }

  const returned = getSingleReturnExpression(callable.declaration);
  if (!returned) {
    return undefined;
  }

  const expression = unwrapExpression(returned);
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return expression;
  }

  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(expression);
  return symbol ? getFunctionLikeDeclarationFromSymbol(project, symbol) : undefined;
}

const binaryAssignedCallableDeclarationCache = new WeakMap<ProjectContext, Map<string, ts.FunctionLikeDeclaration | null>>();

function getBinaryAssignedCallableDeclaration(
  project: ProjectContext,
  symbol: ts.Symbol,
): ts.FunctionLikeDeclaration | undefined {
  const canonicalSymbol = getCanonicalSymbol(project, symbol);
  const symbolKey = getCanonicalSymbolKey(project, canonicalSymbol);
  let cache = binaryAssignedCallableDeclarationCache.get(project);
  if (!cache) {
    cache = new Map<string, ts.FunctionLikeDeclaration | null>();
    binaryAssignedCallableDeclarationCache.set(project, cache);
  }

  const cached = cache.get(symbolKey);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  let match: ts.FunctionLikeDeclaration | null = null;
  let multiple = false;

  for (const sourceFile of project.sourceFiles) {
    if (multiple) {
      break;
    }

    const visit = (node: ts.Node): void => {
      if (multiple) {
        return;
      }

      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right))
      ) {
        const targetSymbol = getAssignmentTargetSymbol(project, node.left);
        if (targetSymbol && getCanonicalSymbolKey(project, targetSymbol) === symbolKey) {
          if (match) {
            multiple = true;
            return;
          }

          match = node.right;
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  cache.set(symbolKey, multiple ? null : match);
  return multiple ? undefined : match ?? undefined;
}

function getCallableSymbol(project: ProjectContext, expression: ts.LeftHandSideExpression): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) {
    return project.checker.getSymbolAtLocation(expression);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return project.checker.getSymbolAtLocation(expression.name);
  }

  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && (
      ts.isStringLiteral(expression.argumentExpression)
      || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
      || ts.isNumericLiteral(expression.argumentExpression)
    )
  ) {
    return project.checker.getSymbolAtLocation(expression.argumentExpression);
  }

  return undefined;
}

function getStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function resolveStaticCallableFromSymbol(
  project: ProjectContext,
  symbol: ts.Symbol,
  segments: string[],
  visitedSymbols: Set<string>,
): ts.FunctionLikeDeclaration | undefined {
  const canonical = getCanonicalSymbol(project, symbol);
  const symbolKey = getCanonicalSymbolKey(project, canonical);
  if (visitedSymbols.has(symbolKey)) {
    return undefined;
  }
  visitedSymbols.add(symbolKey);

  for (const declaration of canonical.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const callable = resolveStaticCallableFromExpression(project, declaration.initializer, segments, visitedSymbols);
      if (callable) {
        return callable;
      }
    }

    if (ts.isPropertyAssignment(declaration)) {
      const callable = resolveStaticCallableFromExpression(project, declaration.initializer, segments, visitedSymbols);
      if (callable) {
        return callable;
      }
    }
  }

  return undefined;
}

function resolveStaticCallableFromExpression(
  project: ProjectContext,
  expression: ts.Expression,
  segments: string[],
  visitedSymbols: Set<string>,
): ts.FunctionLikeDeclaration | undefined {
  const node = unwrapExpression(expression);

  if (segments.length === 0) {
    return (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) ? node : undefined;
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? resolveStaticCallableFromSymbol(project, symbol, segments, visitedSymbols) : undefined;
  }

  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  const [head, ...tail] = segments;
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      continue;
    }

    const propertyName = getStaticPropertyName(property.name);
    if (propertyName !== head) {
      continue;
    }

    if (tail.length === 0) {
      return getFunctionLikeDeclarationFromDeclaration(project, property);
    }

    if (ts.isPropertyAssignment(property)) {
      return resolveStaticCallableFromExpression(project, property.initializer, tail, visitedSymbols);
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(property);
      return valueSymbol ? resolveStaticCallableFromSymbol(project, valueSymbol, tail, visitedSymbols) : undefined;
    }

    return undefined;
  }

  return undefined;
}

function resolveStaticCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): AnalyzableCallableBinding | undefined {
  const segments: string[] = [];
  let current: ts.Expression = expression;

  while (true) {
    const node = unwrapExpression(current);
    if (ts.isPropertyAccessExpression(node)) {
      segments.unshift(node.name.text);
      current = node.expression;
      continue;
    }

    if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression
      && (
        ts.isStringLiteral(node.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
        || ts.isNumericLiteral(node.argumentExpression)
      )
    ) {
      segments.unshift(node.argumentExpression.text);
      current = node.expression;
      continue;
    }

    const declaration = resolveStaticCallableFromExpression(project, node, segments, new Set<string>());
    return declaration ? getAnalyzableCallableBindingFromDeclaration(project, declaration) : undefined;
  }
}

export function getAnalyzableCallableName(callable: AnalyzableCallableBinding): string {
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

  if (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isConditionalExpression(declaration.parent)
    && ts.isVariableDeclaration(declaration.parent.parent)
  ) {
    const parentName = declaration.parent.parent.name;
    if (ts.isIdentifier(parentName)) {
      return parentName.text;
    }
  }

  if ((ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && ts.isPropertyAssignment(declaration.parent)) {
    const propertyName = declaration.parent.name;
    if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
      return propertyName.text;
    }
  }

  if (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isBinaryExpression(declaration.parent)
    && declaration.parent.right === declaration
  ) {
    const assigned = declaration.parent.left;
    if (ts.isIdentifier(assigned)) {
      return assigned.text;
    }

    if (ts.isPropertyAccessExpression(assigned)) {
      return assigned.name.text;
    }

    if (
      ts.isElementAccessExpression(assigned)
      && assigned.argumentExpression
      && (
        ts.isStringLiteral(assigned.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(assigned.argumentExpression)
        || ts.isNumericLiteral(assigned.argumentExpression)
      )
    ) {
      return assigned.argumentExpression.text;
    }
  }

  return "returnedValue";
}

function getAssignmentTargetSymbol(
  project: ProjectContext,
  expression: ts.Expression,
): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) {
    return project.checker.getSymbolAtLocation(expression);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return project.checker.getSymbolAtLocation(expression.name);
  }

  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && (
      ts.isStringLiteral(expression.argumentExpression)
      || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
      || ts.isNumericLiteral(expression.argumentExpression)
    )
  ) {
    return project.checker.getSymbolAtLocation(expression.argumentExpression);
  }

  return undefined;
}

function getCallableBindingSymbolKey(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
  fallbackSymbol?: ts.Symbol,
): string | undefined {
  if (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isBinaryExpression(declaration.parent)
    && declaration.parent.right === declaration
    && declaration.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return `${declaration.getSourceFile().fileName}:${declaration.getStart()}:binary-assigned-callable`;
  }

  return fallbackSymbol ? getCanonicalSymbolKey(project, fallbackSymbol) : undefined;
}

export function getAnalyzableCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): AnalyzableCallableBinding | undefined {
  const calleeSymbol = getCallableSymbol(project, expression);
  if (calleeSymbol) {
    const canonicalSymbol = getCanonicalSymbol(project, calleeSymbol);
    const callable = getFunctionLikeDeclarationFromSymbol(project, canonicalSymbol)
      ?? getBinaryAssignedCallableDeclaration(project, canonicalSymbol);

    if (callable?.body) {
      const symbolKey = getCallableBindingSymbolKey(project, callable, calleeSymbol);
      return callable.getSourceFile().fileName.startsWith(project.rootPath)
        && symbolKey
        ? {
            declaration: callable,
            symbolKey,
          }
        : undefined;
    }
  }

  return resolveStaticCallableBinding(project, expression);
}

export function getAnalyzableCallableBindingFromDeclaration(
  project: ProjectContext,
  declaration: ts.FunctionLikeDeclaration,
): AnalyzableCallableBinding | undefined {
  if (!declaration.body || !declaration.getSourceFile().fileName.startsWith(project.rootPath)) {
    return undefined;
  }

  if (declaration.name && ts.isIdentifier(declaration.name)) {
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    const symbolKey = symbol ? getCallableBindingSymbolKey(project, declaration, symbol) : undefined;
    if (symbolKey) {
      return {
        declaration,
        symbolKey,
      };
    }
  }

  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const symbol = project.checker.getSymbolAtLocation(parent.name);
      const symbolKey = symbol ? getCallableBindingSymbolKey(project, declaration, symbol) : undefined;
      if (symbolKey) {
        return {
          declaration,
          symbolKey,
        };
      }
    }

    if (ts.isPropertyAssignment(parent)) {
      const propertyName = parent.name;
      if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
        const symbol = project.checker.getSymbolAtLocation(propertyName);
        const symbolKey = symbol ? getCallableBindingSymbolKey(project, declaration, symbol) : undefined;
        if (symbolKey) {
          return {
            declaration,
            symbolKey,
          };
        }
      }
    }

    if (
      ts.isBinaryExpression(parent)
      && parent.right === declaration
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const symbol = getAssignmentTargetSymbol(project, parent.left);
      const symbolKey = symbol ? getCallableBindingSymbolKey(project, declaration, symbol) : undefined;
      if (symbolKey) {
        return {
          declaration,
          symbolKey,
        };
      }
    }

    if (
      ts.isConditionalExpression(parent)
      && parent.whenFalse === declaration
      && ts.isVariableDeclaration(parent.parent)
      && ts.isIdentifier(parent.parent.name)
    ) {
      const symbol = project.checker.getSymbolAtLocation(parent.parent.name);
      const symbolKey = symbol ? getCallableBindingSymbolKey(project, declaration, symbol) : undefined;
      if (symbolKey) {
        return {
          declaration,
          symbolKey,
        };
      }
    }
  }

  return undefined;
}

export function resolveAnalyzableFunctionDeclaration(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): ts.FunctionLikeDeclaration | undefined {
  return getAnalyzableCallableBinding(project, expression)?.declaration;
}
