import type { ProjectContext, SkipCategory } from "../../types.js";

import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import type { CallableReturnSummary } from "../tracking/model.js";
import type { AnalysisCapabilityId, AnalysisCapabilityObligationRecord } from "./types.js";

type AnalysisCapabilitySummaryModelKind = "transport" | "retained-storage" | "escape" | "barrier";

type AnalysisCapabilitySummaryModelSource = "same-project" | "library";

interface AnalysisCapabilitySummaryModel {
  id: string;
  capabilityId: AnalysisCapabilityId;
  source: AnalysisCapabilitySummaryModelSource;
  kind: AnalysisCapabilitySummaryModelKind;
  label: string;
  category?: SkipCategory;
  detailHint?: string;
}

type AnalysisCapabilitySummaryRegistry = ReadonlyMap<AnalysisCapabilityId, readonly AnalysisCapabilitySummaryModel[]>;

const FALLBACK_BOUNDARY_LABELS: Record<AnalysisCapabilityId, string> = {
  "finite-keyed-access": "finite keyed access summary fallback",
  "returned-structure-transport": "returned transport summary fallback",
  "helper-transport": "helper transport summary fallback",
  "library-public-surface-aliasing": "public surface aliasing fallback",
};

const LIBRARY_SUMMARY_MODELS: readonly AnalysisCapabilitySummaryModel[] = [
  {
    id: "returned-structure-transport:promise-all-transport",
    capabilityId: "returned-structure-transport",
    source: "library",
    kind: "transport",
    label: "Promise.all transport summary",
    detailHint: "Promise.all()",
  },
  {
    id: "helper-transport:array-callback-boundary",
    capabilityId: "helper-transport",
    source: "library",
    kind: "barrier",
    label: "callback transport boundary",
    category: "array-callback-escape",
  },
  {
    id: "helper-transport:array-opaque-mutation-boundary",
    capabilityId: "helper-transport",
    source: "library",
    kind: "retained-storage",
    label: "opaque helper mutation boundary",
    category: "array-opaque-mutation",
  },
  {
    id: "helper-transport:opaque-object-call-boundary",
    capabilityId: "helper-transport",
    source: "library",
    kind: "escape",
    label: "opaque helper transport boundary",
    category: "opaque-object-call",
  },
  {
    id: "finite-keyed-access:array-at-boundary",
    capabilityId: "finite-keyed-access",
    source: "library",
    kind: "barrier",
    label: "array .at boundary",
    category: "array-at-call",
  },
  {
    id: "finite-keyed-access:computed-key-boundary",
    capabilityId: "finite-keyed-access",
    source: "library",
    kind: "barrier",
    label: "computed key boundary",
    category: "computed-property-access",
  },
  {
    id: "finite-keyed-access:dynamic-index-boundary",
    capabilityId: "finite-keyed-access",
    source: "library",
    kind: "barrier",
    label: "dynamic index boundary",
    category: "dynamic-array-index",
  },
];

function collectSameProjectModels(artifacts: AnalysisArtifacts): AnalysisCapabilitySummaryModel[] {
  let returnSummaries: ReadonlyMap<string, CallableReturnSummary>;

  try {
    returnSummaries = artifacts.getTrackingStageArtifacts("value-liveness").returnSummaries.byCallableId;
  } catch {
    return [];
  }

  const hasTransportSummary = [...returnSummaries.values()].some((summary) =>
    summary.kind === "structured" || summary.kind === "returned-alias",
  );

  return hasTransportSummary
    ? [{
      id: "returned-structure-transport:same-project-helper-return",
      capabilityId: "returned-structure-transport",
      source: "same-project",
      kind: "transport",
      label: "same-project helper return summary",
    }]
    : [];
}

export function createAnalysisCapabilitySummaryRegistry(
  _project: ProjectContext,
  artifacts: AnalysisArtifacts,
): AnalysisCapabilitySummaryRegistry {
  const sameProjectModels = collectSameProjectModels(artifacts);
  const modelsByCapability = new Map<AnalysisCapabilityId, AnalysisCapabilitySummaryModel[]>();

  for (const model of [...sameProjectModels, ...LIBRARY_SUMMARY_MODELS]) {
    const existing = modelsByCapability.get(model.capabilityId) ?? [];
    existing.push(model);
    modelsByCapability.set(model.capabilityId, existing);
  }

  return modelsByCapability;
}

function getCapabilitySummaryModels(
  registry: AnalysisCapabilitySummaryRegistry,
  capabilityId: AnalysisCapabilityId,
): readonly AnalysisCapabilitySummaryModel[] {
  return registry.get(capabilityId) ?? [];
}

export function getCapabilityObligationDetailLabel(
  registry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>,
  capabilityId: AnalysisCapabilityId,
  obligation: Pick<AnalysisCapabilityObligationRecord, "detailHint">,
): string | undefined {
  const models = getCapabilitySummaryModels(registry, capabilityId);
  const detailHint = obligation.detailHint;
  const hintedModel = detailHint
    ? models.find((model) => model.detailHint !== undefined && detailHint.startsWith(model.detailHint))
    : undefined;
  if (hintedModel) {
    return hintedModel.label;
  }

  return models.find((model) => model.source === "same-project" && model.kind === "transport")?.label;
}

export function getCapabilityBoundaryDetailLabel(
  registry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>,
  capabilityId: AnalysisCapabilityId,
  category?: SkipCategory,
): string | undefined {
  if (!category) {
    return undefined;
  }

  return getCapabilitySummaryModels(registry, capabilityId).find((model) => model.category === category)?.label;
}

export function getCapabilityFallbackBoundaryLabel(capabilityId: AnalysisCapabilityId): string {
  return FALLBACK_BOUNDARY_LABELS[capabilityId];
}
