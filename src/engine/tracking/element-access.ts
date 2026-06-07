import ts from "typescript";

import type { PathSegment, ProjectContext, TrackedObject } from "../../types.js";
import { indexSegment, propertySegment } from "../../shared/path-utils.js";
import { getCollectionInfo, getTrackedArrayLength } from "./state.js";
import { unwrapExpression } from "./syntax.js";
import { TRACKING_COLLECTION_KIND } from "./vocabulary.js";

/**
 * Static element-access argument helpers used to keep array/object indexing exact.
 */

export function extractBoundedElementAccessSegment(
  project: ProjectContext,
  argument: ts.Expression,
): PathSegment | undefined {
  const node = unwrapExpression(argument);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return propertySegment(node.text);
  }

  if (ts.isNumericLiteral(node)) {
    return indexSegment(Number(node.text));
  }

  if (
    ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand)
  ) {
    return indexSegment(-Number(node.operand.text));
  }

  const type = project.checker.getTypeAtLocation(node);
  const candidateTypes = type.isUnion() ? type.types : [type];
  const seen = new Set<string>();
  let segment: PathSegment | undefined;

  for (const candidateType of candidateTypes) {
    let nextSegment: PathSegment | undefined;

    if (candidateType.flags & ts.TypeFlags.StringLiteral) {
      nextSegment = propertySegment((candidateType as ts.StringLiteralType).value);
    } else if (candidateType.flags & ts.TypeFlags.NumberLiteral) {
      nextSegment = indexSegment((candidateType as ts.NumberLiteralType).value);
    } else {
      return undefined;
    }

    const key = `${nextSegment.kind}:${nextSegment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (segment) {
      return undefined;
    }
    segment = nextSegment;
  }

  return segment;
}

function resolveLiteralArrayIndex(argument: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(argument)) {
    return Number(argument.text);
  }

  if (
    ts.isPrefixUnaryExpression(argument)
    && argument.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(argument.operand)
  ) {
    return -Number(argument.operand.text);
  }

  return undefined;
}

export function resolveArrayAtIndex(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  argument: ts.Expression,
): number | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== TRACKING_COLLECTION_KIND.array) {
    return undefined;
  }

  const literalIndex = resolveLiteralArrayIndex(argument);
  if (literalIndex === undefined) {
    return undefined;
  }

  const arrayLength = getTrackedArrayLength(trackedObject, segments) ?? 0;

  if (literalIndex >= 0) {
    return literalIndex < arrayLength ? literalIndex : undefined;
  }

  const normalized = arrayLength + literalIndex;
  return normalized >= 0 ? normalized : undefined;
}

export function isDefinitelyNonNullishType(type: ts.Type): boolean {
  const candidates = type.isUnion() ? type.types : [type];
  return candidates.every((candidate) => {
    const flags = candidate.flags;
    return (flags & (
      ts.TypeFlags.Any
      | ts.TypeFlags.Unknown
      | ts.TypeFlags.TypeParameter
      | ts.TypeFlags.Null
      | ts.TypeFlags.Undefined
      | ts.TypeFlags.Void
    )) === 0;
  });
}
