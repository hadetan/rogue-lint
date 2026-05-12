import ts from "typescript";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAnalysisArtifacts } from "../src/engine/analysis-artifacts.js";
import { createAnalysisState } from "../src/engine/analysis-state.js";
import { collectPublicSurface } from "../src/engine/analyzers/support.js";
import { createObjectPathStageContext } from "../src/engine/tracking/object-paths/context.js";
import { extractFinitePropertyUnionSegments } from "../src/engine/tracking/object-paths/policy.js";
import { createValueLivenessStageContext } from "../src/engine/tracking/value-liveness-context.js";
import { buildTrackedObjects } from "../src/engine/tracking/graph.js";
import type { TrackingStage } from "../src/engine/tracking/contracts.js";
import { appendTrackingAnalysisDiagnostics } from "../src/engine/tracking/diagnostics.js";
import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../src/module-graph.js";
import { loadProject } from "../src/project.js";
import { propertySegment } from "../src/shared/path-utils.js";
import { buildSuppressionContext } from "../src/suppressions.js";

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

describe("tracking kernel contract", () => {
  it("exposes run-scoped and stage-scoped tracking artifacts", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds, publicCallableIds);
    const runArtifacts = artifacts.getTrackingRunArtifacts();
    const initialValueStage = runArtifacts.getStageArtifacts("value-liveness");

    expect(initialValueStage.runtimeSummary.seed.reachableFileCount).toBeGreaterThan(0);
    expect(initialValueStage.runtimeSummary.seed.reachableSourceFileCount).toBeGreaterThan(0);

    const valueStage = artifacts.getTrackingStageArtifacts("value-liveness");
    expect(valueStage.returnSummaries.owner).toBe("return-summary-convergence");
    expect("bindings" in valueStage).toBe(false);
    expect(valueStage.runtimeSummary.stageRequests["value-liveness"]).toBe(2);
    expect(valueStage.runtimeSummary.stageRequests["object-paths"]).toBe(0);

    const objectPathStage = artifacts.getTrackingStageArtifacts("object-paths");
    expect(objectPathStage.bindings.owner).toBe("binding-convergence");
    expect(objectPathStage.aliases.owner).toBe("alias-state");
    expect(objectPathStage.boundaries.owner).toBe("boundary-state");
    expect(objectPathStage.runtimeSummary.stageRequests["object-paths"]).toBe(1);
  });

  it("emits convergence warnings in the tracking runtime summary", () => {
    const { project, reachableFiles } = createProjectContext("app-basic");
    const runArtifacts = buildTrackedObjects(project, reachableFiles, {
      warningPassThreshold: 1,
    });
    const runtimeSummary = runArtifacts.getStageArtifacts("value-liveness").runtimeSummary;

    expect(runtimeSummary.convergence.passes).toBeGreaterThanOrEqual(1);
    expect(runtimeSummary.convergence.warned).toBe(true);
    expect(runArtifacts.diagnostics.some((diagnostic) => diagnostic.code === "convergence-warning")).toBe(true);
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
    expect(objectPathStage.trackedBySymbolId).toBe(artifacts.getTrackingStageArtifacts("object-paths").bindings.bySymbolId);

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
      message: expect.stringContaining("tracking warning:"),
    }));
    expect(artifacts.getTrackingStageArtifacts("value-liveness").runtimeSummary.convergence.warned).toBe(true);
  });
});
