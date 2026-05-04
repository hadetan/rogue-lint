import path from "node:path";

import ts from "typescript";

import type { DiagnosticRecord, ModuleEdge, ModuleGraph, ProjectContext } from "./types.js";

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

export function discoverEntrypoints(project: ProjectContext): string[] {
  const configured = project.config.value.entrypoints
    .map((entrypoint) => path.resolve(project.rootPath, entrypoint))
    .filter((entrypoint) => project.sourceFiles.some((sourceFile) => sourceFile.fileName === entrypoint));

  if (configured.length > 0) {
    return configured;
  }

  const roots = new Set<string>();
  const packageJson = project.packageJson ?? {};

  const addIfPresent = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const absolute = path.resolve(project.rootPath, value);
    if (project.sourceFiles.some((sourceFile) => sourceFile.fileName === absolute)) {
      roots.add(absolute);
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
    return [...roots];
  }

  const defaults = ["src/index.ts", "src/main.ts", "index.ts", "index.js"]
    .map((candidate) => path.resolve(project.rootPath, candidate))
    .filter((candidate) => project.sourceFiles.some((sourceFile) => sourceFile.fileName === candidate));

  if (defaults.length > 0) {
    return defaults;
  }

  return project.sourceFiles.length > 0 ? [project.sourceFiles[0]!.fileName] : [];
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
