import { sameTrackedBindingMap } from "./bindings.js";
import { sameCallableReturnSummaryMap } from "./callables.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "./model.js";
import {
  createConvergenceGuardExceeded,
  createConvergenceWarning,
  type TrackingContractDiagnostic,
  type TrackingConvergenceSummary,
} from "./contracts.js";

export type TrackingConvergenceState = {
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: Map<string, CallableReturnSummary>;
};

export type TrackingConvergenceOptions = {
  warningPassThreshold?: number;
  maxPasses?: number;
};

type TrackingConvergenceResult = {
  summary: TrackingConvergenceSummary;
  diagnostics: TrackingContractDiagnostic[];
};

export class TrackingConvergenceError extends Error {
  readonly diagnostic: TrackingContractDiagnostic;

  constructor(message: string) {
    super(message);
    this.name = "TrackingConvergenceError";
    this.diagnostic = createConvergenceGuardExceeded(message);
  }
}

interface NormalizedTrackingConvergenceOptions {
  warningPassThreshold: number;
  maxPasses: number;
}

function normalizeOptions(options: TrackingConvergenceOptions | undefined): NormalizedTrackingConvergenceOptions {
  return {
    warningPassThreshold: Math.max(1, options?.warningPassThreshold ?? 12),
    maxPasses: Math.max(1, options?.maxPasses ?? 50),
  };
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

  while (true) {
    passes += 1;
    if (passes > normalized.maxPasses) {
      throw new TrackingConvergenceError(
        `tracking convergence exceeded ${normalized.maxPasses} passes while stabilizing tracked bindings and callable return summaries`,
      );
    }

    const currentState = getCurrentState();
    const nextState = computeNextState();
    const changed = !sameTrackedBindingMap(currentState.trackedBySymbolId, nextState.trackedBySymbolId)
      || !sameCallableReturnSummaryMap(currentState.functionReturnSummaries, nextState.functionReturnSummaries);

    applyNextState(nextState);

    if (!warned && passes >= normalized.warningPassThreshold) {
      warned = true;
      diagnostics.push(
        createConvergenceWarning(
          `tracking convergence required ${passes} passes, reaching the warning threshold of ${normalized.warningPassThreshold}`,
        ),
      );
    }

    if (!changed) {
      return {
        summary: {
          passes,
          warningPassThreshold: normalized.warningPassThreshold,
          maxPasses: normalized.maxPasses,
          warned,
        },
        diagnostics,
      };
    }
  }
}
