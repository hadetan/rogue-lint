import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderBenchmarkReport } from "../src/benchmark/reporting.js";
import { runWorkspaceBenchmark } from "../src/benchmark/run-benchmark.js";

const tempWorkspaces: string[] = [];

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

function createWorkspace(manifest: Record<string, unknown>): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-lint-benchmark-"));
  tempWorkspaces.push(workspaceRoot);

  fs.mkdirSync(path.join(workspaceRoot, "benchmark", "suites", "real-world"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "benchmark", "README.md"), "# Benchmark\n");
  fs.writeFileSync(
    path.join(workspaceRoot, "benchmark", "suites", "real-world", "target.json"),
    JSON.stringify(manifest, null, 2),
  );

  return workspaceRoot;
}

afterEach(() => {
  while (tempWorkspaces.length > 0) {
    const workspaceRoot = tempWorkspaces.pop();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
});

describe("benchmark harness", () => {
  it(
    "reports missing corpora without failing the command",
    async () => {
      const workspaceRoot = createWorkspace({
        id: "missing-corpus",
        description: "Missing corpus target",
        coverageClass: "library-public-surface",
        repository: {
          url: "https://github.com/example/example-repo",
          ref: "main",
        },
        localCorpusPath: "benchmark/corpus/does-not-exist",
        expectations: {},
      });

      const result = await runWorkspaceBenchmark(workspaceRoot);

      expect(result.noCorpusInstalled).toBe(true);
      expect(result.exitCode).toBe(0);

      const report = renderBenchmarkReport(result);
      expect(report).toContain("No benchmark corpus is installed locally.");
      expect(report).toContain("benchmark/README.md");
      expect(report).toContain("missing-corpus");
    },
    15000,
  );

  it(
    "treats zero-analyzed-file targets as explicit benchmark problems",
    async () => {
      const workspaceRoot = createWorkspace({
        id: "project-reference-root",
        description: "Project reference root",
        coverageClass: "workspace-monorepo-subproject",
        repository: {
          url: "https://github.com/example/example-repo",
          ref: "main",
        },
        localCorpusPath: path.join(process.cwd(), "__references", "get-shit-done"),
        expectations: {},
      });

      const result = await runWorkspaceBenchmark(workspaceRoot);

      expect(result.noCorpusInstalled).toBe(false);
      expect(result.exitCode).toBe(1);

      const report = renderBenchmarkReport(result);
      expect(report).toContain("Invalid Benchmark Targets:");
      expect(report).toContain("project-reference-root");
      expect(report).toContain("zero analyzed files");
    },
    15000,
  );

  it(
    "reports accepted capability debt, unexpected items, and full analysis detail",
    async () => {
      const workspaceRoot = createWorkspace({
        id: "fixture-target",
        description: "Fixture-backed scoring check",
        coverageClass: "application-entrypoint-driven",
        repository: {
          url: "https://github.com/example/example-repo",
          ref: "main",
        },
        localCorpusPath: fixturePath("app-basic"),
        expectations: {
          mustFind: [
            {
              label: "unused export is still detected",
              kind: "unused-export",
              name: "unusedExport",
            },
          ],
          mustNotFind: [
            {
              label: "live object key must stay live",
              kind: "unused-object-key",
              name: "live",
            },
          ],
          mustSkip: [],
          mustDiagnose: [],
          mustNotDiagnose: [],
          acceptedFindings: [
            {
              label: "accepted local deadness debt",
              kind: "unused-local",
              name: "unusedLocal",
            },
          ],
          knownSkips: [],
        },
      });

      const result = await runWorkspaceBenchmark(workspaceRoot);

      expect(result.exitCode).toBe(1);

      const analyzed = result.targets.find((target) => target.state === "analyzed");
      expect(analyzed?.state).toBe("analyzed");
      if (analyzed?.state !== "analyzed") {
        throw new Error("Expected analyzed benchmark target");
      }

      expect(analyzed.evaluation.accepted.findings.present).toHaveLength(1);
      expect(analyzed.evaluation.unexpected.findings.length).toBeGreaterThan(0);
      expect(analyzed.evaluation.required.mustFind.matched).toHaveLength(1);

      const report = renderBenchmarkReport(result);
      expect(report).toContain("Accepted Capability Debt:");
      expect(report).toContain("accepted local deadness debt");
      expect(report).toContain("Unexpected Findings:");
      expect(report).toContain("Analysis Detail:");
      expect(report).toContain("Findings:");
      expect(report).toContain("Skipped:");
    },
    15000,
  );
});
