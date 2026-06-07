import ts from "typescript";

import type {
  EntityRecord,
  PathSegment,
  ProjectContext,
  SkipCategory,
  TrackedObject,
} from "../../../types.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { serializePath } from "../../../shared/path-utils.js";
import { type AnalysisCapabilityFactRecord, createCapabilityFactRecordId } from "../../capabilities/types.js";
import {
  ANALYSIS_CAPABILITY_DETAIL_LABEL_BOUNDED_FINITE_KEY_READ,
  ANALYSIS_CAPABILITY_FACT_FAMILY,
  ANALYSIS_CAPABILITY_FACT_OUTCOME,
  ANALYSIS_CAPABILITY_ID,
} from "../../capabilities/vocabulary.js";
import { buildCollectionBoundaryEntity } from "../state.js";

/**
 * Capability-fact recording helpers shared by the object-path visitor.
 *
 * Boundary facts are emitted whenever the visitor records an exactness boundary
 * (helper transport or finite-keyed access). Live facts are emitted when a
 * finite-keyed access is observed without any escaping boundary.
 */

function getTrackedEntityAtPath(
  trackedObject: TrackedObject,
  segments: PathSegment[],
): EntityRecord {
  return trackedObject.nodes.get(serializePath(segments))?.entity ?? trackedObject.rootEntity;
}

export function registerBoundaryCapabilityFact(
  capabilityFacts: Map<string, AnalysisCapabilityFactRecord>,
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  segments: PathSegment[],
  category: SkipCategory,
  reason: string,
  detailHint?: string,
): void {
  if (
    category === SKIP_CATEGORY.arrayCallbackEscape
    || category === SKIP_CATEGORY.arrayOpaqueMutation
    || category === SKIP_CATEGORY.opaqueObjectCall
  ) {
    const entity = category === SKIP_CATEGORY.arrayCallbackEscape || category === SKIP_CATEGORY.arrayOpaqueMutation
      ? buildCollectionBoundaryEntity(project, trackedObject, sourceFile, node, segments)
      : getTrackedEntityAtPath(trackedObject, segments);
    const recordId = createCapabilityFactRecordId(
      ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport,
      entity,
      ANALYSIS_CAPABILITY_ID.helperTransport,
      detailHint,
    );
    if (!capabilityFacts.has(recordId)) {
      capabilityFacts.set(recordId, {
        id: recordId,
        family: ANALYSIS_CAPABILITY_FACT_FAMILY.helperTransport,
        capabilityId: ANALYSIS_CAPABILITY_ID.helperTransport,
        entity,
        outcome: ANALYSIS_CAPABILITY_FACT_OUTCOME.boundary,
        category,
        reason,
        detailHint,
      });
    }
    return;
  }

  if (
    category === SKIP_CATEGORY.arrayAtCall
    || category === SKIP_CATEGORY.computedPropertyAccess
    || category === SKIP_CATEGORY.dynamicArrayIndex
  ) {
    const entity = category === SKIP_CATEGORY.arrayAtCall || category === SKIP_CATEGORY.dynamicArrayIndex
      ? buildCollectionBoundaryEntity(project, trackedObject, sourceFile, node, segments)
      : getTrackedEntityAtPath(trackedObject, segments);
    const recordId = createCapabilityFactRecordId(
      ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
      entity,
      ANALYSIS_CAPABILITY_ID.finiteKeyedAccess,
      detailHint,
    );
    if (!capabilityFacts.has(recordId)) {
      capabilityFacts.set(recordId, {
        id: recordId,
        family: ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
        capabilityId: ANALYSIS_CAPABILITY_ID.finiteKeyedAccess,
        entity,
        outcome: ANALYSIS_CAPABILITY_FACT_OUTCOME.boundary,
        category,
        reason,
        detailHint,
      });
    }
  }
}

export function registerLiveFiniteKeyedAccessFact(
  capabilityFacts: Map<string, AnalysisCapabilityFactRecord>,
  trackedObject: TrackedObject,
  fullPath: PathSegment[],
): void {
  const entity = getTrackedEntityAtPath(trackedObject, fullPath);
  const recordId = createCapabilityFactRecordId(
    ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
    entity,
    ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
    ANALYSIS_CAPABILITY_DETAIL_LABEL_BOUNDED_FINITE_KEY_READ,
  );
  if (!capabilityFacts.has(recordId)) {
    capabilityFacts.set(recordId, {
      id: recordId,
      family: ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
      capabilityId: ANALYSIS_CAPABILITY_FACT_FAMILY.finiteKeyedAccess,
      entity,
      outcome: ANALYSIS_CAPABILITY_FACT_OUTCOME.live,
      detailHint: ANALYSIS_CAPABILITY_DETAIL_LABEL_BOUNDED_FINITE_KEY_READ,
    });
  }
}
