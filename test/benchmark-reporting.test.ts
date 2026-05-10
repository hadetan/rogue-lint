import { describe, expect, it } from "vitest";

import { evaluateBenchmarkExpectations } from "../src/benchmark/evaluate.js";
import { renderBenchmarkReport } from "../src/benchmark/reporting.js";
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
): AnalyzedBenchmarkTarget {
  const manifest = createManifest(id, coverageClass);
  manifest.expectations = expectations;
  const result = createAnalysisResult(findings, skips, diagnostics);
  const evaluation = evaluateBenchmarkExpectations(findings, skips, diagnostics, expectations);

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
});
