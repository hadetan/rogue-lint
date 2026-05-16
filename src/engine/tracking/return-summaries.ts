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
  cloneCallableReturnSummary,
  getAnalyzableCallableBindingFromDeclaration,
  getAnalyzableCallableName,
  getCallableReturnBinding,
  joinCallableReturnSummaries,
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

  const getSameCallableLocalInitializer = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) {
      return undefined;
    }

    const symbol = project.checker.getSymbolAtLocation(unwrapped);
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

    return declaration.initializer;
  };

  const getSameCallableLocalStructuredAliasSummary = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
  ): CallableReturnSummary | undefined => {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) {
      return undefined;
    }

    const symbol = project.checker.getSymbolAtLocation(unwrapped);
    const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
    if (!symbol || !declaration?.initializer || !ts.isIdentifier(declaration.name)) {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    if (enclosingFunction !== callable.declaration) {
      return undefined;
    }

    const literal = getTrackableStructuredLiteral(declaration.initializer, { allowArraySpreadBoundary: true });
    if (!literal) {
      return undefined;
    }

    return {
      kind: "returned-alias",
      binding: createTrackedBindingForLiteral(
        getCanonicalSymbolKey(project, symbol),
        declaration.getSourceFile(),
        literal,
        declaration.name.text,
        "local",
        declaration.name,
      ),
    };
  };

  const isSameCallableLocalIdentifier = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
  ): boolean => {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(unwrapped);
    const declaration = symbol?.declarations?.find(
      ts.isVariableDeclaration,
    );
    if (!declaration) {
      return false;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    return enclosingFunction === callable.declaration;
  };

  const mergeReturnSummaries = (
    current: CallableReturnSummary | undefined,
    next: CallableReturnSummary,
  ): CallableReturnSummary | undefined => {
    return joinCallableReturnSummaries(current, next).summary;
  };

  const getSpeculativeCallableSummary = (
    callable: AnalyzableCallableBinding,
    activeCallableIds: Set<string>,
    speculativeSummaries: Map<string, CallableReturnSummary>,
  ): CallableReturnSummary | undefined => {
    const stabilizedSummary = functionReturnSummaries.get(callable.symbolKey);
    if (stabilizedSummary && stabilizedSummary.kind !== "opaque") {
      return cloneCallableReturnSummary(stabilizedSummary);
    }

    const cachedSummary = speculativeSummaries.get(callable.symbolKey);
    if (cachedSummary) {
      return cloneCallableReturnSummary(cachedSummary);
    }

    if (activeCallableIds.has(callable.symbolKey)) {
      return undefined;
    }

    const summary = collectFunctionReturnSummary(callable.declaration, activeCallableIds, speculativeSummaries);
    if (summary) {
      speculativeSummaries.set(callable.symbolKey, cloneCallableReturnSummary(summary));
    }

    return summary ? cloneCallableReturnSummary(summary) : undefined;
  };

  const summarizeCallbackReturnExpression = (
    callable: AnalyzableCallableBinding,
    callback: ts.FunctionExpression | ts.ArrowFunction,
    activeCallableIds: Set<string>,
    speculativeSummaries: Map<string, CallableReturnSummary>,
  ): CallableReturnSummary | undefined => {
    if (!ts.isBlock(callback.body)) {
      return summarizeReturnExpression(callable, callback.body, activeCallableIds, speculativeSummaries);
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
        const nextSummary = summarizeReturnExpression(callable, node.expression, activeCallableIds, speculativeSummaries);
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
    return !unsupported && sawReturn && summary ? cloneCallableReturnSummary(summary) : undefined;
  };

  const summarizeReturnExpression = (
    callable: AnalyzableCallableBinding,
    expression: ts.Expression,
    activeCallableIds: Set<string>,
    speculativeSummaries: Map<string, CallableReturnSummary>,
  ): CallableReturnSummary | undefined => {
    if (
      ts.isAwaitExpression(expression)
    ) {
      return summarizeReturnExpression(callable, expression.expression, activeCallableIds, speculativeSummaries);
    }

    if (
      ts.isParenthesizedExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) {
      return summarizeReturnExpression(callable, expression.expression, activeCallableIds, speculativeSummaries);
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

          const nextSummary = summarizeCallbackReturnExpression(
            callable,
            callback,
            activeCallableIds,
            speculativeSummaries,
          );
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
      if (nestedCallable) {
        const summary = getSpeculativeCallableSummary(nestedCallable, activeCallableIds, speculativeSummaries);
        if (summary) {
          return summary;
        }
      }
    }

    if (
      ts.isBinaryExpression(expression)
      && (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      const left = summarizeReturnExpression(callable, expression.left, activeCallableIds, speculativeSummaries);
      const right = summarizeReturnExpression(callable, expression.right, activeCallableIds, speculativeSummaries);
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
        return joinCallableReturnSummaries(left, right).summary;
      }

      return { kind: "opaque" };
    }

    if (ts.isConditionalExpression(expression)) {
      const whenTrue = summarizeReturnExpression(callable, expression.whenTrue, activeCallableIds, speculativeSummaries);
      const whenFalse = summarizeReturnExpression(callable, expression.whenFalse, activeCallableIds, speculativeSummaries);
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
        return joinCallableReturnSummaries(whenTrue, whenFalse).summary;
      }

      return { kind: "opaque" };
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

    const localStructuredAliasSummary = getSameCallableLocalStructuredAliasSummary(callable, expression);
    if (localStructuredAliasSummary) {
      return localStructuredAliasSummary;
    }

    const localInitializer = getSameCallableLocalInitializer(callable, expression);
    if (localInitializer) {
      const localSummary = summarizeReturnExpression(callable, localInitializer, activeCallableIds, speculativeSummaries);
      if (localSummary) {
        return localSummary;
      }
    }

    if (isSameCallableLocalIdentifier(callable, expression)) {
      return undefined;
    }

    if (isTrackablePureExpression(expression)) {
      return { kind: "value" };
    }

    return undefined;
  };

  const collectFunctionReturnSummary = (
    declaration: ts.FunctionLikeDeclaration,
    activeCallableIds = new Set<string>(),
    speculativeSummaries = new Map<string, CallableReturnSummary>(),
  ): CallableReturnSummary | undefined => {
    const callable = getAnalyzableCallableBindingFromDeclaration(project, declaration);
    if (!callable?.declaration.body) {
      return undefined;
    }

    if (activeCallableIds.has(callable.symbolKey)) {
      return undefined;
    }

    activeCallableIds.add(callable.symbolKey);

    let summary: CallableReturnSummary | undefined;
    let sawReturn = false;
    let pending = false;

    const visit = (node: ts.Node): void => {
      if (pending) {
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
          : summarizeReturnExpression(callable, node.expression, activeCallableIds, speculativeSummaries);
        if (!nextSummary) {
          pending = true;
          return;
        }

        if (!summary) {
          summary = cloneCallableReturnSummary(nextSummary);
          return;
        }

        const joinedSummary = joinCallableReturnSummaries(summary, nextSummary).summary;
        if (!joinedSummary) {
          pending = true;
          return;
        }

        summary = joinedSummary;
      }

      ts.forEachChild(node, visit);
    };

    try {
      ts.forEachChild(callable.declaration.body, visit);
    } finally {
      activeCallableIds.delete(callable.symbolKey);
    }

    if (!sawReturn) {
      return undefined;
    }

    return pending ? undefined : summary ? cloneCallableReturnSummary(summary) : undefined;
  };

  return {
    collectFunctionReturnSummary,
    getTrackableStructuredLiteral,
    resolveStructuredReturnAliasCallable,
  };
}
