import ts from "typescript";

import type {
  EntityKind,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import {
  extendTrackedBinding,
  getCanonicalSymbolKey,
  sameTrackedBinding,
} from "./bindings.js";
import {
  resolveAnalyzableCallableBinding,
  resolveTrackedObjectAccess,
} from "./access.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getAnalyzableCallableName,
  getCallableReturnBinding,
} from "./callables.js";
import type {
  AnalyzableCallableBinding,
  CallableReturnSummary,
  TrackedObjectBinding,
} from "./model.js";
import { unwrapExpression } from "./syntax.js";
import {
  getTrackableStructuredLiteralExpression,
  isTrackablePureExpression,
  isTrackableReturnObjectStructure,
} from "./trackable-structures.js";

interface ReturnSummaryCollectorOptions {
  project: ProjectContext;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  createTrackedBindingForLiteral: (
    symbolKey: string,
    sourceFile: ts.SourceFile,
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    name: string,
    kind: EntityKind,
    anchor: ts.Node,
  ) => TrackedObjectBinding;
}

function getTrackableStructuredLiteral(
  expression: ts.Expression,
  options: { allowArraySpreadBoundary?: boolean } = {},
): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  if (!options.allowArraySpreadBoundary) {
    return getTrackableStructuredLiteralExpression(expression);
  }

  const initializer = unwrapExpression(expression);
  return (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
    && isTrackableReturnObjectStructure(initializer)
    ? initializer
    : undefined;
}

/**
 * Builds the structured-return summary helpers used during tracking convergence.
 */
export function createReturnSummaryCollector(options: ReturnSummaryCollectorOptions): {
  collectFunctionReturnSummary: (declaration: ts.FunctionLikeDeclaration) => CallableReturnSummary | undefined;
  getTrackableStructuredLiteral: (
    expression: ts.Expression,
    options?: { allowArraySpreadBoundary?: boolean },
  ) => ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined;
  resolveStructuredReturnAliasCallable: (declaration: ts.VariableDeclaration) => AnalyzableCallableBinding | undefined;
} {
  const {
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    createTrackedBindingForLiteral,
  } = options;

  const createStructuredReturnBinding = (
    callable: AnalyzableCallableBinding,
    literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ): TrackedObjectBinding => {
    const returnKind = ts.isObjectLiteralExpression(literal) ? "object" : "array";
    return createTrackedBindingForLiteral(
      `${callable.symbolKey}:return:${returnKind}`,
      literal.getSourceFile(),
      literal,
      `${getAnalyzableCallableName(callable)}()`,
      "expression",
      literal,
    );
  };

  const createStructuredReturnSummary = (
    callable: AnalyzableCallableBinding,
    literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ): CallableReturnSummary => {
    return {
      kind: "structured",
      binding: createStructuredReturnBinding(callable, literal),
    };
  };

  const cloneReturnSummary = (summary: CallableReturnSummary): CallableReturnSummary => {
    if (summary.kind === "value" || summary.kind === "opaque") {
      return { kind: summary.kind };
    }

    return {
      kind: summary.kind,
      binding: summary.binding,
    };
  };

  const resolveStructuredReturnAliasCallable = (
    declaration: ts.VariableDeclaration,
  ): AnalyzableCallableBinding | undefined => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
      return undefined;
    }

    if (!getTrackableStructuredLiteral(declaration.initializer, { allowArraySpreadBoundary: true })) {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    const callable = enclosingFunction
      ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction)
      : undefined;
    if (!callable?.declaration.body) {
      return undefined;
    }

    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    if (!symbol) {
      return undefined;
    }

    const symbolKey = getCanonicalSymbolKey(project, symbol);
    let returned = false;
    const visit = (node: ts.Node): void => {
      if (returned) {
        return;
      }

      if (ts.isFunctionLike(node) && node !== callable.declaration) {
        return;
      }

      if (ts.isReturnStatement(node) && node.expression) {
        const expression = unwrapExpression(node.expression);
        if (ts.isIdentifier(expression)) {
          const returnedSymbol = project.checker.getSymbolAtLocation(expression);
          if (returnedSymbol && getCanonicalSymbolKey(project, returnedSymbol) === symbolKey) {
            returned = true;
            return;
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(callable.declaration.body, visit);
    return returned ? callable : undefined;
  };

  const resolveTrackableReturnedLiteralAlias = (
    callable: AnalyzableCallableBinding,
    candidate: ts.Expression,
  ): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined => {
    const node = unwrapExpression(candidate);
    if (!ts.isIdentifier(node)) {
      return undefined;
    }

    const symbol = project.checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
    if (!declaration?.initializer) {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    if (enclosingFunction !== callable.declaration) {
      return undefined;
    }

    return getTrackableStructuredLiteral(declaration.initializer, { allowArraySpreadBoundary: true });
  };

  const mergeReturnSummaries = (
    current: CallableReturnSummary | undefined,
    next: CallableReturnSummary,
  ): CallableReturnSummary | undefined => {
    if (!current) {
      return cloneReturnSummary(next);
    }

    if (current.kind === "value" && next.kind === "value") {
      return { kind: "value" };
    }

    const currentBinding = getCallableReturnBinding(current);
    const nextBinding = getCallableReturnBinding(next);
    if (!currentBinding) {
      return cloneReturnSummary(next);
    }
    if (!nextBinding) {
      return cloneReturnSummary(current);
    }

    if (!sameTrackedBinding(currentBinding, nextBinding)) {
      return undefined;
    }

    if (current.kind !== next.kind && !(current.kind === "returned-alias" && next.kind === "returned-alias")) {
      return { kind: "returned-alias", binding: currentBinding };
    }

    return cloneReturnSummary(current);
  };

  const summarizeCallbackReturnExpression = (
    callable: AnalyzableCallableBinding,
    callback: ts.FunctionExpression | ts.ArrowFunction,
  ): CallableReturnSummary | undefined => {
    if (!ts.isBlock(callback.body)) {
      return summarizeReturnExpression(callable, callback.body);
    }

    let summary: CallableReturnSummary | undefined;
    let sawReturn = false;
    let unsupported = false;

    const visit = (node: ts.Node): void => {
      if (unsupported) {
        return;
      }

      if (ts.isFunctionLike(node) && node !== callback) {
        return;
      }

      if (ts.isReturnStatement(node) && node.expression) {
        sawReturn = true;
        const nextSummary = summarizeReturnExpression(callable, node.expression);
        if (!nextSummary) {
          unsupported = true;
          return;
        }

        const merged = mergeReturnSummaries(summary, nextSummary);
        if (!merged) {
          unsupported = true;
          return;
        }

        summary = merged;
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(callback.body, visit);
    return !unsupported && sawReturn && summary ? cloneReturnSummary(summary) : undefined;
  };

  const summarizeReturnExpression = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
  ): CallableReturnSummary | undefined => {
    if (
      ts.isAwaitExpression(expression)
    ) {
      return summarizeReturnExpression(callable, expression.expression);
    }

    if (
      ts.isParenthesizedExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) {
      return summarizeReturnExpression(callable, expression.expression);
    }

    if ((ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) && isTrackableReturnObjectStructure(expression)) {
      return createStructuredReturnSummary(callable, expression);
    }

    if (ts.isCallExpression(expression)) {
      if (
        ts.isPropertyAccessExpression(expression.expression)
        && (expression.expression.name.text === "then" || expression.expression.name.text === "catch")
      ) {
        let callbackSummary: CallableReturnSummary | undefined;

        for (const argument of expression.arguments) {
          const callback = unwrapExpression(argument);
          if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
            continue;
          }

          const nextSummary = summarizeCallbackReturnExpression(callable, callback);
          if (!nextSummary) {
            return undefined;
          }

          const merged = mergeReturnSummaries(callbackSummary, nextSummary);
          if (!merged) {
            return undefined;
          }

          callbackSummary = merged;
        }

        if (callbackSummary) {
          return callbackSummary;
        }
      }

      const nestedCallable = resolveAnalyzableCallableBinding(
        project,
        expression.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      const summary = nestedCallable ? functionReturnSummaries.get(nestedCallable.symbolKey) : undefined;
      return summary && summary.kind !== "opaque" ? cloneReturnSummary(summary) : undefined;
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
        const returnedLiteralAlias = resolveTrackableReturnedLiteralAlias(callable, node.expression);
        const nextSummary = returnedLiteralAlias
          ? createStructuredReturnSummary(callable, returnedLiteralAlias)
          : summarizeReturnExpression(callable, node.expression);
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

    return unsupported ? { kind: "opaque" } : summary ? cloneReturnSummary(summary) : { kind: "opaque" };
  };

  return {
    collectFunctionReturnSummary,
    getTrackableStructuredLiteral,
    resolveStructuredReturnAliasCallable,
  };
}
