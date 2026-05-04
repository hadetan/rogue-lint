import type { AnalysisResult, FindingRecord, ReportFormat } from "./types.js";

function formatFinding(finding: FindingRecord): string {
  return `${finding.kind.padEnd(20)} ${finding.entity.location.file}:${finding.entity.location.line}:${finding.entity.location.column} ${finding.entity.name}`;
}

export function renderResult(result: AnalysisResult, format: ReportFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    "dead-lint",
    "",
    `Mode: ${result.mode}`,
    `Files analyzed: ${result.summary.filesAnalyzed}`,
    `Reachable files: ${result.summary.reachableFiles}`,
    `Findings: ${result.summary.findings}`,
    `Kept: ${result.summary.kept}`,
    `Skipped: ${result.summary.skipped}`,
  ];

  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    lines.push(...result.findings.map(formatFinding));
  }

  if (result.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    lines.push(
      ...result.diagnostics.map((diagnostic) =>
        diagnostic.file ? `${diagnostic.kind} ${diagnostic.file}: ${diagnostic.message}` : `${diagnostic.kind}: ${diagnostic.message}`,
      ),
    );
  }

  return lines.join("\n");
}
