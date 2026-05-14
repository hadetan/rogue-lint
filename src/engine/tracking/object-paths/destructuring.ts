import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { propertySegment } from "../../../shared/path-utils.js";
import { getBindingSymbolKey, resolveTrackedObjectAccess } from "../access.js";
import type {
  ArrayProjectionBinding,
  CallableReturnSummary,
  ResolvedTrackedObjectAccess,
  TrackedObjectBinding,
} from "../model.js";
import { getProjectionBinding } from "../state.js";

interface DestructuringHandlerOptions {
  project: ProjectContext;
  sourceFile: ts.SourceFile;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  projectionBindings: Map<string, ArrayProjectionBinding>;
  markAliasObserved: (
    resolved: ResolvedTrackedObjectAccess,
    aliasTrackedObjectsById: Map<string, TrackedObject>,
  ) => void;
  markProjectionElementRead: (
    projection: ArrayProjectionBinding,
    projectionTrackedObjectsById: Map<string, TrackedObject>,
    index: number,
    observeSubtree?: boolean,
  ) => void;
  markRead: (trackedObject: TrackedObject, segments: PathSegment[]) => void;
  markEscaped: (
    trackedObject: TrackedObject,
    segments: PathSegment[],
    category: SkipCategory,
    reason: string,
    detailHint?: string,
  ) => void;
  recordArrayBoundary: (
    project: ProjectContext,
    trackedObject: TrackedObject,
    boundarySourceFile: ts.SourceFile,
    node: ts.Node,
    collectionPath: PathSegment[],
    affectedPath: PathSegment[],
    category: SkipCategory,
    reason: string,
    invalidate?: boolean,
    detailHint?: string,
  ) => void;
}

/**
 * Owns binding-pattern destructuring rules for object-path analysis.
 */
export function createDestructuringHandler(options: DestructuringHandlerOptions): {
  handleArrayBindingPattern: (node: ts.VariableDeclaration) => void;
  handleObjectBindingPattern: (node: ts.VariableDeclaration) => void;
} {
  const {
    project,
    sourceFile,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    projectionBindings,
    markAliasObserved,
    markProjectionElementRead,
    markRead,
    markEscaped,
    recordArrayBoundary,
  } = options;

  const handleArrayBindingPattern = (
    node: ts.VariableDeclaration,
  ): void => {
    if (!ts.isArrayBindingPattern(node.name) || !node.initializer) {
      return;
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      node.initializer,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (!resolved || resolved.dynamic) {
      return;
    }

    const projection = getProjectionBinding(
      resolved.binding.trackedObject,
      [...resolved.binding.prefix, ...resolved.segments],
    );
    if (!projection) {
      return;
    }

    node.name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) {
        return;
      }

      if (element.dotDotDotToken) {
        recordArrayBoundary(
          project,
          projection.trackedObject,
          sourceFile,
          element,
          projection.sourcePath,
          projection.sourcePath,
          "array-rest",
          "array rest pattern escapes remaining elements",
          true,
        );
        return;
      }

      if (ts.isIdentifier(element.name)) {
        const symbolKey = getBindingSymbolKey(project, element.name);
        if (symbolKey) {
          const elementPath = projection.elementPaths[index];
          if (elementPath) {
            projectionBindings.set(symbolKey, {
              trackedObject: projection.trackedObject,
              sourcePath: elementPath,
              elementPaths: [elementPath],
            });
          }
        }
        markProjectionElementRead(projection, trackedObjectsById, index);
        return;
      }

      markProjectionElementRead(projection, trackedObjectsById, index, true);
    });
  };

  const handleObjectBindingPattern = (
    node: ts.VariableDeclaration,
  ): void => {
    if (!ts.isObjectBindingPattern(node.name) || !node.initializer) {
      return;
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      node.initializer,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (!resolved || resolved.dynamic) {
      return;
    }

    for (const element of node.name.elements) {
      if (element.dotDotDotToken) {
        markEscaped(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments],
          "object-rest",
          "object rest pattern escapes remaining properties",
        );
        continue;
      }

      const keyNode = element.propertyName ?? element.name;
      if (ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) || ts.isNumericLiteral(keyNode)) {
        markAliasObserved(resolved, trackedObjectsById);
        markRead(
          resolved.binding.trackedObject,
          [...resolved.binding.prefix, ...resolved.segments, propertySegment(keyNode.text)],
        );
      }
    }
  };

  return {
    handleArrayBindingPattern,
    handleObjectBindingPattern,
  };
}
