import type { AuditRecord, DiagnosticRecord, FindingRecord } from "../types.js";
import { renderResult } from "../output/render-result.js";
import { ENTITY_KIND } from "../shared/entity-vocabulary.js";
import type {
  AnalyzedBenchmarkTarget,
  BenchmarkCapabilityPriorityEntry,
  BenchmarkDiagnosticMatcher,
  BenchmarkFindingMatcher,
  BenchmarkGapPriorityEntry,
  BenchmarkSkipMatcher,
  BenchmarkWorkspaceRun,
  ExpectationCountViolation,
  MatcherRecords,
} from "./types.js";
import {
  BENCHMARK_TARGET_STATE,
  formatBenchmarkGapPriorityScope,
  getBenchmarkGapPriorityRank,
} from "./vocabulary.js";

const REPORT_KIND_WIDTH = 28;
const COARSE_MATCHER_NOTE = "coarse matcher: same-file churn is surfaced only in the raw records below";

function formatTrackingSafetyMetric(metric: "passes" | "binding-changes" | "return-summary-changes" | "elapsed-ms"): string {
  switch (metric) {
    case "passes":
      return "convergence passes";
    case "binding-changes":
      return "binding churn";
    case "return-summary-changes":
      return "return-summary churn";
    case "elapsed-ms":
      return "tracking elapsed ms";
    default:
      return metric;
  }
}

function qualifyLabel(owner: string | undefined, name: string): string {
  if (!owner || name === owner || name.startsWith(`${owner}.`) || name.startsWith(`${owner}[`)) {
    return name;
  }

  return name.startsWith("[") ? `${owner}${name}` : `${owner}.${name}`;
}

function formatFinding(record: FindingRecord): string {
  const label = record.entity.kind === ENTITY_KIND.file
    ? record.entity.name
    : qualifyLabel(record.entity.owner, record.entity.name);

  return `${record.kind.padEnd(REPORT_KIND_WIDTH)} ${record.entity.location.file}:${record.entity.location.line}:${record.entity.location.column} ${label} - ${record.reason}`;
}

function formatAudit(record: AuditRecord): string {
  const label = qualifyLabel(record.owner, record.name);

  if (!record.location) {
    return `${record.kind.padEnd(REPORT_KIND_WIDTH)} ${label} - ${record.reason}`;
  }

  return `${record.kind.padEnd(REPORT_KIND_WIDTH)} ${record.location.file}:${record.location.line}:${record.location.column} ${label} - ${record.reason}`;
}

function formatDiagnostic(record: DiagnosticRecord): string {
  return record.file ? `${record.kind} ${record.file}: ${record.message}` : `${record.kind}: ${record.message}`;
}

function renderLabelList<Matcher extends { label: string }>(title: string, matchers: Matcher[]): string[] {
  if (matchers.length === 0) {
    return [];
  }

  return ["", `${title}:`, ...matchers.map((matcher) => `- ${matcher.label}`)];
}

function renderMatcherRecords<Matcher extends { label: string }, Record>(
  title: string,
  entries: Array<MatcherRecords<Matcher, Record>>,
  formatRecord: (record: Record) => string,
  describeMatcher?: (matcher: Matcher) => string | undefined,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const lines = ["", `${title}:`];
  for (const entry of entries) {
    const note = describeMatcher?.(entry.matcher);
    lines.push(note ? `- ${entry.matcher.label} [${note}]` : `- ${entry.matcher.label}`);
    for (const record of entry.records) {
      lines.push(`  ${formatRecord(record)}`);
    }
  }

  return lines;
}

function formatCountExpectation(entry: { actualCount: number; minCount?: number; maxCount?: number }): string {
  const parts = [`actual: ${entry.actualCount}`];
  if (entry.minCount !== undefined) {
    parts.push(`min: ${entry.minCount}`);
  }
  if (entry.maxCount !== undefined) {
    parts.push(`max: ${entry.maxCount}`);
  }
  return parts.join(", ");
}

function renderCountViolations<Matcher extends { label: string }, Record>(
  title: string,
  entries: Array<ExpectationCountViolation<Matcher, Record>>,
  formatRecord: (record: Record) => string,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const lines = ["", `${title}:`];
  for (const entry of entries) {
    lines.push(`- ${entry.matcher.label} (${formatCountExpectation(entry)})`);
    for (const record of entry.records) {
      lines.push(`  ${formatRecord(record)}`);
    }
  }

  return lines;
}

function renderTopCounts(title: string, entries: Array<[string, number]>): string[] {
  if (entries.length === 0) {
    return [];
  }

  return ["", `${title}:`, ...entries.map(([name, count]) => `- ${name}: ${count}`)];
}

function formatCapabilityPriorityDetails(details: BenchmarkCapabilityPriorityEntry["details"]): string {
  return details.map((detail) => `${detail.label}: ${detail.count}`).join(", ");
}

function renderCapabilityPriority(title: string, entries: BenchmarkCapabilityPriorityEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  return [
    "",
    `${title}:`,
    ...entries.map((entry) => {
      const detailSummary = formatCapabilityPriorityDetails(entry.details);
      return detailSummary.length > 0
        ? `- ${entry.capabilityId}: ${entry.count} (${detailSummary})`
        : `- ${entry.capabilityId}: ${entry.count}`;
    }),
  ];
}

function describeFindingMatcherPrecision(matcher: BenchmarkFindingMatcher): string | undefined {
  return matcher.id === undefined
    && matcher.name === undefined
    && matcher.owner === undefined
    && matcher.reasonIncludes === undefined
    && matcher.messageIncludes === undefined
    ? COARSE_MATCHER_NOTE
    : undefined;
}

function describeSkipMatcherPrecision(matcher: BenchmarkSkipMatcher): string | undefined {
  return matcher.id === undefined
    && matcher.name === undefined
    && matcher.owner === undefined
    && matcher.reasonIncludes === undefined
    ? COARSE_MATCHER_NOTE
    : undefined;
}

function formatTargetStatus(target: AnalyzedBenchmarkTarget): string {
  if (target.evaluation.contract.incomplete) {
    return "INCOMPLETE";
  }

  return target.exitCode === 0 ? "PASS" : "FAIL";
}

function collectWorkspaceGapPriority(targets: AnalyzedBenchmarkTarget[]): Array<BenchmarkGapPriorityEntry & { targetCount: number }> {
  const grouped = new Map<string, { entry: BenchmarkGapPriorityEntry; targetIds: Set<string> }>();

  for (const target of targets) {
    for (const entry of target.evaluation.gapPriority) {
      const key = `${entry.scope}:${entry.label}`;
      const current = grouped.get(key);
      if (current) {
        current.entry.count += entry.count;
        current.targetIds.add(target.manifest.id);
        continue;
      }

      grouped.set(key, {
        entry: { ...entry },
        targetIds: new Set([target.manifest.id]),
      });
    }
  }

  return [...grouped.values()]
    .map(({ entry, targetIds }) => ({
      ...entry,
      targetCount: targetIds.size,
    }))
    .sort((left, right) => {
      const rankDelta = getBenchmarkGapPriorityRank(left.scope) - getBenchmarkGapPriorityRank(right.scope);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return right.targetCount - left.targetCount || right.count - left.count || left.label.localeCompare(right.label);
    });
}

function collectWorkspaceCapabilityPriority(
  targets: AnalyzedBenchmarkTarget[],
): Array<BenchmarkCapabilityPriorityEntry & { targetCount: number }> {
  const grouped = new Map<
    string,
    {
      entry: BenchmarkCapabilityPriorityEntry;
      detailCounts: Map<string, number>;
      targetIds: Set<string>;
    }
  >();

  for (const target of targets) {
    for (const entry of target.evaluation.capabilityPriority) {
      const current = grouped.get(entry.capabilityId);
      if (current) {
        current.entry.count += entry.count;
        current.targetIds.add(target.manifest.id);
        for (const detail of entry.details) {
          current.detailCounts.set(detail.label, (current.detailCounts.get(detail.label) ?? 0) + detail.count);
        }
        continue;
      }

      grouped.set(entry.capabilityId, {
        entry: {
          capabilityId: entry.capabilityId,
          count: entry.count,
          details: [],
        },
        detailCounts: new Map(entry.details.map((detail) => [detail.label, detail.count])),
        targetIds: new Set([target.manifest.id]),
      });
    }
  }

  return [...grouped.values()]
    .map(({ entry, detailCounts, targetIds }) => ({
      ...entry,
      details: [...detailCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
      targetCount: targetIds.size,
    }))
    .sort((left, right) => {
      return right.targetCount - left.targetCount || right.count - left.count || left.capabilityId.localeCompare(right.capabilityId);
    });
}

function renderAnalyzedTarget(target: AnalyzedBenchmarkTarget): string {
  const lines = [
    `Target: ${target.manifest.id}`,
    `Description: ${target.manifest.description}`,
    `Coverage class: ${target.manifest.coverageClass}`,
    `Repository: ${target.manifest.repository.url} @ ${target.manifest.repository.ref}`,
    `Corpus: ${target.manifest.localCorpusPath}`,
    `Analyzed path: ${target.targetPath}`,
    `Status: ${formatTargetStatus(target)}`,
    "",
    "Required Contract:",
    `- required anchors: ${target.evaluation.contract.requiredAnchorTotal}`,
    `- must-find matched: ${target.evaluation.required.mustFind.matched.length}/${target.evaluation.required.mustFind.total}`,
    `- must-not-find clean: ${target.evaluation.required.mustNotFind.clean.length}/${target.evaluation.required.mustNotFind.total}`,
    `- must-skip matched: ${target.evaluation.required.mustSkip.matched.length}/${target.evaluation.required.mustSkip.total}`,
    `- must-not-skip clean: ${target.evaluation.required.mustNotSkip.clean.length}/${target.evaluation.required.mustNotSkip.total}`,
    `- must-diagnose matched: ${target.evaluation.required.mustDiagnose.matched.length}/${target.evaluation.required.mustDiagnose.total}`,
    `- must-not-diagnose clean: ${target.evaluation.required.mustNotDiagnose.clean.length}/${target.evaluation.required.mustNotDiagnose.total}`,
    "",
    "Accepted Capability Debt:",
    `- accepted findings at bound: ${target.evaluation.accepted.findings.present.length}/${target.evaluation.accepted.findings.total}`,
    `- accepted findings reduced: ${target.evaluation.accepted.findings.reduced.length}`,
    `- accepted finding growth: ${target.evaluation.accepted.findings.regressions.length}`,
    `- known skips at bound: ${target.evaluation.accepted.skips.present.length}/${target.evaluation.accepted.skips.total}`,
    `- known skips reduced: ${target.evaluation.accepted.skips.reduced.length}`,
    `- known skip growth: ${target.evaluation.accepted.skips.regressions.length}`,
    "",
    "Unexpected:",
    `- findings: ${target.evaluation.unexpected.findings.length}`,
    `- skips: ${target.evaluation.unexpected.skips.length}`,
    `- diagnostics: ${target.evaluation.unexpected.diagnostics.length}`,
  ];

  if (target.evaluation.trackingSafety) {
    lines.push(
      "",
      "Tracking Upgrade Safety:",
      `- passes: ${target.evaluation.trackingSafety.metrics.passes} (budget <= ${target.evaluation.trackingSafety.budgets.maxPasses})`,
      `- binding churn: ${target.evaluation.trackingSafety.metrics.bindingChanges} (budget <= ${target.evaluation.trackingSafety.budgets.maxBindingChanges})`,
      `- return-summary churn: ${target.evaluation.trackingSafety.metrics.returnSummaryChanges} (budget <= ${target.evaluation.trackingSafety.budgets.maxReturnSummaryChanges})`,
      `- elapsed ms: ${target.evaluation.trackingSafety.metrics.elapsedMs} (info <= ${target.evaluation.trackingSafety.budgets.maxElapsedMs})`,
      `- convergence warned: ${target.evaluation.trackingSafety.metrics.warned ? "yes" : "no"}`,
    );

    if (target.evaluation.trackingSafety.enforced.violations.length > 0) {
      lines.push(
        "",
        "Tracking Safety Regressions:",
        ...target.evaluation.trackingSafety.enforced.violations.map((violation) =>
          `- ${formatTrackingSafetyMetric(violation.metric)}: actual ${violation.actual}, budget ${violation.budget}`),
      );
    }

    if (target.evaluation.trackingSafety.informational.advisories.length > 0) {
      lines.push(
        "",
        "Tracking Safety Advisories:",
        ...target.evaluation.trackingSafety.informational.advisories.map((advisory) =>
          `- ${formatTrackingSafetyMetric(advisory.metric)}: actual ${advisory.actual}, budget ${advisory.budget}`),
      );
    }
  }

  lines.push(
    ...renderTopCounts(
      "Current Engine Gap Signal (Finding Kinds)",
      target.evaluation.gapSignal.findingsByKind,
    ),
  );
  lines.push(
    ...renderTopCounts(
      "Current Engine Gap Signal (Skip Categories)",
      target.evaluation.gapSignal.skipsByCategory,
    ),
  );
  lines.push(
    ...renderCapabilityPriority(
      "Current Capability Gap Signal",
      target.evaluation.capabilityPriority,
    ),
  );

  if (target.evaluation.contract.incomplete) {
    lines.push(
      "",
      "Incomplete Benchmark Contract:",
      "- no required benchmark anchors are configured for this target",
    );
  }

  lines.push(
    ...renderLabelList("Missing Required Findings", target.evaluation.required.mustFind.missing),
  );
  lines.push(
    ...renderCountViolations<BenchmarkFindingMatcher, FindingRecord>(
      "Required Finding Count Violations",
      target.evaluation.required.mustFind.overLimit,
      formatFinding,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkFindingMatcher, FindingRecord>(
      "Must-Not-Find Violations",
      target.evaluation.required.mustNotFind.violations,
      formatFinding,
    ),
  );
  lines.push(
    ...renderLabelList("Missing Required Skips", target.evaluation.required.mustSkip.missing),
  );
  lines.push(
    ...renderCountViolations<BenchmarkSkipMatcher, AuditRecord>(
      "Required Skip Count Violations",
      target.evaluation.required.mustSkip.overLimit,
      formatAudit,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkSkipMatcher, AuditRecord>(
      "Must-Not-Skip Violations",
      target.evaluation.required.mustNotSkip.violations,
      formatAudit,
      describeSkipMatcherPrecision,
    ),
  );
  lines.push(
    ...renderLabelList("Missing Required Diagnostics", target.evaluation.required.mustDiagnose.missing),
  );
  lines.push(
    ...renderCountViolations<BenchmarkDiagnosticMatcher, DiagnosticRecord>(
      "Required Diagnostic Count Violations",
      target.evaluation.required.mustDiagnose.overLimit,
      formatDiagnostic,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkDiagnosticMatcher, DiagnosticRecord>(
      "Must-Not-Diagnose Violations",
      target.evaluation.required.mustNotDiagnose.violations,
      formatDiagnostic,
    ),
  );

  lines.push(
    ...renderMatcherRecords<BenchmarkFindingMatcher, FindingRecord>(
      "Accepted Findings",
      target.evaluation.accepted.findings.present,
      formatFinding,
      describeFindingMatcherPrecision,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkFindingMatcher, FindingRecord>(
      "Reduced Accepted Findings",
      target.evaluation.accepted.findings.reduced,
      formatFinding,
      describeFindingMatcherPrecision,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkSkipMatcher, AuditRecord>(
      "Known Skips",
      target.evaluation.accepted.skips.present,
      formatAudit,
      describeSkipMatcherPrecision,
    ),
  );
  lines.push(
    ...renderMatcherRecords<BenchmarkSkipMatcher, AuditRecord>(
      "Reduced Known Skips",
      target.evaluation.accepted.skips.reduced,
      formatAudit,
      describeSkipMatcherPrecision,
    ),
  );

  lines.push(
    ...renderLabelList("Resolved Accepted Findings", target.evaluation.accepted.findings.resolved),
  );
  lines.push(
    ...renderLabelList("Resolved Known Skips", target.evaluation.accepted.skips.resolved),
  );
  lines.push(
    ...renderCountViolations<BenchmarkFindingMatcher, FindingRecord>(
      "Accepted Finding Growth",
      target.evaluation.accepted.findings.regressions,
      formatFinding,
    ),
  );
  lines.push(
    ...renderCountViolations<BenchmarkSkipMatcher, AuditRecord>(
      "Known Skip Growth",
      target.evaluation.accepted.skips.regressions,
      formatAudit,
    ),
  );

  if (target.evaluation.unexpected.findings.length > 0) {
    lines.push("", "Unexpected Findings:");
    for (const record of target.evaluation.unexpected.findings) {
      lines.push(`- ${formatFinding(record)}`);
    }
  }

  if (target.evaluation.unexpected.skips.length > 0) {
    lines.push("", "Unexpected Skips:");
    for (const record of target.evaluation.unexpected.skips) {
      lines.push(`- ${formatAudit(record)}`);
    }
  }

  if (target.evaluation.unexpected.diagnostics.length > 0) {
    lines.push("", "Unexpected Diagnostics:");
    for (const record of target.evaluation.unexpected.diagnostics) {
      lines.push(`- ${formatDiagnostic(record)}`);
    }
  }

  lines.push("", "Analysis Detail:", renderResult(target.result, "text"));

  return lines.join("\n");
}

export function renderBenchmarkReport(result: BenchmarkWorkspaceRun): string {
  const missingTargets = result.targets.filter((target) => target.state === BENCHMARK_TARGET_STATE.missingCorpus);
  const invalidTargets = result.targets.filter((target) => target.state === BENCHMARK_TARGET_STATE.invalidTarget);
  const analyzedTargets = result.targets.filter((target) => target.state === BENCHMARK_TARGET_STATE.analyzed);

  const lines = [
    "rogue-lint benchmark",
    "",
    `Configured targets: ${result.manifests.length}`,
    `Installed corpora: ${analyzedTargets.length + invalidTargets.length}`,
    `Missing corpora: ${missingTargets.length}`,
  ];

  if (result.noCorpusInstalled) {
    lines.push(
      "",
      "No benchmark corpus is installed locally.",
      `See ${result.docsPath} for setup instructions.`,
    );

    if (missingTargets.length > 0) {
      lines.push("", "Configured Missing Corpora:");
      for (const target of missingTargets) {
        lines.push(`- ${target.manifest.id}: ${target.manifest.localCorpusPath}`);
      }
    }

    return lines.join("\n");
  }

  const failedTargets = analyzedTargets.filter((target) => target.exitCode === 1).length + invalidTargets.length;
  lines.push(`Failed targets: ${failedTargets}`);
  lines.push(`Passed targets: ${analyzedTargets.length - analyzedTargets.filter((target) => target.exitCode === 1).length}`);
  lines.push(
    `Tracking safety regressions: ${analyzedTargets.filter((target) => (target.evaluation.trackingSafety?.enforced.violations.length ?? 0) > 0).length}`,
  );
  lines.push(
    `Tracking safety advisories: ${analyzedTargets.filter((target) => (target.evaluation.trackingSafety?.informational.advisories.length ?? 0) > 0).length}`,
  );

  const capabilityWorklist = collectWorkspaceCapabilityPriority(analyzedTargets);
  if (capabilityWorklist.length > 0) {
    lines.push(
      "",
      "Prioritized Capability Worklist:",
      "Provider-attributed gap records are grouped by capability family below; raw kind/category worklist follows for source-level detail.",
      ...capabilityWorklist.map((entry) => {
        const detailSummary = formatCapabilityPriorityDetails(entry.details);
        return `- capability ${entry.capabilityId}: ${entry.count} `
          + `record${entry.count === 1 ? "" : "s"} across ${entry.targetCount} `
          + `target${entry.targetCount === 1 ? "" : "s"}`
          + (detailSummary.length > 0 ? ` (${detailSummary})` : "");
      }),
    );
  }

  const worklist = collectWorkspaceGapPriority(analyzedTargets);
  if (worklist.length > 0) {
    lines.push(
      "",
      "Prioritized Engine Gap Worklist:",
      "See per-target Accepted Findings, Known Skips, and Unexpected sections below for raw records.",
      `Coarse accepted and known matchers are labeled as '${COARSE_MATCHER_NOTE}'.`,
      ...worklist.map((entry) =>
        `- ${formatBenchmarkGapPriorityScope(entry.scope)} ${entry.label}: ${entry.count} `
        + `record${entry.count === 1 ? "" : "s"} across ${entry.targetCount} `
        + `target${entry.targetCount === 1 ? "" : "s"}`),
    );
  }

  if (missingTargets.length > 0) {
    lines.push("", "Missing Corpora:");
    for (const target of missingTargets) {
      lines.push(`- ${target.manifest.id}: ${target.manifest.localCorpusPath}`);
    }
  }

  if (invalidTargets.length > 0) {
    lines.push("", "Invalid Benchmark Targets:");
    for (const target of invalidTargets) {
      lines.push(`- ${target.manifest.id}: ${target.problem}`);
      if (target.error) {
        lines.push(`  ${target.error}`);
      }
    }
  }

  for (const target of analyzedTargets) {
    lines.push("", "---", "", renderAnalyzedTarget(target));
  }

  return lines.join("\n");
}
