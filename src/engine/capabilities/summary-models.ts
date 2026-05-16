import type { ProjectContext, SkipCategory } from "../../types.js";
import { SKIP_CATEGORY } from "../../shared/skip-category-vocabulary.js";

import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { VALUE_LIVENESS_TRACKING_STAGE } from "../tracking/contracts.js";
import type { CallableReturnSummary } from "../tracking/model.js";
import { TRACKING_RETURN_SUMMARY_KIND } from "../tracking/vocabulary.js";
import type {
  AnalysisCapabilityFactRecord,
  AnalysisCapabilityId,
  AnalysisCapabilityObligationRecord,
} from "./types.js";
import {
  ANALYSIS_CAPABILITY_DETAIL_LABEL,
  ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL,
  ANALYSIS_CAPABILITY_ID,
} from "./vocabulary.js";

interface AnalysisCapabilitySummaryRegistry {
  hasSameProjectReturnedStructureTransport: boolean;
}

function hasSameProjectTransportSummary(artifacts: AnalysisArtifacts): boolean {
  let returnSummaries: ReadonlyMap<string, CallableReturnSummary>;

  try {
    returnSummaries = artifacts.getTrackingStageArtifacts(VALUE_LIVENESS_TRACKING_STAGE).returnSummaries.byCallableId;
  } catch {
    return false;
  }

  for (const summary of returnSummaries.values()) {
    if (
      summary.kind === TRACKING_RETURN_SUMMARY_KIND.structured
      || summary.kind === TRACKING_RETURN_SUMMARY_KIND.returnedAlias
    ) {
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
    case ANALYSIS_CAPABILITY_ID.helperTransport:
      if (detailHint.startsWith(ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperTransport)) {
        return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperTransport;
      }
      if (detailHint.startsWith(ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperRetainedStorage)) {
        return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperRetainedStorage;
      }
      if (detailHint.startsWith(ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperEscape)) {
        return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectHelperEscape;
      }
      return undefined;
    case ANALYSIS_CAPABILITY_ID.finiteKeyedAccess:
      return detailHint.startsWith(ANALYSIS_CAPABILITY_DETAIL_LABEL.boundedFiniteKeyRead)
        ? ANALYSIS_CAPABILITY_DETAIL_LABEL.boundedFiniteKeyRead
        : undefined;
    case ANALYSIS_CAPABILITY_ID.returnedStructureTransport:
      return detailHint.startsWith("Promise.all()")
        ? ANALYSIS_CAPABILITY_DETAIL_LABEL.promiseAllTransport
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
    case ANALYSIS_CAPABILITY_ID.helperTransport:
      switch (category) {
        case SKIP_CATEGORY.arrayCallbackEscape:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.callbackTransportBoundary;
        case SKIP_CATEGORY.arrayOpaqueMutation:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.opaqueHelperMutationBoundary;
        case SKIP_CATEGORY.opaqueObjectCall:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.opaqueHelperTransportBoundary;
        default:
          return undefined;
      }
    case ANALYSIS_CAPABILITY_ID.finiteKeyedAccess:
      switch (category) {
        case SKIP_CATEGORY.arrayAtCall:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.arrayAtBoundary;
        case SKIP_CATEGORY.computedPropertyAccess:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.computedKeyBoundary;
        case SKIP_CATEGORY.dynamicArrayIndex:
          return ANALYSIS_CAPABILITY_DETAIL_LABEL.dynamicIndexBoundary;
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

  if (capabilityId === ANALYSIS_CAPABILITY_ID.returnedStructureTransport && registry.hasSameProjectReturnedStructureTransport) {
    return ANALYSIS_CAPABILITY_DETAIL_LABEL.sameProjectReturnedStructure;
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
  return ANALYSIS_CAPABILITY_FALLBACK_BOUNDARY_LABEL[capabilityId];
}
