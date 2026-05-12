import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../types.js";
import { getSymbolKey } from "../../compiler/ast-utils.js";
import {
  indexSegment,
  propertySegment,
  serializePath,
  samePath,
} from "../../shared/path-utils.js";
import type {
  AnalyzableCallableBinding,
  CallableReturnSummary,
  ForwardedParameterBinding,
  ProjectedArrayUsageContext,
  ResolvedProjectionAccess,
  ResolvedTrackedObjectAccess,
  TrackedObjectBinding,
} from "./model.js";
import { TrackedObjectBindingRecord } from "./model.js";
import {
  extendTrackedBinding,
  getBindingByNode,
  getCanonicalSymbol,
  getCanonicalSymbolKey,
  getGlobalThisBindingKey,
  isGlobalThisIdentifier,
  sameTrackedBinding,
} from "./bindings.js";
import {
  getAnalyzableCallableBinding,
  getAnalyzableCallableBindingFromDeclaration,
  getCallableReturnBinding,
} from "./callables.js";
import {
  getCollectionInfo,
  getConcreteProjectionPaths,
  getTrackedArrayLength,
  hasTrackedChildren,
  registerExactPathAlias,
  resolveExactPathAlias,
} from "./state.js";
import { unwrapExpression } from "./syntax.js";

/**
 * Shared access-resolution helpers for the exact tracking kernel.
 *
 * This module owns exact path resolution, retained-container slot identity,
 * callback projection resolution, and the binding propagation helpers used by
 * both heavy analyzer stages.
 */

const EXACT_ARRAY_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

function hasExactTrackedPath(trackedObject: TrackedObject, segments: PathSegment[]): boolean {
  const joinedPath = serializePath(segments);
  return trackedObject.nodes.has(joinedPath)
    || trackedObject.callablePaths.has(joinedPath)
    || trackedObject.exactPathAliases.has(joinedPath)
    || Boolean(getCollectionInfo(trackedObject, segments))
    || hasTrackedChildren(trackedObject, segments);
}

function cloneTrackedObjectForCallSite(base: TrackedObject, id: string): TrackedObject {
  return {
    ...base,
    id,
    reportingOwnerId: base.reportingOwnerId ?? base.id,
    descendantNodeKeys: new Map([...base.descendantNodeKeys.entries()].map(([key, value]) => [key, [...value]])),
    collections: new Map(base.collections),
    collectionStates: new Map(base.collectionStates),
    collectionBoundaries: new Map(base.collectionBoundaries),
    invalidatedCollectionPaths: new Set(base.invalidatedCollectionPaths),
    invalidatedPaths: new Map(base.invalidatedPaths),
    placeStates: new Map(base.placeStates),
    observedSubtrees: new Set(),
    escapedPaths: new Map(base.escapedPaths),
    exactPathAliases: new Map(),
    valueFates: base.valueFates.map((valueFate) => ({
      ...valueFate,
      path: [...valueFate.path],
      relatedPath: valueFate.relatedPath ? [...valueFate.relatedPath] : undefined,
    })),
    reads: new Set(),
    writes: new Set(),
  };
}

function syncTrackedObjectForCallSite(target: TrackedObject, base: TrackedObject): void {
  target.reportingOwnerId = base.reportingOwnerId ?? base.id;
  target.descendantNodeKeys = new Map([...base.descendantNodeKeys.entries()].map(([key, value]) => [key, [...value]]));
  target.collections = new Map(base.collections);
  target.collectionStates = new Map(base.collectionStates);
  target.collectionBoundaries = new Map(base.collectionBoundaries);
  target.invalidatedCollectionPaths = new Set(base.invalidatedCollectionPaths);
  target.invalidatedPaths = new Map(base.invalidatedPaths);
  target.placeStates = new Map(base.placeStates);
  target.escapedPaths = new Map(base.escapedPaths);
  target.exactPathAliases = new Map();
  target.valueFates = base.valueFates.map((valueFate) => ({
    ...valueFate,
    path: [...valueFate.path],
    relatedPath: valueFate.relatedPath ? [...valueFate.relatedPath] : undefined,
  }));
}

function getResolvedSpreadPropertySegments(binding: TrackedObjectBinding): PathSegment[] | undefined {
  const collection = getCollectionInfo(binding.trackedObject, binding.prefix);
  if (!collection || collection.kind !== "object") {
    return undefined;
  }

  const propertySegments: PathSegment[] = [];
  const seen = new Set<string>();

  for (const childPath of collection.childPaths) {
    if (childPath.length !== binding.prefix.length + 1) {
      continue;
    }

    const segment = childPath[binding.prefix.length];
    if (!segment || segment.kind !== "property") {
      return undefined;
    }

    const key = `${segment.kind}:${segment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    propertySegments.push(segment);
  }

  return propertySegments.length > 0 ? propertySegments : undefined;
}

function isPristineCallSiteClone(trackedObject: TrackedObject): boolean {
  return trackedObject.reads.size === 0
    && trackedObject.writes.size === 0
    && trackedObject.observedSubtrees.size === 0
    && [...trackedObject.exactPathAliases.values()].every((alias) => !alias.observed);
}

function collapseExactBindingPrefix(
  binding: TrackedObjectBinding,
  trackedObjectsById: Map<string, TrackedObject>,
): TrackedObjectBinding {
  let current = binding;

  while (current.prefix.length > 0) {
    const baseBinding = new TrackedObjectBindingRecord(current.trackedObject, []);
    const aliased = resolveExactPathAlias(baseBinding, current.prefix, trackedObjectsById);
    if (sameTrackedBinding(aliased.binding, baseBinding)) {
      break;
    }

    current = aliased.binding;
  }

  return current;
}

function getReturnedStructuredLiteralFromExpression(
  project: ProjectContext,
  callable: AnalyzableCallableBinding,
  expression: ts.Expression,
): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  const node = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return node;
  }

  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  if (!declaration?.initializer) {
    return undefined;
  }

  const enclosingFunction = ts.findAncestor(
    declaration,
    (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
  );
  if (enclosingFunction !== callable.declaration) {
    return undefined;
  }

  const initializer = unwrapExpression(declaration.initializer);
  return (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
    ? initializer
    : undefined;
}

function getStructuredReturnLiteral(
  project: ProjectContext,
  callable: AnalyzableCallableBinding,
): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  if (!callable.declaration.body) {
    return undefined;
  }

  let literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined;
  let unsupported = false;

  const visit = (node: ts.Node): void => {
    if (unsupported) {
      return;
    }

    if (ts.isFunctionLike(node) && node !== callable.declaration) {
      return;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const nextLiteral = getReturnedStructuredLiteralFromExpression(project, callable, node.expression);
      if (!nextLiteral) {
        unsupported = true;
        return;
      }

      if (!literal) {
        literal = nextLiteral;
        return;
      }

      if (literal !== nextLiteral) {
        unsupported = true;
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(callable.declaration.body, visit);
  return unsupported ? undefined : literal;
}

function registerSpecializedStructuredReturnAliases(
  project: ProjectContext,
  trackedObject: TrackedObject,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  segments: PathSegment[],
  maxDepth: number,
  localBindings: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): void {
  if (segments.length > maxDepth) {
    return;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const resolved = resolveTrackedObjectAccess(
          project,
          property.expression,
          localBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolved && !resolved.dynamic) {
          const spreadBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          const spreadSegments = getResolvedSpreadPropertySegments(spreadBinding);
          if (spreadSegments) {
            for (const spreadSegment of spreadSegments) {
              registerExactPathAlias(
                trackedObject,
                [...segments, spreadSegment],
                extendTrackedBinding(resolved.binding, [...resolved.segments, spreadSegment]),
                "call-site structured return keeps this spread property exact",
              );
            }
          }
        }
        continue;
      }

      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }

      const propertyName = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;
      if (!propertyName) {
        continue;
      }

      const fullPath = [...segments, propertySegment(propertyName)];
      const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      const unwrapped = unwrapExpression(initializer);
      if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
        registerSpecializedStructuredReturnAliases(
          project,
          trackedObject,
          unwrapped,
          fullPath,
          maxDepth,
          localBindings,
          functionReturnSummaries,
          trackedObjectsById,
        );
        continue;
      }

      const resolved = resolveTrackedObjectAccess(
        project,
        unwrapped,
        localBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (resolved && !resolved.dynamic) {
        registerExactPathAlias(
          trackedObject,
          fullPath,
          extendTrackedBinding(resolved.binding, resolved.segments),
          "call-site structured return keeps this nested binding exact",
        );
      }
    }
    return;
  }

  node.elements.forEach((element, index) => {
    if (!element || ts.isSpreadElement(element)) {
      return;
    }

    const fullPath = [...segments, indexSegment(index)];
    const unwrapped = unwrapExpression(element);
    if (ts.isObjectLiteralExpression(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      registerSpecializedStructuredReturnAliases(
        project,
        trackedObject,
        unwrapped,
        fullPath,
        maxDepth,
        localBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
      return;
    }

    const resolved = resolveTrackedObjectAccess(
      project,
      unwrapped,
      localBindings,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (resolved && !resolved.dynamic) {
      registerExactPathAlias(
        trackedObject,
        fullPath,
        extendTrackedBinding(resolved.binding, resolved.segments),
        "call-site structured return keeps this nested binding exact",
      );
    }
  });
}

function pathStartsWith(path: PathSegment[], prefix: PathSegment[]): boolean {
  return path.length >= prefix.length && samePath(path.slice(0, prefix.length), prefix);
}

function buildCallSiteLocalBindings(
  project: ProjectContext,
  node: ts.CallExpression,
  callable: AnalyzableCallableBinding,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): {
  localBindings: Map<string, TrackedObjectBinding>;
  specializedBindings: Map<string, TrackedObjectBinding>;
} {
  const localBindings = new Map(trackedBySymbolId);
  const specializedBindings = new Map<string, TrackedObjectBinding>();

  node.arguments.forEach((argument, index) => {
    const parameter = callable.declaration.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return;
    }

    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) {
      return;
    }

    const paramSymbolKey = getSymbolKey(parameterSymbol);
    const baseBinding = trackedBySymbolId.get(paramSymbolKey);
    const specializedArgumentBinding = baseBinding
      ? getCallSiteStructuredArgumentBinding(
          project,
          node,
          argument,
          baseBinding,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        )
      : undefined;
    if (specializedArgumentBinding) {
      localBindings.set(paramSymbolKey, specializedArgumentBinding);
      specializedBindings.set(paramSymbolKey, specializedArgumentBinding);
    }
  });

  for (const forwarded of getForwardedParameterBindings(
    project,
    node,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  )) {
    localBindings.set(forwarded.paramSymbolKey, forwarded.binding);
    specializedBindings.set(forwarded.paramSymbolKey, forwarded.binding);
  }

  return {
    localBindings,
    specializedBindings,
  };
}

function remapCallSiteReturnBinding(
  binding: TrackedObjectBinding,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  specializedBindings: Map<string, TrackedObjectBinding>,
): TrackedObjectBinding {
  for (const [symbolKey, specializedBinding] of specializedBindings) {
    const baseBinding = trackedBySymbolId.get(symbolKey);
    if (!baseBinding || binding.trackedObject.id !== baseBinding.trackedObject.id) {
      continue;
    }

    if (!pathStartsWith(binding.prefix, baseBinding.prefix)) {
      continue;
    }

    return extendTrackedBinding(specializedBinding, binding.prefix.slice(baseBinding.prefix.length));
  }

  return binding;
}

function specializeReturnedAliasBinding(
  node: ts.CallExpression,
  binding: TrackedObjectBinding,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  specializedBindings: Map<string, TrackedObjectBinding>,
  trackedObjectsById: Map<string, TrackedObject>,
): TrackedObjectBinding {
  const directRemapped = remapCallSiteReturnBinding(binding, trackedBySymbolId, specializedBindings);
  if (!sameTrackedBinding(directRemapped, binding)) {
    return directRemapped;
  }

  if (specializedBindings.size === 0 || binding.trackedObject.exactPathAliases.size === 0) {
    return binding;
  }

  let changed = false;
  const remappedAliases = new Map<string, TrackedObject["exactPathAliases"] extends Map<string, infer T> ? T : never>();

  for (const [aliasPath, alias] of binding.trackedObject.exactPathAliases.entries()) {
    const sourceTrackedObject = trackedObjectsById.get(alias.sourceObjectId);
    if (!sourceTrackedObject) {
      remappedAliases.set(aliasPath, {
        ...alias,
        sourcePath: [...alias.sourcePath],
      });
      continue;
    }

    const remappedSource = remapCallSiteReturnBinding(
      {
        trackedObject: sourceTrackedObject,
        prefix: alias.sourcePath,
      },
      trackedBySymbolId,
      specializedBindings,
    );
    if (
      remappedSource.trackedObject.id !== alias.sourceObjectId
      || !samePath(remappedSource.prefix, alias.sourcePath)
    ) {
      changed = true;
    }

    remappedAliases.set(aliasPath, {
      ...alias,
      sourceObjectId: remappedSource.trackedObject.id,
      sourcePath: remappedSource.prefix,
    });
  }

  if (!changed) {
    return binding;
  }

  const callSiteId = `${binding.trackedObject.id}:returned-call:${node.getSourceFile().fileName}:${node.getStart()}`;
  const existing = trackedObjectsById.get(callSiteId);
  const specialized = existing ?? cloneTrackedObjectForCallSite(binding.trackedObject, callSiteId);
  if (existing) {
    syncTrackedObjectForCallSite(specialized, binding.trackedObject);
  } else {
    trackedObjectsById.set(callSiteId, specialized);
  }

  specialized.exactPathAliases = remappedAliases;
  return new TrackedObjectBindingRecord(specialized, binding.prefix);
}

function getCallSiteStructuredReturnBinding(
  project: ProjectContext,
  node: ts.CallExpression,
  callable: AnalyzableCallableBinding,
  summary: CallableReturnSummary,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): TrackedObjectBinding | undefined {
  const binding = getCallableReturnBinding(summary);
  if (!binding) {
    return undefined;
  }

  if (callable.declaration.parameters.length === 0) {
    return binding;
  }

  const { localBindings, specializedBindings } = buildCallSiteLocalBindings(
    project,
    node,
    callable,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );
  const remappedBinding = remapCallSiteReturnBinding(binding, trackedBySymbolId, specializedBindings);

  if (summary.kind !== "structured") {
    return specializeReturnedAliasBinding(
      node,
      remappedBinding,
      trackedBySymbolId,
      specializedBindings,
      trackedObjectsById,
    );
  }

  const literal = getStructuredReturnLiteral(project, callable);
  if (!literal) {
    return remappedBinding;
  }

  const callSiteId = `${binding.trackedObject.id}:call:${node.getSourceFile().fileName}:${node.getStart()}`;
  const existing = trackedObjectsById.get(callSiteId);
  if (existing) {
    if (isPristineCallSiteClone(existing)) {
      syncTrackedObjectForCallSite(existing, binding.trackedObject);

      registerSpecializedStructuredReturnAliases(
        project,
        existing,
        literal,
        [],
        project.config.value.objectAnalysis.maxPathDepth,
        localBindings,
        functionReturnSummaries,
        trackedObjectsById,
      );
    }

    return new TrackedObjectBindingRecord(existing, []);
  }

  const specialized = cloneTrackedObjectForCallSite(binding.trackedObject, callSiteId);
  trackedObjectsById.set(callSiteId, specialized);

  registerSpecializedStructuredReturnAliases(
    project,
    specialized,
    literal,
    [],
    project.config.value.objectAnalysis.maxPathDepth,
    localBindings,
    functionReturnSummaries,
    trackedObjectsById,
  );

  return new TrackedObjectBindingRecord(specialized, []);
}

export function getCallSiteStructuredArgumentBinding(
  project: ProjectContext,
  node: ts.CallExpression,
  argument: ts.Expression,
  baseBinding: TrackedObjectBinding,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): TrackedObjectBinding | undefined {
  const literal = unwrapExpression(argument);
  if (!ts.isObjectLiteralExpression(literal) && !ts.isArrayLiteralExpression(literal)) {
    return undefined;
  }

  const callSiteId = `${baseBinding.trackedObject.id}:arg:${node.getSourceFile().fileName}:${argument.getStart()}`;
  const existing = trackedObjectsById.get(callSiteId);
  if (existing) {
    if (isPristineCallSiteClone(existing)) {
      syncTrackedObjectForCallSite(existing, baseBinding.trackedObject);
      registerSpecializedStructuredReturnAliases(
        project,
        existing,
        literal,
        [],
        project.config.value.objectAnalysis.maxPathDepth,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
    }

    return new TrackedObjectBindingRecord(existing, []);
  }

  const specialized = cloneTrackedObjectForCallSite(baseBinding.trackedObject, callSiteId);
  trackedObjectsById.set(callSiteId, specialized);
  registerSpecializedStructuredReturnAliases(
    project,
    specialized,
    literal,
    [],
    project.config.value.objectAnalysis.maxPathDepth,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );

  return new TrackedObjectBindingRecord(specialized, []);
}

function extractBoundedElementAccessSegment(
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

function resolveArrayAtIndex(
  trackedObject: TrackedObject,
  segments: PathSegment[],
  argument: ts.Expression,
): number | undefined {
  const collection = getCollectionInfo(trackedObject, segments);
  if (!collection || collection.kind !== "array") {
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

export function isExactArrayCallbackMethod(methodName: string): boolean {
  return EXACT_ARRAY_CALLBACK_METHODS.has(methodName);
}

export function getSupportedArrayCallbackParamIndex(methodName: string): number | undefined {
  if (!isExactArrayCallbackMethod(methodName)) {
    return undefined;
  }

  return methodName === "reduce" || methodName === "reduceRight" ? 1 : 0;
}

export function getSupportedArrayCallbackIndexParamIndex(methodName: string): number | undefined {
  const valueParamIndex = getSupportedArrayCallbackParamIndex(methodName);
  return valueParamIndex === undefined ? undefined : valueParamIndex + 1;
}

function getContainerTypeName(project: ProjectContext, expression: ts.Expression): string | undefined {
  const typeSymbol = project.checker.getTypeAtLocation(expression).getSymbol();
  return typeSymbol?.getName();
}

function isObjectCreateNullExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Object"
    && node.expression.name.text === "create"
    && node.arguments.length === 1
    && node.arguments[0]!.kind === ts.SyntaxKind.NullKeyword;
}

function getLocallyOwnedRetainedBindingContainerKind(
  project: ProjectContext,
  expression: ts.Expression,
): "map-like" | "object-backed" | undefined {
  const node = unwrapExpression(expression);
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  for (const declaration of getCanonicalSymbol(project, symbol).declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }

    const initializer = unwrapExpression(declaration.initializer);
    if (
      ts.isNewExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && ["Map", "WeakMap"].includes(initializer.expression.text)
    ) {
      return "map-like";
    }

    if (isObjectCreateNullExpression(initializer)) {
      return "object-backed";
    }
  }

  return undefined;
}

function getRetainedBindingContainerReceiverKey(project: ProjectContext, receiver: ts.Expression): string | undefined {
  const node = unwrapExpression(receiver);
  if (!ts.isIdentifier(node)) {
    return undefined;
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  return symbol ? `container:${getCanonicalSymbolKey(project, symbol)}` : undefined;
}

function getRetainedBindingContainerStaticPropertySlotKey(
  project: ProjectContext,
  receiver: ts.Expression,
  propertyName: string,
): string | undefined {
  const receiverKey = getRetainedBindingContainerReceiverKey(project, receiver);
  return receiverKey ? `${receiverKey}:string:${propertyName}` : undefined;
}

export function isSupportedRetainedBindingContainerType(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  const typeName = getContainerTypeName(project, expression);
  return typeName === "Map"
    || typeName === "WeakMap"
    || getLocallyOwnedRetainedBindingContainerKind(project, expression) === "object-backed";
}

export function isLocallyOwnedRetainedBindingContainer(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  return getLocallyOwnedRetainedBindingContainerKind(project, expression) !== undefined;
}

function isLocallyOwnedObjectBackedRetainedBindingContainer(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  return getLocallyOwnedRetainedBindingContainerKind(project, expression) === "object-backed";
}

function getRetainedBindingContainerSlotToken(project: ProjectContext, expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `string:${node.text}`;
  }
  if (ts.isNumericLiteral(node)) {
    return `number:${node.text}`;
  }
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? `symbol:${getCanonicalSymbolKey(project, symbol)}` : undefined;
  }
  return undefined;
}

export function getRetainedBindingContainerSlotKey(
  project: ProjectContext,
  receiver: ts.Expression,
  slot: ts.Expression,
): string | undefined {
  const receiverKey = getRetainedBindingContainerReceiverKey(project, receiver);
  if (!receiverKey || !isSupportedRetainedBindingContainerType(project, receiver)) {
    return undefined;
  }

  const slotToken = getRetainedBindingContainerSlotToken(project, slot);
  if (!slotToken) {
    return undefined;
  }

  return `${receiverKey}:${slotToken}`;
}

function isDefinitelyNonNullishType(type: ts.Type): boolean {
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

export function getObjectBackedRetainedBindingSlotKeyFromAccess(
  project: ProjectContext,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (!isLocallyOwnedObjectBackedRetainedBindingContainer(project, node.expression)) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return getRetainedBindingContainerStaticPropertySlotKey(project, node.expression, node.name.text);
  }

  if (!node.argumentExpression) {
    return undefined;
  }

  const argument = unwrapExpression(node.argumentExpression);
  if (
    !ts.isStringLiteral(argument)
    && !ts.isNoSubstitutionTemplateLiteral(argument)
    && !ts.isNumericLiteral(argument)
  ) {
    return undefined;
  }

  return getRetainedBindingContainerSlotKey(project, node.expression, argument);
}

export function getAccessPath(
  node: ts.Node,
): { root: ts.Identifier; segments: PathSegment[]; dynamic: boolean } | undefined {
  if (ts.isIdentifier(node)) {
    return { root: node, segments: [], dynamic: false };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    return { root: nested.root, segments: [...nested.segments, propertySegment(node.name.text)], dynamic: nested.dynamic };
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = getAccessPath(node.expression);
    if (!nested) {
      return undefined;
    }
    if (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
      return {
        root: nested.root,
        segments: [
          ...nested.segments,
          ts.isNumericLiteral(node.argumentExpression)
            ? indexSegment(Number(node.argumentExpression.text))
            : propertySegment(node.argumentExpression.text),
        ],
        dynamic: nested.dynamic,
      };
    }
    return { root: nested.root, segments: nested.segments, dynamic: true };
  }

  return undefined;
}

/**
 * Resolves tracked access paths while preserving exactness boundaries for callers.
 */
export function resolveTrackedObjectAccess(
  project: ProjectContext,
  node: ts.Node,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): ResolvedTrackedObjectAccess | undefined {
  if (ts.isAwaitExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
  }

  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
  }

  if (ts.isIdentifier(node)) {
    const binding = getBindingByNode(project, node, trackedBySymbolId);
    return binding ? { binding, segments: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.name.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const retainedBinding = trackedBySymbolId.get(
      getObjectBackedRetainedBindingSlotKeyFromAccess(project, node) ?? "",
    );
    if (retainedBinding) {
      return {
        binding: retainedBinding,
        segments: [],
        dynamic: false,
      };
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (nested?.dynamic) {
      return nested;
    }
    if (!nested) {
      return undefined;
    }
    const currentBinding = collapseExactBindingPrefix(
      extendTrackedBinding(nested.binding, nested.segments),
      trackedObjectsById,
    );
    const aliased = resolveExactPathAlias(currentBinding, [propertySegment(node.name.text)], trackedObjectsById);
    const nextSegments = sameTrackedBinding(aliased.binding, currentBinding)
      ? [propertySegment(node.name.text)]
      : [];
    if (sameTrackedBinding(aliased.binding, currentBinding) && !hasExactTrackedPath(aliased.binding.trackedObject, [...aliased.binding.prefix, ...nextSegments])) {
      return undefined;
    }
    return {
      binding: aliased.binding,
      segments: nextSegments,
      dynamic: nested.dynamic,
      boundaryCategory: nested.boundaryCategory,
      boundaryReason: nested.boundaryReason,
      viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
      viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
    };
  }

  if (ts.isElementAccessExpression(node)) {
    if (isGlobalThisIdentifier(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      const binding = trackedBySymbolId.get(getGlobalThisBindingKey(node.argumentExpression.text));
      return binding ? { binding, segments: [], dynamic: false } : undefined;
    }

    const retainedBinding = trackedBySymbolId.get(
      getObjectBackedRetainedBindingSlotKeyFromAccess(project, node) ?? "",
    );
    if (retainedBinding) {
      return {
        binding: retainedBinding,
        segments: [],
        dynamic: false,
      };
    }

    const nested = resolveTrackedObjectAccess(project, node.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!nested) {
      return undefined;
    }

    if (nested.dynamic) {
      return nested;
    }

    const boundedSegment = extractBoundedElementAccessSegment(project, node.argumentExpression);
    if (boundedSegment) {
      const nextSegment = boundedSegment;
      const currentBinding = collapseExactBindingPrefix(
        extendTrackedBinding(nested.binding, nested.segments),
        trackedObjectsById,
      );
      const aliased = resolveExactPathAlias(currentBinding, [nextSegment], trackedObjectsById);
      const nextSegments = sameTrackedBinding(aliased.binding, currentBinding)
        ? [nextSegment]
        : [];
      if (sameTrackedBinding(aliased.binding, currentBinding) && !hasExactTrackedPath(aliased.binding.trackedObject, [...aliased.binding.prefix, ...nextSegments])) {
        return undefined;
      }
      return {
        binding: aliased.binding,
        segments: nextSegments,
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
        viaAliasObjectId: aliased.viaAliasObjectId ?? nested.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? nested.viaAliasPath,
      };
    }

    const targetPath = [...nested.binding.prefix, ...nested.segments];
    const isArrayIndex = getCollectionInfo(nested.binding.trackedObject, targetPath)?.kind === "array";
    return {
      binding: nested.binding,
      segments: nested.segments,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "pop" || node.expression.name.text === "shift")
      && node.arguments.length === 0
    ) {
      const receiver = resolveTrackedObjectAccess(
        project,
        node.expression.expression,
        trackedBySymbolId,
        functionReturnSummaries,
        trackedObjectsById,
      );
      if (!receiver) {
        return undefined;
      }

      if (receiver.dynamic) {
        return receiver;
      }

      const receiverPath = [...receiver.binding.prefix, ...receiver.segments];
      const collection = getCollectionInfo(receiver.binding.trackedObject, receiverPath);
      if (collection?.kind !== "array") {
        return undefined;
      }

      const arrayLength = getTrackedArrayLength(receiver.binding.trackedObject, receiverPath);
      const targetIndex = node.expression.name.text === "pop"
        ? (arrayLength !== undefined && arrayLength > 0 ? arrayLength - 1 : undefined)
        : arrayLength === 1
          ? 0
          : undefined;
      if (targetIndex === undefined) {
        return undefined;
      }

      const aliased = resolveExactPathAlias(
        receiver.binding,
        [...receiver.segments, indexSegment(targetIndex)],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, receiver.binding)
          ? [...receiver.segments, indexSegment(targetIndex)]
          : [],
        dynamic: false,
        viaAliasObjectId: aliased.viaAliasObjectId ?? receiver.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? receiver.viaAliasPath,
      };
    }

    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "at"
      && node.arguments.length === 1
    ) {
      const receiver = resolveTrackedObjectAccess(project, node.expression.expression, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
      if (!receiver) {
        return undefined;
      }

      if (receiver.dynamic) {
        return receiver;
      }

      const receiverPath = [...receiver.binding.prefix, ...receiver.segments];
      const collection = getCollectionInfo(receiver.binding.trackedObject, receiverPath);
      if (collection?.kind !== "array") {
        return undefined;
      }

      const resolvedIndex = resolveArrayAtIndex(receiver.binding.trackedObject, receiverPath, node.arguments[0]!);
      if (resolvedIndex === undefined) {
        return {
          binding: receiver.binding,
          segments: receiver.segments,
          dynamic: true,
          boundaryCategory: "array-at-call",
          boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
          viaAliasObjectId: receiver.viaAliasObjectId,
          viaAliasPath: receiver.viaAliasPath,
        };
      }

      const aliased = resolveExactPathAlias(
        receiver.binding,
        [...receiver.segments, indexSegment(resolvedIndex)],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, receiver.binding)
          ? [...receiver.segments, indexSegment(resolvedIndex)]
          : [],
        dynamic: false,
        viaAliasObjectId: aliased.viaAliasObjectId ?? receiver.viaAliasObjectId,
        viaAliasPath: aliased.viaAliasPath ?? receiver.viaAliasPath,
      };
    }

    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "get"
      && node.arguments.length === 1
      && isLocallyOwnedRetainedBindingContainer(project, node.expression.expression)
    ) {
      const slotKey = getRetainedBindingContainerSlotKey(project, node.expression.expression, node.arguments[0]!);
      const binding = slotKey ? trackedBySymbolId.get(slotKey) : undefined;
      if (binding) {
        return {
          binding,
          segments: [],
          dynamic: false,
        };
      }
    }

    const callable = resolveAnalyzableCallableBinding(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    const summary = callable ? functionReturnSummaries.get(callable.symbolKey) : undefined;
    const binding = callable && summary
      ? getCallSiteStructuredReturnBinding(
          project,
          node,
          callable,
          summary,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        )
      : undefined;
    return binding
      ? {
          binding,
          segments: [],
          dynamic: false,
        }
      : undefined;
  }

  if (
    ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    const left = resolveTrackedObjectAccess(project, node.left, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const right = resolveTrackedObjectAccess(project, node.right, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!left) {
      return right && !right.dynamic ? right : undefined;
    }
    if (!right) {
      return left && !left.dynamic ? left : undefined;
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && !left.dynamic
      && isDefinitelyNonNullishType(project.checker.getTypeAtLocation(node.left))
    ) {
      return left;
    }
    return sameTrackedBinding(extendTrackedBinding(left.binding, left.segments), extendTrackedBinding(right.binding, right.segments))
      ? {
          binding: left.binding,
          segments: left.segments,
          dynamic: left.dynamic || right.dynamic,
          boundaryCategory: left.boundaryCategory ?? right.boundaryCategory,
          boundaryReason: left.boundaryReason ?? right.boundaryReason,
        }
      : undefined;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveTrackedObjectAccess(project, node.whenTrue, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    const whenFalse = resolveTrackedObjectAccess(project, node.whenFalse, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!whenTrue) {
      return whenFalse && !whenFalse.dynamic ? whenFalse : undefined;
    }
    if (!whenFalse) {
      return whenTrue && !whenTrue.dynamic ? whenTrue : undefined;
    }
    return sameTrackedBinding(
      extendTrackedBinding(whenTrue.binding, whenTrue.segments),
      extendTrackedBinding(whenFalse.binding, whenFalse.segments),
    )
      ? {
          binding: whenTrue.binding,
          segments: whenTrue.segments,
          dynamic: whenTrue.dynamic || whenFalse.dynamic,
          boundaryCategory: whenTrue.boundaryCategory ?? whenFalse.boundaryCategory,
          boundaryReason: whenTrue.boundaryReason ?? whenFalse.boundaryReason,
        }
      : undefined;
  }

  return undefined;
}

export function resolveAnalyzableCallableBinding(
  project: ProjectContext,
  expression: ts.LeftHandSideExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): AnalyzableCallableBinding | undefined {
  const direct = getAnalyzableCallableBinding(project, expression);
  if (direct) {
    return direct;
  }

  let receiverExpression: ts.Expression | undefined;
  let nextSegment: PathSegment | undefined;
  if (ts.isPropertyAccessExpression(expression)) {
    receiverExpression = expression.expression;
    nextSegment = propertySegment(expression.name.text);
  } else if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    receiverExpression = expression.expression;
    nextSegment = extractBoundedElementAccessSegment(project, expression.argumentExpression);
  }

  if (!receiverExpression || !nextSegment) {
    return undefined;
  }

  const receiver = resolveTrackedObjectAccess(
    project,
    receiverExpression,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );
  if (!receiver || receiver.dynamic) {
    return undefined;
  }

  return receiver.binding.trackedObject.callablePaths.get(
    serializePath([...receiver.binding.prefix, ...receiver.segments, nextSegment]),
  );
}

export function getForwardedParameterBindings(
  project: ProjectContext,
  node: ts.CallExpression,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  functionReturnSummaries: Map<string, CallableReturnSummary>,
  trackedObjectsById: Map<string, TrackedObject>,
): ForwardedParameterBinding[] {
  const callable = resolveAnalyzableCallableBinding(
    project,
    node.expression,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
  );
  if (!callable) {
    return [];
  }

  const enclosingFunction = ts.findAncestor(
    node,
    (ancestor): ancestor is ts.FunctionLikeDeclaration => ts.isFunctionLike(ancestor),
  );
  const enclosingCallable = enclosingFunction
    ? getAnalyzableCallableBindingFromDeclaration(project, enclosingFunction)
    : undefined;
  if (enclosingCallable?.symbolKey === callable.symbolKey) {
    return [];
  }

  const forwarded: ForwardedParameterBinding[] = [];

  node.arguments.forEach((argument, index) => {
    const parameter = callable.declaration.parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return;
    }

    const resolved = resolveTrackedObjectAccess(project, argument, trackedBySymbolId, functionReturnSummaries, trackedObjectsById);
    if (!resolved || resolved.dynamic) {
      return;
    }

    const parameterSymbol = project.checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) {
      return;
    }

    forwarded.push({
      index,
      paramSymbolKey: getSymbolKey(parameterSymbol),
      binding: extendTrackedBinding(resolved.binding, resolved.segments),
    });
  });

  return forwarded;
}

export function getBindingSymbolKey(
  project: ProjectContext,
  node: ts.Expression | ts.ForInitializer | ts.ParameterDeclaration,
): string | undefined {
  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  if (ts.isVariableDeclarationList(node) && node.declarations.length === 1) {
    const [declaration] = node.declarations;
    if (declaration && ts.isIdentifier(declaration.name)) {
      const symbol = project.checker.getSymbolAtLocation(declaration.name);
      return symbol ? getSymbolKey(symbol) : undefined;
    }
  }

  if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
    const symbol = project.checker.getSymbolAtLocation(node.name);
    return symbol ? getSymbolKey(symbol) : undefined;
  }

  return undefined;
}

/**
 * Resolves projected callback element access while preserving exactness boundaries.
 */
export function resolveProjectionAccess(
  project: ProjectContext,
  node: ts.Node,
  context: ProjectedArrayUsageContext,
): ResolvedProjectionAccess | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveProjectionAccess(project, node.expression, context);
  }

  if (ts.isIdentifier(node)) {
    const symbol = project.checker.getSymbolAtLocation(node);
    const projection = symbol ? context.elementBindings.get(getSymbolKey(symbol)) : undefined;
    return projection ? { projection, suffix: [], dynamic: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, context);
    if (nested?.dynamic) {
      return nested;
    }
    return nested
      ? {
          projection: nested.projection,
          suffix: [...nested.suffix, propertySegment(node.name.text)],
          dynamic: nested.dynamic,
          boundaryCategory: nested.boundaryCategory,
          boundaryReason: nested.boundaryReason,
        }
      : undefined;
  }

  if (ts.isElementAccessExpression(node)) {
    const nested = resolveProjectionAccess(project, node.expression, context);
    if (!nested) {
      const receiver = unwrapExpression(node.expression);
      const index = unwrapExpression(node.argumentExpression);
      if (!ts.isIdentifier(receiver) || !ts.isIdentifier(index)) {
        return undefined;
      }

      const receiverSymbol = project.checker.getSymbolAtLocation(receiver);
      const indexSymbol = project.checker.getSymbolAtLocation(index);
      const receiverProjection = receiverSymbol ? context.receiverBindings.get(getSymbolKey(receiverSymbol)) : undefined;
      const indexProjection = indexSymbol ? context.indexBindings.get(getSymbolKey(indexSymbol)) : undefined;
      if (!receiverProjection || !indexProjection) {
        return undefined;
      }

      const sameProjection = receiverProjection.trackedObject.id === indexProjection.trackedObject.id
        && samePath(receiverProjection.sourcePath, indexProjection.sourcePath);
      return sameProjection
        ? {
            projection: receiverProjection,
            suffix: [],
            dynamic: false,
          }
        : {
            projection: receiverProjection,
            suffix: [],
            dynamic: true,
            boundaryCategory: "dynamic-array-index",
            boundaryReason: "callback index cannot yet be correlated across different tracked arrays",
          };
    }

    if (nested.dynamic) {
      return nested;
    }

    const boundedSegment = extractBoundedElementAccessSegment(project, node.argumentExpression);
    if (boundedSegment) {
      return {
        projection: nested.projection,
        suffix: [
          ...nested.suffix,
          boundedSegment,
        ],
        dynamic: nested.dynamic,
        boundaryCategory: nested.boundaryCategory,
        boundaryReason: nested.boundaryReason,
      };
    }

    const concreteTargets = getConcreteProjectionPaths(nested.projection, nested.suffix);
    const isArrayIndex = concreteTargets.some((path) => getCollectionInfo(nested.projection.trackedObject, path)?.kind === "array");
    return {
      projection: nested.projection,
      suffix: nested.suffix,
      dynamic: true,
      boundaryCategory: isArrayIndex ? "dynamic-array-index" : "computed-property-access",
      boundaryReason: isArrayIndex
        ? "dynamic array index prevents exact element analysis"
        : "computed property access prevents exact path analysis",
    };
  }

  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "at"
    && node.arguments.length === 1
  ) {
    const receiver = resolveProjectionAccess(project, node.expression.expression, context);
    if (!receiver) {
      return undefined;
    }

    if (receiver.dynamic) {
      return receiver;
    }

    const elementPaths = getConcreteProjectionPaths(receiver.projection, receiver.suffix)
      .map((receiverPath) => {
        const resolvedIndex = resolveArrayAtIndex(receiver.projection.trackedObject, receiverPath, node.arguments[0]!);
        return resolvedIndex === undefined ? undefined : [...receiverPath, indexSegment(resolvedIndex)];
      })
      .filter((path): path is PathSegment[] => Boolean(path));

    if (elementPaths.length === 0) {
      return {
        projection: receiver.projection,
        suffix: receiver.suffix,
        dynamic: true,
        boundaryCategory: "array-at-call",
        boundaryReason: "non-literal .at(...) prevents exact array slot analysis",
      };
    }

    return {
      projection: {
        trackedObject: receiver.projection.trackedObject,
        sourcePath: receiver.projection.sourcePath,
        elementPaths,
      },
      suffix: [],
      dynamic: false,
    };
  }

  return undefined;
}
