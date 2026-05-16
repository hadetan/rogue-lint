import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAnalysisArtifacts } from "../src/engine/analysis-artifacts.js";
import {
  createAnalysisRunState,
  getAnalysisRunResultMetadata,
} from "../src/engine/analysis-run-state.js";
import {
  createAnalysisState,
  getCapabilityFacts,
  registerCapabilityFact,
} from "../src/engine/analysis-state.js";
import { collectPublicSurface } from "../src/engine/analyzers/support.js";
import { attachAnalysisCapabilityLedger } from "../src/engine/capabilities/providers.js";
import { createEmptyAnalysisCapabilityLedger } from "../src/engine/capabilities/types.js";
import { attachTrackingRuntimeSummary } from "../src/engine/tracking/upgrade-safety.js";
import { buildModuleGraph, computeReachableFiles, discoverEntrypoints } from "../src/module-graph.js";
import { loadProject } from "../src/project.js";
import type { AnalysisResult, EntityRecord } from "../src/types.js";
import type { TrackingRuntimeSummary } from "../src/engine/tracking/contracts.js";

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

function createCandidateEntity(name: string): EntityRecord {
  return {
    id: `entity:${name}`,
    kind: "object-key",
    name,
    owner: "carrier()",
    location: {
      file: "src/example.ts",
      line: 1,
      column: 1,
    },
  };
}

function createResult(): AnalysisResult {
  return {
    tool: "rogue-lint",
    version: "test",
    target: "/tmp/project",
    mode: "library",
    exitCodes: {
      findings: 1,
      failure: 2,
    },
    generatedAt: new Date(0).toISOString(),
    summary: {
      filesAnalyzed: 1,
      reachableFiles: 1,
      findings: 0,
      kept: 0,
      skipped: 0,
      byKind: {},
    },
    findings: [],
    kept: [],
    skipped: [],
    diagnostics: [],
  };
}

function createTrackingRuntimeSummary(): TrackingRuntimeSummary {
  return {
    seed: {
      reachableFileCount: 1,
      reachableSourceFileCount: 1,
    },
    convergence: {
      passes: 1,
      warningPassThreshold: 4,
      maxPasses: 10,
      warned: false,
      elapsedMs: 5,
      churn: {
        bindingChanges: 1,
        bindingChangedPasses: 1,
        returnSummaryChanges: 1,
        returnSummaryChangedPasses: 1,
      },
      widening: {
        bindingChanges: 0,
        returnSummaryChanges: 0,
        reasons: {
          bindings: [],
          returnSummaries: [],
        },
      },
      unstableSamples: {
        bindings: [],
        returnSummaries: [],
      },
    },
    totals: {
      trackedBindings: 1,
      returnSummaries: 1,
      trackedObjects: 1,
    },
    stageRequests: {
      "value-liveness": 0,
      "object-paths": 0,
    },
  };
}

describe("analysis run state", () => {
  it("stores capability facts on the explicit run-owned state surface", () => {
    const runState = createAnalysisRunState();
    const state = createAnalysisState(runState);
    const entity = createCandidateEntity("hidden");

    registerCapabilityFact(state, "helper-transport", entity, "helper-transport", "live", {
      detailHint: "same-project helper transport",
    });

    expect(getCapabilityFacts(state)).toHaveLength(1);
    expect([...runState.capabilityFacts.values()]).toContainEqual(
      expect.objectContaining({
        entity,
        capabilityId: "helper-transport",
      }),
    );
  });

  it("threads analysis artifact caches through the explicit run-owned state surface", () => {
    const { project, reachableFiles, publicSurfaceIds, publicCallableIds } = createProjectContext("array-basic");
    const runState = createAnalysisRunState();
    const artifacts = createAnalysisArtifacts(
      project,
      reachableFiles,
      publicSurfaceIds,
      publicCallableIds,
      undefined,
      runState,
    );
    const sourceFile = project.sourceFiles[0]!;

    artifacts.getSemanticDiagnostics(sourceFile);
    artifacts.getTrackingRunArtifacts();

    expect(runState.semanticDiagnosticsByFile.get(sourceFile.fileName)).toBeDefined();
    expect(runState.trackingArtifacts).toBeDefined();
    expect(artifacts.referenceCaches).toBe(runState.referenceCaches);
  });

  it("attaches internal result metadata through explicit adapters without changing public serialization", () => {
    const result = createResult();
    const publicKeys = Object.keys(result);
    const publicJson = JSON.stringify(result);
    const ledger = createEmptyAnalysisCapabilityLedger();
    const runtimeSummary = createTrackingRuntimeSummary();

    attachAnalysisCapabilityLedger(result, ledger);
    attachTrackingRuntimeSummary(result, runtimeSummary);

    expect(getAnalysisRunResultMetadata(result)).toEqual({
      capabilityLedger: ledger,
      trackingRuntimeSummary: runtimeSummary,
    });
    expect(Object.keys(result)).toEqual(publicKeys);
    expect(JSON.stringify(result)).toBe(publicJson);
  });
});