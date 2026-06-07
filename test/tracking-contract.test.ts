import ts from "typescript";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { analyzeProject } from "../src/index.js";
import { createAnalysisArtifacts } from "../src/engine/analysis-artifacts.js";
import { getAnalysisRunResultMetadata } from "../src/engine/analysis-run-state.js";
import { createAnalysisState } from "../src/engine/analysis-state.js";
import { collectPublicSurface } from "../src/engine/analyzers/support.js";
import { joinCallableReturnSummaries } from "../src/engine/tracking/callables.js";
import { runTrackingConvergence } from "../src/engine/tracking/convergence.js";
import {
  TRACKING_GRAPH_BUILD_TRACKING_STAGE,
  TRACKING_ALIAS_OWNER,
  TRACKING_BINDINGS_OWNER,
  TRACKING_BOUNDARY_OWNER,
  TRACKING_RETURN_SUMMARY_OWNER,
} from "../src/engine/tracking/contracts.js";
import { createObjectPathStageContext } from "../src/engine/tracking/object-paths/stage-context.js";
import { getCanonicalSymbolKey } from "../src/engine/tracking/bindings.js";
import { isTrackingProtectedStructuralRole } from "../src/engine/tracking/ownership.js";
import {
  getObjectPathOverlayBoundaryRecords,
  getObjectPathOverlayEscapedReason,
  getObjectPathOverlayObservedAliases,
  getObjectPathOverlayReads,
  isObjectPathOverlayCollectionPathInvalidated,
} from "../src/engine/tracking/object-paths/overlay.js";
import { createHelperPlanningHelpers } from "../src/engine/tracking/object-paths/helper-plans.js";
import { extractFinitePropertyUnionSegments } from "../src/engine/tracking/object-paths/policy.js";
import { visitObjectPathSourceFile } from "../src/engine/tracking/object-paths/visitor.js";
import { createValueLivenessStageContext } from "../src/engine/tracking/value-liveness-context.js";
import { buildTrackedObjects } from "../src/engine/tracking/graph.js";
import type { TrackingStage } from "../src/engine/tracking/contracts.js";
import type { CallableReturnSummary } from "../src/engine/tracking/model.js";
import { appendTrackingAnalysisDiagnostics } from "../src/engine/tracking/diagnostics.js";
import { getCollectionInfo } from "../src/engine/tracking/state.js";
import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../src/module-graph.js";
import { loadProject } from "../src/project.js";
import { indexSegment, propertySegment, serializePath } from "../src/shared/path-utils.js";
import { buildSuppressionContext } from "../src/suppressions.js";
import type { TrackedObject } from "../src/types.js";

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

function createProjectContext(name: string) {
  const project = loadProject({
    cwd: process.cwd(),
    targetPath: fixturePath(name),
  });
  const entrypointDiscovery = discoverEntrypoints(project);
  const reachableFiles = computeReachableFiles(entrypointDiscovery.entrypoints, buildModuleGraph(project));
  const publicSurface = collectPublicSurface(project, entrypointDiscovery.publicSurfaceEntrypoints);

  return {
    project,
    reachableFiles,
    publicSurfaceIds: publicSurface.ids,
    publicCallableIds: publicSurface.callableIds,
  };
}

function findSourceFile(projectName: string, suffix: string) {
  const { project } = createProjectContext(projectName);
  const sourceFile = project.sourceFiles.find((candidate) => candidate.fileName.endsWith(suffix));

  if (!sourceFile) {
    throw new Error(`missing source file ${suffix} in fixture ${projectName}`);
  }

  return { project, sourceFile };
}

function findElementAccessExpression(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.ElementAccessExpression) => boolean,
): ts.ElementAccessExpression {
  let match: ts.ElementAccessExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (match) {
      return;
    }

    if (ts.isElementAccessExpression(node) && predicate(node)) {
      match = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  if (!match) {
    throw new Error(`missing matching element access in ${sourceFile.fileName}`);
  }

  return match;
}

function runObjectPathStage(name: string) {
  const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext(name);
  const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
  const state = createAnalysisState();
  const suppressionContext = buildSuppressionContext(project);
  const objectPathStage = createObjectPathStageContext(
    project,
    reachableFiles,
    state,
    suppressionContext,
    artifacts,
  );

  for (const sourceFile of project.sourceFiles) {
    if (!reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    visitObjectPathSourceFile(objectPathStage, objectPathStage.createSourceFileContext(sourceFile));
  }

  return {
    artifacts,
    objectPathStage,
  };
}

function findFunctionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let match: ts.FunctionDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (match) {
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  if (!match) {
    throw new Error(`missing function ${name} in ${sourceFile.fileName}`);
  }

  return match;
}

function findVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration {
  let match: ts.VariableDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (match) {
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      match = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  if (!match) {
    throw new Error(`missing variable ${name} in ${sourceFile.fileName}`);
  }

  return match;
}

function getTrackedObjectByRootName(
  trackedObjects: Iterable<import("../src/types.js").TrackedObject>,
  rootName: string,
) {
  const trackedObject = [...trackedObjects].find((candidate) => candidate.rootName === rootName);
  if (!trackedObject) {
    throw new Error(`missing tracked object ${rootName}`);
  }

  return trackedObject;
}

function getFirstTrackedObjectPair(
  stageTrackedObjects: ReadonlyMap<string, import("../src/types.js").TrackedObject>,
  snapshotTrackedObjects: ReadonlyMap<string, import("../src/types.js").TrackedObject>,
) {
  const [trackedObjectId, snapshotTrackedObject] = snapshotTrackedObjects.entries().next().value as [
    string,
    import("../src/types.js").TrackedObject,
  ];
  const stageTrackedObject = stageTrackedObjects.get(trackedObjectId);

  if (!stageTrackedObject) {
    throw new Error(`missing stage tracked object ${trackedObjectId}`);
  }

  return {
    stageTrackedObject,
    snapshotTrackedObject,
  };
}

describe("tracking kernel contract", () => {
  it("keeps shared tracking owners explicit and stable", () => {
    expect(new Set([
      TRACKING_BINDINGS_OWNER,
      TRACKING_RETURN_SUMMARY_OWNER,
      TRACKING_ALIAS_OWNER,
      TRACKING_BOUNDARY_OWNER,
    ])).toEqual(new Set([
      "binding-convergence",
      "return-summary-convergence",
      "alias-state",
      "boundary-state",
    ]));
  });

  it("exposes run-scoped and stage-scoped tracking artifacts", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const runArtifacts = artifacts.getTrackingRunArtifacts();
    const buildStage = runArtifacts.getStageArtifacts(TRACKING_GRAPH_BUILD_TRACKING_STAGE);

    expect(buildStage.runtimeSummary.seed.reachableFileCount).toBeGreaterThan(0);
    expect(buildStage.runtimeSummary.seed.reachableSourceFileCount).toBeGreaterThan(0);
    expect(buildStage.bindings.owner).toBe("binding-convergence");
    expect(buildStage.aliases.owner).toBe("alias-state");
    expect(buildStage.boundaries.owner).toBe("boundary-state");
    expect(buildStage.runtimeSummary.stageRequests[TRACKING_GRAPH_BUILD_TRACKING_STAGE]).toBe(1);
    expect(buildStage.runtimeSummary.stageRequests["value-liveness"]).toBe(0);
    expect(buildStage.runtimeSummary.stageRequests["object-paths"]).toBe(0);

    const valueStage = artifacts.getTrackingStageArtifacts("value-liveness");
    expect(valueStage.returnSummaries.owner).toBe("return-summary-convergence");
    expect(valueStage.returnSummaries).toBe(buildStage.returnSummaries);
    expect("bindings" in valueStage).toBe(false);
    expect(valueStage.runtimeSummary).toBe(buildStage.runtimeSummary);
    expect(valueStage.runtimeSummary.stageRequests[TRACKING_GRAPH_BUILD_TRACKING_STAGE]).toBe(1);
    expect(valueStage.runtimeSummary.stageRequests["value-liveness"]).toBe(1);
    expect(valueStage.runtimeSummary.stageRequests["object-paths"]).toBe(0);

    const objectPathStage = artifacts.getTrackingStageArtifacts("object-paths");
    expect(objectPathStage.returnSummaries).toBe(buildStage.returnSummaries);
    expect(objectPathStage.runtimeSummary).toBe(buildStage.runtimeSummary);
    expect(objectPathStage.bindings.owner).toBe("binding-convergence");
    expect(objectPathStage.aliases.owner).toBe("alias-state");
    expect(objectPathStage.boundaries.owner).toBe("boundary-state");
    expect(objectPathStage.runtimeSummary.stageRequests["object-paths"]).toBe(1);
  });

  it("builds the tracking graph explicitly before downstream tracking stages in analyzeProject", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
    });
    const runtimeSummary = getAnalysisRunResultMetadata(result)?.trackingRuntimeSummary;

    expect(runtimeSummary).toBeDefined();
    expect(runtimeSummary?.stageRequests[TRACKING_GRAPH_BUILD_TRACKING_STAGE]).toBeGreaterThanOrEqual(1);
    expect(runtimeSummary?.stageRequests["value-liveness"]).toBe(1);
    expect(runtimeSummary?.stageRequests["object-paths"]).toBe(1);
    expect(runtimeSummary?.stageTimingsMs[TRACKING_GRAPH_BUILD_TRACKING_STAGE]).toBe(runtimeSummary?.convergence.elapsedMs);
    expect(runtimeSummary?.stageTimingsMs["value-liveness"]).toBeGreaterThanOrEqual(0);
    expect(runtimeSummary?.stageTimingsMs["object-paths"]).toBeGreaterThanOrEqual(0);
  });

  it("reports solver-owned state family metrics in the tracking runtime summary", () => {
    const { project, reachableFiles } = createProjectContext("helper-return-alias-projection-basic");
    const runtimeSummary = buildTrackedObjects(project, reachableFiles)
      .getStageArtifacts(TRACKING_GRAPH_BUILD_TRACKING_STAGE)
      .runtimeSummary;

    expect(runtimeSummary.solverState.trackedObjectRegistryEntries).toBeGreaterThan(0);
    expect(runtimeSummary.solverState.callSiteSpecializations).toBeGreaterThan(0);
    expect(
      runtimeSummary.solverState.literalBindingCacheEntries
      + runtimeSummary.solverState.returnLiteralBindingCacheEntries,
    ).toBeGreaterThan(0);
  });

  it("fails explicitly when a pass heartbeat exceeds the elapsed guard budget", () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      expect(() => runTrackingConvergence(
        () => ({
          trackedBySymbolId: new Map(),
          functionReturnSummaries: new Map(),
        }),
        (heartbeat) => {
          now = 2;
          heartbeat();
          return {
            trackedBySymbolId: new Map(),
            functionReturnSummaries: new Map(),
          };
        },
        () => {},
        {
          maxPassElapsedMs: 1,
        },
      )).toThrow(/elapsed budget of 1ms/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("fails explicitly when per-pass call-site specialization growth exceeds the guard budget", () => {
    const { project, reachableFiles } = createProjectContext("helper-return-alias-projection-basic");

    expect(() => buildTrackedObjects(project, reachableFiles, {
      maxPassCallSiteSpecializationGrowth: 0,
    })).toThrow(/call-site specialization growth budget of 0/);

    try {
      buildTrackedObjects(project, reachableFiles, {
        maxPassCallSiteSpecializationGrowth: 0,
      });
    } catch (error) {
      expect((error as { diagnostic?: { stage?: string } }).diagnostic?.stage).toBe(TRACKING_GRAPH_BUILD_TRACKING_STAGE);
    }
  });

  it("emits convergence warnings with churn attribution in the tracking runtime summary", () => {
    const { project, reachableFiles } = createProjectContext("app-basic");
    const runArtifacts = buildTrackedObjects(project, reachableFiles, {
      warningPassThreshold: 1,
    });
    const runtimeSummary = runArtifacts.getStageArtifacts("value-liveness").runtimeSummary;
    const warningDiagnostic = runArtifacts.diagnostics.find((diagnostic) => diagnostic.code === "convergence-warning");

    expect(runtimeSummary.convergence.passes).toBeGreaterThanOrEqual(1);
    expect(runtimeSummary.convergence.warned).toBe(true);
    expect(runtimeSummary.convergence.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(
      runtimeSummary.convergence.churn.bindingChanges + runtimeSummary.convergence.churn.returnSummaryChanges,
    ).toBeGreaterThan(0);
    expect(warningDiagnostic).toBeDefined();
    expect(
      (warningDiagnostic?.details?.bindingChanges ?? 0) + (warningDiagnostic?.details?.returnSummaryChanges ?? 0),
    ).toBeGreaterThan(0);
  });

  it("fails explicitly when the convergence budget is exceeded", () => {
    const { project, reachableFiles } = createProjectContext("returned-object-basic");
    const baseline = buildTrackedObjects(project, reachableFiles);
    const guardLimit = baseline.getStageArtifacts("value-liveness").runtimeSummary.convergence.passes - 1;

    expect(baseline.getStageArtifacts("value-liveness").runtimeSummary.convergence.passes).toBeGreaterThan(1);
    expect(() =>
      buildTrackedObjects(project, reachableFiles, {
        maxPasses: guardLimit,
      })
    ).toThrow(`tracking convergence exceeded ${guardLimit} passes`);
    expect(() =>
      buildTrackedObjects(project, reachableFiles, {
        maxPasses: guardLimit,
      })
    ).toThrow(/recent churn:/);
  });

  it("captures pass-by-pass convergence traces only when explicitly enabled", () => {
    const { project, reachableFiles } = createProjectContext("returned-object-basic");
    const baseline = buildTrackedObjects(project, reachableFiles);
    const traced = buildTrackedObjects(project, reachableFiles, {
      tracePasses: true,
    });

    expect(baseline.debugTrace).toBeUndefined();
    expect(traced.debugTrace?.passTraces.length).toBeGreaterThan(0);
    expect(
      traced.debugTrace?.passTraces.some((passTrace) => passTrace.bindingChanges > 0 || passTrace.returnSummaryChanges > 0),
    ).toBe(true);
  });

  it("widens conflicting return summary states monotonically", () => {
    const trackedObjectA = { id: "tracked-a" } as TrackedObject;
    const trackedObjectB = { id: "tracked-b" } as TrackedObject;
    const valueSummary: CallableReturnSummary = { kind: "value" };
    const structuredA: CallableReturnSummary = {
      kind: "structured",
      binding: {
        trackedObject: trackedObjectA,
        prefix: [],
      },
    };
    const aliasA: CallableReturnSummary = {
      kind: "returned-alias",
      binding: {
        trackedObject: trackedObjectA,
        prefix: [],
      },
    };
    const structuredB: CallableReturnSummary = {
      kind: "structured",
      binding: {
        trackedObject: trackedObjectB,
        prefix: [],
      },
    };

    const widenedAlias = joinCallableReturnSummaries(structuredA, aliasA);
    expect(widenedAlias.summary).toEqual(aliasA);
    expect(widenedAlias.widened).toBe(true);
    expect(joinCallableReturnSummaries(widenedAlias.summary, structuredA).summary).toEqual(aliasA);

    const preservedStructured = joinCallableReturnSummaries(structuredA, valueSummary);
    expect(preservedStructured.summary).toEqual(structuredA);
    expect(preservedStructured.widened).toBe(false);

    const adoptedStructured = joinCallableReturnSummaries(valueSummary, structuredA);
    expect(adoptedStructured.summary).toEqual(structuredA);
    expect(adoptedStructured.widened).toBe(false);

    const widenedOpaque = joinCallableReturnSummaries(structuredA, structuredB);
    expect(widenedOpaque.summary).toEqual({ kind: "opaque" });
    expect(widenedOpaque.widened).toBe(true);
    expect(joinCallableReturnSummaries(widenedOpaque.summary, structuredA).summary).toEqual({ kind: "opaque" });
  });

  it("keeps focused return-summary stress fixtures stable without convergence warnings", () => {
    for (const fixtureName of [
      "higher-order-helper-return-basic",
      "returned-recursive-status-wrapper-basic",
      "returned-summary-alias-cycle-basic",
      "library-public-nested-callable-returns-basic",
    ]) {
      const { project, reachableFiles } = createProjectContext(fixtureName);
      const runtimeSummary = buildTrackedObjects(project, reachableFiles).getStageArtifacts("value-liveness").runtimeSummary;

      expect(runtimeSummary.convergence.warned, fixtureName).toBe(false);
    }
  });

  it("records contract violations for invalid stage requests", () => {
    const { project, reachableFiles } = createProjectContext("app-basic");
    const runArtifacts = buildTrackedObjects(project, reachableFiles);

    expect(() => runArtifacts.getStageArtifacts("invalid-stage" as unknown as TrackingStage)).toThrow(
      "outside the declared tracking-kernel contract",
    );
    expect(runArtifacts.diagnostics.some((diagnostic) => diagnostic.code === "contract-violation")).toBe(true);
  });

  it("keeps stage-local source-file bookkeeping isolated from shared tracking facts", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const state = createAnalysisState();
    const suppressionContext = buildSuppressionContext(project);
    const reachableSourceFiles = project.sourceFiles.filter((sourceFile) => reachableFiles.has(sourceFile.fileName));

    expect(reachableSourceFiles.length).toBeGreaterThanOrEqual(2);

    const objectPathStage = createObjectPathStageContext(
      project,
      reachableFiles,
      state,
      suppressionContext,
      artifacts,
    );
    const objectFileA = objectPathStage.createSourceFileContext(reachableSourceFiles[0]);
    const objectFileB = objectPathStage.createSourceFileContext(reachableSourceFiles[1]);

    objectFileA.handledExactCallbackBodies.add(reachableSourceFiles[0]);
    objectFileA.retainedContainerConflicts.add("config");
    objectFileA.parameterMeaningfulUse.set("param", true);

    expect(objectFileA.handledExactCallbackBodies).not.toBe(objectFileB.handledExactCallbackBodies);
    expect(objectFileB.handledExactCallbackBodies.size).toBe(0);
    expect(objectFileA.retainedContainerConflicts).not.toBe(objectFileB.retainedContainerConflicts);
    expect(objectFileB.retainedContainerConflicts.size).toBe(0);
    expect(objectFileA.parameterMeaningfulUse).not.toBe(objectFileB.parameterMeaningfulUse);
    expect(objectFileB.parameterMeaningfulUse.size).toBe(0);
    const objectPathArtifacts = artifacts.getTrackingStageArtifacts("object-paths");
    expect(objectPathStage.trackedBindingRegistry).not.toBe(objectPathArtifacts.bindings.bySymbolId);
    expect(objectPathStage.trackedBindingRegistry.size).toBe(objectPathArtifacts.bindings.bySymbolId.size);
    expect(objectPathStage.trackedObjectRegistry).not.toBe(objectPathArtifacts.aliases.trackedObjectsById);
    expect(objectPathStage.trackedObjectRegistry.size).toBe(objectPathArtifacts.aliases.trackedObjectsById.size);
    const { stageTrackedObject, snapshotTrackedObject } = getFirstTrackedObjectPair(
      objectPathStage.trackedObjectRegistry,
      objectPathArtifacts.aliases.trackedObjectsById,
    );
    expect(stageTrackedObject).not.toBe(snapshotTrackedObject);
    expect(
      [...objectPathStage.trackedBindingRegistry.values()].some((binding) => binding.trackedObject === stageTrackedObject),
    ).toBe(true);
    expect(
      [...objectPathStage.trackedBindingRegistry.values()].some((binding) => binding.trackedObject === snapshotTrackedObject),
    ).toBe(false);
    stageTrackedObject.exactPathAliases.set("__probe__", {
      fate: "inserted-by-reference",
      sourceObjectId: stageTrackedObject.id,
      sourcePath: [],
      observed: false,
    });
    expect(snapshotTrackedObject.exactPathAliases.has("__probe__")).toBe(false);
    expect(objectPathArtifacts.boundaries.trackedObjectsById).toBe(objectPathArtifacts.aliases.trackedObjectsById);

    const valueLivenessStage = createValueLivenessStageContext(
      reachableFiles,
      artifacts,
    );
    const valueFileA = valueLivenessStage.createSourceFileContext(reachableSourceFiles[0]);
    const valueFileB = valueLivenessStage.createSourceFileContext(reachableSourceFiles[1]);

    valueFileA.accesses.set("symbol", []);
    valueFileA.parameterMeaningfulUse.set("param", true);

    expect(valueFileA.accesses).not.toBe(valueFileB.accesses);
    expect(valueFileB.accesses.size).toBe(0);
    expect(valueFileA.parameterMeaningfulUse).not.toBe(valueFileB.parameterMeaningfulUse);
    expect(valueFileB.parameterMeaningfulUse.size).toBe(0);
    expect(valueLivenessStage.functionReturnSummaries).toBe(
      artifacts.getTrackingStageArtifacts("value-liveness").returnSummaries.byCallableId,
    );
  });

  it("keeps the value-liveness stage context surface narrow", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);

    const valueLivenessStage = createValueLivenessStageContext(
      reachableFiles,
      artifacts,
    );

    expect(Object.keys(valueLivenessStage).sort()).toEqual([
      "createSourceFileContext",
      "functionReturnSummaries",
      "reachableFiles",
    ]);
  });

  it("keeps locale-format recovery in the dedicated policy seam", () => {
    const { project, sourceFile } = findSourceFile("locale-runtime-format-source-backed-extra-basic", "/src/index.ts");
    const formatLookup = findElementAccessExpression(
      sourceFile,
      (node) => ts.isIdentifier(node.expression) && node.expression.text === "formatDictionary",
    );

    const segments = extractFinitePropertyUnionSegments(project, formatLookup.argumentExpression);

    expect(segments).toEqual(expect.arrayContaining([
      propertySegment("email"),
      propertySegment("url"),
      propertySegment("mac"),
      propertySegment("template_literal"),
    ]));
    expect(segments).not.toEqual(expect.arrayContaining([
      propertySegment("uuidv4"),
      propertySegment("uuidv6"),
    ]));
  });

  it("adapts tracking warnings into analysis-facing diagnostics while keeping runtime summaries internal", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds, {
      warningPassThreshold: 1,
    });
    const state = createAnalysisState();

    appendTrackingAnalysisDiagnostics(state, artifacts);

    expect(state.diagnostics).toContainEqual(expect.objectContaining({
      kind: "project-warning",
      message: expect.stringContaining(`tracking warning (${TRACKING_GRAPH_BUILD_TRACKING_STAGE}):`),
    }));
    expect(artifacts.getTrackingStageArtifacts("value-liveness").runtimeSummary.convergence.warned).toBe(true);
  });

  it("records append/readback observations in the overlay without mutating snapshot-owned reads", () => {
    const { artifacts, objectPathStage } = runObjectPathStage("helper-mutation-basic");
    const stageItems = getTrackedObjectByRootName(objectPathStage.trackedObjectRegistry.values(), "items");
    const snapshotItems = getTrackedObjectByRootName(
      artifacts.getTrackingStageArtifacts("object-paths").aliases.trackedObjectsById.values(),
      "items",
    );

    expect(getObjectPathOverlayReads(objectPathStage.overlayState, stageItems.id)).toContain(
      serializePath([indexSegment(0)]),
    );
    expect(snapshotItems.reads.size).toBe(0);
  });

  it("tracks returned-object readback on derived call-site objects through overlay reads", () => {
    const { objectPathStage } = runObjectPathStage("returned-object-basic");
    const returnedClone = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) => {
      const reads = getObjectPathOverlayReads(objectPathStage.overlayState, trackedObject.id);

      return reads?.has(serializePath([propertySegment("live")]))
        && reads.has(serializePath([propertySegment("nested"), propertySegment("read")]))
        && trackedObject.rootName.length > 0;
    });

    expect(returnedClone).toBeDefined();
  });

  it("tracks alias-backed helper readback through overlay observed alias paths", () => {
    const { objectPathStage } = runObjectPathStage("helper-return-alias-projection-basic");
    const aliasObservedObject = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) =>
      getObjectPathOverlayObservedAliases(objectPathStage.overlayState, trackedObject.id)?.has(serializePath([indexSegment(0)])));

    expect(aliasObservedObject).toBeDefined();
  });

  it("captures bounded helper append steps for merged issue payload assembly", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("returned-run-payload-merged-issue-keys-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const state = createAnalysisState();
    const suppressionContext = buildSuppressionContext(project);
    const objectPathStage = createObjectPathStageContext(
      project,
      reachableFiles,
      state,
      suppressionContext,
      artifacts,
    );
    const sourceFile = project.sourceFiles.find((candidate) => candidate.fileName.endsWith("/returned-run-payload-merged-issue-keys-basic/src/index.ts"));

    expect(sourceFile).toBeDefined();

    const sourceFileContext = objectPathStage.createSourceFileContext(sourceFile!);
    const helper = findFunctionDeclaration(sourceFile!, "handleIntersectionResults");
    const resultParameter = helper.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "result");
    const leftParameter = helper.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "left");

    expect(resultParameter && ts.isIdentifier(resultParameter.name)).toBe(true);
    expect(leftParameter && ts.isIdentifier(leftParameter.name)).toBe(true);

    const { getBoundedHelperExecutionSnapshot } = createHelperPlanningHelpers({
      project,
      trackedBySymbolId: objectPathStage.trackedBindingRegistry,
      functionReturnSummaries: objectPathStage.functionReturnSummaries,
      trackedObjectsById: objectPathStage.trackedObjectRegistry,
      parameterMeaningfulUse: sourceFileContext.parameterMeaningfulUse,
      parameterSummaryCache: sourceFileContext.parameterSummaryCache,
      helperExecutionSnapshotCache: sourceFileContext.helperExecutionSnapshotCache,
      helperExactAppendPlanCache: sourceFileContext.helperExactAppendPlanCache,
      helperProjectedUsagePlanCache: sourceFileContext.helperProjectedUsagePlanCache,
      higherOrderCallableReturnSummaryCache: sourceFileContext.higherOrderCallableReturnSummaryCache,
    });

    const resultSnapshot = getBoundedHelperExecutionSnapshot(helper, resultParameter!.name as ts.Identifier);
    const leftSnapshot = getBoundedHelperExecutionSnapshot(helper, leftParameter!.name as ts.Identifier);

    expect(resultSnapshot?.steps.some((step) =>
      step.kind === "exact-append-mutation"
      && serializePath(step.relativeCollectionPath) === serializePath([propertySegment("issues")]))).toBe(true);
    expect(resultSnapshot?.steps.some((step) => step.kind === "spread-materialization-prerequisite")).toBe(true);
    expect(resultSnapshot?.steps.some((step) => step.kind === "returned-carrier-emission")).toBe(true);
    expect(leftSnapshot?.steps.some((step) => step.kind === "alias-write")).toBe(true);
    expect(leftSnapshot?.steps.some((step) => step.kind === "projected-iteration-binding")).toBe(true);
  });

  it("tracks merged helper payload readback through returned carrier overlay reads", () => {
    const { objectPathStage } = runObjectPathStage("returned-run-payload-merged-issue-keys-basic");
    const mergedPayload = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) =>
      getObjectPathOverlayReads(objectPathStage.overlayState, trackedObject.id)?.has(
        serializePath([propertySegment("issues"), indexSegment(0)]),
      ));

    expect(mergedPayload).toBeDefined();
  });

  it("tracks merged helper payload field readback on the returned payload owner", () => {
    const { objectPathStage } = runObjectPathStage("returned-run-payload-merged-issue-keys-basic");
    const payloadOwner = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) =>
      getObjectPathOverlayReads(objectPathStage.overlayState, trackedObject.id)?.has(
        serializePath([propertySegment("issues"), indexSegment(0), propertySegment("code")]),
      ));

    expect(payloadOwner).toBeDefined();
  });

  it("tracks merged helper key-array readback on the original unrecognized array", () => {
    const { objectPathStage } = runObjectPathStage("returned-run-payload-merged-issue-keys-basic");
    const unrecognized = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) =>
      trackedObject.rootName === "unrecognized"
      && getObjectPathOverlayReads(objectPathStage.overlayState, trackedObject.id)?.has(
        serializePath([indexSegment(0)]),
      ));

    expect(unrecognized).toBeDefined();
  });

  it("keeps parse helper returns exact enough to project issues arrays", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("returned-run-payload-merged-issue-keys-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const state = createAnalysisState();
    const suppressionContext = buildSuppressionContext(project);
    const objectPathStage = createObjectPathStageContext(
      project,
      reachableFiles,
      state,
      suppressionContext,
      artifacts,
    );

    for (const sourceFile of project.sourceFiles) {
      if (!reachableFiles.has(sourceFile.fileName)) {
        continue;
      }

      visitObjectPathSourceFile(objectPathStage, objectPathStage.createSourceFileContext(sourceFile));
    }

    const sourceFile = project.sourceFiles.find((candidate) => candidate.fileName.endsWith("/returned-run-payload-merged-issue-keys-basic/src/index.ts"));
    expect(sourceFile).toBeDefined();

    const leftDeclaration = findVariableDeclaration(sourceFile!, "left");
    const leftSymbol = project.checker.getSymbolAtLocation(leftDeclaration.name);
    expect(leftSymbol).toBeDefined();

    const leftBinding = objectPathStage.trackedBindingRegistry.get(getCanonicalSymbolKey(project, leftSymbol!));

    expect(leftBinding).toBeDefined();
    expect(getCollectionInfo(leftBinding!.trackedObject, [...leftBinding!.prefix, propertySegment("issues")])?.kind).toBe("array");
    expect(isTrackingProtectedStructuralRole(leftBinding!.trackedObject.structuralRole)).toBe(false);
  });

  it("tracks collection invalidation and boundary state in the overlay", () => {
    const { objectPathStage } = runObjectPathStage("helper-queue-basic");
    const queue = getTrackedObjectByRootName(objectPathStage.trackedObjectRegistry.values(), "queue");
    const boundaries = getObjectPathOverlayBoundaryRecords(objectPathStage.overlayState, queue.id);

    expect(boundaries).toBeDefined();
    expect([...boundaries!.values()].some((boundary) => boundary.category === "array-reorder-mutation")).toBe(true);
    expect(isObjectPathOverlayCollectionPathInvalidated(objectPathStage.overlayState, queue.id, [])).toBe(true);
  });

  it("seeds snapshot-derived boundary, invalidation, and escape state into the overlay instead of stage clone runtime fields", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("helper-queue-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const snapshotQueue = getTrackedObjectByRootName(
      artifacts.getTrackingStageArtifacts("object-paths").aliases.trackedObjectsById.values(),
      "queue",
    );

    snapshotQueue.collectionBoundaries.set("boundary:queue", {
      entity: {
        id: "boundary:queue",
        kind: "collection-boundary",
        name: "queue",
        owner: "queue",
        location: {
          file: "src/index.ts",
          line: 1,
          column: 1,
        },
      },
      path: [],
      category: "array-reorder-mutation",
      reason: "seeded boundary",
    });
    snapshotQueue.invalidatedCollectionPaths.add(serializePath([]));
    snapshotQueue.invalidatedPaths.set(serializePath([]), {
      reason: "seeded invalidation",
      findingKind: "stale-read-after-mutation",
    });
    snapshotQueue.escapedPaths.set(serializePath([indexSegment(0)]), {
      category: "opaque-object-call",
      reason: "seeded escape",
    });
    snapshotQueue.reads.add(serializePath([indexSegment(0)]));
    snapshotQueue.writes.add(serializePath([indexSegment(0)]));

    const state = createAnalysisState();
    const suppressionContext = buildSuppressionContext(project);
    const objectPathStage = createObjectPathStageContext(
      project,
      reachableFiles,
      state,
      suppressionContext,
      artifacts,
    );
    const stageQueue = getTrackedObjectByRootName(objectPathStage.trackedObjectRegistry.values(), "queue");

    expect(getObjectPathOverlayBoundaryRecords(objectPathStage.overlayState, stageQueue.id)?.get("boundary:queue")).toEqual(
      snapshotQueue.collectionBoundaries.get("boundary:queue"),
    );
    expect(isObjectPathOverlayCollectionPathInvalidated(objectPathStage.overlayState, stageQueue.id, [])).toBe(true);
    expect(getObjectPathOverlayEscapedReason(objectPathStage.overlayState, stageQueue.id, [indexSegment(0)])).toEqual(
      snapshotQueue.escapedPaths.get(serializePath([indexSegment(0)])),
    );
    expect(stageQueue.collectionBoundaries.size).toBe(0);
    expect(stageQueue.invalidatedCollectionPaths.size).toBe(0);
    expect(stageQueue.escapedPaths.size).toBe(0);
    expect(stageQueue.reads.size).toBe(0);
    expect(stageQueue.writes.size).toBe(0);
  });

  it("keeps fresh call-site clones from leaking collection metadata back into the source return object", () => {
    const { objectPathStage } = runObjectPathStage("returned-object-array-mutation-basic");
    const baseReturnObject = [...objectPathStage.trackedObjectRegistry.values()].find((trackedObject) =>
      trackedObject.rootName === "buildContainer()" && !trackedObject.id.includes(":call:"));

    if (!baseReturnObject) {
      throw new Error("missing base return object");
    }

    const itemsPath = serializePath([propertySegment("items")]);
    const itemsCollection = baseReturnObject.collections.get(itemsPath);
    const itemsState = baseReturnObject.collectionStates.get(itemsPath);

    expect(itemsCollection?.arrayLength).toBe(0);
    expect(itemsCollection?.childPaths).toEqual([]);
    expect(itemsState?.arrayLength).toBe(0);
  });
});
