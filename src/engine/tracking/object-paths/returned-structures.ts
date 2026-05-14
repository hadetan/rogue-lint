import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { resolveTrackedObjectAccess } from "../access.js";
import {
  extendTrackedBinding,
  sameTrackedBinding,
} from "../bindings.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getCallableReturnBinding,
} from "../callables.js";
import type {
  CallableReturnSummary,
  TrackedObjectBinding,
} from "../model.js";
import { unwrapExpression } from "../syntax.js";

interface ReturnedStructureHandlerOptions {
  project: ProjectContext;
  publicCallableIds: ReadonlySet<string>;
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
    publicCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    markObservedSubtree,
    markEscaped,
  } = options;

  const getPublicReturnBinding = (node: ts.Node): TrackedObjectBinding | undefined => {
    if (project.config.value.mode !== "library") {
      return undefined;
    }

    const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
    if (!enclosingFunction) {
      return undefined;
    }

    const callable = getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction);
    if (!callable || !publicCallableIds.has(callable.symbolKey)) {
      return undefined;
    }

    return getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey));
  };

  const isExactStructuredReturnExpression = (
    callable: ReturnType<typeof getAnalyzableCallableBindingFromDeclaration> | undefined,
    expression: ts.Expression,
  ): boolean => {
    if (!callable) {
      return false;
    }

    const summary = functionReturnSummaries.get(callable.symbolKey);
    if (summary?.kind !== "structured") {
      return false;
    }

    const unwrapped = unwrapExpression(expression);
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

    const resolved = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    const enclosingFunction = ts.findAncestor(node, (candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate));
    const callable = enclosingFunction ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction) : undefined;
    const propagated = callable ? getCallableReturnBinding(functionReturnSummaries.get(callable.symbolKey)) : undefined;
    const returnBinding = resolved && !resolved.dynamic
      ? extendTrackedBinding(resolved.binding, resolved.segments)
      : undefined;
    const publicReturnBinding = getPublicReturnBinding(node);
    const returnedExpression = unwrapExpression(node.expression);
    const returnedStructureStaysExact = Boolean(
      (returnBinding && propagated && sameTrackedBinding(propagated, returnBinding))
      || isExactStructuredReturnExpression(callable, returnedExpression),
    );
    if (publicReturnBinding) {
      markObservedSubtree(publicReturnBinding.trackedObject, publicReturnBinding.prefix, trackedObjectsById);
    }
    if (ts.isObjectLiteralExpression(returnedExpression) || ts.isArrayLiteralExpression(returnedExpression)) {
      if (publicReturnBinding) {
        markObservedAggregateLiteralBindings(returnedExpression);
      } else if (!returnedStructureStaysExact) {
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
