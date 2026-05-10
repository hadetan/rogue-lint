import ts from "typescript";

import { getSuppressionAudit } from "../../../suppressions.js";
import type {
  EntityRecord,
  PathSegment,
  ProjectContext,
  SkipCategory,
  SuppressionContext,
  TrackedObject,
} from "../../../types.js";
import { makeEntity } from "../../../shared/entity-utils.js";
import { indexSegment, renderPathWithRoot } from "../../../shared/path-utils.js";
import {
  addAudit,
  addFinding,
  type AnalysisState,
} from "../../analysis-state.js";
import { getAccessPath, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, getBindingByNode } from "../bindings.js";
import type {
  CallableReturnSummary,
  ExactAppendSlotPlan,
  TrackedObjectBinding,
} from "../model.js";
import {
  ARRAY_APPEND_METHODS,
  ARRAY_REORDER_METHODS,
  ARRAY_REPLACEMENT_METHODS,
  ARRAY_TRUNCATE_METHODS,
} from "../semantics.js";
import {
  addValueFate,
  buildCollectionBoundaryEntity,
  createInvalidatedPathRecord,
  ensureCollectionChildPath,
  getCollectionInfo,
  getEscapedReason,
  getInvalidatedPathRecord,
  getNearestArrayCollectionPath,
  getTrackedArrayLength,
  hasTrackedChildren,
  invalidateCollectionPath,
  markEscaped,
  markObservedSubtree,
  markRead,
  materializeExactAppendSlot,
  recordCollectionBoundary,
  setTrackedArrayLength,
} from "../state.js";
import { materializeTrackedLiteralAtPath } from "../graph.js";
import { unwrapExpression } from "../syntax.js";

function isNestedTrackedAccess(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    || (ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
    || (ts.isCallExpression(node.parent) && node.parent.expression === node)
  );
}

function buildReadExpressionEntity(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): EntityRecord {
  return makeEntity(
    project.rootPath,
    "expression",
    sourceFile,
    node,
    renderPathWithRoot(trackedObject.rootName, fullPath),
    trackedObject.rootName,
  );
}

export function recordArrayBoundary(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  collectionPath: PathSegment[],
  affectedPath: PathSegment[],
  category: SkipCategory,
  reason: string,
  invalidate = false,
): void {
  recordCollectionBoundary(
    trackedObject,
    collectionPath,
    {
      entity: buildCollectionBoundaryEntity(project, trackedObject, sourceFile, node, affectedPath),
      path: affectedPath,
      category,
      reason,
    },
    invalidate ? affectedPath : undefined,
    invalidate ? createInvalidatedPathRecord(category, reason) : undefined,
  );
}

export function maybeReportInvalidatedRead(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  trackedObject: TrackedObject,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  if (isNestedTrackedAccess(node)) {
    return;
  }

  const invalidated = getInvalidatedPathRecord(trackedObject, fullPath);
  if (!invalidated?.findingKind) {
    return;
  }

  if (getEscapedReason(trackedObject, fullPath)) {
    return;
  }

  const entity = buildReadExpressionEntity(project, trackedObject, sourceFile, node, fullPath);
  const suppression = getSuppressionAudit(project, suppressionContext, entity, node);
  if (addAudit(state.kept, suppression)) {
    return;
  }

  const renderedPath = renderPathWithRoot(trackedObject.rootName, fullPath);
  addFinding(
    state,
    entity,
    invalidated.findingKind,
    invalidated.reason,
    invalidated.findingKind === "invalidated-read"
      ? `Invalidated read of ${renderedPath}`
      : `Stale read after mutation of ${renderedPath}`,
    "review",
  );
}

export function handleTrackedArrayMutation(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  collectionPath: PathSegment[],
  methodName: string,
): void {
  const arrayLength = getTrackedArrayLength(trackedObject, collectionPath);

  if (ARRAY_APPEND_METHODS.has(methodName)) {
    if (arrayLength !== undefined) {
      setTrackedArrayLength(trackedObject, collectionPath, arrayLength + node.arguments.length);
    }
    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-append-mutation",
      `${methodName} appends new elements beyond exact local analysis`,
    );
    return;
  }

  if (ARRAY_TRUNCATE_METHODS.has(methodName)) {
    if (arrayLength !== undefined && arrayLength > 0) {
      const removedPath = [...collectionPath, indexSegment(arrayLength - 1)];
      markRead(trackedObject, removedPath);
      invalidateCollectionPath(
        trackedObject,
        collectionPath,
        removedPath,
        createInvalidatedPathRecord("array-truncate-mutation", `${methodName} removes previously tracked elements`),
      );
      setTrackedArrayLength(trackedObject, collectionPath, arrayLength - 1);
      return;
    }

    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-truncate-mutation",
      `${methodName} removes elements beyond exact local analysis`,
      true,
    );
    return;
  }

  if (ARRAY_REPLACEMENT_METHODS.has(methodName)) {
    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-replacement-mutation",
      `${methodName} overwrites tracked array regions beyond exact local analysis`,
      true,
    );
    return;
  }

  if (ARRAY_REORDER_METHODS.has(methodName)) {
    if (methodName === "shift" && arrayLength === 1) {
      const removedPath = [...collectionPath, indexSegment(0)];
      markRead(trackedObject, removedPath);
      invalidateCollectionPath(
        trackedObject,
        collectionPath,
        removedPath,
        createInvalidatedPathRecord("array-truncate-mutation", "shift consumes the only tracked element"),
      );
      setTrackedArrayLength(trackedObject, collectionPath, 0);
      return;
    }

    recordArrayBoundary(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      collectionPath,
      collectionPath,
      "array-reorder-mutation",
      `${methodName} changes stable array element ordering`,
      true,
    );
  }
}

function isSupportedExactAppendValue(argument: ts.Expression): boolean {
  return (
    ts.isIdentifier(argument)
    || ts.isStringLiteralLike(argument)
    || ts.isNumericLiteral(argument)
    || argument.kind === ts.SyntaxKind.TrueKeyword
    || argument.kind === ts.SyntaxKind.FalseKeyword
    || argument.kind === ts.SyntaxKind.NullKeyword
    || ts.isNoSubstitutionTemplateLiteral(argument)
  );
}

function tryRegisterExactArrayInsertion(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  collectionPath: PathSegment[],
  methodName: string,
  slotPlans: ExactAppendSlotPlan[],
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): boolean {
  const arrayLength = getTrackedArrayLength(trackedObject, collectionPath);
  if (arrayLength === undefined) {
    return false;
  }

  if (methodName === "unshift" && arrayLength > 0) {
    return false;
  }

  const startIndex = methodName === "unshift" ? 0 : arrayLength;
  slotPlans.forEach((slotPlan, index) => {
    const receiverPath = [...collectionPath, indexSegment(startIndex + index)];
    ensureCollectionChildPath(trackedObject, collectionPath, receiverPath);
    materializeExactAppendSlot(
      project,
      trackedObject,
      sourceFile,
      node.expression,
      receiverPath,
      slotPlan,
    );
    if (slotPlan.kind === "structured") {
      materializeTrackedLiteralAtPath(
        project,
        trackedObject,
        sourceFile,
        slotPlan.literal,
        trackedObject.rootName,
        receiverPath,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
    }
  });
  setTrackedArrayLength(trackedObject, collectionPath, arrayLength + slotPlans.length);
  return true;
}

export function handleSupportedValueFateCall(
  project: ProjectContext,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
  handledSpreadAppendStarts: Set<number>,
): Set<number> {
  const handledIndices = new Set<number>();
  const calleeText = node.expression.getText(sourceFile);
  const calleeAccessPath = getAccessPath(node.expression);
  const methodName = calleeAccessPath && !calleeAccessPath.dynamic && calleeAccessPath.segments.length > 0
    ? calleeAccessPath.segments.at(-1)?.kind === "property"
      ? calleeAccessPath.segments.at(-1)?.value
      : undefined
    : undefined;
  const trackedReceiver = calleeAccessPath
    ? getBindingByNode(project, calleeAccessPath.root, trackedBySymbolId)
    : undefined;
  const receiverPath = trackedReceiver && calleeAccessPath
    ? [...trackedReceiver.prefix, ...calleeAccessPath.segments.slice(0, -1)]
    : undefined;
  const receiverCollection = trackedReceiver && receiverPath
    ? getCollectionInfo(trackedReceiver.trackedObject, receiverPath)
    : undefined;

  if (trackedReceiver && receiverPath && receiverCollection?.kind === "array" && methodName === "slice") {
    markObservedSubtree(trackedReceiver.trackedObject, receiverPath, trackedObjectsById);
    addValueFate(
      trackedReceiver.trackedObject,
      "shallow-cloned",
      receiverPath,
      "slice reads the receiver to create a shallow-cloned array",
    );
  }

  if (trackedReceiver && receiverPath && receiverCollection?.kind === "array" && methodName === "concat") {
    markObservedSubtree(trackedReceiver.trackedObject, receiverPath, trackedObjectsById);
    addValueFate(
      trackedReceiver.trackedObject,
      "shallow-cloned",
      receiverPath,
      "concat reads the receiver to create a shallow-cloned array",
    );
    for (const [index, argument] of node.arguments.entries()) {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        continue;
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "shallow-cloned",
        fullPath,
        "concat reads this value to create a shallow-cloned array",
        trackedReceiver.trackedObject.id,
        receiverPath,
      );
      handledIndices.add(index);
    }
  }

  if (calleeText === "Promise.all" && node.arguments[0]) {
    const resolved = resolveTrackedObjectAccess(
      project,
      node.arguments[0],
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      const collectionInfo = getCollectionInfo(resolved.binding.trackedObject, fullPath);
      if (collectionInfo?.kind === "array") {
        markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
        handledIndices.add(0);
      }
    }
  }

  if (
    trackedReceiver
    && receiverPath
    && receiverCollection?.kind === "array"
    && (methodName === "push" || methodName === "unshift")
  ) {
    const slotPlans: ExactAppendSlotPlan[] = [];
    let exactAppendSupported = node.arguments.length > 0;
    let sawSpreadArgument = false;
    for (const [index, argument] of node.arguments.entries()) {
      if (!exactAppendSupported) {
        break;
      }

      if (ts.isSpreadElement(argument)) {
        sawSpreadArgument = true;
        const resolvedSpread = resolveTrackedObjectAccess(
          project,
          argument.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (!resolvedSpread || resolvedSpread.dynamic) {
          exactAppendSupported = false;
          continue;
        }

        const spreadPath = [...resolvedSpread.binding.prefix, ...resolvedSpread.segments];
        const spreadCollection = getCollectionInfo(resolvedSpread.binding.trackedObject, spreadPath);
        if (!spreadCollection || spreadCollection.kind !== "array") {
          exactAppendSupported = false;
          continue;
        }

        for (const childPath of spreadCollection.childPaths) {
          slotPlans.push({
            kind: "alias",
            binding: {
              trackedObject: resolvedSpread.binding.trackedObject,
              prefix: childPath,
            },
            observeSourceAtInsert: true,
            insertReason: `${methodName} inserts ${renderPathWithRoot(resolvedSpread.binding.trackedObject.rootName, childPath)} by reference`,
            sourceObservationReason: `${methodName} spread observes this source slot before appending`,
          });
        }
        handledIndices.add(index);
        handledSpreadAppendStarts.add(argument.getStart(sourceFile));
        continue;
      }

      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        const binding = extendTrackedBinding(resolved.binding, resolved.segments);
        slotPlans.push({
          kind: "alias",
          binding,
          observeSourceAtInsert: false,
          insertReason: `${methodName} inserts ${renderPathWithRoot(binding.trackedObject.rootName, binding.prefix)} by reference`,
        });
        handledIndices.add(index);
        continue;
      }

      const structuredLiteral = unwrapExpression(argument);
      if (ts.isObjectLiteralExpression(structuredLiteral) || ts.isArrayLiteralExpression(structuredLiteral)) {
        slotPlans.push({
          kind: "structured",
          literal: structuredLiteral,
          insertReason: `${methodName} appends a structured value into an exact receiver slot`,
        });
        handledIndices.add(index);
        continue;
      }

      if (isSupportedExactAppendValue(argument)) {
        slotPlans.push({
          kind: "value",
          insertReason: `${methodName} appends a scalar value into an exact receiver slot`,
        });
        handledIndices.add(index);
        continue;
      }

      exactAppendSupported = false;
    }

    if (exactAppendSupported) {
      if (!tryRegisterExactArrayInsertion(
        project,
        trackedReceiver.trackedObject,
        sourceFile,
        node,
        receiverPath,
        methodName,
        slotPlans,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      )) {
        if (sawSpreadArgument) {
          recordArrayBoundary(
            project,
            trackedReceiver.trackedObject,
            sourceFile,
            node.expression,
            receiverPath,
            receiverPath,
            "array-append-mutation",
            methodName === "unshift"
              ? "unshift cannot preserve exact slot remapping once the receiver already contains elements"
              : `${methodName} spreads a source beyond exact local analysis`,
          );
          for (let index = 0; index < node.arguments.length; index += 1) {
            handledIndices.add(index);
          }
        } else {
          handledIndices.clear();
        }
      }
    } else {
      handledIndices.clear();
      if (sawSpreadArgument) {
        recordArrayBoundary(
          project,
          trackedReceiver.trackedObject,
          sourceFile,
          node.expression,
          receiverPath,
          receiverPath,
          "array-append-mutation",
          `${methodName} spreads a source beyond exact local analysis`,
        );
        for (let index = 0; index < node.arguments.length; index += 1) {
          handledIndices.add(index);
        }
        for (const argument of node.arguments) {
          if (ts.isSpreadElement(argument)) {
            handledSpreadAppendStarts.delete(argument.getStart(sourceFile));
          }
        }
      }
    }
  }

  if (calleeText === "structuredClone" && node.arguments[0]) {
    const resolved = resolveTrackedObjectAccess(
      project,
      node.arguments[0],
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "deep-cloned",
        fullPath,
        "structuredClone reads this value to create a deep-cloned copy",
      );
      handledIndices.add(0);
    }
  }

  if (calleeText === "Object.assign" && node.arguments.length > 0) {
    const target = resolveTrackedObjectAccess(
      project,
      node.arguments[0]!,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (target && !target.dynamic) {
      const targetPath = [...target.binding.prefix, ...target.segments];
      markEscaped(
        target.binding.trackedObject,
        targetPath,
        "object-spread",
        "Object.assign merges properties beyond exact local analysis",
      );
      handledIndices.add(0);
    }

    for (const [offset, argument] of node.arguments.slice(1).entries()) {
      const resolved = resolveTrackedObjectAccess(
        project,
        argument,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!resolved || resolved.dynamic) {
        continue;
      }

      const fullPath = [...resolved.binding.prefix, ...resolved.segments];
      markObservedSubtree(resolved.binding.trackedObject, fullPath, trackedObjectsById);
      addValueFate(
        resolved.binding.trackedObject,
        "shallow-cloned",
        fullPath,
        "Object.assign reads this value to copy properties into another object",
      );
      handledIndices.add(offset + 1);
    }
  }

  return handledIndices;
}

export function maybeInvalidateReplacedTrackedPath(
  project: ProjectContext,
  trackedObject: TrackedObject,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  fullPath: PathSegment[],
): void {
  if (!hasTrackedChildren(trackedObject, fullPath) && !getCollectionInfo(trackedObject, fullPath)) {
    return;
  }

  const arrayPath = getNearestArrayCollectionPath(trackedObject, fullPath);
  if (!arrayPath) {
    return;
  }

  recordArrayBoundary(
    project,
    trackedObject,
    sourceFile,
    node,
    arrayPath,
    fullPath,
    "array-replacement-mutation",
    `assignment replaces ${renderPathWithRoot(trackedObject.rootName, fullPath)} beyond exact local analysis`,
    true,
  );
}
