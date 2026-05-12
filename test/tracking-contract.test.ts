import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAnalysisArtifacts } from "../src/engine/analysis-artifacts.js";
import { collectPublicSurfaceIds } from "../src/engine/analyzers/support.js";
import { buildTrackedObjects } from "../src/engine/tracking/graph.js";
import type { TrackingStage } from "../src/engine/tracking/contracts.js";
import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../src/module-graph.js";
import { loadProject } from "../src/project.js";

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

  return {
    project,
    reachableFiles,
    publicSurfaceIds: collectPublicSurfaceIds(project, entrypointDiscovery.publicSurfaceEntrypoints),
  };
}

describe("tracking kernel contract", () => {
  it("exposes run-scoped and stage-scoped tracking artifacts", () => {
    const { project, reachableFiles, publicSurfaceIds } = createProjectContext("app-basic");
    const artifacts = createAnalysisArtifacts(project, reachableFiles, publicSurfaceIds);
    const runArtifacts = artifacts.getTrackingRunArtifacts();

    expect(runArtifacts.seed.reachableFileCount).toBeGreaterThan(0);
    expect(runArtifacts.seed.reachableSourceFileCount).toBeGreaterThan(0);
    expect(runArtifacts.runtimeSummary.stageRequests["value-liveness"]).toBe(0);
    expect(runArtifacts.runtimeSummary.stageRequests["object-paths"]).toBe(0);

    const valueStage = artifacts.getTrackingStageArtifacts("value-liveness");
    expect(valueStage.returnSummaries.owner).toBe("return-summary-convergence");
    expect("bindings" in valueStage).toBe(false);
    expect(valueStage.runtimeSummary.stageRequests["value-liveness"]).toBe(1);
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

    expect(runArtifacts.runtimeSummary.convergence.passes).toBeGreaterThanOrEqual(1);
    expect(runArtifacts.runtimeSummary.convergence.warned).toBe(true);
    expect(runArtifacts.diagnostics.some((diagnostic) => diagnostic.code === "convergence-warning")).toBe(true);
  });

  it("fails explicitly when the convergence budget is exceeded", () => {
    const { project, reachableFiles } = createProjectContext("returned-object-basic");
    const baseline = buildTrackedObjects(project, reachableFiles);
    const guardLimit = baseline.runtimeSummary.convergence.passes - 1;

    expect(baseline.runtimeSummary.convergence.passes).toBeGreaterThan(1);
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
});
