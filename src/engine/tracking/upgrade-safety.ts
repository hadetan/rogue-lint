import type { AnalysisResult } from "../../types.js";

import { attachAnalysisRunResultMetadata, getAnalysisRunResultMetadata } from "../analysis-run-state.js";
import type { TrackingRuntimeSummary } from "./contracts.js";

export interface TrackingSafetyBudgets {
  maxPasses: number;
  maxBindingChurnMultiplier: number;
  maxReturnSummaryChurnMultiplier: number;
  maxElapsedMs: number;
}

export interface TrackingSafetyEvaluation {
  metrics: {
    passes: number;
    warningPassThreshold: number;
    warned: boolean;
    bindingChanges: number;
    returnSummaryChanges: number;
    elapsedMs: number;
    trackedBindings: number;
    returnSummaries: number;
    stageTimingsMs: Readonly<Record<string, number>>;
  };
  budgets: {
    maxPasses: number;
    maxBindingChanges: number;
    maxReturnSummaryChanges: number;
    maxElapsedMs: number;
  };
  enforced: {
    violations: Array<{
      metric: "passes" | "binding-changes" | "return-summary-changes" | "elapsed-ms";
      actual: number;
      budget: number;
      severity: "enforced" | "informational";
    }>;
  };
  informational: {
    advisories: Array<{
      metric: "passes" | "binding-changes" | "return-summary-changes" | "elapsed-ms";
      actual: number;
      budget: number;
      severity: "enforced" | "informational";
    }>;
  };
}
function normalizeBudget(value: number): number {
  return Math.max(1, Math.floor(value));
}

export function attachTrackingRuntimeSummary(result: AnalysisResult, runtimeSummary: TrackingRuntimeSummary): void {
  attachAnalysisRunResultMetadata(result, { trackingRuntimeSummary: runtimeSummary });
}

function getTrackingRuntimeSummary(result: AnalysisResult): TrackingRuntimeSummary | undefined {
  return getAnalysisRunResultMetadata(result)?.trackingRuntimeSummary;
}

function observeTrackingSafetyEvaluationShape(evaluation: TrackingSafetyEvaluation): void {
  void evaluation.metrics.passes;
  void evaluation.metrics.warningPassThreshold;
  void evaluation.metrics.warned;
  void evaluation.metrics.bindingChanges;
  void evaluation.metrics.returnSummaryChanges;
  void evaluation.metrics.elapsedMs;
  void evaluation.metrics.trackedBindings;
  void evaluation.metrics.returnSummaries;
  void evaluation.metrics.stageTimingsMs;

  void evaluation.budgets.maxPasses;
  void evaluation.budgets.maxBindingChanges;
  void evaluation.budgets.maxReturnSummaryChanges;
  void evaluation.budgets.maxElapsedMs;

  for (const violation of evaluation.enforced.violations) {
    void violation.metric;
    void violation.actual;
    void violation.budget;
    void violation.severity;
  }

  for (const advisory of evaluation.informational.advisories) {
    void advisory.metric;
    void advisory.actual;
    void advisory.budget;
    void advisory.severity;
  }
}

function evaluateTrackingSafetySummary(
  runtimeSummary: TrackingRuntimeSummary,
  budgets: TrackingSafetyBudgets,
): TrackingSafetyEvaluation {
  const normalizedBudgets = {
    maxPasses: normalizeBudget(budgets.maxPasses),
    maxBindingChurnMultiplier: normalizeBudget(budgets.maxBindingChurnMultiplier),
    maxReturnSummaryChurnMultiplier: normalizeBudget(budgets.maxReturnSummaryChurnMultiplier),
    maxElapsedMs: normalizeBudget(budgets.maxElapsedMs),
  };
  const maxBindingChanges = Math.max(1, runtimeSummary.totals.trackedBindings) * normalizedBudgets.maxBindingChurnMultiplier;
  const maxReturnSummaryChanges = Math.max(1, runtimeSummary.totals.returnSummaries) * normalizedBudgets.maxReturnSummaryChurnMultiplier;

  const enforced: TrackingSafetyEvaluation["enforced"]["violations"] = [];
  if (runtimeSummary.convergence.passes > normalizedBudgets.maxPasses) {
    enforced.push({
      metric: "passes",
      actual: runtimeSummary.convergence.passes,
      budget: normalizedBudgets.maxPasses,
      severity: "enforced",
    });
  }

  if (runtimeSummary.convergence.churn.bindingChanges > maxBindingChanges) {
    enforced.push({
      metric: "binding-changes",
      actual: runtimeSummary.convergence.churn.bindingChanges,
      budget: maxBindingChanges,
      severity: "enforced",
    });
  }

  if (runtimeSummary.convergence.churn.returnSummaryChanges > maxReturnSummaryChanges) {
    enforced.push({
      metric: "return-summary-changes",
      actual: runtimeSummary.convergence.churn.returnSummaryChanges,
      budget: maxReturnSummaryChanges,
      severity: "enforced",
    });
  }

  const informational: TrackingSafetyEvaluation["informational"]["advisories"] = [];
  if (runtimeSummary.convergence.elapsedMs > normalizedBudgets.maxElapsedMs) {
    informational.push({
      metric: "elapsed-ms",
      actual: runtimeSummary.convergence.elapsedMs,
      budget: normalizedBudgets.maxElapsedMs,
      severity: "informational",
    });
  }

  for (const violation of enforced) {
    void violation.metric;
    void violation.actual;
    void violation.budget;
    void violation.severity;
  }

  for (const advisory of informational) {
    void advisory.metric;
    void advisory.actual;
    void advisory.budget;
    void advisory.severity;
  }

  const evaluation: TrackingSafetyEvaluation = {
    metrics: {
      passes: runtimeSummary.convergence.passes,
      warningPassThreshold: runtimeSummary.convergence.warningPassThreshold,
      warned: runtimeSummary.convergence.warned,
      bindingChanges: runtimeSummary.convergence.churn.bindingChanges,
      returnSummaryChanges: runtimeSummary.convergence.churn.returnSummaryChanges,
      elapsedMs: runtimeSummary.convergence.elapsedMs,
      trackedBindings: runtimeSummary.totals.trackedBindings,
      returnSummaries: runtimeSummary.totals.returnSummaries,
      stageTimingsMs: runtimeSummary.stageTimingsMs,
    },
    budgets: {
      maxPasses: normalizedBudgets.maxPasses,
      maxBindingChanges,
      maxReturnSummaryChanges,
      maxElapsedMs: normalizedBudgets.maxElapsedMs,
    },
    enforced: {
      violations: enforced,
    },
    informational: {
      advisories: informational,
    },
  };

  observeTrackingSafetyEvaluationShape(evaluation);
  return evaluation;
}

export function evaluateTrackingUpgradeSafety(
  result: AnalysisResult,
  budgets: TrackingSafetyBudgets,
): TrackingSafetyEvaluation | undefined {
  const runtimeSummary = getTrackingRuntimeSummary(result);
  return runtimeSummary ? evaluateTrackingSafetySummary(runtimeSummary, budgets) : undefined;
}
