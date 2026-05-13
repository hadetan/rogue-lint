import type { ProjectContext, SkipCategory } from "../../types.js";

import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import type { CallableReturnSummary } from "../tracking/model.js";
import type {
  AnalysisCapabilityFactRecord,
  AnalysisCapabilityId,
  AnalysisCapabilityObligationRecord,
} from "./types.js";

interface AnalysisCapabilitySummaryRegistry {
  hasSameProjectReturnedStructureTransport: boolean;
}

const SAME_PROJECT_HELPER_TRANSPORT_LABEL = "same-project helper transport";
const SAME_PROJECT_HELPER_RETAINED_STORAGE_LABEL = "same-project helper retained storage";
const SAME_PROJECT_HELPER_ESCAPE_LABEL = "same-project helper escape";
const SAME_PROJECT_RETURNED_STRUCTURE_LABEL = "same-project helper return summary";
const BOUNDED_FINITE_KEY_READ_LABEL = "bounded finite key read";
const PROMISE_ALL_TRANSPORT_LABEL = "Promise.all transport summary";
const CALLBACK_TRANSPORT_BOUNDARY_LABEL = "callback transport boundary";
const OPAQUE_HELPER_MUTATION_BOUNDARY_LABEL = "opaque helper mutation boundary";
const OPAQUE_HELPER_TRANSPORT_BOUNDARY_LABEL = "opaque helper transport boundary";
const ARRAY_AT_BOUNDARY_LABEL = "array .at boundary";
const COMPUTED_KEY_BOUNDARY_LABEL = "computed key boundary";
const DYNAMIC_INDEX_BOUNDARY_LABEL = "dynamic index boundary";

const FALLBACK_BOUNDARY_LABELS: Record<AnalysisCapabilityId, string> = {
  "finite-keyed-access": "finite keyed access summary fallback",
  "returned-structure-transport": "returned transport summary fallback",
  "helper-transport": "helper transport summary fallback",
  "library-public-surface-aliasing": "public surface aliasing fallback",
};

function hasSameProjectTransportSummary(artifacts: AnalysisArtifacts): boolean {
  let returnSummaries: ReadonlyMap<string, CallableReturnSummary>;

  try {
    returnSummaries = artifacts.getTrackingStageArtifacts("value-liveness").returnSummaries.byCallableId;
  } catch {
    return false;
  }

  for (const summary of returnSummaries.values()) {
    if (summary.kind === "structured" || summary.kind === "returned-alias") {
      return true;
    }
  }

  return false;
}

export function createAnalysisCapabilitySummaryRegistry(
  _project: ProjectContext,
  artifacts: AnalysisArtifacts,
): AnalysisCapabilitySummaryRegistry {
  return {
    hasSameProjectReturnedStructureTransport: hasSameProjectTransportSummary(artifacts),
  };
}

function getCapabilityDetailHintLabel(
  capabilityId: AnalysisCapabilityId,
  detailHint?: string,
): string | undefined {
  if (!detailHint) {
    return undefined;
  }

  switch (capabilityId) {
    case "helper-transport":
      if (detailHint.startsWith(SAME_PROJECT_HELPER_TRANSPORT_LABEL)) {
        return SAME_PROJECT_HELPER_TRANSPORT_LABEL;
      }
      if (detailHint.startsWith(SAME_PROJECT_HELPER_RETAINED_STORAGE_LABEL)) {
        return SAME_PROJECT_HELPER_RETAINED_STORAGE_LABEL;
      }
      if (detailHint.startsWith(SAME_PROJECT_HELPER_ESCAPE_LABEL)) {
        return SAME_PROJECT_HELPER_ESCAPE_LABEL;
      }
      return undefined;
    case "finite-keyed-access":
      return detailHint.startsWith(BOUNDED_FINITE_KEY_READ_LABEL)
        ? BOUNDED_FINITE_KEY_READ_LABEL
        : undefined;
    case "returned-structure-transport":
      return detailHint.startsWith("Promise.all()")
        ? PROMISE_ALL_TRANSPORT_LABEL
        : undefined;
    default:
      return undefined;
  }
}

function getCapabilityBoundaryCategoryLabel(
  capabilityId: AnalysisCapabilityId,
  category?: SkipCategory,
): string | undefined {
  if (category === undefined) {
    return undefined;
  }

  switch (capabilityId) {
    case "helper-transport":
      switch (category) {
        case "array-callback-escape":
          return CALLBACK_TRANSPORT_BOUNDARY_LABEL;
        case "array-opaque-mutation":
          return OPAQUE_HELPER_MUTATION_BOUNDARY_LABEL;
        case "opaque-object-call":
          return OPAQUE_HELPER_TRANSPORT_BOUNDARY_LABEL;
        default:
          return undefined;
      }
    case "finite-keyed-access":
      switch (category) {
        case "array-at-call":
          return ARRAY_AT_BOUNDARY_LABEL;
        case "computed-property-access":
          return COMPUTED_KEY_BOUNDARY_LABEL;
        case "dynamic-array-index":
          return DYNAMIC_INDEX_BOUNDARY_LABEL;
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

export function getCapabilityObligationDetailLabel(
  registry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>,
  capabilityId: AnalysisCapabilityId,
  obligation: Pick<AnalysisCapabilityObligationRecord, "detailHint">,
): string | undefined {
  const detailLabel = getCapabilityDetailHintLabel(capabilityId, obligation.detailHint);
  if (detailLabel) {
    return detailLabel;
  }

  if (capabilityId === "returned-structure-transport" && registry.hasSameProjectReturnedStructureTransport) {
    return SAME_PROJECT_RETURNED_STRUCTURE_LABEL;
  }

  return undefined;
}

export function getCapabilityFactDetailLabel(
  _registry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>,
  capabilityId: AnalysisCapabilityId,
  fact: Pick<AnalysisCapabilityFactRecord, "detailHint" | "category">,
): string | undefined {
  return getCapabilityDetailHintLabel(capabilityId, fact.detailHint)
    ?? getCapabilityBoundaryCategoryLabel(capabilityId, fact.category)
    ?? fact.detailHint;
}

export function getCapabilityBoundaryDetailLabel(
  registry: ReturnType<typeof createAnalysisCapabilitySummaryRegistry>,
  capabilityId: AnalysisCapabilityId,
  category?: SkipCategory,
): string | undefined {
  void registry;
  return getCapabilityBoundaryCategoryLabel(capabilityId, category);
}

export function getCapabilityFallbackBoundaryLabel(capabilityId: AnalysisCapabilityId): string {
  return FALLBACK_BOUNDARY_LABELS[capabilityId];
}
