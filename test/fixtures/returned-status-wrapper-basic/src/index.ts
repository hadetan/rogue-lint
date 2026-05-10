type Manifest = {
  label: string;
};

type AnalyzedResult = {
  live: string;
  dead: string;
};

type TargetRun =
  | { state: "missing-corpus"; manifest: Manifest; corpusPath: string }
  | { state: "invalid-target"; manifest: Manifest; corpusPath: string; targetPath: string; problem: string }
  | {
      state: "analyzed";
      manifest: Manifest;
      corpusPath: string;
      targetPath: string;
      result: AnalyzedResult;
      exitCode: number;
    };

function observeTargetShape(target: TargetRun): void {
  void target.state;
  void target.manifest.label;
  void target.corpusPath;

  if (target.state === "missing-corpus") {
    return;
  }

  void target.targetPath;

  if (target.state === "invalid-target") {
    void target.problem;
    return;
  }

  void target.result.live;
  void target.exitCode;
}

function runTarget(state: TargetRun["state"]): TargetRun {
  const manifest = { label: "manifest" };
  const corpusPath = "corpus";

  if (state === "missing-corpus") {
    const target: TargetRun = {
      state,
      manifest,
      corpusPath,
    };
    observeTargetShape(target);
    return target;
  }

  const targetPath = "target";

  if (state === "invalid-target") {
    const target: TargetRun = {
      state,
      manifest,
      corpusPath,
      targetPath,
      problem: "missing",
    };
    observeTargetShape(target);
    return target;
  }

  const target: TargetRun = {
    state,
    manifest,
    corpusPath,
    targetPath,
    result: {
      live: "ok",
      dead: "stale",
    },
    exitCode: 0,
  };
  observeTargetShape(target);
  return target;
}

const analyzed = runTarget("analyzed");
if (analyzed.state === "analyzed") {
  console.log(analyzed.result.live);
}

const invalid = runTarget("invalid-target");
if (invalid.state === "invalid-target") {
  console.log(invalid.problem.length);
}

runTarget("missing-corpus");
