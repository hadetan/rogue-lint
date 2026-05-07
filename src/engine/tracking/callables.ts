import ts from "typescript";

import type { ProjectContext } from "../../types.js";
import {
  getCanonicalSymbol,
  getCanonicalSymbolKey,
  sameTrackedBinding,
} from "./bindings.js";
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

export function sameCallableReturnSummaryMap(
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

  return "returnedValue";
}

export function getAnalyzableCallableBinding(
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
  }

  return undefined;
}

export function resolveAnalyzableFunctionDeclaration(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
): ts.FunctionLikeDeclaration | undefined {
  return getAnalyzableCallableBinding(project, expression)?.declaration;
}
