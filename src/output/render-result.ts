import path from "node:path";

import type { AnalysisResult, AuditRecord, FindingRecord, Location, ReportFormat } from "../types.js";

interface GroupedLeafPresentation {
  label: string;
  location?: Location;
  reason: string;
}

interface TextRenderOptions {
  supportsTerminalLinks?: boolean;
}

function getRecordFile(record: { location?: { file: string }; entity?: { location: { file: string } } }): string {
  return record.location?.file ?? record.entity?.location.file ?? "(unknown)";
}

function qualifyLabel(owner: string | undefined, name: string): string {
  if (!owner || name === owner || name.startsWith(`${owner}.`) || name.startsWith(`${owner}[`)) {
    return name;
  }

  return name.startsWith("[") ? `${owner}${name}` : `${owner}.${name}`;
}

function createFindingLeafPresentation(finding: FindingRecord): GroupedLeafPresentation {
  const label = finding.entity.kind === "file"
    ? finding.entity.name
    : qualifyLabel(finding.entity.owner, finding.entity.name);
  return {
    label,
    location: finding.entity.location,
    reason: finding.reason,
  };
}

function createAuditLeafPresentation(record: AuditRecord): GroupedLeafPresentation {
  return {
    label: qualifyLabel(record.owner, record.name),
    location: record.location,
    reason: record.reason,
  };
}

function compareLeafPresentation(left: GroupedLeafPresentation, right: GroupedLeafPresentation): number {
  const leftLine = left.location?.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.location?.line ?? Number.MAX_SAFE_INTEGER;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }

  const leftColumn = left.location?.column ?? Number.MAX_SAFE_INTEGER;
  const rightColumn = right.location?.column ?? Number.MAX_SAFE_INTEGER;
  if (leftColumn !== rightColumn) {
    return leftColumn - rightColumn;
  }

  return `${left.label} ${left.reason}`.localeCompare(`${right.label} ${right.reason}`);
}

function detectTerminalLinkSupport(): boolean {
  return process.env.TERM_PROGRAM === "vscode" && Boolean(process.stdout.isTTY);
}

function resolveTextRenderOptions(options?: TextRenderOptions): Required<TextRenderOptions> {
  return {
    supportsTerminalLinks: options?.supportsTerminalLinks ?? detectTerminalLinkSupport(),
  };
}

function createVsCodeUri(rootPath: string, location: Location): string {
  const absolutePath = path.resolve(rootPath, location.file).replace(/\\/g, "/");
  const uriPath = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
  return `vscode://file${encodeURI(uriPath)}:${location.line}:${location.column}`;
}

function wrapTerminalLink(label: string, target: string): string {
  return `\u001B]8;;${target}\u0007${label}\u001B]8;;\u0007`;
}

function renderGroupedLeaf(leaf: GroupedLeafPresentation, rootPath: string, options: Required<TextRenderOptions>): string {
  const label = leaf.location && options.supportsTerminalLinks
    ? wrapTerminalLink(leaf.label, createVsCodeUri(rootPath, leaf.location))
    : leaf.label;

  if (!leaf.location) {
    return `${label} - ${leaf.reason}`;
  }

  if (options.supportsTerminalLinks) {
    return `${label} - ${leaf.reason}`;
  }

  return `${leaf.location.line}:${leaf.location.column} ${label} - ${leaf.reason}`;
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
  rootPath: string,
  options: Required<TextRenderOptions>,
  createLeafPresentation: (record: T) => GroupedLeafPresentation,
): string[] {
  if (records.length === 0) {
    return [];
  }

  const lines = ["", `${title}:`];

  for (const [kind, files] of groupByKindAndFile(records)) {
    lines.push(kind);
    for (const [file, entries] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${file}`);
      const leafPresentations = entries
        .map((entry) => createLeafPresentation(entry))
        .sort(compareLeafPresentation);
      for (const leaf of leafPresentations) {
        lines.push(`    ${renderGroupedLeaf(leaf, rootPath, options)}`);
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
export function renderResult(result: AnalysisResult, format: ReportFormat, showKept = true, options?: TextRenderOptions): string {

  if (format === "json") {
    return JSON.stringify(createCliVisibleJsonResult(result, showKept), null, 2);
  }

  const textRenderOptions = resolveTextRenderOptions(options);

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

  lines.push(...renderGroupedSection("Findings", result.findings, result.target, textRenderOptions, createFindingLeafPresentation));
  if (showKept) {
    lines.push(...renderGroupedSection("Kept", result.kept, result.target, textRenderOptions, createAuditLeafPresentation));
  }
  lines.push(...renderGroupedSection("Skipped", result.skipped, result.target, textRenderOptions, createAuditLeafPresentation));

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
