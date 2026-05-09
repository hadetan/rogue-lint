import ts from "typescript";

import type {
  EntityKind,
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { makeEntity } from "../../shared/entity-utils.js";
import {
  indexSegment,
  propertySegment,
  renderPath,
  serializePath,
} from "../../shared/path-utils.js";
import type {
  AnalyzableCallableBinding,
  CallableReturnSummary,
  TrackedObjectBinding,
} from "./model.js";
import {
  extendTrackedBinding,
  getCanonicalSymbolKey,
  getGlobalThisBindingKey,
  getStaticGlobalThisPropertyName,
  mergeTrackedBinding,
  sameTrackedBinding,
  sameTrackedBindingMap,
} from "./bindings.js";
import {
  getObjectBackedRetainedBindingSlotKeyFromAccess,
  getForwardedParameterBindings,
  getRetainedBindingContainerSlotKey,
  isLocallyOwnedRetainedBindingContainer,
  resolveTrackedObjectAccess,
} from "./access.js";
import {
  getAnalyzableCallableBinding,
  getAnalyzableCallableBindingFromDeclaration,
  getAnalyzableCallableName,
  getCallableReturnBinding,
  sameCallableReturnSummaryMap,
} from "./callables.js";
import { isExportedVariableDeclaration } from "./semantics.js";
import {
  ASSIGNMENT_OPERATORS,
  classifyTrackedObjectStructuralRole,
  unwrapExpression,
} from "./syntax.js";
import {
  indexTrackedObjectNode,
  markEscaped,
  setCollectionInfo,
} from "./state.js";

/**
 * Shared structural graph helpers for the exact tracking kernel.
 *
 * This module defines which values remain exact-trackable and builds the tracked
 * object graph plus callable return summaries consumed by both heavy stages.
 */

/**
 * Reports whether an expression can be treated as an exact, side-effect-free value.
 */
export function isTrackablePureExpression(expression: ts.Expression): boolean {
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

function addTrackedObjectNode(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
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
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, owner, fullPath, maxDepth);
      }
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, initializer, owner, fullPath, maxDepth);
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
        addTrackedObjectNode(project, trackedObject, sourceFile, element, owner, fullPath, maxDepth);
      }
      if (ts.isArrayLiteralExpression(element)) {
        addTrackedObjectNode(project, trackedObject, sourceFile, element, owner, fullPath, maxDepth);
      }
    });
  }
}

/**
 * Builds the tracked-object graph and analyzable callable summaries to a fixed point.
 */
export function buildTrackedObjects(
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
              isExportedVariableDeclaration(node) ? "export" : "local",
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
          } else if (
            (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
            && resolved
            && !resolved.dynamic
          ) {
            const slotKey = getObjectBackedRetainedBindingSlotKeyFromAccess(project, node.left);
            if (slotKey) {
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                slotKey,
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
        if (
          ts.isFunctionDeclaration(node)
          || ts.isFunctionExpression(node)
          || ts.isArrowFunction(node)
          || ts.isMethodDeclaration(node)
        ) {
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
