import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeProject } from "../index.js";
import { loadBenchmarkManifests, getBenchmarkDocsPath } from "./manifests.js";
import { evaluateBenchmarkExpectations } from "./evaluate.js";
import type {
  BenchmarkTargetConfig,
  BenchmarkTargetManifest,
  BenchmarkTargetRun,
  BenchmarkWorkspaceRun,
} from "./types.js";

class BenchmarkWorkspaceRunRecord implements BenchmarkWorkspaceRun {
  constructor(
    public docsPath: string,
    public exitCode: 0 | 1,
    public manifests: BenchmarkTargetManifest[],
    public noCorpusInstalled: boolean,
    public targets: BenchmarkTargetRun[],
  ) {}
}

function hasConfigOverrides(config: BenchmarkTargetConfig): boolean {
  return Object.values(config).some((value) => value !== undefined);
}

function writeTemporaryConfig(config: BenchmarkTargetConfig): { cleanup: () => void; configPath: string } {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-lint-benchmark-"));
  const configPath = path.join(temporaryDirectory, "rogue-lint.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    configPath,
    cleanup: () => {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    },
  };
}

function observeTargetShape(target: BenchmarkTargetRun): void {
  void target.state;
  void target.manifest;
  void target.corpusPath;

  if (target.state === "missing-corpus") {
    return;
  }

  void target.targetPath;

  if (target.state === "invalid-target") {
    void target.problem;
    if (target.error) {
      void target.error;
    }
    return;
  }

  void target.result;
  void target.evaluation;
  void target.exitCode;
}

async function runManifest(workspaceRoot: string, manifest: BenchmarkTargetManifest): Promise<BenchmarkTargetRun> {
  const corpusPath = path.resolve(workspaceRoot, manifest.localCorpusPath);
  if (!fs.existsSync(corpusPath)) {
    const target: BenchmarkTargetRun = {
      state: "missing-corpus",
      manifest,
      corpusPath,
    };
    observeTargetShape(target);
    return target;
  }

  const targetPath = manifest.targetPath ? path.resolve(corpusPath, manifest.targetPath) : corpusPath;
  if (!fs.existsSync(targetPath)) {
    const target: BenchmarkTargetRun = {
      state: "invalid-target",
      manifest,
      corpusPath,
      targetPath,
      problem: "Configured target path does not exist inside the local corpus.",
    };
    observeTargetShape(target);
    return target;
  }

  let cleanup = (): void => {};
  let configPath: string | undefined;

  if (hasConfigOverrides(manifest.config)) {
    const temporary = writeTemporaryConfig(manifest.config);
    cleanup = temporary.cleanup;
    configPath = temporary.configPath;
  }

  try {
    const result = await analyzeProject({
      cwd: workspaceRoot,
      targetPath,
      configPath,
      mode: manifest.config.mode,
    });

    if (result.summary.filesAnalyzed === 0) {
      const target: BenchmarkTargetRun = {
        state: "invalid-target",
        manifest,
        corpusPath,
        targetPath,
        problem: "Benchmark target produced zero analyzed files.",
      };
      observeTargetShape(target);
      return target;
    }

    const evaluation = evaluateBenchmarkExpectations(
      result.findings,
      result.skipped,
      result.diagnostics,
      manifest.expectations,
    );

    const target: BenchmarkTargetRun = {
      state: "analyzed",
      manifest,
      corpusPath,
      targetPath,
      result,
      evaluation,
      exitCode: evaluation.failed ? 1 : 0,
    };
    observeTargetShape(target);
    return target;
  } catch (error) {
    const target: BenchmarkTargetRun = {
      state: "invalid-target",
      manifest,
      corpusPath,
      targetPath,
      problem: "Benchmark analysis failed.",
      error: error instanceof Error ? error.message : String(error),
    };
    observeTargetShape(target);
    return target;
  } finally {
    cleanup();
  }
}

async function runBenchmarkManifests(workspaceRoot: string, manifests: BenchmarkTargetManifest[]): Promise<BenchmarkWorkspaceRun> {
  const targets: BenchmarkTargetRun[] = [];

  for (const manifest of manifests) {
    targets.push(await runManifest(workspaceRoot, manifest));
  }

  const installedTargets = targets.filter((target) => target.state !== "missing-corpus");
  const noCorpusInstalled = installedTargets.length === 0;
  const exitCode = noCorpusInstalled
    ? 0
    : targets.some((target) => target.state === "invalid-target" || (target.state === "analyzed" && target.exitCode === 1))
      ? 1
      : 0;

  targets.forEach((target) => observeTargetShape(target));

  return new BenchmarkWorkspaceRunRecord(
    getBenchmarkDocsPath(workspaceRoot),
    exitCode,
    manifests,
    noCorpusInstalled,
    targets,
  );
}

export async function runWorkspaceBenchmark(workspaceRoot: string): Promise<BenchmarkWorkspaceRun> {
  return runBenchmarkManifests(workspaceRoot, loadBenchmarkManifests(workspaceRoot));
}
