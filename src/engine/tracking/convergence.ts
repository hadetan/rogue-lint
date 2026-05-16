import { diffTrackedBindingMaps } from "./bindings.js";
import { diffCallableReturnSummaryMaps } from "./callables.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "./model.js";
import {
  createConvergenceGuardExceeded,
  createConvergenceWarning,
  type TrackingContractDiagnostic,
  type TrackingConvergenceDebugTrace,
  type TrackingConvergencePassTrace,
  type TrackingContractDiagnosticDetails,
} from "./contracts.js";

export type TrackingConvergenceState = {
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: Map<string, CallableReturnSummary>;
};

export type TrackingConvergenceOptions = {
  warningPassThreshold?: number;
  maxPasses?: number;
  churnSampleLimit?: number;
  tracePasses?: boolean;
};

type TrackingConvergenceResult = {
  passes: number;
  warningPassThreshold: number;
  maxPasses: number;
  warned: boolean;
  elapsedMs: number;
  churn: {
    bindingChanges: number;
    bindingChangedPasses: number;
    returnSummaryChanges: number;
    returnSummaryChangedPasses: number;
  };
  widening: {
    bindingChanges: number;
    returnSummaryChanges: number;
  };
  unstableSamples: {
    bindings: string[];
    returnSummaries: string[];
  };
  debugTrace?: TrackingConvergenceDebugTrace;
  diagnostics: TrackingContractDiagnostic[];
};

class TrackingConvergenceError extends Error {
  readonly diagnostic: TrackingContractDiagnostic;

  constructor(message: string, details?: TrackingContractDiagnosticDetails) {
    super(message);
    this.name = "TrackingConvergenceError";
    this.diagnostic = createConvergenceGuardExceeded(message, details);
  }
}

interface NormalizedTrackingConvergenceOptions {
  warningPassThreshold: number;
  maxPasses: number;
  churnSampleLimit: number;
  tracePasses: boolean;
}

function normalizeOptions(options: TrackingConvergenceOptions | undefined): NormalizedTrackingConvergenceOptions {
  return {
    warningPassThreshold: Math.max(1, options?.warningPassThreshold ?? 12),
    maxPasses: Math.max(1, options?.maxPasses ?? 50),
    churnSampleLimit: Math.max(1, options?.churnSampleLimit ?? 5),
    tracePasses: options?.tracePasses ?? false,
  };
}

function mergeSamples(target: string[], samples: readonly string[], sampleLimit: number): void {
  for (const sample of samples) {
    if (target.includes(sample)) {
      continue;
    }

    if (target.length >= sampleLimit) {
      return;
    }

    target.push(sample);
  }
}

function buildDiagnosticDetails(
  elapsedMs: number,
  bindingChanges: number,
  returnSummaryChanges: number,
  bindingSamples: readonly string[],
  returnSummarySamples: readonly string[],
): TrackingContractDiagnosticDetails {
  return {
    elapsedMs,
    bindingChanges,
    returnSummaryChanges,
    bindingSamples: [...bindingSamples],
    returnSummarySamples: [...returnSummarySamples],
  };
}

function describeChurn(details: TrackingContractDiagnosticDetails): string {
  const parts: string[] = [];
  const bindingChanges = details.bindingChanges ?? 0;
  const returnSummaryChanges = details.returnSummaryChanges ?? 0;

  if (bindingChanges > 0) {
    const samples = details.bindingSamples?.length ? ` [${details.bindingSamples.join(", ")}]` : "";
    parts.push(`${bindingChanges} binding changes${samples}`);
  }

  if (returnSummaryChanges > 0) {
    const samples = details.returnSummarySamples?.length ? ` [${details.returnSummarySamples.join(", ")}]` : "";
    parts.push(`${returnSummaryChanges} return-summary changes${samples}`);
  }

  return parts.length > 0 ? `; recent churn: ${parts.join("; ")}` : "";
}

export function runTrackingConvergence(
  getCurrentState: () => TrackingConvergenceState,
  computeNextState: () => TrackingConvergenceState,
  applyNextState: (nextState: TrackingConvergenceState) => void,
  options?: TrackingConvergenceOptions,
): TrackingConvergenceResult {
  const normalized = normalizeOptions(options);
  let passes = 0;
  let warned = false;
  const diagnostics: TrackingContractDiagnostic[] = [];
  const startedAt = Date.now();
  const churn = {
    bindingChanges: 0,
    bindingChangedPasses: 0,
    returnSummaryChanges: 0,
    returnSummaryChangedPasses: 0,
  };
  const unstableSamples = {
    bindings: [] as string[],
    returnSummaries: [] as string[],
  };
  const debugTrace: { sampleLimit: number; passTraces: TrackingConvergencePassTrace[] } | undefined = normalized.tracePasses
    ? {
        sampleLimit: normalized.churnSampleLimit,
        passTraces: [],
      }
    : undefined;
  let lastDiagnosticDetails = buildDiagnosticDetails(0, 0, 0, [], []);

  while (true) {
    passes += 1;
    if (passes > normalized.maxPasses) {
      const elapsedMs = Date.now() - startedAt;
      const details = buildDiagnosticDetails(
        elapsedMs,
        lastDiagnosticDetails.bindingChanges ?? 0,
        lastDiagnosticDetails.returnSummaryChanges ?? 0,
        lastDiagnosticDetails.bindingSamples ?? [],
        lastDiagnosticDetails.returnSummarySamples ?? [],
      );
      throw new TrackingConvergenceError(
        `tracking convergence exceeded ${normalized.maxPasses} passes while stabilizing tracked bindings and callable return summaries${describeChurn(details)}`,
        details,
      );
    }

    const currentState = getCurrentState();
    const nextState = computeNextState();
    const bindingDiff = diffTrackedBindingMaps(
      currentState.trackedBySymbolId,
      nextState.trackedBySymbolId,
      normalized.churnSampleLimit,
    );
    const returnSummaryDiff = diffCallableReturnSummaryMaps(
      currentState.functionReturnSummaries,
      nextState.functionReturnSummaries,
      normalized.churnSampleLimit,
    );
    const changed = bindingDiff.changedCount > 0 || returnSummaryDiff.changedCount > 0;
    const elapsedMs = Date.now() - startedAt;

    if (bindingDiff.changedCount > 0) {
      churn.bindingChanges += bindingDiff.changedCount;
      churn.bindingChangedPasses += 1;
      mergeSamples(unstableSamples.bindings, bindingDiff.sampleKeys, normalized.churnSampleLimit);
    }

    if (returnSummaryDiff.changedCount > 0) {
      churn.returnSummaryChanges += returnSummaryDiff.changedCount;
      churn.returnSummaryChangedPasses += 1;
      mergeSamples(unstableSamples.returnSummaries, returnSummaryDiff.sampleKeys, normalized.churnSampleLimit);
    }

    lastDiagnosticDetails = buildDiagnosticDetails(
      elapsedMs,
      bindingDiff.changedCount,
      returnSummaryDiff.changedCount,
      bindingDiff.sampleKeys,
      returnSummaryDiff.sampleKeys,
    );

    if (debugTrace) {
      debugTrace.passTraces.push({
        pass: passes,
        elapsedMs,
        bindingChanges: bindingDiff.changedCount,
        returnSummaryChanges: returnSummaryDiff.changedCount,
        bindingSamples: [...bindingDiff.sampleKeys],
        returnSummarySamples: [...returnSummaryDiff.sampleKeys],
      });
    }

    applyNextState(nextState);

    if (!warned && passes >= normalized.warningPassThreshold) {
      warned = true;
      diagnostics.push(
        createConvergenceWarning(
          `tracking convergence required ${passes} passes, reaching the warning threshold of ${normalized.warningPassThreshold}${describeChurn(lastDiagnosticDetails)}`,
          lastDiagnosticDetails,
        ),
      );
    }

    if (!changed) {
      return {
        passes,
        warningPassThreshold: normalized.warningPassThreshold,
        maxPasses: normalized.maxPasses,
        warned,
        elapsedMs,
        churn,
        widening: {
          bindingChanges: 0,
          returnSummaryChanges: 0,
        },
        unstableSamples,
        debugTrace,
        diagnostics,
      };
    }
  }
}
