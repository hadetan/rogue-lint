import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getAnalysisCapabilityLedger } from "../src/engine/capabilities/providers.js";
import { analyzeProject } from "../src/index.js";

function normalizeAudit(entry: { category?: string; kind: string; name: string; location?: { file: string; line: number } }): string {
  return `${entry.category ?? "-"}:${entry.kind}:${entry.location?.file ?? "-"}:${entry.location?.line ?? 0}:${entry.name}`;
}

function normalizeFinding(entry: { kind: string; entity: { name: string; location?: { file: string; line: number } } }): string {
  return `-:${entry.kind}:${entry.entity.location?.file ?? "-"}:${entry.entity.location?.line ?? 0}:${entry.entity.name}`;
}

function getCapabilityCoverageGapDiagnostics(result: { diagnostics: Array<{ message: string }> }): Array<{ message: string }> {
  return result.diagnostics.filter((diagnostic) => diagnostic.message.includes("capability coverage gap"));
}

const EXPECTED_SELF_HOST_FINDINGS: string[] = [];
const EXPECTED_SELF_HOST_SKIPS: string[] = [];
const SELF_HOST_TIMEOUT_MS = 20000;

let selfHostLibraryResultPromise: ReturnType<typeof analyzeProject> | undefined;

function getSelfHostLibraryResult() {
  selfHostLibraryResultPromise ??= analyzeProject({
    cwd: process.cwd(),
    targetPath: process.cwd(),
    format: "json",
    mode: "library",
  });

  return selfHostLibraryResultPromise;
}

describe("rogue-lint self-host analyzer", () => {
  it("does not surface helper bookkeeping residuals during self-host analysis", async () => {
    const result = await getSelfHostLibraryResult();

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.location.file === "src/engine/tracking/object-paths/visitor.ts"
      && [120, 637].includes(finding.entity.location.line)
      && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.location.file === "src/engine/tracking/semantics.ts"
      && finding.entity.location.line === 193
      && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.location.file === "src/benchmark/run-benchmark.ts"
      && finding.entity.location.line === 104
      && finding.entity.name === "format"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.category === "array-callback-escape"
      && entry.location?.file === "src/engine/tracking/semantics.ts"
      && entry.location.line === 834
      && entry.name === "getExactHelperReadPaths()"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.category === "returned-object"
      && ((entry.location?.file === "src/engine/tracking/graph.ts" && entry.location.line === 269)
        || (entry.location?.file === "src/engine/tracking/semantics.ts" && entry.location.line === 198))
      && entry.name === "[0]"
    )).toBe(false);
  }, SELF_HOST_TIMEOUT_MS);

  it("keeps the self-host surface clean while preserving bounded tracking analysis", async () => {
    const result = await getSelfHostLibraryResult();

    expect(result.diagnostics).toHaveLength(0);
    expect(getCapabilityCoverageGapDiagnostics(result)).toHaveLength(0);
    expect(result.summary.findings).toBe(EXPECTED_SELF_HOST_FINDINGS.length);
    expect(result.summary.skipped).toBe(EXPECTED_SELF_HOST_SKIPS.length);
    expect(result.summary.reachableFiles).toBe(result.summary.filesAnalyzed);
    expect(result.findings.map(normalizeFinding).sort()).toEqual(EXPECTED_SELF_HOST_FINDINGS);
    expect(result.skipped.map(normalizeAudit).sort()).toEqual(EXPECTED_SELF_HOST_SKIPS);
  }, SELF_HOST_TIMEOUT_MS);

  it("keeps self-host CLI json mode free of tracking-graph-build guard diagnostics", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli([".", "--mode", "library", "--json"], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });
    const result = JSON.parse(stdout.join("").trim()) as Awaited<ReturnType<typeof getSelfHostLibraryResult>>;

    expect(stderr.join("")).toBe("");
    expect(exitCode).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
  }, SELF_HOST_TIMEOUT_MS);

  it("keeps helper and finite capability boundary debt out of the normalized self-host surface", async () => {
    const result = await getSelfHostLibraryResult();
    const ledger = getAnalysisCapabilityLedger(result);

    expect(
      ledger?.boundaries.filter((entry) =>
        entry.capabilityId === "helper-transport" || entry.capabilityId === "finite-keyed-access"
      ) ?? [],
    ).toHaveLength(0);
    expect(
      ledger?.attributions.filter((entry) =>
        entry.capabilityId === "helper-transport" || entry.capabilityId === "finite-keyed-access"
      ) ?? [],
    ).toHaveLength(0);
  }, SELF_HOST_TIMEOUT_MS);
});
