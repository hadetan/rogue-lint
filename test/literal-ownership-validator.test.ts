import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatLiteralOwnershipViolations,
  validateLiteralOwnership,
} from "../tools/literal-ownership/validator.js";

const tempWorkspaces: string[] = [];

function createWorkspace(files: Record<string, string>): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-lint-literal-ownership-"));
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

describe("literal ownership validator", () => {
  it("reports same-file unmanaged duplicate literals", () => {
    const workspaceRoot = createWorkspace({
      "src/example.ts": [
        "export const first = \"duplicate\";",
        "export const second = \"duplicate\";",
      ].join("\n"),
    });

    const result = validateLiteralOwnership(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
      enforceUnownedDuplicates: true,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      kind: "unowned-duplicate",
      literal: "duplicate",
    });
    expect(result.violations[0]?.occurrences).toHaveLength(2);
  });

  it("reports cross-file unmanaged duplicate literals", () => {
    const workspaceRoot = createWorkspace({
      "src/first.ts": "export const first = \"shared\";\n",
      "src/second.ts": "export const second = \"shared\";\n",
    });

    const result = validateLiteralOwnership(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
      enforceUnownedDuplicates: true,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      kind: "unowned-duplicate",
      literal: "shared",
    });
    expect(result.violations[0]?.occurrences.map((occurrence) => occurrence.relativeFilePath).sort()).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
  });

  it("supports explicit owner surfaces for managed literals", () => {
    const workspaceRoot = createWorkspace({
      "src/benchmark/vocabulary.ts": "export const BENCHMARK_STATE = \"analyzed\";\n",
      "src/benchmark/reporting.ts": "export const repeated = \"analyzed\";\n",
    });

    const result = validateLiteralOwnership(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
      ownedLiteralRules: [
        {
          literal: "analyzed",
          ownerGlobs: ["src/benchmark/vocabulary.ts"],
        },
      ],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      kind: "literal-outside-owner",
      literal: "analyzed",
    });
    expect(formatLiteralOwnershipViolations(result.violations)).toContain("owned by src/benchmark/vocabulary.ts");
  });

  it("ignores excluded trees and import module specifiers", () => {
    const workspaceRoot = createWorkspace({
      "src/shared.ts": "export const value = 1;\n",
      "src/consumer-a.ts": "import { value } from \"./shared.js\";\nexport const first = value;\n",
      "src/consumer-b.ts": "import { value } from \"./shared.js\";\nexport const second = value;\n",
      "src/generated/first.ts": "export const first = \"generated\";\n",
      "src/generated/second.ts": "export const second = \"generated\";\n",
    });

    const result = validateLiteralOwnership(workspaceRoot, {
      includeGlobs: ["src/**/*.ts"],
      excludeGlobs: ["src/generated/**"],
    });

    expect(result.violations).toHaveLength(0);
  });
});
