import type ts from "typescript";

import type { AnalysisResult } from "../types.js";
import type { ReferenceCaches } from "./analyzers/support.js";
import type {
  AnalysisCapabilityFactRecord,
  AnalysisCapabilityLedger,
} from "./capabilities/types.js";
import type {
  TrackingRunArtifacts,
  TrackingRuntimeSummary,
} from "./tracking/contracts.js";

interface AnalysisResultMetadata {
  capabilityLedger?: AnalysisCapabilityLedger;
  trackingRuntimeSummary?: TrackingRuntimeSummary;
}

export interface AnalysisRunState {
  capabilityFacts: Map<string, AnalysisCapabilityFactRecord>;
  semanticDiagnosticsByFile: Map<string, readonly ts.Diagnostic[]>;
  referenceCaches: ReferenceCaches;
  trackingArtifacts?: TrackingRunArtifacts;
  capabilityLedger?: AnalysisCapabilityLedger;
  trackingRuntimeSummary?: TrackingRuntimeSummary;
}

interface AnalysisResultWithInternals extends AnalysisResult {
  [ANALYSIS_RESULT_INTERNALS_SYMBOL]?: AnalysisResultMetadata;
}

const ANALYSIS_RESULT_INTERNALS_SYMBOL = Symbol("analysis-result-internals");

class AnalysisRunStateRecord implements AnalysisRunState {
  capabilityFacts = new Map<string, AnalysisCapabilityFactRecord>();

  semanticDiagnosticsByFile = new Map<string, readonly ts.Diagnostic[]>();

  referenceCaches: ReferenceCaches = {
    hasReference: new Map(),
    exportReferences: new Map(),
    referenceSummaries: new Map(),
    usage: new Map(),
  };

  trackingArtifacts?: TrackingRunArtifacts;

  capabilityLedger?: AnalysisCapabilityLedger;

  trackingRuntimeSummary?: TrackingRuntimeSummary;
}

export function createAnalysisRunState(): AnalysisRunState {
  return new AnalysisRunStateRecord();
}

function ensureAnalysisResultInternals(result: AnalysisResult): AnalysisResultMetadata {
  const resultWithInternals = result as AnalysisResultWithInternals;
  const existing = resultWithInternals[ANALYSIS_RESULT_INTERNALS_SYMBOL];
  if (existing) {
    return existing;
  }

  const created: AnalysisResultMetadata = {};
  Object.defineProperty(resultWithInternals, ANALYSIS_RESULT_INTERNALS_SYMBOL, {
    value: created,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return created;
}

export function attachAnalysisRunResultMetadata(
  result: AnalysisResult,
  metadata: AnalysisResultMetadata,
): void {
  Object.assign(ensureAnalysisResultInternals(result), metadata);
}

export function getAnalysisRunResultMetadata(
  result: AnalysisResult,
): AnalysisResultMetadata | undefined {
  return (result as AnalysisResultWithInternals)[ANALYSIS_RESULT_INTERNALS_SYMBOL];
}
