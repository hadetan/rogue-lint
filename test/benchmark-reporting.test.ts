import { describe, expect, it } from "vitest";

import { evaluateBenchmarkExpectations } from "../src/benchmark/evaluate.js";
import { renderBenchmarkReport } from "../src/benchmark/reporting.js";
import { attachAnalysisCapabilityLedger } from "../src/engine/capabilities/providers.js";
import {
  createDiagnosticCapabilityRecordId,
  createEmptyAnalysisCapabilityLedger,
} from "../src/engine/capabilities/types.js";
import type {
  AnalysisResult,
  AuditRecord,
  DiagnosticRecord,
  FindingKind,
  FindingRecord,
} from "../src/types.js";
import type { AnalyzedBenchmarkTarget, BenchmarkTargetManifest, BenchmarkWorkspaceRun } from "../src/benchmark/types.js";

function createFinding(kind: FindingKind, name: string, file: string, id = `${kind}:${name}`): FindingRecord {
  return {
    id,
    kind,
    message: `${kind} ${name}`,
    entity: {
      id: `${id}:entity`,
      kind: kind === "unused-export" ? "export" : "local",
      name,
      location: {
        file,
        line: 1,
        column: 1,
      },
    },
    reason: `${name} is unused`,
    suggestion: "remove",
  };
}

function createDiagnostic(kind: DiagnosticRecord["kind"], message: string): DiagnosticRecord {
  return { kind, message };
}

function createAnalysisResult(findings: FindingRecord[], skips: AuditRecord[], diagnostics: DiagnosticRecord[]): AnalysisResult {
  const byKind: AnalysisResult["summary"]["byKind"] = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  }

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
      byKind,
    },
    findings,
    kept: [],
    skipped: skips,
    diagnostics,
  };
}

function createManifest(id: string, coverageClass: BenchmarkTargetManifest["coverageClass"]): BenchmarkTargetManifest {
  return {
    id,
    description: `${id} target`,
    coverageClass,
    repository: {
      url: "https://github.com/example/example-repo",
      ref: "main",
    },
    localCorpusPath: `benchmark/corpus/${id}`,
    config: {},
    expectations: {
      mustFind: [],
      mustNotFind: [],
      mustSkip: [],
      mustNotSkip: [],
      mustDiagnose: [],
      mustNotDiagnose: [],
      acceptedFindings: [],
      knownSkips: [],
    },
  };
}

function createAnalyzedTarget(
  id: string,
  coverageClass: BenchmarkTargetManifest["coverageClass"],
  findings: FindingRecord[],
  skips: AuditRecord[],
  diagnostics: DiagnosticRecord[],
  expectations: BenchmarkTargetManifest["expectations"],
  result = createAnalysisResult(findings, skips, diagnostics),
): AnalyzedBenchmarkTarget {
  const manifest = createManifest(id, coverageClass);
  manifest.expectations = expectations;
  const evaluation = evaluateBenchmarkExpectations(result, expectations);

  return {
    state: "analyzed",
    manifest,
    corpusPath: `/tmp/${id}`,
    targetPath: `/tmp/${id}`,
    result,
    evaluation,
    exitCode: evaluation.failed ? 1 : 0,
  };
}

function createWorkspaceRun(targets: AnalyzedBenchmarkTarget[]): BenchmarkWorkspaceRun {
  return {
    docsPath: "benchmark/README.md",
    exitCode: targets.some((target) => target.exitCode === 1) ? 1 : 0,
    manifests: targets.map((target) => target.manifest),
    noCorpusInstalled: false,
    targets,
  };
}

describe("benchmark reporting", () => {
  it("renders incomplete contracts with coverage metadata", () => {
    const target = createAnalyzedTarget(
      "incomplete-target",
      "library-public-surface",
      [createFinding("unused-local", "value", "src/example.ts")],
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

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("Coverage class: library-public-surface");
    expect(report).toContain("Status: INCOMPLETE");
    expect(report).toContain("Incomplete Benchmark Contract:");
  });

  it("prioritizes unexpected items above accepted debt and points back to raw detail", () => {
    const target = createAnalyzedTarget(
      "priority-target",
      "library-public-surface",
      [
        createFinding("unused-export", "unexpectedExport", "src/constant.ts"),
        createFinding("unused-local", "acceptedLocal", "src/index.ts"),
      ],
      [],
      [createDiagnostic("project-warning", "diagnostic anchor")],
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
            file: "src/index.ts",
            maxCount: 1,
          },
        ],
        knownSkips: [],
      },
    );

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("Prioritized Engine Gap Worklist:");
    expect(report).toContain(
      "See per-target Accepted Findings, Known Skips, and Unexpected sections below for raw records.",
    );
    expect(report.indexOf("unexpected finding unused-export")).toBeLessThan(
      report.indexOf("accepted finding unused-local"),
    );
  });

  it("reuses concise grouped analysis detail inside the benchmark report", () => {
    const target = createAnalyzedTarget(
      "detail-target",
      "library-public-surface",
      [createFinding("unused-local", "value", "src/example.ts")],
      [],
      [],
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

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("Analysis Detail:");
    expect(report).toContain("unused-local\n  src/example.ts\n    1:1 value - value is unused");
    expect(report).not.toContain("unused-local                  src/example.ts:1:1 value - value is unused");
  });

  it("labels coarse accepted debt anchors in the report", () => {
    const target = createAnalyzedTarget(
      "coarse-target",
      "workspace-monorepo-subproject",
      [
        createFinding("unused-export", "requiredExport", "src/required.ts"),
        createFinding("unused-local", "acceptedLocal", "src/index.ts"),
      ],
      [],
      [],
      {
        mustFind: [
          {
            label: "required export anchor",
            kind: "unused-export",
            file: "src/required.ts",
            name: "requiredExport",
            minCount: 1,
            maxCount: 1,
          },
        ],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [],
        mustDiagnose: [],
        mustNotDiagnose: [],
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/index.ts",
            maxCount: 1,
          },
        ],
        knownSkips: [],
      },
    );

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("Coarse accepted and known matchers are labeled as 'coarse matcher: same-file churn is surfaced only in the raw records below'.");
    expect(report).toContain("accepted local debt [coarse matcher: same-file churn is surfaced only in the raw records below]");
  });

  it("renders must-not-skip violations explicitly", () => {
    const target = createAnalyzedTarget(
      "must-not-skip-target",
      "library-public-surface",
      [],
      [
        {
          id: "skip-1",
          kind: "object-key",
          name: "value",
          reason: "computed property access prevents exact path analysis",
          category: "computed-property-access",
          location: {
            file: "src/example.ts",
            line: 1,
            column: 1,
          },
        },
      ],
      [],
      {
        mustFind: [],
        mustNotFind: [],
        mustSkip: [],
        mustNotSkip: [
          {
            label: "forbidden computed-property skip",
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

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("must-not-skip clean: 0/1");
    expect(report).toContain("Must-Not-Skip Violations:");
    expect(report).toContain("forbidden computed-property skip");
  });

  it("does not surface required skip anchors as gap worklist debt", () => {
    const skip: AuditRecord = {
      id: "skip-1",
      kind: "object-key",
      name: "value",
      reason: "computed property access prevents exact path analysis",
      category: "computed-property-access",
      location: {
        file: "src/example.ts",
        line: 1,
        column: 1,
      },
    };
    const result = createAnalysisResult([], [skip], []);
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [skip.id, "finite-keyed-access"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const target = createAnalyzedTarget(
      "required-skip-target",
      "library-public-surface",
      [],
      [skip],
      [],
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
      result,
    );

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("must-skip matched: 1/1");
    expect(report).not.toContain("Current Engine Gap Signal (Skip Categories):");
    expect(report).not.toContain("Current Capability Gap Signal:");
    expect(report).not.toContain("Prioritized Engine Gap Worklist:");
    expect(report).not.toContain("Prioritized Capability Worklist:");
  });

  it("surfaces unexpected capability coverage diagnostics in the workspace gap worklist", () => {
    const target = createAnalyzedTarget(
      "diagnostic-priority-target",
      "library-public-surface",
      [createFinding("unused-local", "acceptedLocal", "src/index.ts")],
      [],
      [
        createDiagnostic("project-warning", "diagnostic anchor"),
        createDiagnostic(
          "project-warning",
          "capability coverage gap (returned-contract-member): object-key hidden never resolved to finding, kept, skipped, or live",
        ),
      ],
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
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/index.ts",
            maxCount: 1,
          },
        ],
        knownSkips: [],
      },
    );

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("unexpected diagnostic capability coverage gap (returned-contract-member)");
    expect(report.indexOf("unexpected diagnostic capability coverage gap (returned-contract-member)")).toBeLessThan(
      report.indexOf("accepted finding unused-local"),
    );
    expect(report).toContain("Unexpected Diagnostics:");
  });

  it("renders capability-first worklists beside the raw benchmark worklist", () => {
    const finding = createFinding("unused-local", "acceptedLocal", "src/index.ts");
    const skip: AuditRecord = {
      id: "skip-1",
      kind: "object-key",
      name: "value",
      reason: "computed property access prevents exact path analysis",
      category: "computed-property-access",
      location: {
        file: "src/example.ts",
        line: 1,
        column: 1,
      },
    };
    const capabilityDiagnostic = createDiagnostic(
      "project-warning",
      "capability coverage gap (returned-contract-member): object-key hidden never resolved to finding, kept, skipped, or live",
    );
    const result = createAnalysisResult(
      [finding],
      [skip],
      [createDiagnostic("project-warning", "diagnostic anchor"), capabilityDiagnostic],
    );
    const capabilityLedger = createEmptyAnalysisCapabilityLedger();
    capabilityLedger.recordCapabilityById = new Map([
      [finding.id, "finite-keyed-access"],
      [skip.id, "finite-keyed-access"],
      [createDiagnosticCapabilityRecordId(capabilityDiagnostic), "returned-structure-transport"],
    ]);
    attachAnalysisCapabilityLedger(result, capabilityLedger);

    const target = createAnalyzedTarget(
      "capability-priority-target",
      "library-public-surface",
      [finding],
      [skip],
      [createDiagnostic("project-warning", "diagnostic anchor"), capabilityDiagnostic],
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
        acceptedFindings: [
          {
            label: "accepted local debt",
            kind: "unused-local",
            file: "src/index.ts",
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
      },
      result,
    );

    const report = renderBenchmarkReport(createWorkspaceRun([target]));

    expect(report).toContain("Prioritized Capability Worklist:");
    expect(report).toContain("capability finite-keyed-access: 2 records across 1 target");
    expect(report).toContain("capability returned-structure-transport: 1 record across 1 target");
    expect(report).toContain("Current Capability Gap Signal:");
    expect(report).toContain("finite-keyed-access: 2 (computed-property-access: 1, unused-local: 1)");
    expect(report).toContain("Prioritized Engine Gap Worklist:");
  });
});
