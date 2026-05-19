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

type TrackingConvergenceSolverStateMetrics = {
  trackedObjectRegistryEntries: number;
  callSiteSpecializations: number;
  literalBindingCacheEntries: number;
  returnLiteralBindingCacheEntries: number;
};

export type TrackingConvergenceOptions = {
  warningPassThreshold?: number;
  maxPasses?: number;
  churnSampleLimit?: number;
  tracePasses?: boolean;
  maxPassElapsedMs?: number;
  maxPassTrackedObjectRegistryGrowth?: number;
  maxPassCallSiteSpecializationGrowth?: number;
  maxPassLiteralBindingCacheGrowth?: number;
  maxPassReturnLiteralBindingCacheGrowth?: number;
  getSolverStateMetrics?: () => TrackingConvergenceSolverStateMetrics;
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

function observeTrackingContractDiagnosticShape(diagnostic: TrackingContractDiagnostic): void {
  diagnostic.code;
  diagnostic.message;
  diagnostic.stage;
  diagnostic.details;
}

class TrackingConvergenceError extends Error {
  readonly diagnostic: TrackingContractDiagnostic;
  readonly debugTrace?: TrackingConvergenceDebugTrace;

  constructor(
    message: string,
    details?: TrackingContractDiagnosticDetails,
    debugTrace?: TrackingConvergenceDebugTrace,
  ) {
    super(message);
    this.name = "TrackingConvergenceError";
    this.diagnostic = createConvergenceGuardExceeded(message, details);
    this.debugTrace = debugTrace;
  }
}

interface NormalizedTrackingConvergenceOptions {
  warningPassThreshold: number;
  maxPasses: number;
  churnSampleLimit: number;
  tracePasses: boolean;
  maxPassElapsedMs?: number;
  maxPassTrackedObjectRegistryGrowth?: number;
  maxPassCallSiteSpecializationGrowth?: number;
  maxPassLiteralBindingCacheGrowth?: number;
  maxPassReturnLiteralBindingCacheGrowth?: number;
  getSolverStateMetrics?: () => TrackingConvergenceSolverStateMetrics;
}

function normalizeOptionalBudget(value: number | undefined, minimum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Math.max(minimum, Math.floor(value));
}

function normalizeOptions(options: TrackingConvergenceOptions | undefined): NormalizedTrackingConvergenceOptions {
  return {
    warningPassThreshold: Math.max(1, options?.warningPassThreshold ?? 12),
    maxPasses: Math.max(1, options?.maxPasses ?? 50),
    churnSampleLimit: Math.max(1, options?.churnSampleLimit ?? 5),
    tracePasses: options?.tracePasses ?? false,
    maxPassElapsedMs: normalizeOptionalBudget(options?.maxPassElapsedMs, 1),
    maxPassTrackedObjectRegistryGrowth: normalizeOptionalBudget(options?.maxPassTrackedObjectRegistryGrowth, 0),
    maxPassCallSiteSpecializationGrowth: normalizeOptionalBudget(options?.maxPassCallSiteSpecializationGrowth, 0),
    maxPassLiteralBindingCacheGrowth: normalizeOptionalBudget(options?.maxPassLiteralBindingCacheGrowth, 0),
    maxPassReturnLiteralBindingCacheGrowth: normalizeOptionalBudget(options?.maxPassReturnLiteralBindingCacheGrowth, 0),
    getSolverStateMetrics: options?.getSolverStateMetrics,
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
  extraDetails: Partial<TrackingContractDiagnosticDetails> = {},
): TrackingContractDiagnosticDetails {
  return {
    elapsedMs,
    bindingChanges,
    returnSummaryChanges,
    ...extraDetails,
    bindingSamples: [...bindingSamples],
    returnSummarySamples: [...returnSummarySamples],
  };
}

function computeSolverStateGrowth(
  baseline: TrackingConvergenceSolverStateMetrics | undefined,
  current: TrackingConvergenceSolverStateMetrics | undefined,
): TrackingConvergenceSolverStateMetrics | undefined {
  if (!baseline || !current) {
    return undefined;
  }

  return {
    trackedObjectRegistryEntries: Math.max(0, current.trackedObjectRegistryEntries - baseline.trackedObjectRegistryEntries),
    callSiteSpecializations: Math.max(0, current.callSiteSpecializations - baseline.callSiteSpecializations),
    literalBindingCacheEntries: Math.max(0, current.literalBindingCacheEntries - baseline.literalBindingCacheEntries),
    returnLiteralBindingCacheEntries: Math.max(0, current.returnLiteralBindingCacheEntries - baseline.returnLiteralBindingCacheEntries),
  };
}

function describeSolverStateGrowth(growth: TrackingConvergenceSolverStateMetrics | undefined): string {
  if (!growth) {
    return "";
  }

  const parts: string[] = [];
  if (growth.trackedObjectRegistryEntries > 0) {
    parts.push(`${growth.trackedObjectRegistryEntries} tracked-object registry entries`);
  }
  if (growth.callSiteSpecializations > 0) {
    parts.push(`${growth.callSiteSpecializations} call-site specializations`);
  }
  if (growth.literalBindingCacheEntries > 0) {
    parts.push(`${growth.literalBindingCacheEntries} literal-binding cache entries`);
  }
  if (growth.returnLiteralBindingCacheEntries > 0) {
    parts.push(`${growth.returnLiteralBindingCacheEntries} return-literal cache entries`);
  }

  return parts.length > 0 ? `; solver-state growth: ${parts.join("; ")}` : "";
}

function buildSolverStateGuardDetails(
  pass: number,
  elapsedMs: number,
  currentSolverState: TrackingConvergenceSolverStateMetrics | undefined,
  solverStateGrowth: TrackingConvergenceSolverStateMetrics | undefined,
): Partial<TrackingContractDiagnosticDetails> {
  return {
    pass,
    trackedObjectRegistryEntries: currentSolverState?.trackedObjectRegistryEntries,
    callSiteSpecializations: currentSolverState?.callSiteSpecializations,
    literalBindingCacheEntries: currentSolverState?.literalBindingCacheEntries,
    returnLiteralBindingCacheEntries: currentSolverState?.returnLiteralBindingCacheEntries,
    trackedObjectRegistryGrowth: solverStateGrowth?.trackedObjectRegistryEntries,
    callSiteSpecializationGrowth: solverStateGrowth?.callSiteSpecializations,
    literalBindingCacheGrowth: solverStateGrowth?.literalBindingCacheEntries,
    returnLiteralBindingCacheGrowth: solverStateGrowth?.returnLiteralBindingCacheEntries,
    elapsedMs,
  };
}

function throwIfPassGuardExceeded(
  pass: number,
  normalized: NormalizedTrackingConvergenceOptions,
  passStartedAt: number,
  passStartedSolverState: TrackingConvergenceSolverStateMetrics | undefined,
): void {
  const elapsedMs = Date.now() - passStartedAt;
  const currentSolverState = normalized.getSolverStateMetrics?.();
  const solverStateGrowth = computeSolverStateGrowth(passStartedSolverState, currentSolverState);
  const extraDetails = buildSolverStateGuardDetails(pass, elapsedMs, currentSolverState, solverStateGrowth);

  if (normalized.maxPassElapsedMs !== undefined && elapsedMs > normalized.maxPassElapsedMs) {
    throw new TrackingConvergenceError(
      `tracking convergence pass ${pass} exceeded elapsed budget of ${normalized.maxPassElapsedMs}ms while stabilizing tracked bindings and callable return summaries${describeSolverStateGrowth(solverStateGrowth)}`,
      buildDiagnosticDetails(elapsedMs, 0, 0, [], [], extraDetails),
    );
  }

  if (
    normalized.maxPassTrackedObjectRegistryGrowth !== undefined
    && (solverStateGrowth?.trackedObjectRegistryEntries ?? 0) > normalized.maxPassTrackedObjectRegistryGrowth
  ) {
    throw new TrackingConvergenceError(
      `tracking convergence pass ${pass} exceeded tracked-object registry growth budget of ${normalized.maxPassTrackedObjectRegistryGrowth}${describeSolverStateGrowth(solverStateGrowth)}`,
      buildDiagnosticDetails(elapsedMs, 0, 0, [], [], extraDetails),
    );
  }

  if (
    normalized.maxPassCallSiteSpecializationGrowth !== undefined
    && (solverStateGrowth?.callSiteSpecializations ?? 0) > normalized.maxPassCallSiteSpecializationGrowth
  ) {
    throw new TrackingConvergenceError(
      `tracking convergence pass ${pass} exceeded call-site specialization growth budget of ${normalized.maxPassCallSiteSpecializationGrowth}${describeSolverStateGrowth(solverStateGrowth)}`,
      buildDiagnosticDetails(elapsedMs, 0, 0, [], [], extraDetails),
    );
  }

  if (
    normalized.maxPassLiteralBindingCacheGrowth !== undefined
    && (solverStateGrowth?.literalBindingCacheEntries ?? 0) > normalized.maxPassLiteralBindingCacheGrowth
  ) {
    throw new TrackingConvergenceError(
      `tracking convergence pass ${pass} exceeded literal-binding cache growth budget of ${normalized.maxPassLiteralBindingCacheGrowth}${describeSolverStateGrowth(solverStateGrowth)}`,
      buildDiagnosticDetails(elapsedMs, 0, 0, [], [], extraDetails),
    );
  }

  if (
    normalized.maxPassReturnLiteralBindingCacheGrowth !== undefined
    && (solverStateGrowth?.returnLiteralBindingCacheEntries ?? 0) > normalized.maxPassReturnLiteralBindingCacheGrowth
  ) {
    throw new TrackingConvergenceError(
      `tracking convergence pass ${pass} exceeded return-literal cache growth budget of ${normalized.maxPassReturnLiteralBindingCacheGrowth}${describeSolverStateGrowth(solverStateGrowth)}`,
      buildDiagnosticDetails(elapsedMs, 0, 0, [], [], extraDetails),
    );
  }
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
  computeNextState: (heartbeat: () => void) => TrackingConvergenceState,
  applyNextState: (nextState: TrackingConvergenceState, heartbeat: () => void) => void,
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
        debugTrace,
      );
    }

    const currentState = getCurrentState();
    const passStartedAt = Date.now();
    const passStartedSolverState = normalized.getSolverStateMetrics?.();
    const heartbeat = (): void => {
      throwIfPassGuardExceeded(passes, normalized, passStartedAt, passStartedSolverState);
    };
    const nextState = computeNextState(heartbeat);
    heartbeat();
    const bindingDiff = diffTrackedBindingMaps(
      currentState.trackedBySymbolId,
      nextState.trackedBySymbolId,
      normalized.churnSampleLimit,
      heartbeat,
    );
    const returnSummaryDiff = diffCallableReturnSummaryMaps(
      currentState.functionReturnSummaries,
      nextState.functionReturnSummaries,
      normalized.churnSampleLimit,
      heartbeat,
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

    applyNextState(nextState, heartbeat);
    heartbeat();

    if (debugTrace) {
      debugTrace.passTraces.push({
        pass: passes,
        elapsedMs,
        bindingChanges: bindingDiff.changedCount,
        returnSummaryChanges: returnSummaryDiff.changedCount,
        bindingSamples: [...bindingDiff.sampleKeys],
        returnSummarySamples: [...returnSummaryDiff.sampleKeys],
        solverState: normalized.getSolverStateMetrics?.(),
      });
    }

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
      for (const diagnostic of diagnostics) {
        observeTrackingContractDiagnosticShape(diagnostic);
      }

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
