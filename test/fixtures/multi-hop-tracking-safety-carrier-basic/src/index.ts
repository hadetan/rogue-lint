type Violation = {
  metric: string;
  actual: number;
  budget: number;
  severity: string;
};

function buildTrackingSafety() {
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

function buildEvaluation() {
  const trackingSafety = buildTrackingSafety();

  return {
    trackingSafety,
    failed: trackingSafety.enforced.violations.length > 0,
  };
}

const evaluation = buildEvaluation();
const target = { evaluation };

console.log(target.evaluation.trackingSafety.metrics.passes);
console.log(target.evaluation.trackingSafety.enforced.violations.map((violation) => violation.metric).join(","));
