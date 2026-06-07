type Violation = {
  metric: string;
  actual: number;
  budget: number;
  severity: string;
};

function buildReport() {
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

const report = buildReport();

console.log(report.metrics.passes);
console.log(report.enforced.violations.map((violation) => violation.metric).join(","));
