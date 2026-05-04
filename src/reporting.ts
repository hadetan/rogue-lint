import type { AnalysisResult, AuditRecord, FindingRecord, ReportFormat } from "./types.js";

function formatFinding(finding: FindingRecord): string {
  return `${finding.kind.padEnd(20)} ${finding.entity.location.file}:${finding.entity.location.line}:${finding.entity.location.column} ${finding.entity.name}`;
}

function formatAudit(record: AuditRecord): string {
  if (!record.location) {
    return `${record.kind.padEnd(20)} ${record.name}`;
  }

  return `${record.kind.padEnd(20)} ${record.location.file}:${record.location.line}:${record.location.column} ${record.name}`;
}

function groupByKindAndFile<T extends { kind: string; location?: { file: string } }>(
  records: T[],
): Array<[string, Map<string, T[]>]> {
  const grouped = new Map<string, Map<string, T[]>>();

  for (const record of records) {
    const byFile = grouped.get(record.kind) ?? new Map<string, T[]>();
    const file = record.location?.file ?? "(unknown)";
    const entries = byFile.get(file) ?? [];
    entries.push(record);
    byFile.set(file, entries);
    grouped.set(record.kind, byFile);
  }

  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderGroupedSection<T extends { kind: string; location?: { file: string } }>(
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

  lines.push(...renderGroupedSection("Findings", result.findings, formatFinding));
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
