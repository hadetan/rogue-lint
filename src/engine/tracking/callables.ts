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

/**
 * Callable-binding and return-summary helpers shared across the tracking kernel.
 *
 * These helpers define how same-project callable declarations are resolved and how
 * tracked return summaries are compared across fixpoint iterations.
 */

export function getCallableReturnBinding(summary: CallableReturnSummary | undefined): TrackedObjectBinding | undefined {
  if (!summary || summary.kind === "value" || summary.kind === "opaque") {
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
  if (summary.kind === "value" || summary.kind === "opaque") {
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
    if (current.kind === "opaque") {
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

  if (current.kind === "opaque") {
    return {
      summary: { kind: "opaque" },
      widened: false,
    };
  }

  if (next.kind === "opaque") {
    return {
      summary: { kind: "opaque" },
      widened: true,
      reason: "unsupported summary widened to opaque",
    };
  }

  if (current.kind === "value" && next.kind === "value") {
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
    if (current.kind === "returned-alias" || next.kind === "returned-alias") {
      return {
        summary: {
          kind: "returned-alias",
          binding: cloneTrackedBinding(currentBinding),
        },
        widened: current.kind !== "returned-alias" || next.kind !== "returned-alias",
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
): TrackingMapDiff {
  let changedCount = 0;
  const sampleKeys: string[] = [];
  const keys = new Set<string>([...left.keys(), ...right.keys()]);

  for (const key of keys) {
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

function getFunctionLikeDeclarationFromDeclaration(declaration: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
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

function getFunctionLikeDeclarationFromSymbol(symbol: ts.Symbol): ts.FunctionLikeDeclaration | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const callable = getFunctionLikeDeclarationFromDeclaration(declaration);
    if (callable) {
      return callable;
    }
  }

  return undefined;
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
      return getFunctionLikeDeclarationFromDeclaration(property);
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

  return "returnedValue";
}

export function getAnalyzableCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): AnalyzableCallableBinding | undefined {
  const calleeSymbol = getCallableSymbol(project, expression);
  if (calleeSymbol) {
    const callable = getFunctionLikeDeclarationFromSymbol(getCanonicalSymbol(project, calleeSymbol));

    if (callable?.body) {
      return callable.getSourceFile().fileName.startsWith(project.rootPath)
        ? {
            declaration: callable,
            symbolKey: getCanonicalSymbolKey(project, calleeSymbol),
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

    if (ts.isPropertyAssignment(parent)) {
      const propertyName = parent.name;
      if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) {
        const symbol = project.checker.getSymbolAtLocation(propertyName);
        if (symbol) {
          return {
            declaration,
            symbolKey: getCanonicalSymbolKey(project, symbol),
          };
        }
      }
    }

    if (
      ts.isConditionalExpression(parent)
      && parent.whenFalse === declaration
      && ts.isVariableDeclaration(parent.parent)
      && ts.isIdentifier(parent.parent.name)
    ) {
      const symbol = project.checker.getSymbolAtLocation(parent.parent.name);
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

export function resolveAnalyzableFunctionDeclaration(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): ts.FunctionLikeDeclaration | undefined {
  return getAnalyzableCallableBinding(project, expression)?.declaration;
}
