import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeProject } from "../index.js";
import { loadBenchmarkManifests, getBenchmarkDocsPath } from "./manifests.js";
import { evaluateBenchmarkExpectations } from "./evaluate.js";
import { BENCHMARK_TARGET_STATE } from "./vocabulary.js";
import type {
  BenchmarkTargetConfig,
  BenchmarkTargetManifest,
  BenchmarkTargetRun,
  BenchmarkWorkspaceRun,
} from "./types.js";

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

  if (target.state === BENCHMARK_TARGET_STATE.missingCorpus) {
    return;
  }

  void target.targetPath;

  if (target.state === BENCHMARK_TARGET_STATE.invalidTarget) {
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

function observeWorkspaceRunShape(result: BenchmarkWorkspaceRun): void {
  void result.docsPath;
  void result.exitCode;
  void result.manifests;
  void result.noCorpusInstalled;
  void result.targets;
}

async function appendManifestTarget(
  targets: BenchmarkTargetRun[],
  workspaceRoot: string,
  manifest: BenchmarkTargetManifest,
): Promise<void> {
  const corpusPath = path.resolve(workspaceRoot, manifest.localCorpusPath);
  if (!fs.existsSync(corpusPath)) {
    const target: BenchmarkTargetRun = {
      state: BENCHMARK_TARGET_STATE.missingCorpus,
      manifest,
      corpusPath,
    };
    observeTargetShape(target);
    targets.push(target);
    return;
  }

  const targetPath = manifest.targetPath ? path.resolve(corpusPath, manifest.targetPath) : corpusPath;
  if (!fs.existsSync(targetPath)) {
    const target: BenchmarkTargetRun = {
      state: BENCHMARK_TARGET_STATE.invalidTarget,
      manifest,
      corpusPath,
      targetPath,
      problem: "Configured target path does not exist inside the local corpus.",
    };
    observeTargetShape(target);
    targets.push(target);
    return;
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
        state: BENCHMARK_TARGET_STATE.invalidTarget,
        manifest,
        corpusPath,
        targetPath,
        problem: "Benchmark target produced zero analyzed files.",
      };
      observeTargetShape(target);
      targets.push(target);
      return;
    }

    const evaluation = evaluateBenchmarkExpectations(result, manifest.expectations, manifest.coverageClass);

    const target: BenchmarkTargetRun = {
      state: BENCHMARK_TARGET_STATE.analyzed,
      manifest,
      corpusPath,
      targetPath,
      result,
      evaluation,
      exitCode: evaluation.failed ? 1 : 0,
    };
    observeTargetShape(target);
    targets.push(target);
    return;
  } catch (error) {
    const target: BenchmarkTargetRun = {
      state: BENCHMARK_TARGET_STATE.invalidTarget,
      manifest,
      corpusPath,
      targetPath,
      problem: "Benchmark analysis failed.",
      error: error instanceof Error ? error.message : String(error),
    };
    observeTargetShape(target);
    targets.push(target);
    return;
  } finally {
    cleanup();
  }
}

async function runBenchmarkManifests(workspaceRoot: string, manifests: BenchmarkTargetManifest[]): Promise<BenchmarkWorkspaceRun> {
  const targets: BenchmarkTargetRun[] = [];

  for (const manifest of manifests) {
    await appendManifestTarget(targets, workspaceRoot, manifest);
  }

  const installedTargets = targets.filter((target) => target.state !== BENCHMARK_TARGET_STATE.missingCorpus);
  const noCorpusInstalled = installedTargets.length === 0;
  const exitCode = noCorpusInstalled
    ? 0
    : targets.some((target) => target.state === BENCHMARK_TARGET_STATE.invalidTarget || (target.state === BENCHMARK_TARGET_STATE.analyzed && target.exitCode === 1))
      ? 1
      : 0;

  targets.forEach((target) => observeTargetShape(target));

  const benchmarkRun: BenchmarkWorkspaceRun = {
    docsPath: getBenchmarkDocsPath(workspaceRoot),
    exitCode,
    manifests,
    noCorpusInstalled,
    targets,
  };

  observeWorkspaceRunShape(benchmarkRun);
  return benchmarkRun;
}

export async function runWorkspaceBenchmark(workspaceRoot: string): Promise<BenchmarkWorkspaceRun> {
  return runBenchmarkManifests(workspaceRoot, loadBenchmarkManifests(workspaceRoot));
}
