import { describe, expect, it } from "vitest";

import { evaluateBenchmarkExpectations } from "../src/benchmark/evaluate.js";
import { attachAnalysisCapabilityLedger } from "../src/engine/capabilities/providers.js";
import {
  createDiagnosticCapabilityRecordId,
  createEmptyAnalysisCapabilityLedger,
} from "../src/engine/capabilities/types.js";
import type { AnalysisResult, AuditRecord, DiagnosticRecord, FindingRecord } from "../src/types.js";

function createFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: overrides.id ?? "finding-1",
    kind: overrides.kind ?? "unused-local",
    message: overrides.message ?? "unused local",
    entity: overrides.entity ?? {
      id: "entity-1",
      kind: "local",
      name: "value",
      location: {
        file: "src/example.ts",
        line: 1,
        column: 1,
      },
    },
    reason: overrides.reason ?? "declared but never read",
    suggestion: overrides.suggestion ?? "remove",
  };
}

function createSkip(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: overrides.id ?? "skip-1",
    kind: overrides.kind ?? "object-key",
    name: overrides.name ?? "value",
    owner: overrides.owner,
    reason: overrides.reason ?? "computed property access is not modeled exactly",
    category: overrides.category ?? "computed-property-access",
    location: overrides.location ?? {
      file: "src/example.ts",
      line: 1,
      column: 1,
    },
  };
}

function createDiagnostic(overrides: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return {
    kind: overrides.kind ?? "project-warning",
    message: overrides.message ?? "anchor diagnostic",
    file: overrides.file,
  };
}

function createAnalysisResult(
  findings: FindingRecord[],
  skips: AuditRecord[],
  diagnostics: DiagnosticRecord[],
): AnalysisResult {
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
      findings: findings.length,
      kept: 0,
      skipped: skips.length,
      byKind: {},
    },
    findings,
    kept: [],
    skipped: skips,
    diagnostics,
  };
}

describe("benchmark expectation evaluation", () => {
  it("marks targets with no required anchors as incomplete contracts", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult([createFinding()], [], []),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/example.ts",
            maxCount: 1,
          },
        ],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.requiredAnchorTotal).toBe(0);
    expect(evaluation.contract.incomplete).toBe(true);
    expect(evaluation.failed).toBe(true);
  });

  it("fails accepted finding debt that grows beyond its configured bound", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult(
        [
          createFinding(),
          createFinding({
            id: "finding-2",
            entity: {
              id: "entity-2",
              kind: "local",
              name: "otherValue",
              location: {
                file: "src/example.ts",
                line: 2,
                column: 1,
              },
            },
          }),
        ],
        [],
        [createDiagnostic()],
      ),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [
          {
            label: "diagnostic anchor",
            kind: "project-warning",
          },
        ],
        mustNotDiagnose: [],
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/example.ts",
            maxCount: 1,
          },
        ],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.incomplete).toBe(false);
    expect(evaluation.accepted.findings.regressions).toHaveLength(1);
    expect(evaluation.accepted.findings.regressions[0]?.actualCount).toBe(2);
    expect(evaluation.failed).toBe(true);
  });

  it("reports accepted debt shrinkage as an improvement without failing", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult([createFinding()], [createSkip()], [createDiagnostic()]),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [
          {
            label: "diagnostic anchor",
            kind: "project-warning",
          },
        ],
        mustNotDiagnose: [],
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/example.ts",
            maxCount: 2,
          },
        ],
        knownSkips: [
          {
            label: "accepted skip debt",
            category: "computed-property-access",
            file: "src/example.ts",
            maxCount: 2,
          },
        ],
      },
    );

    expect(evaluation.accepted.findings.reduced).toHaveLength(1);
    expect(evaluation.accepted.skips.reduced).toHaveLength(1);
    expect(evaluation.accepted.findings.regressions).toHaveLength(0);
    expect(evaluation.accepted.skips.regressions).toHaveLength(0);
    expect(evaluation.failed).toBe(false);
  });

  it("supports count-aware required expectations", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult([createFinding()], [], []),
      {
        mustFind: [
          {
            label: "two locals are required",
            kind: "unused-local",
            file: "src/example.ts",
            minCount: 2,
          },
        ],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.incomplete).toBe(false);
    expect(evaluation.required.mustFind.missing).toHaveLength(1);
    expect(evaluation.failed).toBe(true);
  });

  it("fails negative skip anchors when a forbidden conservative skip is still present", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult([], [createSkip()], []),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [
          {
            label: "computed property skip must be gone",
            category: "computed-property-access",
            file: "src/example.ts",
            name: "value",
            maxCount: 0,
          },
        ],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.incomplete).toBe(false);
    expect(evaluation.required.mustNotSkip.violations).toHaveLength(1);
    expect(evaluation.required.mustNotSkip.violations[0]?.actualCount).toBe(1);
    expect(evaluation.unexpected.skips).toHaveLength(0);
    expect(evaluation.failed).toBe(true);
  });

  it("matches skip owners when negative skip anchors need owner precision", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult([], [
        createSkip({ id: "skip-1", owner: "validate()" }),
        createSkip({ id: "skip-2", owner: "handleOptionalResult" }),
      ], []),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [
          {
            label: "validate skip must be gone",
            category: "computed-property-access",
            file: "src/example.ts",
            name: "value",
            owner: "validate()",
            maxCount: 0,
          },
        ],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.required.mustNotSkip.violations).toHaveLength(1);
    expect(evaluation.required.mustNotSkip.violations[0]?.actualCount).toBe(1);
    expect(evaluation.required.mustNotSkip.violations[0]?.records).toHaveLength(1);
    expect(evaluation.required.mustNotSkip.violations[0]?.records[0]?.owner).toBe("validate()");
  });

  it("keeps required skip anchors out of gap-priority and capability-priority debt signals", () => {
    const skip = createSkip();
    const result = createAnalysisResult([], [skip], []);
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [skip.id, "finite-keyed-access"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const evaluation = evaluateBenchmarkExpectations(
      result,
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [
          {
            label: "required conservative skip",
            category: "computed-property-access",
            file: "src/example.ts",
            name: "value",
            minCount: 1,
            maxCount: 1,
          },
        ],
        mustNotSkip: [],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.incomplete).toBe(false);
    expect(evaluation.required.mustSkip.matched).toHaveLength(1);
    expect(evaluation.gapSignal.skipsByCategory).toHaveLength(0);
    expect(evaluation.gapPriority).toHaveLength(0);
    expect(evaluation.capabilityPriority).toHaveLength(0);
    expect(evaluation.failed).toBe(false);
  });

  it("prefers provider-owned record detail labels over raw skip categories in capability priority", () => {
    const skip = createSkip();
    const result = createAnalysisResult([], [skip], []);
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [skip.id, "finite-keyed-access"],
    ]);
    capabilityLedger.recordDetailById = new Map([
      [skip.id, "dynamic index boundary"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const evaluation = evaluateBenchmarkExpectations(
      result,
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.capabilityPriority).toEqual([
      {
        capabilityId: "finite-keyed-access",
        count: 1,
        details: [{ label: "dynamic index boundary", count: 1 }],
      },
    ]);
  });

  it("promotes unexpected capability coverage diagnostics into the benchmark gap worklist", () => {
    const evaluation = evaluateBenchmarkExpectations(
      createAnalysisResult(
        [],
        [],
        [
          createDiagnostic({ message: "diagnostic anchor" }),
          createDiagnostic({
            message: "capability coverage gap (returned-contract-member): object-key hidden never resolved to finding, kept, skipped, or live",
            file: "src/example.ts",
          }),
        ],
      ),
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [
          {
            label: "diagnostic anchor",
            kind: "project-warning",
            messageIncludes: "diagnostic anchor",
          },
        ],
        mustNotDiagnose: [],
        acceptedFindings: [],
        knownSkips: [],
      },
    );

    expect(evaluation.contract.incomplete).toBe(false);
    expect(evaluation.unexpected.diagnostics).toHaveLength(1);
    expect(evaluation.gapPriority).toContainEqual({
      scope: "unexpected-diagnostic",
      label: "capability coverage gap (returned-contract-member)",
      count: 1,
    });
    expect(evaluation.failed).toBe(true);
  });

  it("groups provider-attributed gap records by capability while preserving raw priorities", () => {
    const finding = createFinding();
    const skip = createSkip();
    const capabilityDiagnostic = createDiagnostic({
      message: "capability coverage gap (returned-contract-member): object-key hidden never resolved to finding, kept, skipped, or live",
      file: "src/example.ts",
    });
    const result = createAnalysisResult(
      [finding],
      [skip],
      [createDiagnostic({ message: "diagnostic anchor" }), capabilityDiagnostic],
    );
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [finding.id, "finite-keyed-access"],
      [skip.id, "finite-keyed-access"],
      [createDiagnosticCapabilityRecordId(capabilityDiagnostic), "returned-structure-transport"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const evaluation = evaluateBenchmarkExpectations(result, {
      mustFind: [],
      mustNotFind: [],
      mustSkip: [],
      mustNotSkip: [],
      mustDiagnose: [
        {
          label: "diagnostic anchor",
          kind: "project-warning",
          messageIncludes: "diagnostic anchor",
        },
      ],
      mustNotDiagnose: [],
      acceptedFindings: [
        {
          label: "accepted local debt",
          kind: "unused-local",
          file: "src/example.ts",
          maxCount: 1,
        },
      ],
      knownSkips: [
        {
          label: "accepted skip debt",
          category: "computed-property-access",
          file: "src/example.ts",
          maxCount: 1,
        },
      ],
    });

    expect(evaluation.capabilityPriority[0]?.capabilityId).toBe("finite-keyed-access");
    expect(evaluation.capabilityPriority[0]?.count).toBe(2);
    expect(evaluation.capabilityPriority[0]?.details).toEqual(
      expect.arrayContaining([
        { label: "computed-property-access", count: 1 },
        { label: "unused-local", count: 1 },
      ]),
    );
    expect(evaluation.capabilityPriority).toContainEqual({
      capabilityId: "returned-structure-transport",
      count: 1,
      details: [{ label: "capability coverage gap (returned-contract-member)", count: 1 }],
    });
    expect(evaluation.gapPriority).toContainEqual({
      scope: "unexpected-diagnostic",
      label: "capability coverage gap (returned-contract-member)",
      count: 1,
    });
  });

  it("keeps helper and finite capability priorities isolated while preserving raw skip categories", () => {
    const finiteSkip = createSkip({
      id: "skip-finite",
      category: "computed-property-access",
      reason: "computed property access is not modeled exactly",
    });
    const helperSkip = createSkip({
      id: "skip-helper",
      category: "array-opaque-mutation",
      kind: "array-element",
      name: "[0]",
      reason: "helper stores this value by reference beyond exact local analysis",
      location: {
        file: "src/helper.ts",
        line: 8,
        column: 1,
      },
    });
    const result = createAnalysisResult([], [finiteSkip, helperSkip], []);
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [finiteSkip.id, "finite-keyed-access"],
      [helperSkip.id, "helper-transport"],
    ]);
    capabilityLedger.recordDetailById = new Map([
      [finiteSkip.id, "bounded finite key read"],
      [helperSkip.id, "same-project helper retained storage"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const evaluation = evaluateBenchmarkExpectations(result, {
      mustFind: [],
      mustNotFind: [],
      mustSkip: [],
      mustNotSkip: [],
      mustDiagnose: [],
      mustNotDiagnose: [],
      acceptedFindings: [],
      knownSkips: [],
    });

    expect(evaluation.capabilityPriority).toEqual(
      expect.arrayContaining([
        {
          capabilityId: "finite-keyed-access",
          count: 1,
          details: [{ label: "bounded finite key read", count: 1 }],
        },
        {
          capabilityId: "helper-transport",
          count: 1,
          details: [{ label: "same-project helper retained storage", count: 1 }],
        },
      ]),
    );
    expect(evaluation.gapSignal.skipsByCategory).toEqual(
      expect.arrayContaining([
        ["computed-property-access", 1],
        ["array-opaque-mutation", 1],
      ]),
    );
  });
});
