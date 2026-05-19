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
import { extendTrackedBinding, sameTrackedBinding } from "./bindings.js";
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
import { getResolvedSpreadPropertyNames } from "./spread-support.js";
import { classifyTrackedObjectStructuralRole, unwrapExpression } from "./syntax.js";
import {
  TRACKING_COLLECTION_KIND,
  TRACKING_PLACE_STATE,
} from "./vocabulary.js";
import {
  bumpTrackedObjectDerivedStateRevision,
  ensureCollectionChildPath,
  getCollectionInfo,
  indexTrackedObjectNode,
  markEscaped,
  registerExactPathAlias,
  setCollectionInfo,
  setTrackedArrayLength,
} from "./state.js";
import { TRACKING_STRUCTURAL_ROLE } from "./ownership.js";

let trackingLiteralMaterializationHeartbeat: (() => void) | undefined;

export function withTrackingLiteralMaterializationHeartbeat<T>(heartbeat: (() => void) | undefined, work: () => T): T {
  const previousHeartbeat = trackingLiteralMaterializationHeartbeat;
  trackingLiteralMaterializationHeartbeat = heartbeat;

  try {
    return work();
  } finally {
    trackingLiteralMaterializationHeartbeat = previousHeartbeat;
  }
}

function getKnownSpreadPropertyNames(expression: ts.Expression): ReadonlySet<string> | undefined {
  const node = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(node)) {
    const propertyNames = new Set<string>();
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

      propertyNames.add(propertyName);
    }

    return propertyNames;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = getKnownSpreadPropertyNames(node.whenTrue);
    const whenFalse = getKnownSpreadPropertyNames(node.whenFalse);
    if (!whenTrue || !whenFalse) {
      return undefined;
    }

    const merged = new Set<string>(whenTrue);
    for (const propertyName of whenFalse) {
      merged.add(propertyName);
    }
    return merged;
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

      const merged = new Set<string>(left);
      for (const propertyName of right) {
        merged.add(propertyName);
      }
      return merged;
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
  type PendingLiteral = {
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
    segments: PathSegment[];
    next?: PendingLiteral;
  };
  const observePendingLiteralShape = (pendingLiteral: PendingLiteral): void => {
    pendingLiteral.node;
    pendingLiteral.segments;
    pendingLiteral.next;
  };
  const pendingHead: PendingLiteral = { node, segments };
  observePendingLiteralShape(pendingHead);
  let pendingTail = pendingHead;

  for (let current: PendingLiteral | undefined = pendingHead; current; current = current.next) {
    trackingLiteralMaterializationHeartbeat?.();
    if (current.segments.length > maxDepth) {
      continue;
    }

    if (ts.isObjectLiteralExpression(current.node)) {
      if (!getCollectionInfo(trackedObject, current.segments)) {
        setCollectionInfo(trackedObject, current.segments, TRACKING_COLLECTION_KIND.object);
      }

      for (const property of current.node.properties) {
        trackingLiteralMaterializationHeartbeat?.();

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
            const spreadPropertyNames = getResolvedSpreadPropertyNames(spreadBinding);
            if (spreadPropertyNames) {
              for (const spreadPropertyName of spreadPropertyNames) {
                const fullPath = [...current.segments, propertySegment(spreadPropertyName)];
                const joinedPath = serializePath(fullPath);
                ensureCollectionChildPath(trackedObject, current.segments, fullPath);
                const entity = makeEntity(
                  project.rootPath,
                  fullPath.length === 1 ? ENTITY_KIND.objectKey : ENTITY_KIND.nestedPath,
                  sourceFile,
                  property.expression,
                  fullPath.length === 1 ? spreadPropertyName : renderPath(fullPath),
                  owner,
                );
                trackedObject.nodes.set(joinedPath, {
                  entity,
                  fullPath,
                  origin: TRACKED_OBJECT_NODE_ORIGIN.property,
                });
                trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
                indexTrackedObjectNode(trackedObject, joinedPath, fullPath);
              }

              continue;
            }
          }

          const spreadPropertyNames = getKnownSpreadPropertyNames(property.expression);
          if (!spreadPropertyNames) {
            markEscaped(trackedObject, current.segments, SKIP_CATEGORY.objectSpread, "object spread introduces opaque properties");
          } else {
            for (const propertyName of spreadPropertyNames) {
              markEscaped(
                trackedObject,
                [...current.segments, propertySegment(propertyName)],
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
              current.segments,
              "computed-property-name",
              "computed property names are not eligible for exact analysis",
            );
            continue;
          }

          const callable = propertyName ? getAnalyzableCallableBindingFromDeclaration(project, property) : undefined;
          if (propertyName && callable) {
            trackedObject.callablePaths.set(serializePath([...current.segments, propertySegment(propertyName)]), callable);
          }

          const fullPath = [...current.segments, propertySegment(propertyName)];
          const joinedPath = serializePath(fullPath);
          ensureCollectionChildPath(trackedObject, current.segments, fullPath);
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
            current.segments,
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
            trackedObject.callablePaths.set(serializePath([...current.segments, propertySegment(propertyName)]), callable);
          }
        }

        const fullPath = [...current.segments, propertySegment(propertyName)];
        const joinedPath = serializePath(fullPath);
        ensureCollectionChildPath(trackedObject, current.segments, fullPath);
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
          origin: TRACKED_OBJECT_NODE_ORIGIN.property,
        });
        trackedObject.placeStates.set(joinedPath, TRACKING_PLACE_STATE.initialized);
        indexTrackedObjectNode(trackedObject, joinedPath, fullPath);

        const initializer = ts.isShorthandPropertyAssignment(property) ? undefined : property.initializer;
        if (initializer && (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))) {
          const nextPending: PendingLiteral = {
            node: initializer,
            segments: fullPath,
          };
          observePendingLiteralShape(nextPending);
          pendingTail.next = nextPending;
          pendingTail = nextPending;
        }
      }

      continue;
    }

    const collection = getCollectionInfo(trackedObject, current.segments)
      ?? setCollectionInfo(trackedObject, current.segments, TRACKING_COLLECTION_KIND.array, current.node.elements.length);
    if (collection.kind === TRACKING_COLLECTION_KIND.array) {
      setTrackedArrayLength(
        trackedObject,
        current.segments,
        Math.max(collection.arrayLength ?? 0, current.node.elements.length),
      );
    }

    for (const [index, element] of current.node.elements.entries()) {
      trackingLiteralMaterializationHeartbeat?.();

      if (!element || ts.isSpreadElement(element)) {
        markEscaped(trackedObject, current.segments, SKIP_CATEGORY.arraySpread, "array spread introduces opaque values");
        continue;
      }

      const fullPath = [...current.segments, indexSegment(index)];
      const joinedPath = serializePath(fullPath);
      ensureCollectionChildPath(trackedObject, current.segments, fullPath);
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

      if (ts.isObjectLiteralExpression(element) || ts.isArrayLiteralExpression(element)) {
        const nextPending: PendingLiteral = {
          node: element,
          segments: fullPath,
        };
        observePendingLiteralShape(nextPending);
        pendingTail.next = nextPending;
        pendingTail = nextPending;
      }
    }
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
  trackingLiteralMaterializationHeartbeat?.();

  const hasSameExactAlias = (pathKey: string, binding: TrackedObjectBinding): boolean => {
    const existingAlias = trackedObject.exactPathAliases.get(pathKey);
    if (!existingAlias) {
      return false;
    }

    const sourceTrackedObject = trackedObjectsById.get(existingAlias.sourceObjectId);
    if (!sourceTrackedObject) {
      return false;
    }

    return sameTrackedBinding(
      {
        trackedObject: sourceTrackedObject,
        prefix: existingAlias.sourcePath,
      },
      binding,
    );
  };
  type PendingLiteral = {
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
    segments: PathSegment[];
    next?: PendingLiteral;
  };
  const observePendingLiteralShape = (pendingLiteral: PendingLiteral): void => {
    pendingLiteral.node;
    pendingLiteral.segments;
    pendingLiteral.next;
  };
  const pendingHead: PendingLiteral = { node, segments };
  observePendingLiteralShape(pendingHead);
  let pendingTail = pendingHead;

  for (let current: PendingLiteral | undefined = pendingHead; current; current = current.next) {
    trackingLiteralMaterializationHeartbeat?.();
    if (current.segments.length > maxDepth) {
      continue;
    }

    if (ts.isObjectLiteralExpression(current.node)) {
      for (const property of current.node.properties) {
        trackingLiteralMaterializationHeartbeat?.();

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
            const spreadPropertyNames = getResolvedSpreadPropertyNames(spreadBinding);
            if (spreadPropertyNames) {
              for (const spreadPropertyName of spreadPropertyNames) {
                const spreadSegment = propertySegment(spreadPropertyName);
                registerExactPathAlias(
                  trackedObject,
                  [...current.segments, spreadSegment],
                  extendTrackedBinding(resolved.binding, [...resolved.segments, spreadSegment]),
                  "object spread keeps this property exact",
                );
              }

              continue;
            }
          }

          const spreadPropertyNames = getKnownSpreadPropertyNames(property.expression);
          if (!spreadPropertyNames) {
            markEscaped(trackedObject, current.segments, SKIP_CATEGORY.objectSpread, "object spread introduces opaque properties");
          } else {
            for (const propertyName of spreadPropertyNames) {
              markEscaped(
                trackedObject,
                [...current.segments, propertySegment(propertyName)],
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

        const fullPath = [...current.segments, propertySegment(propertyName)];
        const pathKey = serializePath(fullPath);
        const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        const unwrapped = unwrapExpression(initializer);

        if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
          if (trackedObject.exactPathAliases.delete(pathKey)) {
            bumpTrackedObjectDerivedStateRevision(trackedObject);
          }
          const nextPending: PendingLiteral = {
            node: unwrapped,
            segments: fullPath,
          };
          observePendingLiteralShape(nextPending);
          pendingTail.next = nextPending;
          pendingTail = nextPending;
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
          const aliasBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          if (hasSameExactAlias(pathKey, aliasBinding)) {
            continue;
          }

          if (trackedObject.exactPathAliases.delete(pathKey)) {
            bumpTrackedObjectDerivedStateRevision(trackedObject);
          }
          registerExactPathAlias(
            trackedObject,
            fullPath,
            aliasBinding,
            "returned structure keeps this nested binding exact",
          );
        } else if (trackedObject.exactPathAliases.delete(pathKey)) {
          bumpTrackedObjectDerivedStateRevision(trackedObject);
        }
      }

      continue;
    }

    for (const [index, element] of current.node.elements.entries()) {
      trackingLiteralMaterializationHeartbeat?.();

      if (!element || ts.isSpreadElement(element)) {
        continue;
      }

      const fullPath = [...current.segments, indexSegment(index)];
      const pathKey = serializePath(fullPath);
      const unwrapped = unwrapExpression(element);

      if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
        if (trackedObject.exactPathAliases.delete(pathKey)) {
          bumpTrackedObjectDerivedStateRevision(trackedObject);
        }
        const nextPending: PendingLiteral = {
          node: unwrapped,
          segments: fullPath,
        };
        observePendingLiteralShape(nextPending);
        pendingTail.next = nextPending;
        pendingTail = nextPending;
        continue;
      }

      if (trackedObject.exactPathAliases.delete(pathKey)) {
        bumpTrackedObjectDerivedStateRevision(trackedObject);
      }
      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        const aliasBinding = extendTrackedBinding(resolved.binding, resolved.segments);
        if (hasSameExactAlias(pathKey, aliasBinding)) {
          continue;
        }

        if (trackedObject.exactPathAliases.delete(pathKey)) {
          bumpTrackedObjectDerivedStateRevision(trackedObject);
        }
        registerExactPathAlias(
          trackedObject,
          fullPath,
          aliasBinding,
          "returned structure keeps this nested binding exact",
        );
      }
    }
  }
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
  options: { materializeNodes?: boolean; registerAliases?: boolean } = {},
): void {
  trackingLiteralMaterializationHeartbeat?.();

  if ((options.materializeNodes ?? true) && segments.length === 1 && segments[0]?.kind === "index") {
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

  if (options.materializeNodes ?? true) {
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
  }

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
