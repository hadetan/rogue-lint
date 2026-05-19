import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatDirectModuleWiringViolations,
  validateDirectModuleWiring,
} from "../tools/direct-module-wiring/validator.js";

const tempWorkspaces: string[] = [];

function createWorkspace(files: Record<string, string>): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-lint-direct-wiring-"));
  tempWorkspaces.push(workspaceRoot);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }

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

describe("direct module wiring validator", () => {
  it("reports pure internal pass-through modules", () => {
    const workspaceRoot = createWorkspace({
      "src/owner.ts": "export const value = 1;\n",
      "src/shim.ts": "export { value } from \"./owner.js\";\n",
    });

    const result = validateDirectModuleWiring(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      kind: "internal-pass-through-module",
      relativeFilePath: "src/shim.ts",
    });
    expect(formatDirectModuleWiringViolations(result.violations)).toContain("src/shim.ts");
  });

  it("reports unchanged forwarding wrappers", () => {
    const workspaceRoot = createWorkspace({
      "src/owner.ts": "export function run(value: number): number {\n  return value;\n}\n",
      "src/wrapper.ts": [
        "import { run as runInCore } from \"./owner.js\";",
        "export function run(value: number): number {",
        "  return runInCore(value);",
        "}",
      ].join("\n"),
    });

    const result = validateDirectModuleWiring(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      kind: "unchanged-forwarding-wrapper",
      relativeFilePath: "src/wrapper.ts",
    });
  });

  it("allows reviewed facade exceptions", () => {
    const workspaceRoot = createWorkspace({
      "src/api/analyze-project.ts": "export function analyzeProject(): void {}\n",
      "src/index.ts": "export { analyzeProject } from \"./api/analyze-project.js\";\n",
    });

    const result = validateDirectModuleWiring(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
      reviewedFacadeExceptions: [
        {
          pathGlobs: ["src/index.ts"],
          category: "package-entrypoint",
          reason: "Public package surface.",
        },
      ],
    });

    expect(result.violations).toHaveLength(0);
  });
});
