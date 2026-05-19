type Violation = {
  metric: string;
  actual: number;
  budget: number;
  severity: string;
};

type TrackingSafety = {
  metrics: {
    passes: number;
    warned: boolean;
  };
  enforced: {
    violations: Violation[];
  };
};

type Evaluation = {
  trackingSafety: TrackingSafety;
  failed: boolean;
};

type Target =
  | {
      state: "analyzed";
      evaluation: Evaluation;
      exitCode: 0 | 1;
    }
  | {
      state: "invalid-target";
      problem: string;
    };

class WorkspaceRunRecord {
  constructor(public targets: Target[]) {}
}

function buildTrackingSafety(): TrackingSafety {
  const violations: Violation[] = [];

  violations.push({
    metric: "passes",
    actual: 3,
    budget: 2,
    severity: "error",
  });

  return {
    metrics: {
      passes: 3,
      warned: true,
    },
    enforced: {
      violations,
    },
  };
}

function buildEvaluation(): Evaluation {
  const trackingSafety = buildTrackingSafety();

  return {
    trackingSafety,
    failed: trackingSafety.enforced.violations.length > 0,
  };
}

function runTarget(state: Target["state"]): Target {
  if (state === "analyzed") {
    const evaluation = buildEvaluation();
    const target: Target = {
      state: "analyzed",
      evaluation,
      exitCode: 1,
    };
    return target;
  }

  return {
    state: "invalid-target",
    problem: "missing corpus",
  };
}

const targets: Target[] = [];

targets.push(runTarget("analyzed"));
targets.push(runTarget("invalid-target"));

const result = new WorkspaceRunRecord(targets);
const analyzedTargets = result.targets.filter((target) => target.state === "analyzed");

console.log(analyzedTargets.filter((target) => target.evaluation.trackingSafety.enforced.violations.length > 0).length);
for (const target of analyzedTargets) {
  console.log(target.evaluation.trackingSafety.metrics.passes);
}
console.log(
  analyzedTargets.flatMap((target) =>
    target.evaluation.trackingSafety.enforced.violations.map((violation) => violation.metric)
  ).join(",")
);
