import path from "node:path";

import ts from "typescript";

import type { DiagnosticRecord, ModuleEdge, ModuleGraph, ProjectContext } from "./types.js";
import { matchesPatterns, normalizeSlashes, toRelative } from "./utils.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveModule(
  fromFile: string,
  specifier: string,
  project: ProjectContext,
): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    fromFile,
    project.compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (!resolved?.resolvedFileName) {
    return undefined;
  }

  const fileName = resolved.resolvedFileName;
  if (fileName.endsWith(".d.ts")) {
    return undefined;
  }

  if (!fileName.startsWith(project.rootPath)) {
    return undefined;
  }

  return path.normalize(fileName);
}

export function buildModuleGraph(project: ProjectContext): ModuleGraph {
  const edges: ModuleEdge[] = [];
  const unresolved: DiagnosticRecord[] = [];

  for (const sourceFile of project.sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveModule(sourceFile.fileName, node.moduleSpecifier.text, project);
        if (target) {
          edges.push({
            from: sourceFile.fileName,
            to: target,
            specifier: node.moduleSpecifier.text,
            dynamic: false,
          });
        } else {
          unresolved.push({
            kind: "project-warning",
            message: `Could not resolve module '${node.moduleSpecifier.text}' from ${sourceFile.fileName}`,
            file: sourceFile.fileName,
          });
        }
      }

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveModule(sourceFile.fileName, node.arguments[0].text, project);
        if (target) {
          edges.push({
            from: sourceFile.fileName,
            to: target,
            specifier: node.arguments[0].text,
            dynamic: true,
          });
        } else {
          unresolved.push({
            kind: "project-warning",
            message: `Could not resolve dynamic import '${node.arguments[0].text}' from ${sourceFile.fileName}`,
            file: sourceFile.fileName,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  const outgoing = new Map<string, ModuleEdge[]>();
  for (const edge of edges) {
    const existing = outgoing.get(edge.from) ?? [];
    existing.push(edge);
    outgoing.set(edge.from, existing);
  }

  return { edges, outgoing, unresolved };
}

function resolveProjectSourceFile(project: ProjectContext, candidate: string): string | undefined {
  const absolute = path.resolve(project.rootPath, candidate);
  return project.sourceFiles.find((sourceFile) => sourceFile.fileName === absolute)?.fileName;
}

function reconcilePackagePath(project: ProjectContext, value: string): string | undefined {
  const normalized = normalizeSlashes(value).replace(/^\.\//, "");
  const withoutExtension = normalized.replace(/\.[^/.]+$/, "");
  const candidateBases = new Set<string>([withoutExtension]);

  for (const prefix of ["dist/", "build/", "lib/", "out/"]) {
    if (withoutExtension.startsWith(prefix)) {
      const suffix = withoutExtension.slice(prefix.length);
      candidateBases.add(`src/${suffix}`);
      candidateBases.add(suffix);
    }
  }

  for (const base of candidateBases) {
    for (const extension of SOURCE_EXTENSIONS) {
      const resolved = resolveProjectSourceFile(project, `${base}${extension}`);
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

function resolveEntrypoint(project: ProjectContext, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return resolveProjectSourceFile(project, value) ?? reconcilePackagePath(project, value);
}

function collectHiddenRoots(project: ProjectContext): {
  roots: string[];
  diagnostics: DiagnosticRecord[];
} {
  const roots = new Set<string>();
  const diagnostics: DiagnosticRecord[] = [];

  for (const pattern of project.config.value.hiddenRoots) {
    const matches = project.sourceFiles.filter((sourceFile) =>
      matchesPatterns(toRelative(project.rootPath, sourceFile.fileName), [pattern]),
    );
    if (matches.length === 0) {
      diagnostics.push({
        kind: "project-warning",
        message: `Configured hidden root pattern '${pattern}' did not match any analyzable source files`,
      });
      continue;
    }

    for (const match of matches) {
      roots.add(match.fileName);
    }
  }

  return { roots: [...roots], diagnostics };
}

export function discoverEntrypoints(project: ProjectContext): {
  entrypoints: string[];
  diagnostics: DiagnosticRecord[];
} {
  const diagnostics: DiagnosticRecord[] = [];
  const configured = project.config.value.entrypoints
    .map((entrypoint) => resolveEntrypoint(project, entrypoint))
    .filter(Boolean) as string[];
  const hiddenRoots = collectHiddenRoots(project);
  diagnostics.push(...hiddenRoots.diagnostics);

  if (configured.length > 0) {
    return {
      entrypoints: [...new Set([...configured, ...hiddenRoots.roots])],
      diagnostics,
    };
  }

  const roots = new Set<string>();
  const packageJson = project.packageJson ?? {};

  const addIfPresent = (value: unknown): void => {
    const resolved = resolveEntrypoint(project, value);
    if (resolved) {
      roots.add(resolved);
    }
  };

  addIfPresent(packageJson.main);

  if (typeof packageJson.bin === "string") {
    addIfPresent(packageJson.bin);
  } else if (packageJson.bin && typeof packageJson.bin === "object") {
    for (const value of Object.values(packageJson.bin as Record<string, unknown>)) {
      addIfPresent(value);
    }
  }

  if (packageJson.exports && typeof packageJson.exports === "object") {
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        addIfPresent(value);
        return;
      }

      if (value && typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
          walk(child);
        }
      }
    };

    walk(packageJson.exports);
  }

  if (roots.size > 0) {
    return {
      entrypoints: [...new Set([...roots, ...hiddenRoots.roots])],
      diagnostics,
    };
  }

  const defaults = ["src/index.ts", "src/main.ts", "index.ts", "index.js"]
    .map((candidate) => path.resolve(project.rootPath, candidate))
    .filter((candidate) => project.sourceFiles.some((sourceFile) => sourceFile.fileName === candidate));

  if (defaults.length > 0) {
    return {
      entrypoints: [...new Set([...defaults, ...hiddenRoots.roots])],
      diagnostics,
    };
  }

  return {
    entrypoints:
      project.sourceFiles.length > 0
        ? [...new Set([project.sourceFiles[0]!.fileName, ...hiddenRoots.roots])]
        : hiddenRoots.roots,
    diagnostics,
  };
}

export function computeReachableFiles(entrypoints: string[], graph: ModuleGraph): Set<string> {
  const reachable = new Set<string>(entrypoints);
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const edge of graph.outgoing.get(current) ?? []) {
      if (!reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return reachable;
}
