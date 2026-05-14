import ts from "typescript";

import type {
  EntityKind,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { makeEntity } from "../../shared/entity-utils.js";
import type {
  CallableReturnSummary,
  TrackedObjectBinding,
} from "./model.js";
import { TrackedObjectBindingRecord } from "./model.js";
import {
  extendTrackedBinding,
  getCanonicalSymbolKey,
  getGlobalThisBindingKey,
  getStaticGlobalThisPropertyName,
  mergeTrackedBinding,
} from "./bindings.js";
import {
  getForwardedParameterBindings,
  resolveAnalyzableCallableBinding,
  resolveTrackedObjectAccess,
} from "./access.js";
import {
  getObjectBackedRetainedBindingSlotKeyFromAccess,
  getRetainedBindingContainerSlotKey,
  isLocallyOwnedRetainedBindingContainer,
} from "./retained-bindings.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getAnalyzableCallableName,
} from "./callables.js";
import type {
  MutableTrackingRuntimeSummary,
  MutableTrackingSnapshot,
  TrackingContractDiagnostic,
  TrackingRunArtifacts,
  TrackingStage,
  TrackingStageArtifacts,
} from "./contracts.js";
import {
  OBJECT_PATHS_TRACKING_STAGE,
  TRACKING_ALIAS_OWNER,
  TRACKING_BINDINGS_OWNER,
  TRACKING_BOUNDARY_OWNER,
  TRACKING_RETURN_SUMMARY_OWNER,
  VALUE_LIVENESS_TRACKING_STAGE,
} from "./contracts.js";
import {
  runTrackingConvergence,
  type TrackingConvergenceOptions,
  type TrackingConvergenceState,
} from "./convergence.js";
import { isExportedVariableDeclaration } from "./semantics.js";
import {
  classifyTrackedObjectStructuralRole,
} from "./syntax.js";
import {
  getTrackableStructuredLiteralExpression,
  isTrackableObjectStructure,
} from "./trackable-structures.js";
import { materializeTrackedLiteralAtPath } from "./literal-materialization.js";
import { createReturnSummaryCollector } from "./return-summaries.js";

/**
 * Shared structural graph helpers for the exact tracking kernel.
 *
 * This module defines which values remain exact-trackable and builds the tracked
 * object graph plus callable return summaries consumed by both heavy stages.
 */

const HELPER_METADATA_ARRAY_ROOT_NAMES = new Set([
  "collectStringLiteralCandidates",
  "exactReadPaths",
  "getExactHelperReadPaths",
  "getKnownSpreadPropertyNames",
  "nextSegments",
  "propertyNames",
  "segments",
]);

const HELPER_METADATA_ARRAY_TYPE_TEXTS = new Set([
  "PathSegment[]",
  "PathSegment[][]",
  "string[]",
]);

function normalizeTrackedRootName(name: string): string {
  return name.endsWith("()") ? name.slice(0, -2) : name;
}

function classifyHelperMetadataArrayRole(
  project: ProjectContext,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  name: string,
  anchor: ts.Node,
): TrackedObject["structuralRole"] | undefined {
  if (!ts.isArrayLiteralExpression(node)) {
    return undefined;
  }

  if (!HELPER_METADATA_ARRAY_ROOT_NAMES.has(normalizeTrackedRootName(name))) {
    return undefined;
  }

  const typeTexts = new Set<string>();
  typeTexts.add(project.checker.typeToString(project.checker.getTypeAtLocation(anchor)).replace(/\s+/g, ""));
  typeTexts.add(project.checker.typeToString(project.checker.getTypeAtLocation(node)).replace(/\s+/g, ""));

  const contextualType = project.checker.getContextualType(node);
  if (contextualType) {
    typeTexts.add(project.checker.typeToString(contextualType).replace(/\s+/g, ""));
  }

  return [...typeTexts].some((typeText) => HELPER_METADATA_ARRAY_TYPE_TEXTS.has(typeText))
    ? "structural-record-array"
    : undefined;
}

/**
 * Builds the tracked-object graph and analyzable callable summaries to a fixed point.
 */
export function buildTrackedObjects(
  project: ProjectContext,
  reachableFiles: Set<string>,
  options?: TrackingConvergenceOptions,
): TrackingRunArtifacts {
  const trackedBySymbolId = new Map<string, TrackedObjectBinding>();
  const functionReturnSummaries = new Map<string, CallableReturnSummary>();
  const trackedLiteralBindings = new Map<string, TrackedObjectBinding>();
  const trackedReturnLiteralBindings = new Map<string, TrackedObjectBinding>();
  const trackedObjectsById = new Map<string, TrackedObject>();
  const reachableSourceFileCount = project.sourceFiles.filter((sourceFile) => reachableFiles.has(sourceFile.fileName)).length;

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
      materializeTrackedLiteralAtPath(
        project,
        existing.trackedObject,
        sourceFile,
        node,
        name,
        [],
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
        { registerAliases: kind === "expression" },
      );
      return existing;
    }

    const rootEntity = makeEntity(project.rootPath, kind, sourceFile, anchor, name);
    const trackedObject: TrackedObject = {
      id: rootEntity.id,
      canonicalSymbolKey: symbolKey,
      rootName: name,
      sourceFile: sourceFile.fileName,
      rootEntity,
      structuralRole: classifyTrackedObjectStructuralRole(node)
        ?? classifyHelperMetadataArrayRole(project, node, name, anchor),
      nodes: new Map(),
      callablePaths: new Map(),
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
    materializeTrackedLiteralAtPath(
      project,
      trackedObject,
      sourceFile,
      node,
      name,
      [],
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
      { registerAliases: kind === "expression" },
    );

    const binding = new TrackedObjectBindingRecord(trackedObject, []);

    if (kind === "local") {
      trackedLiteralBindings.set(symbolKey, binding);
    } else {
      trackedReturnLiteralBindings.set(symbolKey, binding);
    }

    return binding;
  };

  const {
    collectFunctionReturnSummary,
    getTrackableStructuredLiteral,
    resolveStructuredReturnAliasCallable,
  } = createReturnSummaryCollector({
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    createTrackedBindingForLiteral,
  });

  const computeNextTrackingState = (): TrackingConvergenceState => {
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
            const returnedAliasCallable = resolveStructuredReturnAliasCallable(node);
            const returnedAliasLiteral = returnedAliasCallable
              ? getTrackableStructuredLiteral(node.initializer, { allowArraySpreadBoundary: true })
              : undefined;
            const binding = createTrackedBindingForLiteral(
              returnedAliasCallable && returnedAliasLiteral
                ? `${returnedAliasCallable.symbolKey}:return:${ts.isObjectLiteralExpression(returnedAliasLiteral) ? "object" : "array"}`
                : symbolKey,
              sourceFile,
              returnedAliasLiteral ?? node.initializer,
              returnedAliasCallable ? `${getAnalyzableCallableName(returnedAliasCallable)}()` : node.name.text,
              returnedAliasCallable ? "expression" : isExportedVariableDeclaration(node) ? "export" : "local",
              returnedAliasLiteral ?? node.name,
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
          const analyzableCallable = resolveAnalyzableCallableBinding(
            project,
            node.expression,
            trackedBySymbolId,
            functionReturnSummaries,
            trackedObjectsById,
          );
          if (analyzableCallable) {
            node.arguments.forEach((argument, index) => {
              const parameter = analyzableCallable.declaration.parameters[index];
              if (!parameter || !ts.isIdentifier(parameter.name)) {
                return;
              }

              const structuredLiteral = getTrackableStructuredLiteralExpression(argument);
              if (!structuredLiteral) {
                return;
              }

              const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
              if (!parameterSymbol) {
                return;
              }

              const symbolKey = getCanonicalSymbolKey(project, parameterSymbol);
              const binding = createTrackedBindingForLiteral(
                symbolKey,
                sourceFile,
                structuredLiteral,
                parameter.name.text,
                "expression",
                argument,
              );
              mergeTrackedBinding(
                nextTrackedBySymbolId,
                conflictedTrackedSymbolIds,
                symbolKey,
                binding,
              );
            });
          }

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

    return {
      trackedBySymbolId: nextTrackedBySymbolId,
      functionReturnSummaries: nextFunctionReturnSummaries,
    };
  };

  const convergenceResult = runTrackingConvergence(
    () => ({ trackedBySymbolId, functionReturnSummaries }),
    computeNextTrackingState,
    (nextState) => {
      trackedBySymbolId.clear();
      nextState.trackedBySymbolId.forEach((binding, symbolKey) => {
        trackedBySymbolId.set(symbolKey, binding);
      });
      functionReturnSummaries.clear();
      nextState.functionReturnSummaries.forEach((summary, symbolKey) => {
        functionReturnSummaries.set(symbolKey, summary);
      });
    },
    options,
  );

  const runtimeSummary: MutableTrackingRuntimeSummary = {
    seed: {
      reachableFileCount: reachableFiles.size,
      reachableSourceFileCount,
    },
    convergence: {
      passes: convergenceResult.passes,
      warningPassThreshold: convergenceResult.warningPassThreshold,
      maxPasses: convergenceResult.maxPasses,
      warned: convergenceResult.warned,
    },
    totals: {
      trackedBindings: trackedBySymbolId.size,
      returnSummaries: functionReturnSummaries.size,
      trackedObjects: trackedObjectsById.size,
    },
    stageRequests: {
      [VALUE_LIVENESS_TRACKING_STAGE]: 0,
      [OBJECT_PATHS_TRACKING_STAGE]: 0,
    },
  };

  const diagnostics: TrackingContractDiagnostic[] = [
    ...convergenceResult.diagnostics,
  ];

  const snapshot: MutableTrackingSnapshot = {
    bindings: {
      owner: TRACKING_BINDINGS_OWNER,
      bySymbolId: trackedBySymbolId,
    },
    returnSummaries: {
      owner: TRACKING_RETURN_SUMMARY_OWNER,
      byCallableId: functionReturnSummaries,
    },
    aliases: {
      owner: TRACKING_ALIAS_OWNER,
      trackedObjectsById,
    },
    boundaries: {
      owner: TRACKING_BOUNDARY_OWNER,
      trackedObjectsById,
    },
    runtimeSummary,
    diagnostics,
  };

  const runArtifacts: TrackingRunArtifacts = {
    diagnostics: snapshot.diagnostics,
    getStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }> {
      if (stage === VALUE_LIVENESS_TRACKING_STAGE) {
        runtimeSummary.stageRequests[VALUE_LIVENESS_TRACKING_STAGE] += 1;
        return {
          stage,
          returnSummaries: snapshot.returnSummaries,
          runtimeSummary: snapshot.runtimeSummary,
        } as unknown as Extract<TrackingStageArtifacts, { stage: TStage }>;
      }

      if (stage === OBJECT_PATHS_TRACKING_STAGE) {
        runtimeSummary.stageRequests[OBJECT_PATHS_TRACKING_STAGE] += 1;
        return {
          stage,
          bindings: snapshot.bindings,
          returnSummaries: snapshot.returnSummaries,
          aliases: snapshot.aliases,
          boundaries: snapshot.boundaries,
          runtimeSummary: snapshot.runtimeSummary,
        } as unknown as Extract<TrackingStageArtifacts, { stage: TStage }>;
      }

      const diagnostic: TrackingContractDiagnostic = {
        code: "contract-violation",
        message: `tracking stage '${stage}' is outside the declared tracking-kernel contract`,
      };
      snapshot.diagnostics.push(diagnostic);
      throw new Error(diagnostic.message);
    },
  };

  return runArtifacts;
}
