import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
import { makeEntity } from "../../shared/entity-utils.js";
import { TRACKED_OBJECT_NODE_ORIGIN } from "../../shared/path-vocabulary.js";
import { SKIP_CATEGORY } from "../../shared/skip-category-vocabulary.js";
import {
  indexSegment,
  propertySegment,
  renderPath,
  serializePath,
} from "../../shared/path-utils.js";
import { extendTrackedBinding } from "./bindings.js";
import {
  resolveAnalyzableCallableBinding,
  resolveTrackedObjectAccess,
} from "./access.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getCallableReturnBinding,
} from "./callables.js";
import type {
  CallableReturnSummary,
  TrackedObjectBinding,
} from "./model.js";
import { visitResolvedSpreadPropertySegments } from "./spread-support.js";
import { classifyTrackedObjectStructuralRole, unwrapExpression } from "./syntax.js";
import {
  TRACKING_COLLECTION_KIND,
  TRACKING_PLACE_STATE,
} from "./vocabulary.js";
import {
  ensureCollectionChildPath,
  getCollectionInfo,
  indexTrackedObjectNode,
  markEscaped,
  registerExactPathAlias,
  setCollectionInfo,
  setTrackedArrayLength,
} from "./state.js";
import { TRACKING_STRUCTURAL_ROLE } from "./ownership.js";

function getKnownSpreadPropertyNames(expression: ts.Expression): string[] | undefined {
  const node = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(node)) {
    const propertyNames: string[] = [];
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        return undefined;
      }

      const propertyName = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
          ? ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
            ? property.name.text
            : undefined
          : undefined;
      if (!propertyName) {
        return undefined;
      }

      propertyNames.push(propertyName);
    }

    return propertyNames;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = getKnownSpreadPropertyNames(node.whenTrue);
    const whenFalse = getKnownSpreadPropertyNames(node.whenFalse);
    if (!whenTrue || !whenFalse) {
      return undefined;
    }

    return [...new Set([...whenTrue, ...whenFalse])];
  }

  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return getKnownSpreadPropertyNames(node.right);
    }

    if (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      const left = getKnownSpreadPropertyNames(node.left);
      const right = getKnownSpreadPropertyNames(node.right);
      if (!left || !right) {
        return undefined;
      }

      return [...new Set([...left, ...right])];
    }
  }

  return undefined;
}

function resolveTrackedSpreadSource(
  project: ProjectContext,
  expression: ts.Expression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped)) {
    const callable = resolveAnalyzableCallableBinding(
      project,
      unwrapped.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    const summary = callable ? functionReturnSummaries.get(callable.symbolKey) : undefined;
    const binding = summary ? getCallableReturnBinding(summary) : undefined;
    if (binding) {
      return {
        binding,
        segments: [],
        dynamic: false,
      };
    }
  }

  return resolveTrackedObjectAccess(
    project,
    expression,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
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
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  if (segments.length > maxDepth) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    if (!getCollectionInfo(trackedObject, segments)) {
      setCollectionInfo(trackedObject, segments, TRACKING_COLLECTION_KIND.object);
    }

    const registerTrackedPropertyNode = (propertyName: string, anchor: ts.Node): PathSegment[] => {
      const fullPath = [...segments, propertySegment(propertyName)];
      const joinedPath = serializePath(fullPath);
      ensureCollectionChildPath(trackedObject, segments, fullPath);
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? ENTITY_KIND.objectKey : ENTITY_KIND.nestedPath,
        sourceFile,
        anchor,
        fullPath.length === 1 ? propertyName : renderPath(fullPath),
        owner,
      );
      trackedObject.nodes.set(joinedPath, {
        entity,
        fullPath,
        origin: TRACKED_OBJECT_NODE_ORIGIN.property,
      });
      trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
      indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
      return fullPath;
    };

    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const resolved = resolveTrackedSpreadSource(
          project,
          property.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved && !resolved.dynamic) {
          const spreadBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          if (visitResolvedSpreadPropertySegments(spreadBinding, (spreadSegment) => {
            if (spreadSegment.kind !== "property") {
              return;
            }

            registerTrackedPropertyNode(spreadSegment.value, property.expression);
          })) {
            continue;
          }
        }

        const spreadPropertyNames = getKnownSpreadPropertyNames(property.expression);
        if (!spreadPropertyNames) {
          markEscaped(trackedObject, segments, SKIP_CATEGORY.objectSpread, "object spread introduces opaque properties");
        } else {
          for (const propertyName of spreadPropertyNames) {
            markEscaped(
              trackedObject,
              [...segments, propertySegment(propertyName)],
              SKIP_CATEGORY.objectSpread,
              "object spread may overwrite this property",
            );
          }
        }
        continue;
      }

      if (ts.isMethodDeclaration(property)) {
        const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
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

        const callable = propertyName ? getAnalyzableCallableBindingFromDeclaration(project, property) : undefined;
        if (propertyName && callable) {
          trackedObject.callablePaths.set(serializePath([...segments, propertySegment(propertyName)]), callable);
        }

        const fullPath = [...segments, propertySegment(propertyName)];
        const joinedPath = serializePath(fullPath);
        ensureCollectionChildPath(trackedObject, segments, fullPath);
        const entity = makeEntity(
          project.rootPath,
          fullPath.length === 1 ? ENTITY_KIND.objectKey : ENTITY_KIND.nestedPath,
          sourceFile,
          property.name,
          fullPath.length === 1 ? propertyName : renderPath(fullPath),
          owner,
        );
        trackedObject.nodes.set(joinedPath, {
          entity,
          fullPath,
          origin: TRACKED_OBJECT_NODE_ORIGIN.method,
        });
        trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
        indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
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

      if (ts.isPropertyAssignment(property)) {
        const callableInitializer = unwrapExpression(property.initializer);
        const callable = (ts.isFunctionExpression(callableInitializer) || ts.isArrowFunction(callableInitializer))
          ? getAnalyzableCallableBindingFromDeclaration(project, callableInitializer)
          : undefined;
        if (callable) {
          trackedObject.callablePaths.set(serializePath([...segments, propertySegment(propertyName)]), callable);
        }
      }

      const fullPath = registerTrackedPropertyNode(propertyName, property.name);

      const initializer = ts.isShorthandPropertyAssignment(property) ? undefined : property.initializer;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        addTrackedObjectNode(
          project,
          trackedObject,
          sourceFile,
          initializer,
          owner,
          fullPath,
          maxDepth,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
      }
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        addTrackedObjectNode(
          project,
          trackedObject,
          sourceFile,
          initializer,
          owner,
          fullPath,
          maxDepth,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
      }
    }
  } else {
    const collection = getCollectionInfo(trackedObject, segments)
      ?? setCollectionInfo(trackedObject, segments, TRACKING_COLLECTION_KIND.array, node.elements.length);
    if (collection.kind === TRACKING_COLLECTION_KIND.array) {
      setTrackedArrayLength(
        trackedObject,
        segments,
        Math.max(collection.arrayLength ?? 0, node.elements.length),
      );
    }

    node.elements.forEach((element, index) => {
      if (!element || ts.isSpreadElement(element)) {
        markEscaped(trackedObject, segments, SKIP_CATEGORY.arraySpread, "array spread introduces opaque values");
        return;
      }

      const fullPath = [...segments, indexSegment(index)];
      const joinedPath = serializePath(fullPath);
      ensureCollectionChildPath(trackedObject, segments, fullPath);
      const entity = makeEntity(
        project.rootPath,
        fullPath.length === 1 ? ENTITY_KIND.arrayElement : ENTITY_KIND.nestedPath,
        sourceFile,
        element,
        renderPath(fullPath),
        owner,
      );
      trackedObject.nodes.set(joinedPath, {
        entity,
        fullPath,
        origin: TRACKED_OBJECT_NODE_ORIGIN.arrayElement,
      });
      trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
      indexTrackedObjectNode(trackedObject, joinedPath, fullPath);

      if (ts.isObjectLiteralExpression(element)) {
        addTrackedObjectNode(
          project,
          trackedObject,
          sourceFile,
          element,
          owner,
          fullPath,
          maxDepth,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
      }
      if (ts.isArrayLiteralExpression(element)) {
        addTrackedObjectNode(
          project,
          trackedObject,
          sourceFile,
          element,
          owner,
          fullPath,
          maxDepth,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
      }
    });
  }
}

function registerTrackedLiteralAliases(
  project: ProjectContext,
  trackedObject: TrackedObject,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  segments: PathSegment[],
  maxDepth: number,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  if (segments.length > maxDepth) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const resolved = resolveTrackedSpreadSource(
          project,
          property.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved && !resolved.dynamic) {
          const spreadBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          if (visitResolvedSpreadPropertySegments(spreadBinding, (spreadSegment) => {
            registerExactPathAlias(
              trackedObject,
              [...segments, spreadSegment],
              extendTrackedBinding(resolved.binding, [...resolved.segments, spreadSegment]),
              "object spread keeps this property exact",
            );
          })) {
            continue;
          }
        }

        const spreadPropertyNames = getKnownSpreadPropertyNames(property.expression);
        if (!spreadPropertyNames) {
          markEscaped(trackedObject, segments, SKIP_CATEGORY.objectSpread, "object spread introduces opaque properties");
        } else {
          for (const propertyName of spreadPropertyNames) {
            markEscaped(
              trackedObject,
              [...segments, propertySegment(propertyName)],
              SKIP_CATEGORY.objectSpread,
              "object spread may overwrite this property",
            );
          }
        }
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
        continue;
      }

      const fullPath = [...segments, propertySegment(propertyName)];
      trackedObject.exactPathAliases.delete(serializePath(fullPath));
      const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      const unwrapped = unwrapExpression(initializer);

      if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
        registerTrackedLiteralAliases(
          project,
          trackedObject,
          unwrapped,
          fullPath,
          maxDepth,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        continue;
      }

      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        registerExactPathAlias(
          trackedObject,
          fullPath,
          extendTrackedBinding(resolved.binding, resolved.segments),
          "returned structure keeps this nested binding exact",
        );
      }
    }

    return;
  }

  node.elements.forEach((element, index) => {
    if (!element || ts.isSpreadElement(element)) {
      return;
    }

    const fullPath = [...segments, indexSegment(index)];
    const unwrapped = unwrapExpression(element);

    if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      registerTrackedLiteralAliases(
        project,
        trackedObject,
        unwrapped,
        fullPath,
        maxDepth,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      return;
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      unwrapped,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      registerExactPathAlias(
        trackedObject,
        fullPath,
        extendTrackedBinding(resolved.binding, resolved.segments),
        "returned structure keeps this nested binding exact",
      );
    }
  });
}

/**
 * Materializes a structured literal into tracked nodes and optional alias bindings at a path.
 */
export function materializeTrackedLiteralAtPath(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  owner: string,
  segments: PathSegment[],
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
  options: { registerAliases?: boolean } = {},
): void {
  if (segments.length === 1 && segments[0]?.kind === "index") {
    const literalRole = classifyTrackedObjectStructuralRole(node);
    if (
      literalRole === TRACKING_STRUCTURAL_ROLE.structuralRecord
      || literalRole === TRACKING_STRUCTURAL_ROLE.stateHolder
    ) {
      if (!trackedObject.structuralRole || trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecordArray) {
        trackedObject.structuralRole = TRACKING_STRUCTURAL_ROLE.structuralRecordArray;
      }
    } else if (trackedObject.structuralRole === TRACKING_STRUCTURAL_ROLE.structuralRecordArray) {
      trackedObject.structuralRole = undefined;
    }
  }

  addTrackedObjectNode(
    project,
    trackedObject,
    sourceFile,
    node,
    owner,
    segments,
    project.config.value.objectAnalysis.maxPathDepth,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );
  if (options.registerAliases === false) {
    return;
  }

  registerTrackedLiteralAliases(
    project,
    trackedObject,
    node,
    segments,
    project.config.value.objectAnalysis.maxPathDepth,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );
}
