import { describe, expect, it } from "vitest";

import { evaluateBenchmarkExpectations } from "../src/benchmark/evaluate.js";
import type { AuditRecord, DiagnosticRecord, FindingRecord } from "../src/types.js";

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

describe("benchmark expectation evaluation", () => {
  it("marks targets with no required anchors as incomplete contracts", () => {
    const evaluation = evaluateBenchmarkExpectations(
      [createFinding()],
      [],
      [],
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
      [createFinding()],
      [createSkip()],
      [createDiagnostic()],
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
      [createFinding()],
      [],
      [],
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
      [],
      [createSkip()],
      [],
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
});
