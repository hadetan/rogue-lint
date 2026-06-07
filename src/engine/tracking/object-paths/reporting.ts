import type { CollectionBoundaryRecord, PathSegment, ProjectContext, SuppressionContext, TrackedObject } from "../../../types.js";
import { ENTITY_KIND } from "../../../shared/entity-vocabulary.js";
import { SKIP_CATEGORY } from "../../../shared/skip-category-vocabulary.js";
import { FINDING_KIND } from "../../../shared/finding-vocabulary.js";
import { kindToFinding } from "../../../shared/entity-utils.js";
import { isSerializedPathWithin, renderPathWithRoot, serializePath } from "../../../shared/path-utils.js";
import { TRACKING_VALUE_FATE } from "../vocabulary.js";
import { addFinding, addSkipped, registerCapabilityObligation, resolveCapabilityObligation, type AnalysisState } from "../../analysis-state.js";
import { ANALYSIS_CAPABILITY_OUTCOME } from "../../capabilities/vocabulary.js";
import { isPreserved } from "../../analyzers/preservation-gate.js";
import { getCollectionInfo, hasTrackedChildren } from "../state.js";
import type { TrackedObjectBinding } from "../model.js";
import { shouldSuppressStructuralPath, shouldSuppressStructuralRoot } from "../syntax.js";
import {
  getObjectPathOverlayBoundaryRecords, getObjectPathOverlayEscapedReason, getObjectPathOverlayObservedAliases, type ObjectPathOverlayState,
  getObjectPathOverlayObservedSubtrees, getObjectPathOverlayReads, getObjectPathOverlayWrites, isObjectPathOverlayCollectionPathInvalidated,
} from "./overlay.js";

function getReportingReads(
  reportingReadsById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): ReadonlySet<string> {
  return reportingReadsById.get(tracked.id) ?? new Set<string>();
}

function getReportingObservedSubtrees(
  reportingObservedSubtreesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): ReadonlySet<string> {
  return reportingObservedSubtreesById.get(tracked.id) ?? new Set<string>();
}

function getReportingObservedAliases(
  reportingObservedAliasesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
): Set<string> {
  return new Set(reportingObservedAliasesById.get(tracked.id) ?? []);
}

function getReportingBoundaries(
  overlayState: ObjectPathOverlayState,
  tracked: TrackedObject,
): ReadonlyMap<string, CollectionBoundaryRecord> {
  return getObjectPathOverlayBoundaryRecords(overlayState, tracked.id) ?? new Map<string, CollectionBoundaryRecord>();
}

function hasDirectReportingObservation(
  overlayState: ObjectPathOverlayState,
  tracked: TrackedObject,
): boolean {
  return Boolean(
    getObjectPathOverlayReads(overlayState, tracked.id)?.size
    || getObjectPathOverlayWrites(overlayState, tracked.id)?.size
    || getObjectPathOverlayObservedSubtrees(overlayState, tracked.id)?.size
    || getObjectPathOverlayObservedAliases(overlayState, tracked.id)?.size
    || getObjectPathOverlayBoundaryRecords(overlayState, tracked.id)?.size
  );
}

function hasDirectReportingObservationAtPath(
  overlayState: ObjectPathOverlayState,
  tracked: TrackedObject,
  joinedPath: string,
): boolean {
  return Boolean(
    getObjectPathOverlayReads(overlayState, tracked.id)?.has(joinedPath)
    || getObjectPathOverlayObservedSubtrees(overlayState, tracked.id)?.has(joinedPath)
    || getObjectPathOverlayObservedAliases(overlayState, tracked.id)?.has(joinedPath)
  );
}

function getReportingOwnerId(
  tracked: TrackedObject,
  trackedBindingsBySymbolId?: ReadonlyMap<string, TrackedObjectBinding>,
): string {
  if (tracked.reportingOwnerId && tracked.reportingOwnerId !== tracked.id) {
    return tracked.reportingOwnerId;
  }

  if (
    trackedBindingsBySymbolId
    && (tracked.rootEntity.kind === ENTITY_KIND.local || tracked.rootEntity.kind === ENTITY_KIND.export)
  ) {
    const currentBinding = trackedBindingsBySymbolId.get(tracked.canonicalSymbolKey);
    if (currentBinding && currentBinding.trackedObject.id !== tracked.id) {
      return currentBinding.trackedObject.reportingOwnerId ?? currentBinding.trackedObject.id;
    }
  }

  return tracked.id;
}

function hasBoundaryAtPath(
  boundaries: ReadonlyMap<string, CollectionBoundaryRecord>,
  path: PathSegment[],
): boolean {
  const joinedPath = serializePath(path);
  return [...boundaries.values()].some((boundary) => serializePath(boundary.path) === joinedPath);
}

function shouldReportBoundary(
  overlayState: ObjectPathOverlayState,
  reportingObservedSubtreesById: ReadonlyMap<string, Set<string>>,
  tracked: TrackedObject,
  path: PathSegment[],
): boolean {
  const joinedPath = serializePath(path);
  const collection = getCollectionInfo(tracked, path);
  const hasExactCoverage = tracked.nodes.has(joinedPath)
    || hasTrackedChildren(tracked, path)
    || (collection?.childPaths.length ?? 0) > 0;

  if (!hasExactCoverage) {
    return false;
  }

  return !getReportingObservedSubtrees(reportingObservedSubtreesById, tracked).has(joinedPath)
    || isObjectPathOverlayCollectionPathInvalidated(overlayState, tracked.id, path);
}

function isReturnedContractMemberCandidate(tracked: TrackedObject, joinedPath: string): boolean {
  const node = tracked.nodes.get(joinedPath);
  return Boolean(
    node
    && node.origin === "method"
    && tracked.rootEntity.kind === ENTITY_KIND.expression
    && tracked.rootName.endsWith("()"),
  );
}

export function finalizeObjectPathFindings(
  project: ProjectContext,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  trackedObjects: Iterable<TrackedObject>,
  overlayState: ObjectPathOverlayState,
  trackedBindingsBySymbolId?: ReadonlyMap<string, TrackedObjectBinding>,
): void {
  const trackedList = [...trackedObjects];
  const reportingReadsById = new Map<string, Set<string>>();
  const reportingObservedSubtreesById = new Map<string, Set<string>>();
  const reportingObservedAliasesById = new Map<string, Set<string>>();
  const reportingExactProxyPathsByOwnerId = new Map<string, Set<string>>();
  const reportingProxyCountsByOwnerId = new Map<string, number>();

  for (const tracked of trackedList) {
    const reportingOwnerId = getReportingOwnerId(tracked, trackedBindingsBySymbolId);
    if (reportingOwnerId !== tracked.id) {
      reportingProxyCountsByOwnerId.set(reportingOwnerId, (reportingProxyCountsByOwnerId.get(reportingOwnerId) ?? 0) + 1);

      const exactProxyPaths = reportingExactProxyPathsByOwnerId.get(reportingOwnerId) ?? new Set<string>();
      for (const [joinedPath, objectNode] of tracked.nodes) {
        if (!isObjectPathOverlayCollectionPathInvalidated(overlayState, tracked.id, objectNode.fullPath)
          && !getObjectPathOverlayEscapedReason(overlayState, tracked.id, objectNode.fullPath)) {
          exactProxyPaths.add(joinedPath);
        }
      }
      reportingExactProxyPathsByOwnerId.set(reportingOwnerId, exactProxyPaths);
    }

    const reads = reportingReadsById.get(reportingOwnerId) ?? new Set<string>();
    const observedSubtrees = reportingObservedSubtreesById.get(reportingOwnerId) ?? new Set<string>();
    const observedAliases = reportingObservedAliasesById.get(reportingOwnerId) ?? new Set<string>();
    getObjectPathOverlayReads(overlayState, tracked.id)?.forEach((path) => reads.add(path));
    getObjectPathOverlayObservedSubtrees(overlayState, tracked.id)?.forEach((path) => observedSubtrees.add(path));
    getObjectPathOverlayObservedAliases(overlayState, tracked.id)?.forEach((path) => observedAliases.add(path));
    reportingReadsById.set(reportingOwnerId, reads);
    reportingObservedSubtreesById.set(reportingOwnerId, observedSubtrees);
    reportingObservedAliasesById.set(reportingOwnerId, observedAliases);
  }

  for (const tracked of trackedList) {
    if (getReportingOwnerId(tracked, trackedBindingsBySymbolId) !== tracked.id) {
      continue;
    }

    const hasAggregatedReportingObservation = Boolean(
      getReportingReads(reportingReadsById, tracked).size
      || getReportingObservedSubtrees(reportingObservedSubtreesById, tracked).size
      || getReportingObservedAliases(reportingObservedAliasesById, tracked).size
    );

    // Literal call-site arguments and function-call return values cross call boundaries.
    // Exact reads cannot be proven from the current scope — emit skipped per the proof perimeter.
    if (tracked.rootName === "argument") {
      for (const [, objectNode] of tracked.nodes) {
        if (!shouldSuppressStructuralPath(tracked, objectNode.fullPath) && !isPreserved(project, state, suppressionContext, objectNode.entity)) {
          addSkipped(state, objectNode.entity, SKIP_CATEGORY.helperCallBoundary, "literal argument passed to call; reads inside callee are not tracked");
        }
      }
      continue;
    }

    if (
      tracked.rootEntity.kind === ENTITY_KIND.expression
      && tracked.rootName.endsWith("()")
      && !hasDirectReportingObservation(overlayState, tracked)
      && !hasAggregatedReportingObservation
    ) {
      for (const [, objectNode] of tracked.nodes) {
        if (!shouldSuppressStructuralPath(tracked, objectNode.fullPath) && !isPreserved(project, state, suppressionContext, objectNode.entity)) {
          addSkipped(state, objectNode.entity, SKIP_CATEGORY.returnedObject, "returned structure from function call; reads through return boundary are not tracked");
        }
      }
      continue;
    }

    if (
      tracked.rootEntity.kind === ENTITY_KIND.expression
      && tracked.rootName.endsWith("()")
      && (reportingProxyCountsByOwnerId.get(tracked.id) ?? 0) > 0
      && !hasDirectReportingObservation(overlayState, tracked)
      && !hasAggregatedReportingObservation
    ) {
      continue;
    }

    for (const boundary of getReportingBoundaries(overlayState, tracked).values()) {
      if (boundary.path.length === 0 && shouldSuppressStructuralRoot(tracked)) {
        continue;
      }
      if (shouldSuppressStructuralPath(tracked, boundary.path)) {
        continue;
      }
      if (!shouldReportBoundary(overlayState, reportingObservedSubtreesById, tracked, boundary.path)) {
        continue;
      }
      if (isPreserved(project, state, suppressionContext, boundary.entity)) {
        continue;
      }
      addSkipped(state, boundary.entity, boundary.category, boundary.reason);
    }

    if (tracked.exactPathAliases.size > 0) {
      const reportingReads = getReportingReads(reportingReadsById, tracked);
      const reportingObservedAliases = getReportingObservedAliases(reportingObservedAliasesById, tracked);
      const aliases = [...tracked.exactPathAliases.entries()];
      if (
        aliases.every(([joinedPath, alias]) => !alias.observed && !reportingReads.has(joinedPath) && !reportingObservedAliases.has(joinedPath))
        && !hasBoundaryAtPath(getReportingBoundaries(overlayState, tracked), [])
        && !shouldSuppressStructuralRoot(tracked)
      ) {
        if (!isPreserved(project, state, suppressionContext, tracked.rootEntity)) {
          addFinding(
            state,
            tracked.rootEntity,
            FINDING_KIND.writeOnlyState,
            "tracked values are accumulated here but never meaningfully observed through an exact supported path",
            `Write-only accumulation in ${tracked.rootName}`,
            "review",
          );
        }
      }
    }

    for (const [joinedPath, objectNode] of tracked.nodes) {
      const isReturnedContractMember = isReturnedContractMemberCandidate(tracked, joinedPath);
      if (objectNode.origin === "method" && !isReturnedContractMember) {
        continue;
      }

      if (isReturnedContractMember) {
        registerCapabilityObligation(
          state,
          "returned-contract-member",
          objectNode.entity,
          "returned-structure-transport",
          tracked.rootName,
        );
      }

      if (shouldSuppressStructuralPath(tracked, objectNode.fullPath)) {
        if (isReturnedContractMember) {
          resolveCapabilityObligation(
            state,
            "returned-contract-member",
            objectNode.entity,
            ANALYSIS_CAPABILITY_OUTCOME.kept,
            "returned-structure-transport",
          );
        }
        continue;
      }
      if (
        isObjectPathOverlayCollectionPathInvalidated(overlayState, tracked.id, objectNode.fullPath)
      ) {
        if (isReturnedContractMember) {
          resolveCapabilityObligation(
            state,
            "returned-contract-member",
            objectNode.entity,
            ANALYSIS_CAPABILITY_OUTCOME.skipped,
            "returned-structure-transport",
          );
        }
        continue;
      }

      const escapedReason = getObjectPathOverlayEscapedReason(overlayState, tracked.id, objectNode.fullPath);
      if (escapedReason) {
        const joinedPath = serializePath(objectNode.fullPath);
        const hasAggregatedProxyObservation = !hasDirectReportingObservationAtPath(overlayState, tracked, joinedPath)
          && (reportingProxyCountsByOwnerId.get(tracked.id) ?? 0) > 0
          && (
            getReportingReads(reportingReadsById, tracked).has(joinedPath)
            || getReportingObservedSubtrees(reportingObservedSubtreesById, tracked).has(joinedPath)
            || getReportingObservedAliases(reportingObservedAliasesById, tracked).has(joinedPath)
            || (reportingExactProxyPathsByOwnerId.get(tracked.id)?.has(joinedPath) ?? false)
          );

        if (hasAggregatedProxyObservation) {
          if (isReturnedContractMember) {
            resolveCapabilityObligation(
              state,
              "returned-contract-member",
              objectNode.entity,
              ANALYSIS_CAPABILITY_OUTCOME.live,
              "returned-structure-transport",
            );
          }
          continue;
        }

        if (isReturnedContractMember) {
          resolveCapabilityObligation(
            state,
            "returned-contract-member",
            objectNode.entity,
            ANALYSIS_CAPABILITY_OUTCOME.skipped,
            "returned-structure-transport",
          );
        }
        addSkipped(state, objectNode.entity, escapedReason.category, escapedReason.reason);
        continue;
      }

      if (isPreserved(project, state, suppressionContext, objectNode.entity, {
        onKept: () => {
          if (isReturnedContractMember) {
            resolveCapabilityObligation(
              state,
              "returned-contract-member",
              objectNode.entity,
              ANALYSIS_CAPABILITY_OUTCOME.kept,
              "returned-structure-transport",
            );
          }
        },
      })) {
        continue;
      }

      const hasRead = getReportingReads(reportingReadsById, tracked).has(joinedPath);
      const hasWrite = getObjectPathOverlayWrites(overlayState, tracked.id)?.has(joinedPath)
        || objectNode.fullPath.length >= 1;

      if (!hasRead && hasWrite) {
        const nodePath = serializePath(objectNode.fullPath);
        const hasInsertedByReferenceAncestor = !hasAggregatedReportingObservation
          && tracked.valueFates.some(
            (fate) => fate.fate === TRACKING_VALUE_FATE.insertedByReference
              && isSerializedPathWithin(nodePath, serializePath(fate.path)),
          );
        if (hasInsertedByReferenceAncestor) {
          addSkipped(state, objectNode.entity, SKIP_CATEGORY.externalContainerStore, "value inserted by reference into another structure; reads through the reference chain are not tracked");
          if (isReturnedContractMember) {
            resolveCapabilityObligation(state, "returned-contract-member", objectNode.entity, ANALYSIS_CAPABILITY_OUTCOME.skipped, "returned-structure-transport");
          }
          continue;
        }

        const findingKind = kindToFinding(objectNode.entity.kind);
        if (!findingKind) {
          continue;
        }
        addFinding(
          state,
          objectNode.entity,
          findingKind,
          "eligible object path is declared or written but never read",
          objectNode.entity.kind === ENTITY_KIND.arrayElement
            ? `Unused array element ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`
            : `Unused object path ${renderPathWithRoot(tracked.rootName, objectNode.fullPath)}`,
        );
        if (isReturnedContractMember) {
          resolveCapabilityObligation(
            state,
            "returned-contract-member",
            objectNode.entity,
            ANALYSIS_CAPABILITY_OUTCOME.finding,
            "returned-structure-transport",
          );
        }
        continue;
      }

      if (isReturnedContractMember) {
        resolveCapabilityObligation(
          state,
          "returned-contract-member",
          objectNode.entity,
          ANALYSIS_CAPABILITY_OUTCOME.live,
          "returned-structure-transport",
        );
      }
    }
  }
}
