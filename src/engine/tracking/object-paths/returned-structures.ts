import ts from "typescript";

import type { PathSegment, ProjectContext, SkipCategory, TrackedObject } from "../../../types.js";
import { isSerializedPathWithin, serializePath } from "../../../shared/path-utils.js";
import { resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, getCanonicalSymbolKey, sameTrackedBinding } from "../bindings.js";
import { getAnalyzableCallableBindingFromDeclaration, getCallableReturnBinding } from "../callables.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "../model.js";
import { isTrackablePureExpression } from "../trackable-structures.js";
import { unwrapExpression } from "../syntax.js";
import { TRACKING_RETURN_SUMMARY_KIND } from "../vocabulary.js";

interface ReturnedStructureHandlerOptions {
  project: ProjectContext;
  publicSurfaceIds: ReadonlySet<string>;
  publiclyReachableCallableIds: ReadonlySet<string>;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  markObservedSubtree: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    aliasTrackedObjectsById?: Map<string, TrackedObject>,
    visited?: Set<string>,
  ) => void;
  markEscaped: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ) => void;
  resolveBoundedHelperReturnBinding?: (expression: ts.CallExpression) => TrackedObjectBinding | undefined;
}

interface PubliclyReachableCallableIdsOptions {
  publicSurfaceIds: ReadonlySet<string>;
  publicCallableIds: ReadonlySet<string>;
  trackedBySymbolId: ReadonlyMap<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: ReadonlyMap<string, TrackedObject>;
}

export function computePubliclyReachableCallableIds(
  options: PubliclyReachableCallableIdsOptions,
): Set<string> {
  const {
    publicSurfaceIds,
    publicCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  } = options;

  const reachable = new Set(publicCallableIds);
  const pendingBindings: TrackedObjectBinding[] = [];
  const visitedBindings = new Set<string>();

  const enqueueBinding = (binding: TrackedObjectBinding | undefined): void => {
    if (!binding) {
      return;
    }

    const key = `${binding.trackedObject.id}:${serializePath(binding.prefix)}`;
    if (visitedBindings.has(key)) {
      return;
    }

    visitedBindings.add(key);
    pendingBindings.push(binding);
  };

  const enqueueCallable = (symbolKey: string): void => {
    if (!reachable.has(symbolKey)) {
      reachable.add(symbolKey);
    }

    enqueueBinding(getCallableReturnBinding(functionReturnSummaries.get(symbolKey)));
  };

  for (const symbolKey of publicCallableIds) {
    enqueueBinding(getCallableReturnBinding(functionReturnSummaries.get(symbolKey)));
  }

  for (const binding of trackedBySymbolId.values()) {
    if (publicSurfaceIds.has(binding.trackedObject.rootEntity.id)) {
      enqueueBinding(binding);
    }
  }

  while (pendingBindings.length > 0) {
    const binding = pendingBindings.pop();
    if (!binding) {
      continue;
    }

    const prefix = serializePath(binding.prefix);

    for (const [joinedPath, callable] of binding.trackedObject.callablePaths.entries()) {
      if (isSerializedPathWithin(joinedPath, prefix)) {
        enqueueCallable(callable.symbolKey);
      }
    }

    for (const [aliasPath, alias] of binding.trackedObject.exactPathAliases.entries()) {
      if (!isSerializedPathWithin(aliasPath, prefix)) {
        continue;
      }

      const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
      if (!sourceTrackedObject) {
        continue;
      }

      enqueueBinding({
        trackedObject: sourceTrackedObject,
        prefix: alias.sourcePath,
      });
    }
  }

  return reachable;
}

/**
 * Creates the returned-structure and aggregate-literal helpers used by object-path analysis.
 */
export function createReturnedStructureHandler(options: ReturnedStructureHandlerOptions): {
  getPublicReturnBinding: (node: ts.Node) => TrackedObjectBinding | undefined;
  markObservedAggregateLiteralBindings: (expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression) => void;
  handleReturnStatement: (node: ts.ReturnStatement) => void;
} {
  const {
    project,
    publicSurfaceIds,
    publiclyReachableCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    markObservedSubtree,
    markEscaped,
    resolveBoundedHelperReturnBinding,
  } = options;

  const isReturnedParameterIdentifier = (
    callable: ts.FunctionLikeDeclaration | undefined,
    expression: ts.Expression,
  ): boolean => {
    const returned = unwrapExpression(expression);
    if (!callable || !ts.isIdentifier(returned)) {
      return false;
    }

    const returnedSymbol = project.checker.getSymbolAtLocation(returned);
    const returnedKey = returnedSymbol ? getCanonicalSymbolKey(project, returnedSymbol) : undefined;
    if (!returnedKey) {
      return false;
    }

    return callable.parameters.some((parameter) => {
      if (!ts.isIdentifier(parameter.name)) {
        return false;
      }

      const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
      return Boolean(parameterSymbol && getCanonicalSymbolKey(project, parameterSymbol) === returnedKey);
    });
  };

  const isFiniteKeyExpression = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(expression);
    return ts.isStringLiteral(unwrapped)
      || ts.isNoSubstitutionTemplateLiteral(unwrapped)
      || ts.isNumericLiteral(unwrapped);
  };

  const isWithinNode = (node: ts.Node, ancestor: ts.Node, stop: ts.Node): boolean => {
    let current: ts.Node | undefined = node;

    while (current && current !== stop) {
      if (current === ancestor) {
        return true;
      }

      current = current.parent;
    }

    return false;
  };

  const hasExportModifier = (node: ts.Node): boolean => Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );

  const isPubliclyExposedCallExpression = (node: ts.CallExpression): boolean => {
    if (ts.isVariableDeclaration(node.parent)) {
      const declarationList = node.parent.parent;
      const statement = declarationList.parent;
      return ts.isVariableStatement(statement) && hasExportModifier(statement);
    }

    return false;
  };

  const isPublicHelperTargetIdentifier = (identifier: ts.Identifier): boolean => {
    const symbol = project.checker.getSymbolAtLocation(identifier);
    if (!symbol) {
      return false;
    }

    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const declarationList = declaration.parent;
        const statement = declarationList.parent;
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
          return true;
        }
      }

      if (!ts.isParameter(declaration)) {
        continue;
      }

      const owner = ts.findAncestor(
        declaration,
        (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate),
      );
      if (!owner) {
        continue;
      }

      const ownerCall = owner.parent;
      if (
        ts.isCallExpression(ownerCall)
        && ownerCall.arguments.some((argument) => unwrapExpression(argument) === owner)
        && isPubliclyExposedCallExpression(ownerCall)
      ) {
        return true;
      }
    }

    return false;
  };

  const helperCallExposesPublicPath = (node: ts.CallExpression): boolean => {
    if (!node.arguments.some(isFiniteKeyExpression)) {
      return false;
    }

    return node.arguments.some((argument) => {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      return Boolean(
        resolved
        && !resolved.dynamic
        && publicSurfaceIds.has(resolved.binding.trackedObject.rootEntity.id),
      );
    }) || node.arguments.some((argument) => {
      const unwrapped = unwrapExpression(argument);
      return ts.isIdentifier(unwrapped) && isPublicHelperTargetIdentifier(unwrapped);
    });
  };

  const isNestedPublicHelperCallable = (declaration: ts.FunctionLikeDeclaration): boolean => {
    const objectLiteral = ts.findAncestor(
      declaration,
      (candidate): candidate is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(candidate),
    );
    if (!objectLiteral) {
      return false;
    }

    const producer = ts.findAncestor(
      declaration.parent,
      (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate) && candidate !== declaration,
    );
    if (!producer) {
      return false;
    }

    const producerCall = producer.parent;
    if (
      !ts.isCallExpression(producerCall)
      || !producerCall.arguments.some((argument) => unwrapExpression(argument) === producer)
      || !helperCallExposesPublicPath(producerCall)
    ) {
      return false;
    }

    const producerBody = producer.body;
    if (!producerBody) {
      return false;
    }

    if (!ts.isBlock(producerBody)) {
      const producedExpression = unwrapExpression(producerBody);
      return (ts.isObjectLiteralExpression(producedExpression) || ts.isArrayLiteralExpression(producedExpression))
        && isWithinNode(declaration, producedExpression, producer);
    }

    const returnStatement = ts.findAncestor(
      objectLiteral,
      (candidate): candidate is ts.ReturnStatement => ts.isReturnStatement(candidate) && isWithinNode(candidate, producerBody, producer),
    );

    return Boolean(returnStatement);
  };

  const isPublicCallable = (declaration: ts.FunctionLikeDeclaration): boolean => {
    const callable = getAnalyzableCallableBindingFromDeclaration(project, declaration);
    return Boolean(
      callable
      && (publiclyReachableCallableIds.has(callable.symbolKey) || isNestedPublicHelperCallable(declaration)),
    );
  };

  const getPublicReturnBinding = (node: ts.Node): TrackedObjectBinding | undefined => {
    if (project.config.value.mode !== "library") {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
    if (!enclosingFunction) {
      return undefined;
    }

    const callable = getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction);
    if (!callable || !isPublicCallable(enclosingFunction)) {
      return undefined;
    }

    return getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey))
      ?? trackedBySymbolId.get(`${callable.symbolKey}:return:object`)
      ?? trackedBySymbolId.get(`${callable.symbolKey}:return:array`);
  };

  const markObservedReturnedExpression = (expression: ts.Expression): void => {
    const unwrapped = unwrapExpression(expression);
    const helperReturnBinding = ts.isCallExpression(unwrapped)
      ? resolveBoundedHelperReturnBinding?.(unwrapped)
      : undefined;
    const resolved = helperReturnBinding
      ? {
        binding: helperReturnBinding,
        segments: [],
        dynamic: false as const,
      }
      : resolveTrackedObjectAccess(
          project,
          unwrapped,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );

    if (resolved && !resolved.dynamic) {
      markObservedSubtree(
        resolved.binding.trackedObject,
        [...resolved.binding.prefix, ...resolved.segments],
        trackedObjectsById,
      );
    }

    if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      markObservedAggregateLiteralBindings(unwrapped);
      return;
    }

    if (ts.isConditionalExpression(unwrapped)) {
      markObservedReturnedExpression(unwrapped.whenTrue);
      markObservedReturnedExpression(unwrapped.whenFalse);
      return;
    }

    if (
      ts.isBinaryExpression(unwrapped)
      && (
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
    ) {
      markObservedReturnedExpression(unwrapped.left);
      markObservedReturnedExpression(unwrapped.right);
      return;
    }

    if (
      ts.isCallExpression(unwrapped)
      && ts.isPropertyAccessExpression(unwrapped.expression)
      && (unwrapped.expression.name.text === "then" || unwrapped.expression.name.text === "catch")
    ) {
      for (const argument of unwrapped.arguments) {
        const callback = unwrapExpression(argument);
        if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
          continue;
        }

        const callbackBinding = getAnalyzableCallableBindingFromDeclaration(project, callback);
        const callbackReturnBinding = callbackBinding
          ? getCallableReturnBinding(functionReturnSummaries.get(callbackBinding.symbolKey))
          : undefined;
        if (callbackReturnBinding) {
          markObservedSubtree(callbackReturnBinding.trackedObject, callbackReturnBinding.prefix, trackedObjectsById);
        }

        if (ts.isBlock(callback.body)) {
          for (const statement of callback.body.statements) {
            if (ts.isReturnStatement(statement) && statement.expression) {
              markObservedReturnedExpression(statement.expression);
            }
          }
          continue;
        }

        markObservedReturnedExpression(callback.body);
      }
    }
  };

  const isExactStructuredReturnExpression = (
    callable: ReturnType<typeof getAnalyzableCallableBindingFromDeclaration> | undefined,
    expression: ts.Expression,
  ): boolean => {
    if (!callable) {
      return false;
    }

    const summary = functionReturnSummaries.get(callable.symbolKey);
    if (summary?.kind !== TRACKING_RETURN_SUMMARY_KIND.structured) {
      return false;
    }

    const unwrapped = unwrapExpression(expression);
    if (ts.isConditionalExpression(unwrapped)) {
      const whenTrueExact = isExactStructuredReturnExpression(callable, unwrapped.whenTrue);
      const whenFalseExact = isExactStructuredReturnExpression(callable, unwrapped.whenFalse);
      return (whenTrueExact && whenFalseExact)
        || (whenTrueExact && isTrackablePureExpression(unwrapped.whenFalse))
        || (whenFalseExact && isTrackablePureExpression(unwrapped.whenTrue));
    }

    if (
      ts.isBinaryExpression(unwrapped)
      && (
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
    ) {
      const leftExact = isExactStructuredReturnExpression(callable, unwrapped.left);
      const rightExact = isExactStructuredReturnExpression(callable, unwrapped.right);
      return (leftExact && rightExact)
        || (leftExact && isTrackablePureExpression(unwrapped.right))
        || (rightExact && isTrackablePureExpression(unwrapped.left));
    }

    if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      return true;
    }

    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(unwrapped);
    const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
    if (!declaration?.initializer) {
      return false;
    }

    const enclosingFunction = ts.findAncestor(
      declaration,
      (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
    );
    if (enclosingFunction !== callable.declaration) {
      return false;
    }

    const initializer = unwrapExpression(declaration.initializer);
    return ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer);
  };

  const markEscapedAggregateLiteralBindings = (
    expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    category: SkipCategory,
    reason: string,
  ): void => {
    const visitStoredExpression = (candidate: ts.Expression): void => {
      const unwrapped = unwrapExpression(candidate);
      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        markEscaped(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          category,
          reason,
        );
        return;
      }

      if (ts.isObjectLiteralExpression(unwrapped)) {
        for (const property of unwrapped.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            visitStoredExpression(property.name);
            continue;
          }

          if (ts.isPropertyAssignment(property)) {
            visitStoredExpression(property.initializer);
          }
        }
        return;
      }

      if (ts.isArrayLiteralExpression(unwrapped)) {
        for (const element of unwrapped.elements) {
          if (!ts.isSpreadElement(element)) {
            visitStoredExpression(element);
          }
        }
      }
    };

    visitStoredExpression(expression);
  };

  const markObservedAggregateLiteralBindings = (
    expression: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  ): void => {
    const visitStoredExpression = (candidate: ts.Expression): void => {
      const unwrapped = unwrapExpression(candidate);
      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        markObservedSubtree(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          trackedObjectsById,
        );
        return;
      }

      if (ts.isObjectLiteralExpression(unwrapped)) {
        for (const property of unwrapped.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            visitStoredExpression(property.name);
            continue;
          }

          if (ts.isPropertyAssignment(property)) {
            visitStoredExpression(property.initializer);
          }
        }
        return;
      }

      if (ts.isArrayLiteralExpression(unwrapped)) {
        for (const element of unwrapped.elements) {
          if (!ts.isSpreadElement(element)) {
            visitStoredExpression(element);
          }
        }
      }
    };

    visitStoredExpression(expression);
  };

  const handleReturnStatement = (node: ts.ReturnStatement): void => {
    if (!node.expression) {
      return;
    }

    const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
    const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
    const publicCallable = enclosingFunction ? isPublicCallable(enclosingFunction) : false;
    const helperReturnBinding = ts.isCallExpression(unwrapExpression(node.expression))
      ? resolveBoundedHelperReturnBinding?.(unwrapExpression(node.expression) as ts.CallExpression)
      : undefined;
    const resolved = helperReturnBinding
      ? {
        binding: helperReturnBinding,
        segments: [],
        dynamic: false as const,
      }
      : resolveTrackedObjectAccess(
          project,
          node.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
    const propagated = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
    const returnBinding = resolved && !resolved.dynamic
      ? extendTrackedBinding(resolved.binding, resolved.segments)
      : undefined;
    const publicReturnBinding = getPublicReturnBinding(node);
    const returnedExpression = unwrapExpression(node.expression);
    const returnedStructureStaysExact = Boolean(
      helperReturnBinding
      || isReturnedParameterIdentifier(enclosingFunction, returnedExpression)
      || (
      (returnBinding && propagated && sameTrackedBinding(propagated, returnBinding))
      )
      || isExactStructuredReturnExpression(callable, returnedExpression),
    );
    if (publicReturnBinding) {
      markObservedSubtree(publicReturnBinding.trackedObject, publicReturnBinding.prefix, trackedObjectsById);
    }
    if (publicCallable) {
      markObservedReturnedExpression(returnedExpression);
    }
    if (ts.isObjectLiteralExpression(returnedExpression) || ts.isArrayLiteralExpression(returnedExpression)) {
      if (!publicCallable && !returnedStructureStaysExact) {
        markEscapedAggregateLiteralBindings(
          returnedExpression,
          "returned-object",
          "stored inside returned aggregate literal beyond exact local analysis",
        );
      }
    }

    if (returnBinding && !returnedStructureStaysExact) {
      markEscaped(
        returnBinding.trackedObject,
        returnBinding.prefix,
        "returned-object",
        "returned object escapes local analysis",
      );
    }
  };

  return {
    getPublicReturnBinding,
    markObservedAggregateLiteralBindings,
    handleReturnStatement,
  };
}
