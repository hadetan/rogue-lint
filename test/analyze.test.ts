import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { analyzeProject } from "../src/index.js";
import { renderResult } from "../src/reporting.js";

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

describe("dead-lint analyzer", () => {
  it("finds unused files, exports, locals, class members, and object paths in application mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-file:unused.ts");
    expect(kindsAndNames).toContain("unused-export:unusedExport");
    expect(kindsAndNames).toContain("unused-type:UnusedShape");
    expect(kindsAndNames).toContain("unused-enum-member:Blue");
    expect(kindsAndNames).toContain("unused-local:unusedLocal");
    expect(kindsAndNames).toContain("unused-class-member:unusedMethod");
    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).toContain("unused-nested-path:nested.stale");

    const keptNames = result.kept.map((entry) => entry.name);
    expect(keptNames).toContain("ignoredLocal");

    expect(result.skipped.some((entry) => entry.reason.includes("computed property access"))).toBe(true);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(true);
  });

  it("keeps public entrypoint exports live in library mode", async () => {
    const fixture = fixturePath("library-basic");
    const libraryResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      format: "json",
    });
    const applicationResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      format: "json",
      mode: "application",
    });

    expect(libraryResult.findings.some((finding) => finding.entity.name === "publicApi")).toBe(false);
    expect(libraryResult.kept.some((entry) => entry.name === "publicApi")).toBe(true);
    expect(applicationResult.findings.some((finding) => finding.entity.name === "publicApi")).toBe(true);
  });

  it("does not list cross-file referenced public exports as kept", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-referenced-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.entity.name === "publicApi")).toBe(false);
    expect(result.kept.some((entry) => entry.name === "publicApi")).toBe(false);
  });

  it("reports exports that are only used within their own file and still honors ignore comments", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("export-scope-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "localOnlyUsed")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-type" && finding.entity.name === "LocalOnlyShape")).toBe(true);
    expect(result.findings.some((finding) => finding.entity.name === "ignoredLocalOnly")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "IgnoredLocalShape")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "crossFileUsed")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "CrossFileShape")).toBe(false);

    expect(result.kept.some((entry) => entry.name === "ignoredLocalOnly" && entry.reason === "suppressed by dead-lint-ignore-next")).toBe(true);
    expect(result.kept.some((entry) => entry.name === "IgnoredLocalShape" && entry.reason === "suppressed by dead-lint-ignore-next")).toBe(true);
  });

  it("renders stable summary metadata", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
      format: "json",
      includeKinds: ["unused-export", "unused-file"],
    });

    expect(result.tool).toBe("dead-lint");
    expect(result.summary.findings).toBe(result.findings.length);
    expect(result.findings.every((finding) => ["unused-export", "unused-file"].includes(finding.kind))).toBe(true);
  });

  it("applies keep rules and external visibility declarations", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("keep-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.entity.name === "deadExport")).toBe(true);
    expect(result.findings.some((finding) => finding.entity.name === "deadMethod")).toBe(true);

    expect(result.findings.some((finding) => finding.entity.name === "keptExport")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "futureApi")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "ignored.ts")).toBe(false);
    expect(result.findings.some((finding) => finding.entity.name === "preservedMethod")).toBe(false);

    const keptNames = result.kept.map((entry) => entry.name);
    expect(keptNames).toContain("keptExport");
    expect(keptNames).toContain("futureApi");
    expect(keptNames).toContain("ignored.ts");
    expect(keptNames).toContain("preservedMethod");
  });

  it("assigns stable unique ids to similarly named findings across files", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("identity-basic"),
      format: "json",
    });

    const matching = result.findings.filter((finding) => finding.entity.name === "sameName");
    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((finding) => finding.id)).size).toBe(2);
  });

  it("handles a larger module graph fixture", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("bulk-basic"),
      format: "json",
    });

    expect(result.summary.filesAnalyzed).toBe(10);
    expect(result.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "dead.ts")).toBe(true);
  });

  it("preserves owner metadata for class members and nested object paths", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
      format: "json",
    });

    const classMember = result.findings.find((finding) => finding.entity.name === "unusedMethod");
    const nestedPath = result.findings.find((finding) => finding.entity.name === "nested.stale");

    expect(classMember?.entity.owner).toBe("Example");
    expect(nestedPath?.entity.owner).toBe("config");
  });

  it("supports analysis controls for file filters, hidden roots, and surface depth", async () => {
    const fixture = fixturePath("controls-basic");
    const excludedResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      configPath: "dead-lint.exclude.json",
      format: "json",
    });
    const hiddenRootResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      configPath: "dead-lint.hidden-roots.json",
      format: "json",
    });
    const surfaceResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      configPath: "dead-lint.surface.json",
      format: "json",
    });

    expect(excludedResult.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "onlyExcluded")).toBe(true);
    expect(excludedResult.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "excluded-consumer.ts")).toBe(false);

    expect(hiddenRootResult.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "worker.ts")).toBe(false);

    expect(surfaceResult.findings.some((finding) => finding.kind === "unused-class-member")).toBe(false);
    expect(surfaceResult.findings.some((finding) => finding.kind === "unused-object-key")).toBe(false);
    expect(surfaceResult.findings.some((finding) => finding.kind === "unused-nested-path")).toBe(false);
  });

  it("reconciles built package roots back to source entrypoints without promoting bin exports to library surface", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("package-roots-basic"),
      format: "json",
      mode: "library",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "cli.ts")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "unusedCliHelper")).toBe(true);
    expect(result.kept.some((entry) => entry.name === "unusedCliHelper")).toBe(false);
  });

  it("honors configured CLI exit codes", async () => {
    const fixture = fixturePath("controls-basic");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const findingsCode = await runCli([fixture, "--config", "dead-lint.exitcodes.json"], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });
    const failureCode = await runCli([fixture, "--config", "dead-lint.failure.json"], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });

    expect(findingsCode).toBe(7);
    expect(failureCode).toBe(9);
    expect(stderr.some((value) => value.length > 0)).toBe(true);
  });

  it("groups text output by kind and file", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
      format: "json",
    });

    const rendered = renderResult(result, "text");

    expect(rendered).toContain("Findings:");
    expect(rendered).toContain("Kept:");
    expect(rendered).toContain("unused-export");
    expect(rendered).toContain("  src/lib.ts");
    expect(rendered).not.toContain("  (unknown)");
    expect(rendered).toContain("Skipped:");
    expect(result.kept.length).toBeGreaterThan(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(rendered).toContain(result.kept[0].reason);
    expect(rendered).toContain(result.skipped[0].reason);
  });

  it("treats supported call boundaries as meaningful value use", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("value-flow-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("dead-store:count");
    expect(kindsAndNames).toContain("dead-store:helperIgnored");
    expect(kindsAndNames).toContain("unused-value:1 + 2");
    expect(kindsAndNames).toContain("write-only-state:status");
    expect(kindsAndNames).not.toContain("dead-store:helperRead");
    expect(kindsAndNames).not.toContain("dead-store:externalRead");
    expect(result.skipped).toHaveLength(0);
  });

  it("reports internal interface members and preserves safe object siblings when another branch escapes", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("deep-coverage-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-interface-member:stale");
    expect(kindsAndNames).toContain("unused-nested-path:safe.stale");
    expect(kindsAndNames).toContain("unused-nested-path:forwarded.stale");
    expect(kindsAndNames).not.toContain("unused-nested-path:safe.read");
    expect(kindsAndNames).not.toContain("unused-nested-path:forwarded.keep");
    expect(result.skipped.some((entry) => entry.name === "escaped" && entry.reason.includes("Object.keys"))).toBe(true);
    expect(result.skipped.some((entry) => entry.category === "reflective-enumeration")).toBe(true);
  });

  it("preserves returned tracked objects across supported same-project helper boundaries", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-object-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).toContain("unused-nested-path:nested.stale");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-nested-path:nested.read");
    expect(result.skipped).toHaveLength(0);
  });

  it("treats external imports as boundaries and preserves structural whole-object usage", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("self-host-hardening-basic"),
      format: "json",
    });

    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("node:path"))).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("minimatch"))).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("./missing.js"))).toBe(true);
    expect(
      result.findings.some((finding) =>
        ["dead-store", "unused-value", "unused-object-key", "unused-nested-path"].includes(finding.kind),
      ),
    ).toBe(false);
  });
});
