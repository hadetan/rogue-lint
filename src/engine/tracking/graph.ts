import ts from "typescript";

import type {
  EntityKind,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { ENTITY_KIND } from "../../shared/entity-vocabulary.js";
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
  withTrackingAccessHeartbeat,
} from "./access.js";
import {
  getObjectBackedRetainedBindingSlotKeyFromAccess,
  getRetainedBindingContainerSlotKey,
  isLocallyOwnedRetainedBindingContainer,
} from "./retained-bindings.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  getAnalyzableCallableName,
  joinCallableReturnSummaries,
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
  getTrackingDiagnosticFromError,
  OBJECT_PATHS_TRACKING_STAGE,
  TRACKING_CONTRACT_DIAGNOSTIC_CODE,
  TRACKING_GRAPH_BUILD_TRACKING_STAGE,
  TRACKING_ALIAS_OWNER,
  TRACKING_BINDINGS_OWNER,
  TRACKING_BOUNDARY_OWNER,
  TRACKING_RETURN_SUMMARY_OWNER,
  VALUE_LIVENESS_TRACKING_STAGE,
} from "./contracts.js";
import { TRACKING_STRUCTURAL_ROLE } from "./ownership.js";
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
} from "./trackable-structures.js";
import { materializeTrackedLiteralAtPath, withTrackingLiteralMaterializationHeartbeat } from "./literal-materialization.js";
import { createReturnSummaryCollector, withTrackingReturnSummaryHeartbeat } from "./return-summaries.js";
import {
  TRACKING_COLLECTION_KIND,
  TRACKING_RETAINED_BINDING_WRITE_METHOD,
} from "./vocabulary.js";

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
const _TRACKED_OBJECT_STRUCTURAL_ROLE_FIELD = "structuralRole" as const;

function normalizeTrackedRootName(name: string): string {
  return name.endsWith("()") ? name.slice(0, -2) : name;
}

function isPathSegmentType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.getName() === "PathSegment";
}

function isHelperMetadataArrayType(project: ProjectContext, type: ts.Type | undefined): boolean {
  if (!type) {
    return false;
  }

  const apparentType = project.checker.getApparentType(type);
  if (!project.checker.isArrayType(apparentType)) {
    return false;
  }

  const [elementType] = project.checker.getTypeArguments(apparentType as ts.TypeReference);
  if (!elementType) {
    return false;
  }

  const apparentElementType = project.checker.getApparentType(elementType);
  if ((apparentElementType.flags & ts.TypeFlags.StringLike) !== 0 || isPathSegmentType(apparentElementType)) {
    return true;
  }

  if (!project.checker.isArrayType(apparentElementType)) {
    return false;
  }

  const [nestedElementType] = project.checker.getTypeArguments(apparentElementType as ts.TypeReference);
  return Boolean(nestedElementType) && isPathSegmentType(project.checker.getApparentType(nestedElementType));
}

function classifyHelperMetadataArrayRole(
  project: ProjectContext,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  name: string,
  anchor: ts.Node,
): TrackedObject[typeof _TRACKED_OBJECT_STRUCTURAL_ROLE_FIELD] | undefined {
  if (!ts.isArrayLiteralExpression(node)) {
    return undefined;
  }

  if (!HELPER_METADATA_ARRAY_ROOT_NAMES.has(normalizeTrackedRootName(name))) {
    return undefined;
  }

  return (
    isHelperMetadataArrayType(project, project.checker.getTypeAtLocation(anchor))
    || isHelperMetadataArrayType(project, project.checker.getTypeAtLocation(node))
    || isHelperMetadataArrayType(project, project.checker.getContextualType(node))
  )
    ? TRACKING_STRUCTURAL_ROLE.structuralRecordArray
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
  const wideningSampleLimit = Math.max(1, options?.churnSampleLimit ?? 5);
  const wideningSummary = {
    returnSummaryChanges: 0,
    reasons: {
      bindings: [] as string[],
      returnSummaries: [] as string[],
    },
  };
  const helperMetadataArrayRoleCache = new Map<string, TrackedObject[typeof _TRACKED_OBJECT_STRUCTURAL_ROLE_FIELD] | null>();

  const recordWideningReason = (target: string[], reason: string | undefined): void => {
    if (!reason || target.includes(reason) || target.length >= wideningSampleLimit) {
      return;
    }

    target.push(reason);
  };

  const getCallSiteSpecializationCount = (): number => {
    let count = 0;

    for (const trackedObject of trackedObjectsById.values()) {
      if (trackedObject.reportingOwnerId && trackedObject.reportingOwnerId !== trackedObject.id) {
        count += 1;
      }
    }

    return count;
  };

  const observeTrackedObjectShape = (trackedObject: TrackedObject): void => {
    void trackedObject.id;
    void trackedObject.derivedStateRevision;
    void trackedObject.canonicalSymbolKey;
    void trackedObject.rootName;
    void trackedObject.sourceFile;
    void trackedObject.rootEntity;
    void trackedObject.structuralRole;
    void trackedObject.nodes;
    void trackedObject.callablePaths;
    void trackedObject.descendantNodeKeys;
    void trackedObject.collections;
    void trackedObject.collectionStates;
    void trackedObject.collectionBoundaries;
    void trackedObject.invalidatedCollectionPaths;
    void trackedObject.invalidatedPaths;
    void trackedObject.placeStates;
    void trackedObject.observedSubtrees;
    void trackedObject.escapedPaths;
    void trackedObject.exactPathAliases;
    void trackedObject.valueFates;
    void trackedObject.reads;
    void trackedObject.writes;
  };

  const observeTrackingConvergenceOptionsShape = (currentOptions: TrackingConvergenceOptions): void => {
    void currentOptions.warningPassThreshold;
    void currentOptions.maxPasses;
    void currentOptions.churnSampleLimit;
    void currentOptions.tracePasses;
    void currentOptions.maxPassElapsedMs;
    void currentOptions.maxPassTrackedObjectRegistryGrowth;
    void currentOptions.maxPassCallSiteSpecializationGrowth;
    void currentOptions.maxPassLiteralBindingCacheGrowth;
    void currentOptions.maxPassReturnLiteralBindingCacheGrowth;
    void currentOptions.getSolverStateMetrics;
  };

  const attachTrackingGraphBuildStage = (
    diagnostic: TrackingContractDiagnostic,
  ): TrackingContractDiagnostic => (
    diagnostic.stage
      ? diagnostic
      : {
          ...diagnostic,
          stage: TRACKING_GRAPH_BUILD_TRACKING_STAGE,
        }
  );

  const getSolverStateMetrics = () => ({
    trackedObjectRegistryEntries: trackedObjectsById.size,
    callSiteSpecializations: getCallSiteSpecializationCount(),
    literalBindingCacheEntries: trackedLiteralBindings.size,
    returnLiteralBindingCacheEntries: trackedReturnLiteralBindings.size,
  });

  const stabilizeFunctionReturnSummaries = (
    currentSummaries: ReadonlyMap<string, CallableReturnSummary>,
    nextSummaries: ReadonlyMap<string, CallableReturnSummary>,
  ): Map<string, CallableReturnSummary> => {
    const stabilized = new Map<string, CallableReturnSummary>();
    const callableIds = new Set<string>([...currentSummaries.keys(), ...nextSummaries.keys()]);

    for (const callableId of callableIds) {
      const joined = joinCallableReturnSummaries(
        currentSummaries.get(callableId),
        nextSummaries.get(callableId),
      );
      if (joined.summary) {
        stabilized.set(callableId, joined.summary);
      }

      if (joined.widened) {
        wideningSummary.returnSummaryChanges += 1;
        recordWideningReason(
          wideningSummary.reasons.returnSummaries,
          joined.reason ? `${callableId}: ${joined.reason}` : undefined,
        );
      }
    }

    return stabilized;
  };

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
        { materializeNodes: false, registerAliases: true },
      );
      return existing;
    }

    let structuralRole = classifyTrackedObjectStructuralRole(node);
    if (structuralRole === undefined) {
      const cacheKey = `${sourceFile.fileName}:${node.pos}:${anchor.pos}:${name}`;
      const cachedRole = helperMetadataArrayRoleCache.get(cacheKey);

      if (cachedRole !== undefined || helperMetadataArrayRoleCache.has(cacheKey)) {
        structuralRole = cachedRole ?? undefined;
      } else {
        structuralRole = classifyHelperMetadataArrayRole(project, node, name, anchor);
        helperMetadataArrayRoleCache.set(cacheKey, structuralRole ?? null);
      }
    }

    const rootEntity = makeEntity(project.rootPath, kind, sourceFile, anchor, name);
    const trackedObject: TrackedObject = {
      id: rootEntity.id,
      derivedStateRevision: 0,
      canonicalSymbolKey: symbolKey,
      rootName: name,
      sourceFile: sourceFile.fileName,
      rootEntity,
      structuralRole,
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
    observeTrackedObjectShape(trackedObject);
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
      { registerAliases: true },
    );

    const binding = new TrackedObjectBindingRecord(trackedObject, []);

    if (kind === ENTITY_KIND.local) {
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

  const computeNextTrackingState = (heartbeat: () => void): TrackingConvergenceState => {
    const nextTrackedBySymbolId = new Map<string, TrackedObjectBinding>();
    const conflictedTrackedSymbolIds = new Set<string>();
    let heartbeatCounter = 0;

    const maybeHeartbeat = (): void => {
      heartbeatCounter += 1;
      if (heartbeatCounter >= 2048) {
        heartbeatCounter = 0;
        heartbeat();
      }
    };

    withTrackingAccessHeartbeat(heartbeat, () => {
      withTrackingLiteralMaterializationHeartbeat(heartbeat, () => {
        for (const sourceFile of project.sourceFiles) {
          if (!reachableFiles.has(sourceFile.fileName)) {
            continue;
          }

          maybeHeartbeat();

          const visit = (node: ts.Node): void => {
            maybeHeartbeat();

            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
              const symbol = project.checker.getSymbolAtLocation(node.name);
              if (!symbol) {
                return ts.forEachChild(node, visit);
              }

              const structuredLiteral = getTrackableStructuredLiteralExpression(node.initializer);

              if (structuredLiteral) {
                const symbolKey = getCanonicalSymbolKey(project, symbol);
                const returnedAliasCallable = resolveStructuredReturnAliasCallable(node);
                const returnedAliasLiteral = returnedAliasCallable
                  ? getTrackableStructuredLiteral(node.initializer, { allowArraySpreadBoundary: true })
                  : undefined;
                const binding = createTrackedBindingForLiteral(
                  returnedAliasCallable && returnedAliasLiteral
                    ? `${returnedAliasCallable.symbolKey}:return:${ts.isObjectLiteralExpression(returnedAliasLiteral) ? TRACKING_COLLECTION_KIND.object : TRACKING_COLLECTION_KIND.array}`
                    : symbolKey,
                  sourceFile,
                  returnedAliasLiteral ?? structuredLiteral,
                  returnedAliasCallable ? `${getAnalyzableCallableName(returnedAliasCallable)}()` : node.name.text,
                  returnedAliasCallable
                    ? "expression"
                    : isExportedVariableDeclaration(node)
                      ? ENTITY_KIND.export
                      : ENTITY_KIND.local,
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
                && node.expression.name.text === TRACKING_RETAINED_BINDING_WRITE_METHOD
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
      });
    });

    const nextFunctionReturnSummaries = new Map<string, CallableReturnSummary>();
    withTrackingReturnSummaryHeartbeat(heartbeat, () => {
      for (const sourceFile of project.sourceFiles) {
        if (!reachableFiles.has(sourceFile.fileName)) {
          continue;
        }

        maybeHeartbeat();

        const visit = (node: ts.Node): void => {
          maybeHeartbeat();

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
    });

    return {
      trackedBySymbolId: nextTrackedBySymbolId,
      functionReturnSummaries: stabilizeFunctionReturnSummaries(functionReturnSummaries, nextFunctionReturnSummaries),
    };
  };

  const convergenceResult = (() => {
    try {
      const convergenceOptions: TrackingConvergenceOptions = { ...options };
      convergenceOptions.getSolverStateMetrics = getSolverStateMetrics;
      observeTrackingConvergenceOptionsShape(convergenceOptions);

      return runTrackingConvergence(
        () => ({ trackedBySymbolId, functionReturnSummaries }),
        computeNextTrackingState,
        (nextState, heartbeat) => {
          let heartbeatCounter = 0;
          const maybeHeartbeat = (): void => {
            heartbeatCounter += 1;
            if (heartbeatCounter >= 2048) {
              heartbeatCounter = 0;
              heartbeat();
            }
          };

          trackedBySymbolId.clear();
          nextState.trackedBySymbolId.forEach((binding, symbolKey) => {
            maybeHeartbeat();
            trackedBySymbolId.set(symbolKey, binding);
          });
          functionReturnSummaries.clear();
          nextState.functionReturnSummaries.forEach((summary, symbolKey) => {
            maybeHeartbeat();
            functionReturnSummaries.set(symbolKey, summary);
          });
        },
        convergenceOptions,
      );
    } catch (error) {
      const diagnostic = getTrackingDiagnosticFromError(error);
      if (diagnostic && !diagnostic.stage) {
        diagnostic.stage = TRACKING_GRAPH_BUILD_TRACKING_STAGE;
      }

      throw error;
    }
  })();

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
      elapsedMs: convergenceResult.elapsedMs,
      churn: {
        bindingChanges: convergenceResult.churn.bindingChanges,
        bindingChangedPasses: convergenceResult.churn.bindingChangedPasses,
        returnSummaryChanges: convergenceResult.churn.returnSummaryChanges,
        returnSummaryChangedPasses: convergenceResult.churn.returnSummaryChangedPasses,
      },
      widening: {
        bindingChanges: convergenceResult.widening.bindingChanges,
        returnSummaryChanges: convergenceResult.widening.returnSummaryChanges + wideningSummary.returnSummaryChanges,
        reasons: {
          bindings: [...wideningSummary.reasons.bindings],
          returnSummaries: [...wideningSummary.reasons.returnSummaries],
        },
      },
      unstableSamples: {
        bindings: [...convergenceResult.unstableSamples.bindings],
        returnSummaries: [...convergenceResult.unstableSamples.returnSummaries],
      },
    },
    totals: {
      trackedBindings: trackedBySymbolId.size,
      returnSummaries: functionReturnSummaries.size,
      trackedObjects: trackedObjectsById.size,
    },
    solverState: getSolverStateMetrics(),
    stageTimingsMs: {
      [TRACKING_GRAPH_BUILD_TRACKING_STAGE]: convergenceResult.elapsedMs,
      [VALUE_LIVENESS_TRACKING_STAGE]: 0,
      [OBJECT_PATHS_TRACKING_STAGE]: 0,
    },
    stageRequests: {
      [TRACKING_GRAPH_BUILD_TRACKING_STAGE]: 0,
      [VALUE_LIVENESS_TRACKING_STAGE]: 0,
      [OBJECT_PATHS_TRACKING_STAGE]: 0,
    },
  };

  const diagnostics: TrackingContractDiagnostic[] = convergenceResult.diagnostics.map(attachTrackingGraphBuildStage);

  const observeTrackingSnapshotShape = (currentSnapshot: MutableTrackingSnapshot): void => {
    void currentSnapshot.sharedFacts.bindings.owner;
    void currentSnapshot.sharedFacts.bindings.bySymbolId;
    void currentSnapshot.sharedFacts.returnSummaries.owner;
    void currentSnapshot.sharedFacts.returnSummaries.byCallableId;
    void currentSnapshot.sharedFacts.aliases.owner;
    void currentSnapshot.sharedFacts.aliases.trackedObjectsById;
    void currentSnapshot.sharedFacts.boundaries.owner;
    void currentSnapshot.sharedFacts.boundaries.trackedObjectsById;
    void currentSnapshot.solverState.diagnostics;
    void currentSnapshot.solverState.runtimeSummary;
  };

  const observeTrackingRunArtifactsShape = (artifacts: TrackingRunArtifacts): void => {
    void artifacts.diagnostics;
    void artifacts.debugTrace;
    void artifacts.runtimeSummary;
    void artifacts.recordStageTiming;
    void artifacts.getStageArtifacts;
  };

  const snapshot: MutableTrackingSnapshot = {
    sharedFacts: {
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
    },
    solverState: {
      runtimeSummary,
      diagnostics,
    },
  };

  observeTrackingSnapshotShape(snapshot);

  const runArtifacts: TrackingRunArtifacts = {
    diagnostics: snapshot.solverState.diagnostics,
    debugTrace: convergenceResult.debugTrace,
    runtimeSummary: snapshot.solverState.runtimeSummary,
    recordStageTiming(stage: TrackingStage, elapsedMs: number): void {
      snapshot.solverState.runtimeSummary.stageTimingsMs[stage] = elapsedMs;
    },
    getStageArtifacts<TStage extends TrackingStage>(stage: TStage): Extract<TrackingStageArtifacts, { stage: TStage }> {
      if (stage === TRACKING_GRAPH_BUILD_TRACKING_STAGE) {
        snapshot.solverState.runtimeSummary.stageRequests[TRACKING_GRAPH_BUILD_TRACKING_STAGE] += 1;
        return {
          stage,
          bindings: snapshot.sharedFacts.bindings,
          returnSummaries: snapshot.sharedFacts.returnSummaries,
          aliases: snapshot.sharedFacts.aliases,
          boundaries: snapshot.sharedFacts.boundaries,
          runtimeSummary: snapshot.solverState.runtimeSummary,
        } as unknown as Extract<TrackingStageArtifacts, { stage: TStage }>;
      }

      if (stage === VALUE_LIVENESS_TRACKING_STAGE) {
        snapshot.solverState.runtimeSummary.stageRequests[VALUE_LIVENESS_TRACKING_STAGE] += 1;
        return {
          stage,
          returnSummaries: snapshot.sharedFacts.returnSummaries,
          runtimeSummary: snapshot.solverState.runtimeSummary,
        } as unknown as Extract<TrackingStageArtifacts, { stage: TStage }>;
      }

      if (stage === OBJECT_PATHS_TRACKING_STAGE) {
        snapshot.solverState.runtimeSummary.stageRequests[OBJECT_PATHS_TRACKING_STAGE] += 1;
        return {
          stage,
          bindings: snapshot.sharedFacts.bindings,
          returnSummaries: snapshot.sharedFacts.returnSummaries,
          aliases: snapshot.sharedFacts.aliases,
          boundaries: snapshot.sharedFacts.boundaries,
          runtimeSummary: snapshot.solverState.runtimeSummary,
        } as unknown as Extract<TrackingStageArtifacts, { stage: TStage }>;
      }

      const diagnostic: TrackingContractDiagnostic = {
        code: TRACKING_CONTRACT_DIAGNOSTIC_CODE.contractViolation,
        message: `tracking stage '${stage}' is outside the declared tracking-kernel contract`,
      };
      snapshot.solverState.diagnostics.push(diagnostic);
      throw new Error(diagnostic.message);
    },
  };

  observeTrackingRunArtifactsShape(runArtifacts);

  return runArtifacts;
}
