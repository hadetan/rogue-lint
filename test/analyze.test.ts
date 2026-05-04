import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeProject } from "../src/index.js";

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
});
