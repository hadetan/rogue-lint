import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeProject } from "../src/index.js";
import type { AnalysisArtifacts } from "../src/engine/analysis-artifacts.js";
import {
  addFinding,
  appendProviderObligationDiagnostics,
  createAnalysisState,
  registerCapabilityObligation,
  resolveCapabilityObligation,
} from "../src/engine/analysis-state.js";
import {
  collectAnalysisCapabilityLedger,
  getAnalysisCapabilityLedger,
} from "../src/engine/capabilities/providers.js";
import { assembleProviderBackedReportSurface } from "../src/engine/capabilities/report-assembly.js";
import { createDiagnosticCapabilityRecordId } from "../src/engine/capabilities/types.js";
import type { EntityRecord, ProjectContext } from "../src/types.js";

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

function createCandidateEntity(name: string): EntityRecord {
  return {
    id: `entity:${name}`,
    kind: "object-key",
    name,
    owner: "publicCarrier()",
    location: {
      file: "src/example.ts",
      line: 1,
      column: 1,
    },
  };
}

describe("analysis capability providers", () => {
  it("deduplicates provider-backed unresolved coverage diagnostics during report assembly", () => {
    const state = createAnalysisState();

    registerCapabilityObligation(
      state,
      "returned-contract-member",
      createCandidateEntity("hidden"),
      "returned-structure-transport",
    );
    appendProviderObligationDiagnostics(state);
    state.diagnostics.push({ ...state.diagnostics[0]! });

    const ledger = collectAnalysisCapabilityLedger(
      {} as ProjectContext,
      state,
      {} as AnalysisArtifacts,
    );
    const surface = assembleProviderBackedReportSurface(state, ledger, []);

    expect(surface.diagnostics).toHaveLength(1);
    expect(ledger.recordCapabilityById.get(createDiagnosticCapabilityRecordId(surface.diagnostics[0]!))).toBe(
      "returned-structure-transport",
    );
  });

  it("maps returned-structure transport findings for resolved candidates", () => {
    const state = createAnalysisState();
    const entity = createCandidateEntity("hidden");

    registerCapabilityObligation(
      state,
      "returned-contract-member",
      entity,
      "returned-structure-transport",
    );
    addFinding(
      state,
      entity,
      "unused-object-key",
      "eligible object path is declared or written but never read",
      "Unused object path publicCarrier().hidden",
    );
    resolveCapabilityObligation(
      state,
      "returned-contract-member",
      entity,
      "finding",
      "returned-structure-transport",
    );

    const ledger = collectAnalysisCapabilityLedger(
      {} as ProjectContext,
      state,
      {} as AnalysisArtifacts,
    );

    expect(ledger.recordCapabilityById.get(entity.id)).toBe("returned-structure-transport");
    expect(ledger.evidences).toContainEqual(
      expect.objectContaining({
        capabilityId: "returned-structure-transport",
        source: "finding",
        recordId: entity.id,
      }),
    );
  });

  it("prefers summary-backed detail labels for provider-owned skipped boundaries", async () => {
    const arrayResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("array-basic"),
      format: "json",
    });
    const arrayLedger = getAnalysisCapabilityLedger(arrayResult);
    const finiteKeyedSkip = arrayResult.skipped.find((entry) => entry.category === "dynamic-array-index");

    expect(finiteKeyedSkip).toBeDefined();
    expect(arrayLedger?.recordDetailById.get(finiteKeyedSkip!.id)).toBe("dynamic index boundary");

    const helperResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("collection-state-basic"),
      format: "json",
    });
    const helperLedger = getAnalysisCapabilityLedger(helperResult);
    const helperSkip = helperResult.skipped.find((entry) => entry.category === "array-opaque-mutation");

    expect(helperSkip).toBeDefined();
    expect(helperLedger?.recordDetailById.get(helperSkip!.id)).toBe("opaque helper mutation boundary");
  });

  it("emits fallback boundary detail labels when no summary model matches", () => {
    const state = createAnalysisState();

    registerCapabilityObligation(
      state,
      "returned-contract-member",
      createCandidateEntity("hidden"),
      "returned-structure-transport",
    );
    appendProviderObligationDiagnostics(state);

    const ledger = collectAnalysisCapabilityLedger(
      {} as ProjectContext,
      state,
      {
        getTrackingStageArtifacts: () => ({
          stage: "value-liveness",
          returnSummaries: { owner: "return-summary-convergence", byCallableId: new Map() },
          runtimeSummary: {
            seed: { reachableFileCount: 0, reachableSourceFileCount: 0 },
            convergence: { passes: 0, warningPassThreshold: 0, maxPasses: 0, warned: false },
            totals: { trackedBindings: 0, returnSummaries: 0, trackedObjects: 0 },
            stageRequests: { "value-liveness": 0, "object-paths": 0 },
          },
        }),
      } as AnalysisArtifacts,
    );

    expect(ledger.recordDetailById.get(createDiagnosticCapabilityRecordId(state.diagnostics[0]!))).toBe(
      "returned transport summary fallback",
    );
  });

  it("maps public-surface aliasing keeps on analyzed results", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-interface-consumer-tiers-basic"),
      format: "json",
      mode: "library",
    });
    const ledger = getAnalysisCapabilityLedger(result);
    const kept = result.kept.find((entry) => entry.kind === "interface-member" && entry.name === "preserved");

    expect(kept).toBeDefined();
    expect(ledger?.recordCapabilityById.get(kept!.id)).toBe("library-public-surface-aliasing");
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("capability coverage gap"))).toBe(false);
  });

  it("maps conservative skipped boundaries to finite-keyed and helper transport capabilities", async () => {
    const arrayResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("array-basic"),
      format: "json",
    });
    const arrayLedger = getAnalysisCapabilityLedger(arrayResult);
    const finiteKeyedSkip = arrayResult.skipped.find((entry) => entry.category === "dynamic-array-index");

    expect(finiteKeyedSkip).toBeDefined();
    expect(arrayLedger?.recordCapabilityById.get(finiteKeyedSkip!.id)).toBe("finite-keyed-access");

    const helperResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("collection-state-basic"),
      format: "json",
    });
    const helperLedger = getAnalysisCapabilityLedger(helperResult);
    const helperSkip = helperResult.skipped.find((entry) => entry.category === "array-opaque-mutation");

    expect(helperSkip).toBeDefined();
    expect(helperLedger?.recordCapabilityById.get(helperSkip!.id)).toBe("helper-transport");
  });

  it("records supported helper transport facts for exact same-project helper flows", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-readonly-basic"),
      format: "json",
    });
    const ledger = getAnalysisCapabilityLedger(result);

    expect(ledger?.evidences).toContainEqual(
      expect.objectContaining({
        capabilityId: "helper-transport",
        source: "fact",
        label: "same-project helper transport",
      }),
    );
  });

  it("prefers retained-storage helper fact labels over generic helper boundary labels", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-storage-basic"),
      format: "json",
    });
    const ledger = getAnalysisCapabilityLedger(result);
    const helperSkip = result.skipped.find((entry) => entry.category === "array-opaque-mutation");

    expect(helperSkip).toBeDefined();
    expect(ledger?.recordDetailById.get(helperSkip!.id)).toBe("same-project helper retained storage");
  });

  it("records bounded finite-key facts for exact finite lookup reads", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("finite-union-keyed-access-basic"),
      format: "json",
    });
    const ledger = getAnalysisCapabilityLedger(result);

    expect(ledger?.evidences).toContainEqual(
      expect.objectContaining({
        capabilityId: "finite-keyed-access",
        source: "fact",
        label: "bounded finite key read",
      }),
    );
  });
});
