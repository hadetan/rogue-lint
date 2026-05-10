import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { analyzeProject } from "../src/index.js";
import { renderResult } from "../src/output/render-result.js";

function fixturePath(name: string): string {
  return path.join(process.cwd(), "test", "fixtures", name);
}

function normalizeAudit(entry: { category?: string; kind: string; name: string; location?: { file: string; line: number } }): string {
  return `${entry.category ?? "-"}:${entry.kind}:${entry.location?.file ?? "-"}:${entry.location?.line ?? 0}:${entry.name}`;
}

const EXPECTED_SELF_HOST_SKIPS: string[] = [];

describe("rogue-lint analyzer", () => {
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

    expect(result.skipped).toHaveLength(0);
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

  it("keeps exported fluent class members and enum members live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-fluent-api-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "lower")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "upper")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "chain")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-enum-member" && finding.entity.name === "Short")).toBe(false);

    expect(result.kept.some((entry) => entry.kind === "class-member" && entry.name === "chain")).toBe(true);
    expect(result.kept.some((entry) => entry.kind === "enum-member" && entry.name === "Short")).toBe(true);
  });

  it("keeps exported factory-prototype class members live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-factory-prototype-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "format")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "chain")).toBe(false);

    expect(result.kept.some((entry) => entry.kind === "class-member" && entry.name === "format")).toBe(true);
    expect(result.kept.some((entry) => entry.kind === "class-member" && entry.name === "chain")).toBe(true);
  });

  it("keeps aliased exported factory-prototype class members live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-factory-prototype-alias-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "format")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "chain")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-class-member" && finding.entity.name === "stale")).toBe(true);

    expect(result.kept.some((entry) => entry.kind === "class-member" && entry.name === "format")).toBe(true);
    expect(result.kept.some((entry) => entry.kind === "class-member" && entry.name === "chain")).toBe(true);
  });

  it("keeps namespace-exported values and types live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-namespace-export-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "normalize")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-type" && finding.entity.name === "ToolkitConfig")).toBe(false);

    expect(result.kept.some((entry) => entry.kind === "export" && entry.name === "normalize")).toBe(true);
    expect(result.kept.some((entry) => entry.kind === "type" && entry.name === "ToolkitConfig")).toBe(true);
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

    expect(result.kept.some((entry) => entry.name === "ignoredLocalOnly" && entry.reason === "suppressed by rogue-lint-ignore-next")).toBe(true);
    expect(result.kept.some((entry) => entry.name === "IgnoredLocalShape" && entry.reason === "suppressed by rogue-lint-ignore-next")).toBe(true);
  });

  it("supports exact and conservative array analysis", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("array-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(result.findings.filter((finding) => finding.kind === "unused-array-element")).toHaveLength(2);
    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).toContain("unused-nested-path:[0].stale");
    expect(kindsAndNames).toContain("unused-nested-path:[1].stale");
    expect(kindsAndNames).toContain("unused-nested-path:[0].nested.dead");
    expect(kindsAndNames).toContain("unused-nested-path:[1].nested.dead");
    expect(kindsAndNames).toContain("unused-nested-path:[0].items[0].dead");
    expect(kindsAndNames).toContain("unused-nested-path:[1].items[0].dead");
    expect(kindsAndNames).not.toContain("unused-nested-path:[0].nested.keep");
    expect(kindsAndNames).not.toContain("unused-nested-path:[1].items[0].live");

    expect(result.skipped.some((entry) => entry.category === "dynamic-array-index")).toBe(true);
    expect(result.skipped.some((entry) => entry.category === "array-at-call")).toBe(true);
    expect(result.skipped.some((entry) => entry.category === "array-spread")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "array-reorder-mutation")).toBe(true);
    expect(result.skipped.some((entry) => entry.category === "array-rest")).toBe(true);
    expect(result.skipped.some((entry) => entry.kind === "collection-boundary" && entry.name === "mutatedRows")).toBe(true);
  });

  it("preserves exact collection siblings while reporting root-owned collection boundaries", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("collection-state-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-nested-path:[0].stale");
    expect(kindsAndNames).toContain("unused-nested-path:[0].dead");
    expect(kindsAndNames).toContain("unused-nested-path:[0].items[0].dead");
    expect(kindsAndNames).toContain("unused-nested-path:[0].safe.stale");
    expect(kindsAndNames).toContain("unused-nested-path:[1].safe.stale");
    expect(kindsAndNames).not.toContain("unused-nested-path:[1].stale");
    expect(kindsAndNames).not.toContain("unused-nested-path:[1].nested.dead");

    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.name === "stack" && entry.category === "array-append-mutation"
    )).toBe(true);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.name === "replaced[1]" && entry.category === "array-replacement-mutation"
    )).toBe(true);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.name === "reordered" && entry.category === "array-reorder-mutation"
    )).toBe(true);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.name === "nested[0].items" && entry.category === "array-append-mutation"
    )).toBe(true);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.name === "opaque" && entry.category === "array-opaque-mutation"
    )).toBe(true);
    expect(result.skipped.some((entry) => entry.name === "[0]")).toBe(false);
  });

  it("promotes compiler safety diagnostics and reports invalidated reads conservatively", async () => {
    const fixture = fixturePath("safety-basic");
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      format: "json",
    });
    const filtered = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      format: "json",
      includeKinds: ["use-before-init"],
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("use-before-init:maybeInit");
    expect(kindsAndNames).toContain("stale-read-after-mutation:reordered[1].stale");
    expect(kindsAndNames).toContain("invalidated-read:replaced[1].dead");
    expect(kindsAndNames).toContain("unused-nested-path:[0].safe.stale");
    expect(kindsAndNames).toContain("unused-nested-path:[1].safe.stale");
    expect(kindsAndNames).not.toContain("stale-read-after-mutation:appended[0].safe.keep");
    expect(kindsAndNames).not.toContain("invalidated-read:escaped[0].dead");

    expect(result.kept.some((entry) => entry.name === "ignored" && entry.reason === "suppressed by rogue-lint-ignore-next")).toBe(true);
    expect(result.skipped.some((entry) => entry.reason.includes("JSON.stringify"))).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "serialization")).toBe(false);

    expect(filtered.findings).toHaveLength(1);
    expect(filtered.findings[0]?.kind).toBe("use-before-init");
    expect(filtered.findings[0]?.entity.name).toBe("maybeInit");
  });

  it("preserves exact imported object and array usage across files", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("cross-file-exact-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).toContain("unused-nested-path:[0].dead");
    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-nested-path:[0].live");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-export:arr");
    expect(kindsAndNames).not.toContain("unused-export:obj");
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps public exports live without hiding unused remaining imported paths", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("cross-file-public-surface-basic"),
      format: "json",
      mode: "library",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-array-element:[6]");
    expect(kindsAndNames).toContain("unused-array-element:[7]");
    expect(kindsAndNames).toContain("unused-array-element:[8]");
    expect(kindsAndNames).toContain("unused-array-element:[9]");
    expect(kindsAndNames).toContain("unused-object-key:age");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-array-element:[5]");
    expect(kindsAndNames).not.toContain("unused-object-key:name");
    expect(kindsAndNames).not.toContain("unused-export:arr");
    expect(kindsAndNames).not.toContain("unused-export:obj");
    expect(result.skipped).toHaveLength(0);
  });

  it("classifies JS value fate conservatively and reports write-only accumulation", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("value-fate-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).toContain("unused-object-key:stale");
    expect(kindsAndNames).toContain("write-only-state:unread");
    expect(kindsAndNames).toContain("unused-value:numbers.slice(1)");
    expect(kindsAndNames).toContain("unused-value:structuredClone(numbers)");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-object-key:keep");
    expect(result.skipped.some((entry) => entry.category === "array-spread")).toBe(false);
    expect(result.skipped.some((entry) => entry.reason.includes("structuredClone"))).toBe(false);
  });

  it("tracks exact spread append slots without falling back to append boundaries", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("spread-append-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-export:numbers");
    expect(result.skipped.some((entry) => entry.category === "array-append-mutation")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "spread-escape")).toBe(false);
  });

  it("materializes exact append growth for scalar values and direct alias insertion", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("append-growth-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(result.skipped.some((entry) => entry.category === "array-append-mutation")).toBe(false);
  });

  it("treats allowlisted whole-receiver observation as meaningful use of inserted aliases", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("append-alias-observation-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-array-element:[1]");
    expect(kindsAndNames).not.toContain("write-only-state:abc");
    expect(kindsAndNames).not.toContain("write-only-state:def");
    expect(result.findings).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps opaque iterable spread append conservative", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("append-boundary-basic"),
      format: "json",
    });

    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary" && entry.category === "array-append-mutation" && entry.name === "sink"
    )).toBe(true);
  });

  it("keeps helper storage by reference honest with a boundary instead of a false unused slot", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-storage-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "childPaths"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary"
      && entry.name === "childPaths"
      && entry.category === "array-opaque-mutation"
      && entry.reason.includes("helper stores this value by reference")
      && entry.reason.includes("helper cause at")
    )).toBe(true);
  });

  it("preserves exact reads through same-project helper observers", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-readonly-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[1]"
    )).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it("preserves exact helper-local append mutations when later reads stay supported", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-mutation-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items"
    )).toBe(false);
    expect(result.skipped).toHaveLength(0);
  });

  it("tracks supported retained module bindings across same-project helpers", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-retained-binding-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[1]"
    )).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it("tracks supported static globalThis retention across same-project helpers", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-global-this-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items" && finding.entity.name === "[1]"
    )).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps helper queue/worklist mutations conservative until they are modeled exactly", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-queue-basic"),
      format: "json",
    });

    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary"
      && entry.name === "queue"
      && entry.category === "array-reorder-mutation"
    )).toBe(true);
  });

  it("preserves exact single-item worklist consume after exact append", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("queue-lifecycle-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(result.skipped.some((entry) => entry.category === "array-reorder-mutation")).toBe(false);
  });

  it("treats nested helper closure capture as a conservative boundary", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-closure-capture-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element" && finding.entity.owner === "items"
    )).toBe(false);
    expect(result.skipped.some((entry) =>
      entry.kind === "collection-boundary"
      && entry.name === "items"
      && entry.reason.includes("nested function")
    )).toBe(true);
  });

  it("renders stable summary metadata", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("app-basic"),
      format: "json",
      includeKinds: ["unused-export", "unused-file"],
    });

    expect(result.tool).toBe("rogue-lint");
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

  it("supports analysis controls for file filters and hidden roots", async () => {
    const fixture = fixturePath("controls-basic");
    const excludedResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      configPath: "rogue-lint.exclude.json",
      format: "json",
    });
    const hiddenRootResult = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixture,
      configPath: "rogue-lint.hidden-roots.json",
      format: "json",
    });

    expect(excludedResult.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "onlyExcluded")).toBe(true);
    expect(excludedResult.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "excluded-consumer.ts")).toBe(false);

    expect(hiddenRootResult.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "worker.ts")).toBe(false);
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

  it("keeps internal-only deep files and types reportable under exported subpath barrels", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("package-subpath-surface-basic"),
      format: "json",
      mode: "library",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-file" && finding.entity.name === "hidden.ts")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-type" && finding.entity.name === "InternalOptions")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-type" && finding.entity.name === "PublicConfig")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-export" && finding.entity.name === "buildPublicThing")).toBe(false);
  });

  it("honors configured CLI exit codes", async () => {
    const fixture = fixturePath("controls-basic");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const findingsCode = await runCli([fixture, "--config", "rogue-lint.exitcodes.json"], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });
    const failureCode = await runCli([fixture, "--config", "rogue-lint.failure.json"], {
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
    expect(result.kept.length).toBeGreaterThan(0);
    expect(rendered).toContain(result.kept[0].reason);
    expect(rendered).toContain("Skipped: 0");
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

  it("reports analyzable discarded call results without duplicating unread saved returns", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("call-return-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-value:echo(\"unused\")");
    expect(kindsAndNames).toContain("unused-value:importedText()");
    expect(kindsAndNames).toContain("unused-local:saved");
    expect(kindsAndNames).not.toContain("unused-value:echo(\"observed\")");
    expect(kindsAndNames).not.toContain("unused-value:echo(\"saved\")");
    expect(result.skipped).toHaveLength(0);
  });

  it("does not report dead stores for staged self-rewrites or sentinel writes", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("value-flow-staged-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).not.toContain("dead-store:regex");
    expect(kindsAndNames).not.toContain("dead-store:value");
    expect(kindsAndNames).not.toContain("write-only-state:value");
  });

  it("preserves benchmark-like dynamic lookup tables and conditional array receivers conservatively", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("dynamic-benchmark-patterns-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).not.toContain("unused-object-key:string");
    expect(kindsAndNames).not.toContain("unused-object-key:number");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(kindsAndNames).not.toContain("unused-array-element:[3]");
  });

  it("purity-gates ignored returns while keeping structural dead metadata reportable", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("self-host-trust-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-value:rows.slice()");
    expect(kindsAndNames).toContain("unused-object-key:label");
    expect(kindsAndNames).toContain("unused-object-key:path");
    expect(kindsAndNames).not.toContain("unused-value:touchState(state)");
    expect(kindsAndNames).not.toContain("unused-object-key:kind");
    expect(kindsAndNames).not.toContain("unused-object-key:value");
    expect(result.skipped.some((entry) => entry.kind === "collection-boundary" && entry.name === "findings")).toBe(false);
    expect(result.skipped.some((entry) => entry.kind === "collection-boundary" && entry.name === "diagnostics")).toBe(false);
  });

  it("preserves exact callback index correlation for supported local array callbacks", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("callback-correlation-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-nested-path:[0].dead");
    expect(kindsAndNames).toContain("unused-nested-path:[1].dead");
    expect(result.skipped.some((entry) => entry.category === "dynamic-array-index")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "array-callback-escape")).toBe(false);
  });

  it("preserves retained bindings through supported local Map set/get flows", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("container-retention-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(result.skipped.some((entry) => entry.category === "opaque-object-call")).toBe(false);
  });

  it("preserves supported object-backed retained storage and keeps dynamic slots conservative", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("object-retention-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-object-key:stale");
    expect(result.skipped.some((entry) => entry.category === "opaque-object-call")).toBe(true);
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
    expect(kindsAndNames).not.toContain("unused-nested-path:escaped.maybe");
    expect(result.skipped.some((entry) => entry.name === "escaped" && entry.reason.includes("Object.keys"))).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "reflective-enumeration")).toBe(false);
  });

  it("keeps supported observers and bounded keyed access exact without widening unsupported dynamic access", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("observer-keyed-access-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "keyed"
      && finding.entity.name === "dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-nested-path"
      && finding.entity.owner === "keyed"
      && finding.entity.name === "nested.dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "untouched"
      && finding.entity.name === "dead"
    )).toBe(true);

    expect(result.findings.some((finding) =>
      finding.entity.owner === "observedEntries"
      && ["live", "stale"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.entity.owner === "serialized"
      && ["nested.dead", "nested.keep"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.entity.owner === "keyed"
      && ["live", "nested.live"].includes(finding.entity.name)
    )).toBe(false);

    expect(result.skipped.some((entry) => entry.category === "reflective-enumeration")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "serialization")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(true);
  });

  it("keeps finite union keyed object reads exact without hiding unrelated dead keys", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("finite-union-keyed-access-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "entries"
      && finding.entity.name === "unused"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-nested-path"
      && finding.entity.owner === "entries"
      && ["email.dead", "url.dead", "unused.dead"].includes(finding.entity.name)
    )).toBe(true);

    expect(result.findings.some((finding) =>
      finding.entity.owner === "labels"
      && ["email", "url"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.entity.owner === "entries"
      && ["email.label", "url.label"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("keeps finite dispatch table entries live through a returned context wrapper", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("finite-dispatch-table-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "allProcessors"
      && ["string", "number"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("keeps recursive finite dispatch helper reuse stable", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("finite-dispatch-recursive-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "allProcessors"
      && ["string", "number"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("keeps finite dispatch table entries live through a rich returned context helper", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("finite-dispatch-rich-context-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "allProcessors"
      && ["string", "number"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("preserves nested locale child paths after finite keyed dictionary lookup", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("locale-dictionary-reduction-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-nested-path"
      && finding.entity.owner === "formatDictionary"
      && [
        "regex.label",
        "regex.gender",
        "template_literal.label",
        "template_literal.gender",
      ].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("preserves nested locale child paths after finite keyed lookup through optional chaining", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("locale-dictionary-optional-chain-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-nested-path"
      && finding.entity.owner === "formatDictionary"
      && [
        "regex.label",
        "regex.gender",
        "template_literal.label",
        "template_literal.gender",
      ].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "computed-property-access")).toBe(false);
  });

  it("preserves same-project namespace and member helpers plus awaited structured returns", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-async-propagation-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "namespaceObserved"
      && finding.entity.name === "dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "memberObserved"
      && finding.entity.name === "dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "make()"
      && finding.entity.name === "dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && finding.entity.owner === "buildAsync()"
      && finding.entity.name === "dead"
    )).toBe(true);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-nested-path"
      && finding.entity.owner === "buildAsync()"
      && finding.entity.name === "nested.dead"
    )).toBe(true);

    expect(result.findings.some((finding) =>
      ["namespaceObserved", "memberObserved", "make()", "buildAsync()"].includes(finding.entity.owner ?? "")
      && ["live", "nested.live"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "opaque-object-call")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("treats Promise.all array aggregation as a supported whole-array observation", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("promise-all-array-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-array-element")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "array-opaque-mutation" && entry.name === "items")).toBe(false);
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

  it("preserves conditional helper fallback returns across supported same-project calls", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-object-conditional-helper-basic"),
      format: "json",
    });

    expect(result.skipped.some((entry) => entry.category === "returned-object" && entry.name === "[0]")).toBe(false);
  });

  it("preserves bounded discriminated returned status wrappers without returned-object skips", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-status-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-nested-path" && finding.entity.name === "result.dead")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "live")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves recursive discriminated status wrappers through later data readback", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-recursive-status-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "mergeValues()")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "valid")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "data")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves trivial returned carriers for tracked objects and scalar prefixes", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-alias-carrier-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "dead")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "live")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element" && finding.entity.name === "[1]")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element" && finding.entity.name === "[0]")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves returned form-error wrappers without write-only-state regressions", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-form-errors-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "summary")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "formErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "fieldErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "flattenError()")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves returned wrappers built from mutated local carrier aliases", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-local-carrier-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "summary")).toBe(true);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "formErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "fieldErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "flattenError()")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves helper-built returned issue wrappers and appended keys", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-helper-issue-keys-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && ["message", "code", "input", "inst", "keys"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "buildIssue()")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves pure spread-cloned returned issue wrappers", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-pure-spread-issue-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && ["message", "code", "input", "inst"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "issue()")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves spread-cloned issue wrappers after append and later readback", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-spread-issue-array-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && ["message", "input", "inst", "keys"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "issue()")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves discriminant-narrowed heterogeneous issue-array reads", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-heterogeneous-issue-keys-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-object-key"
      && ["message", "inst", "keys"].includes(finding.entity.name)
    )).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("preserves discriminant-narrowed issue arrays across _zod.run payload flows", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-run-payload-issue-keys-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "keys")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "returned-object")).toBe(false);
  });

  it("keeps bounded bookkeeping transfers exact while preserving nearby escape boundaries", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("bookkeeping-transfer-record-basic"),
      format: "json",
    });

    expect(result.skipped.some((entry) => entry.category === "array-append-mutation" && entry.name === "result")).toBe(false);
    expect(result.skipped.some((entry) => entry.category === "array-reorder-mutation" && entry.name === "result")).toBe(false);
    expect(result.skipped.some((entry) => entry.kind === "collection-boundary" && entry.name === "opaqueRecords")).toBe(true);
  });

  it("preserves alias-backed projected helper returns while keeping unread siblings reportable", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("helper-return-alias-projection-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.owner === "projectedSegments"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.owner === "selectiveSegments"
      && finding.entity.name === "[0]"
    )).toBe(false);
    expect(result.findings.some((finding) =>
      finding.kind === "unused-array-element"
      && finding.entity.name === "[1]"
    )).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps public returned issue objects and collected keys live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-returned-issues-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "message")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "code")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "input")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "inst")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "keys")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-array-element" && finding.entity.name === "[0]")).toBe(false);
  });

  it("keeps public returned carrier wrapper fields live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-returned-carrier-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "flattenError()")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "formErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "fieldErrors")).toBe(false);
  });

  it("keeps public class-method carrier wrapper fields live in library mode", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("library-class-returned-carrier-wrapper-basic"),
      format: "json",
    });

    expect(result.findings.some((finding) => finding.kind === "write-only-state" && finding.entity.name === "flatten()")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "formErrors")).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "unused-object-key" && finding.entity.name === "fieldErrors")).toBe(false);
  });

  it("tracks direct returned literals for whole-result and nested structured usage", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("returned-literal-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-value:buildSummary()");
    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).toContain("unused-nested-path:nested.stale");
    expect(kindsAndNames).toContain("unused-nested-path:[0].stale");
    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-nested-path:nested.read");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
    expect(result.skipped).toHaveLength(0);
  });

  it("preserves exact structured return usage across same-project imports", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: fixturePath("cross-file-return-structure-basic"),
      format: "json",
    });

    const kindsAndNames = result.findings.map((finding) => `${finding.kind}:${finding.entity.name}`);

    expect(kindsAndNames).toContain("unused-object-key:dead");
    expect(kindsAndNames).toContain("unused-nested-path:nested.stale");
    expect(kindsAndNames).toContain("unused-nested-path:[0].stale");
    expect(kindsAndNames).toContain("unused-array-element:[1]");
    expect(kindsAndNames).not.toContain("unused-object-key:live");
    expect(kindsAndNames).not.toContain("unused-nested-path:nested.read");
    expect(kindsAndNames).not.toContain("unused-array-element:[0]");
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

  it("enforces the normalized self-host library-mode zero-gap surface", async () => {
    const result = await analyzeProject({
      cwd: process.cwd(),
      targetPath: process.cwd(),
      format: "json",
      mode: "library",
    });

    expect(result.summary.findings).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.summary.skipped).toBe(EXPECTED_SELF_HOST_SKIPS.length);
    expect(result.summary.reachableFiles).toBe(result.summary.filesAnalyzed);
    expect(result.skipped.map(normalizeAudit).sort()).toEqual(EXPECTED_SELF_HOST_SKIPS);
  }, 15000);
});
