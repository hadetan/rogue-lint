import type { AnalysisResult, AuditRecord, FindingRecord, ReportFormat } from "../types.js";

const REPORT_KIND_WIDTH = 28;

function formatFinding(finding: FindingRecord): string {
  return `${finding.kind.padEnd(REPORT_KIND_WIDTH)} ${finding.entity.location.file}:${finding.entity.location.line}:${finding.entity.location.column} ${finding.entity.name} - ${finding.reason}`;
}

function formatAudit(record: AuditRecord): string {
  if (!record.location) {
    return `${record.kind.padEnd(REPORT_KIND_WIDTH)} ${record.name} - ${record.reason}`;
  }

  return `${record.kind.padEnd(REPORT_KIND_WIDTH)} ${record.location.file}:${record.location.line}:${record.location.column} ${record.name} - ${record.reason}`;
}

function getRecordFile(record: { location?: { file: string }; entity?: { location: { file: string } } }): string {
  return record.location?.file ?? record.entity?.location.file ?? "(unknown)";
}

function groupByKindAndFile<T extends { kind: string; location?: { file: string }; entity?: { location: { file: string } } }>(
  records: T[],
): Array<[string, Map<string, T[]>]> {
  const grouped = new Map<string, Map<string, T[]>>();

  for (const record of records) {
    const byFile = grouped.get(record.kind) ?? new Map<string, T[]>();
    const file = getRecordFile(record);
    const entries = byFile.get(file) ?? [];
    entries.push(record);
    byFile.set(file, entries);
    grouped.set(record.kind, byFile);
  }

  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderGroupedSection<T extends { kind: string; location?: { file: string }; entity?: { location: { file: string } } }>(
  title: string,
  records: T[],
  formatRecord: (record: T) => string,
): string[] {
  if (records.length === 0) {
    return [];
  }

  const lines = ["", `${title}:`];

  for (const [kind, files] of groupByKindAndFile(records)) {
    lines.push(kind);
    for (const [file, entries] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${file}`);
      for (const entry of entries.sort((left, right) => formatRecord(left).localeCompare(formatRecord(right)))) {
        lines.push(`    ${formatRecord(entry)}`);
      }
    }
  }

  return lines;
}

function createCliVisibleJsonResult(result: AnalysisResult, showKept: boolean): object {
  if (showKept) {
    return result;
  }

  return {
    tool: result.tool,
    version: result.version,
    target: result.target,
    mode: result.mode,
    exitCodes: result.exitCodes,
    generatedAt: result.generatedAt,
    summary: {
      filesAnalyzed: result.summary.filesAnalyzed,
      reachableFiles: result.summary.reachableFiles,
      findings: result.summary.findings,
      skipped: result.summary.skipped,
      byKind: result.summary.byKind,
    },
    findings: result.findings,
    skipped: result.skipped,
    diagnostics: result.diagnostics,
  };
}

/**
 * Renders an analysis result as either stable JSON or grouped human-readable text output.
 */
export function renderResult(result: AnalysisResult, format: ReportFormat, showKept = true): string {

  if (format === "json") {
    return JSON.stringify(createCliVisibleJsonResult(result, showKept), null, 2);
  }

  const lines = [
    "rogue-lint",
    "",
    `Mode: ${result.mode}`,
    `Files analyzed: ${result.summary.filesAnalyzed}`,
    `Reachable files: ${result.summary.reachableFiles}`,
    `Findings: ${result.summary.findings}`,
    `Skipped: ${result.summary.skipped}`,
  ];

  if (showKept) {
    lines.splice(6, 0, `Kept: ${result.summary.kept}`);
  }

  lines.push(...renderGroupedSection("Findings", result.findings, formatFinding));
  if (showKept) {
    lines.push(...renderGroupedSection("Kept", result.kept, formatAudit));
  }
  lines.push(...renderGroupedSection("Skipped", result.skipped, formatAudit));

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
