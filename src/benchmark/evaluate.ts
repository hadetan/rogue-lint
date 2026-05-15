import type {
  AnalysisResult,
  AuditRecord,
  DiagnosticRecord,
  FindingRecord,
  FindingKind,
  SkipCategory,
} from "../types.js";
import { getAnalysisCapabilityLedger } from "../engine/capabilities/providers.js";
import {
  createDiagnosticCapabilityRecordId,
  type AnalysisCapabilityId,
  type AnalysisCapabilityLedger,
} from "../engine/capabilities/types.js";
import { uniqueById } from "../shared/general-utils.js";
import type {
  AcceptedDebtResult,
  BenchmarkCapabilityPriorityDetail,
  BenchmarkCapabilityPriorityEntry,
  BenchmarkDiagnosticMatcher,
  BenchmarkEvaluation,
  BenchmarkExpectations,
  BenchmarkFindingMatcher,
  BenchmarkGapPriorityEntry,
  BenchmarkGapPriorityScope,
  BenchmarkSkipMatcher,
  CountedMatcherRecords,
  ExpectationCountViolation,
  NegativeExpectationResult,
  PositiveExpectationResult,
} from "./types.js";

interface CountMatcherFields {
  minCount?: number;
  maxCount?: number;
}

function matchesFinding(record: FindingRecord, matcher: BenchmarkFindingMatcher): boolean {
  return (
    (matcher.id === undefined || record.id === matcher.id)
    && (matcher.kind === undefined || record.kind === matcher.kind)
    && (matcher.entityKind === undefined || record.entity.kind === matcher.entityKind)
    && (matcher.file === undefined || record.entity.location.file === matcher.file)
    && (matcher.name === undefined || record.entity.name === matcher.name)
    && (matcher.owner === undefined || record.entity.owner === matcher.owner)
    && (matcher.reasonIncludes === undefined || record.reason.includes(matcher.reasonIncludes))
    && (matcher.messageIncludes === undefined || record.message.includes(matcher.messageIncludes))
  );
}

function matchesSkip(record: AuditRecord, matcher: BenchmarkSkipMatcher): boolean {
  return (
    (matcher.id === undefined || record.id === matcher.id)
    && (matcher.kind === undefined || record.kind === matcher.kind)
    && (matcher.file === undefined || record.location?.file === matcher.file)
    && (matcher.name === undefined || record.name === matcher.name)
    && (matcher.owner === undefined || record.owner === matcher.owner)
    && (matcher.category === undefined || record.category === matcher.category)
    && (matcher.reasonIncludes === undefined || record.reason.includes(matcher.reasonIncludes))
  );
}

function matchesDiagnostic(record: DiagnosticRecord, matcher: BenchmarkDiagnosticMatcher): boolean {
  return (
    (matcher.kind === undefined || record.kind === matcher.kind)
    && (matcher.fileIncludes === undefined || record.file?.includes(matcher.fileIncludes) === true)
    && (matcher.messageIncludes === undefined || record.message.includes(matcher.messageIncludes))
  );
}

function matchesAny<Record, Matcher>(
  record: Record,
  matchers: Matcher[],
  matches: (candidate: Record, matcher: Matcher) => boolean,
): boolean {
  return matchers.some((matcher) => matches(record, matcher));
}

function collectMatcherRecords<Record, Matcher>(
  records: Record[],
  matchers: Matcher[],
  matches: (candidate: Record, matcher: Matcher) => boolean,
): Array<CountedMatcherRecords<Matcher, Record>> {
  return matchers.map((matcher) => {
    const matchedRecords = records.filter((record) => matches(record, matcher));
    return {
      matcher,
      records: matchedRecords,
      actualCount: matchedRecords.length,
    };
  });
}

function createCountViolation<Matcher extends CountMatcherFields, Record>(
  entry: CountedMatcherRecords<Matcher, Record>,
): ExpectationCountViolation<Matcher, Record> {
  return {
    ...entry,
    minCount: entry.matcher.minCount,
    maxCount: entry.matcher.maxCount,
  };
}

function evaluatePositive<Record, Matcher extends CountMatcherFields>(
  records: Record[],
  matchers: Matcher[],
  matches: (candidate: Record, matcher: Matcher) => boolean,
): PositiveExpectationResult<Matcher, Record> {
  const grouped = collectMatcherRecords(records, matchers, matches);

  return {
    total: matchers.length,
    matched: grouped.filter((entry) => {
      const minCount = entry.matcher.minCount ?? 1;
      const maxCount = entry.matcher.maxCount;
      return entry.actualCount >= minCount && (maxCount === undefined || entry.actualCount <= maxCount);
    }),
    missing: grouped
      .filter((entry) => entry.actualCount < (entry.matcher.minCount ?? 1))
      .map((entry) => entry.matcher),
    overLimit: grouped
      .filter((entry) => entry.matcher.maxCount !== undefined && entry.actualCount > entry.matcher.maxCount)
      .map((entry) => createCountViolation(entry)),
  };
}

function evaluateNegative<Record, Matcher extends CountMatcherFields>(
  records: Record[],
  matchers: Matcher[],
  matches: (candidate: Record, matcher: Matcher) => boolean,
): NegativeExpectationResult<Matcher, Record> {
  const grouped = collectMatcherRecords(records, matchers, matches);

  return {
    total: matchers.length,
    clean: grouped
      .filter((entry) => entry.actualCount <= (entry.matcher.maxCount ?? 0))
      .map((entry) => entry.matcher),
    violations: grouped
      .filter((entry) => entry.actualCount > (entry.matcher.maxCount ?? 0))
      .map((entry) => createCountViolation(entry)),
  };
}

function evaluateAccepted<Record, Matcher extends CountMatcherFields>(
  records: Record[],
  matchers: Matcher[],
  matches: (candidate: Record, matcher: Matcher) => boolean,
): AcceptedDebtResult<Matcher, Record> {
  const grouped = collectMatcherRecords(records, matchers, matches);

  return {
    total: matchers.length,
    present: grouped.filter((entry) => entry.actualCount > 0 && (entry.matcher.maxCount === undefined || entry.actualCount === entry.matcher.maxCount)),
    reduced: grouped.filter((entry) => entry.actualCount > 0 && entry.matcher.maxCount !== undefined && entry.actualCount < entry.matcher.maxCount),
    resolved: grouped.filter((entry) => entry.actualCount === 0).map((entry) => entry.matcher),
    regressions: grouped
      .filter((entry) => entry.matcher.maxCount !== undefined && entry.actualCount > entry.matcher.maxCount)
      .map((entry) => createCountViolation(entry)),
  };
}

function countKinds<T extends string>(values: T[]): Array<[T, number]> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function gapPriorityRank(scope: BenchmarkGapPriorityScope): number {
  switch (scope) {
    case "accepted-finding-growth":
    case "known-skip-growth":
      return 0;
    case "unexpected-finding":
    case "unexpected-diagnostic":
    case "unexpected-skip":
      return 1;
    case "accepted-finding":
    case "known-skip":
      return 2;
    default:
      return 3;
  }
}

function groupFindingPriority(
  records: FindingRecord[],
  scope: Extract<BenchmarkGapPriorityScope, "accepted-finding" | "accepted-finding-growth" | "unexpected-finding">,
): BenchmarkGapPriorityEntry[] {
  return countKinds(records.map((record) => record.kind)).map(([label, count]) => ({
    scope,
    label,
    count,
  }));
}

function groupSkipPriority(
  records: AuditRecord[],
  scope: Extract<BenchmarkGapPriorityScope, "known-skip" | "known-skip-growth" | "unexpected-skip">,
): BenchmarkGapPriorityEntry[] {
  return countKinds(records.map((record) => record.category ?? record.kind)).map(([label, count]) => ({
    scope,
    label,
    count,
  }));
}

function getDiagnosticPriorityLabel(record: DiagnosticRecord): string {
  const capabilityCoverageMatch = /^capability coverage gap \(([^)]+)\):/.exec(record.message);
  if (capabilityCoverageMatch) {
    return `capability coverage gap (${capabilityCoverageMatch[1]})`;
  }

  return record.kind;
}

function groupDiagnosticPriority(
  records: DiagnosticRecord[],
  scope: Extract<BenchmarkGapPriorityScope, "unexpected-diagnostic">,
): BenchmarkGapPriorityEntry[] {
  return countKinds(records.map(getDiagnosticPriorityLabel)).map(([label, count]) => ({
    scope,
    label,
    count,
  }));
}

function sortGapPriority(entries: BenchmarkGapPriorityEntry[]): BenchmarkGapPriorityEntry[] {
  return [...entries].sort((left, right) => {
    const rankDelta = gapPriorityRank(left.scope) - gapPriorityRank(right.scope);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return right.count - left.count || left.label.localeCompare(right.label);
  });
}

function sortCapabilityPriorityDetails(
  details: BenchmarkCapabilityPriorityDetail[],
): BenchmarkCapabilityPriorityDetail[] {
  return [...details].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function groupCapabilityPriority(
  findings: FindingRecord[],
  skips: AuditRecord[],
  diagnostics: DiagnosticRecord[],
  capabilityLedger: AnalysisCapabilityLedger | undefined,
): BenchmarkCapabilityPriorityEntry[] {
  if (!capabilityLedger) {
    return [];
  }

  const grouped = new Map<
    AnalysisCapabilityId,
    { count: number; details: Map<string, number> }
  >();

  const addRecord = (capabilityId: AnalysisCapabilityId | undefined, label: string): void => {
    if (!capabilityId) {
      return;
    }

    const entry = grouped.get(capabilityId) ?? { count: 0, details: new Map<string, number>() };
    entry.count += 1;
    entry.details.set(label, (entry.details.get(label) ?? 0) + 1);
    grouped.set(capabilityId, entry);
  };

  for (const record of findings) {
    addRecord(
      capabilityLedger.recordCapabilityById.get(record.id),
      capabilityLedger.recordDetailById.get(record.id) ?? record.kind,
    );
  }

  for (const record of skips) {
    addRecord(
      capabilityLedger.recordCapabilityById.get(record.id),
      capabilityLedger.recordDetailById.get(record.id) ?? record.category ?? record.kind,
    );
  }

  for (const record of diagnostics) {
    const diagnosticRecordId = createDiagnosticCapabilityRecordId(record);
    addRecord(
      capabilityLedger.recordCapabilityById.get(diagnosticRecordId),
      capabilityLedger.recordDetailById.get(diagnosticRecordId) ?? getDiagnosticPriorityLabel(record),
    );
  }

  return [...grouped.entries()]
    .map(([capabilityId, entry]) => ({
      capabilityId,
      count: entry.count,
      details: sortCapabilityPriorityDetails(
        [...entry.details.entries()].map(([label, count]) => ({ label, count })),
      ),
    }))
    .sort((left, right) => right.count - left.count || left.capabilityId.localeCompare(right.capabilityId));
}

export function evaluateBenchmarkExpectations(
  result: AnalysisResult,
  expectations: BenchmarkExpectations,
): BenchmarkEvaluation {
  const findings = result.findings;
  const skips = result.skipped;
  const diagnostics = result.diagnostics;
  const capabilityLedger = getAnalysisCapabilityLedger(result);

  const requiredAnchorTotal =
    expectations.mustFind.length
    + expectations.mustNotFind.length
    + expectations.mustSkip.length
    + expectations.mustNotSkip.length
    + expectations.mustDiagnose.length
    + expectations.mustNotDiagnose.length;
  const incompleteContract = requiredAnchorTotal === 0;

  const mustFind = evaluatePositive(findings, expectations.mustFind, matchesFinding);
  const mustNotFind = evaluateNegative(findings, expectations.mustNotFind, matchesFinding);
  const acceptedFindings = evaluateAccepted(findings, expectations.acceptedFindings, matchesFinding);

  const mustSkip = evaluatePositive(skips, expectations.mustSkip, matchesSkip);
  const mustNotSkip = evaluateNegative(skips, expectations.mustNotSkip, matchesSkip);
  const knownSkips = evaluateAccepted(skips, expectations.knownSkips, matchesSkip);

  const mustDiagnose = evaluatePositive(diagnostics, expectations.mustDiagnose, matchesDiagnostic);
  const mustNotDiagnose = evaluateNegative(diagnostics, expectations.mustNotDiagnose, matchesDiagnostic);

  const unexpectedFindings = findings.filter((record) =>
    !matchesAny(record, expectations.mustFind, matchesFinding)
    && !matchesAny(record, expectations.acceptedFindings, matchesFinding)
    && !matchesAny(record, expectations.mustNotFind, matchesFinding),
  );
  const unexpectedSkips = skips.filter((record) =>
    !matchesAny(record, expectations.mustSkip, matchesSkip)
    && !matchesAny(record, expectations.mustNotSkip, matchesSkip)
    && !matchesAny(record, expectations.knownSkips, matchesSkip),
  );
  const unexpectedDiagnostics = diagnostics.filter((record) =>
    !matchesAny(record, expectations.mustDiagnose, matchesDiagnostic)
    && !matchesAny(record, expectations.mustNotDiagnose, matchesDiagnostic),
  );

  const gapFindingRecords = uniqueById([
    ...acceptedFindings.present.flatMap((entry) => entry.records),
    ...acceptedFindings.reduced.flatMap((entry) => entry.records),
    ...acceptedFindings.regressions.flatMap((entry) => entry.records),
    ...unexpectedFindings,
  ]);
  const gapSkipRecords = uniqueById([
    ...knownSkips.present.flatMap((entry) => entry.records),
    ...knownSkips.reduced.flatMap((entry) => entry.records),
    ...knownSkips.regressions.flatMap((entry) => entry.records),
    ...unexpectedSkips,
  ]);

  const findingsByKind = countKinds(gapFindingRecords.map((record) => record.kind));
  const skipsByCategory = countKinds(
    gapSkipRecords
      .map((record) => record.category)
      .filter((category): category is SkipCategory => category !== undefined),
  );

  const failed =
    incompleteContract
    || mustFind.missing.length > 0
    || mustFind.overLimit.length > 0
    || mustNotFind.violations.length > 0
    || mustSkip.missing.length > 0
    || mustSkip.overLimit.length > 0
    || mustNotSkip.violations.length > 0
    || mustDiagnose.missing.length > 0
    || mustDiagnose.overLimit.length > 0
    || mustNotDiagnose.violations.length > 0
    || acceptedFindings.regressions.length > 0
    || knownSkips.regressions.length > 0
    || unexpectedFindings.length > 0
    || unexpectedSkips.length > 0
    || unexpectedDiagnostics.length > 0;

  const gapPriority = sortGapPriority([
    ...groupFindingPriority(unexpectedFindings, "unexpected-finding"),
    ...groupDiagnosticPriority(unexpectedDiagnostics, "unexpected-diagnostic"),
    ...groupSkipPriority(unexpectedSkips, "unexpected-skip"),
    ...groupFindingPriority(
      [
        ...acceptedFindings.present.flatMap((entry) => entry.records),
        ...acceptedFindings.reduced.flatMap((entry) => entry.records),
      ],
      "accepted-finding",
    ),
    ...groupFindingPriority(
      acceptedFindings.regressions.flatMap((entry) => entry.records),
      "accepted-finding-growth",
    ),
    ...groupSkipPriority(
      [
        ...knownSkips.present.flatMap((entry) => entry.records),
        ...knownSkips.reduced.flatMap((entry) => entry.records),
      ],
      "known-skip",
    ),
    ...groupSkipPriority(
      knownSkips.regressions.flatMap((entry) => entry.records),
      "known-skip-growth",
    ),
  ]);
  const capabilityPriority = groupCapabilityPriority(
    gapFindingRecords,
    gapSkipRecords,
    unexpectedDiagnostics,
    capabilityLedger,
  );

  return {
    contract: {
      requiredAnchorTotal,
      incomplete: incompleteContract,
    },
    required: {
      mustFind,
      mustNotFind,
      mustSkip,
      mustNotSkip,
      mustDiagnose,
      mustNotDiagnose,
    },
    accepted: {
      findings: acceptedFindings,
      skips: knownSkips,
    },
    unexpected: {
      findings: unexpectedFindings,
      skips: unexpectedSkips,
      diagnostics: unexpectedDiagnostics,
    },
    gapSignal: {
      findingsByKind: findingsByKind as Array<[FindingKind, number]>,
      skipsByCategory: skipsByCategory as Array<[SkipCategory, number]>,
    },
    gapPriority,
    capabilityPriority,
    failed,
  };
}
