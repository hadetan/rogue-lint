import ts from "typescript";

import type { PathSegment, ProjectContext, TrackedObject } from "../../../types.js";
import { propertySegment, serializePath } from "../../../shared/path-utils.js";
import { getBindingSymbolKey, resolveAnalyzableCallableBinding, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, sameTrackedBinding } from "../bindings.js";
import {
  getAnalyzableCallableBindingFromDeclaration,
  resolveAnalyzableFunctionDeclaration,
} from "../callables.js";
import type { CallableReturnSummary, TrackedObjectBinding } from "../model.js";
import { getCollectionInfo, resolveExactPathAlias } from "../state.js";
import { unwrapExpression } from "../syntax.js";
import { TRACKING_COLLECTION_KIND } from "../vocabulary.js";
import type { FiniteLookupCandidate } from "./types.js";
import { extractFinitePropertyUnionSegments } from "./policy.js";

interface FiniteLookupReadPlan {
  candidates: FiniteLookupCandidate[];
  suffix: PathSegment[];
}

interface FiniteLookupPlannerOptions {
  project: ProjectContext;
  reachableFiles: ReadonlySet<string>;
  publiclyReachableCallableIds: ReadonlySet<string>;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  finiteLookupBindings: Map<string, FiniteLookupCandidate[]>;
  helperFiniteReturnCache: Map<string, FiniteLookupReadPlan | null>;
  hasExactTrackedPath: (binding: TrackedObjectBinding, segments: PathSegment[]) => boolean;
  collapseExactBindingPrefix: (binding: TrackedObjectBinding) => TrackedObjectBinding;
}

/**
 * Creates the bounded finite-key lookup planner used by the object-path stage.
 */
export function createFiniteLookupPlanner(options: FiniteLookupPlannerOptions): {
  getHelperFiniteReturnPlan: (callable: ts.FunctionLikeDeclaration) => FiniteLookupReadPlan | undefined;
  resolveFiniteLookupRead: (node: ts.Expression) => FiniteLookupReadPlan | undefined;
} {
  const {
    project,
    reachableFiles,
    publiclyReachableCallableIds,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    finiteLookupBindings,
    helperFiniteReturnCache,
    hasExactTrackedPath,
    collapseExactBindingPrefix,
  } = options;
  const helperStringReturnCache = new Map<string, PathSegment[] | null>();
  const parameterFiniteCandidateCache = new Map<string, PathSegment[] | null>();

  const mergeFiniteSegments = (...candidates: Array<PathSegment[] | undefined>): PathSegment[] | undefined => {
    const merged: PathSegment[] = [];
    const seen = new Set<string>();

    for (const candidateSet of candidates) {
      if (!candidateSet || candidateSet.length === 0) {
        return undefined;
      }

      for (const candidate of candidateSet) {
        const key = serializePath([candidate]);
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        merged.push(candidate);
      }
    }

    return merged.length > 0 ? merged : undefined;
  };

  const isPublicHelperParameterIdentifier = (expression: ts.Expression | undefined): boolean => {
    if (!expression) {
      return false;
    }

    const node = unwrapExpression(expression);
    if (!ts.isIdentifier(node)) {
      return false;
    }

    const symbol = project.checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.find(ts.isParameter);
    if (!declaration) {
      return false;
    }

    const callable = (
      ts.isFunctionDeclaration(declaration.parent)
      || ts.isFunctionExpression(declaration.parent)
      || ts.isArrowFunction(declaration.parent)
      || ts.isMethodDeclaration(declaration.parent)
    )
      ? declaration.parent
      : undefined;
    const callableBinding = callable
      ? getAnalyzableCallableBindingFromDeclaration(project, callable)
      : undefined;
    return Boolean(callableBinding && publiclyReachableCallableIds.has(callableBinding.symbolKey));
  };

  const getDirectPropertyCandidateCount = (binding: TrackedObjectBinding): number => {
    const collection = getCollectionInfo(binding.trackedObject, binding.prefix);
    if (!collection || collection.kind !== TRACKING_COLLECTION_KIND.object) {
      return 0;
    }

    const seen = new Set<string>();
    for (const childPath of collection.childPaths) {
      if (childPath.length !== binding.prefix.length + 1) {
        continue;
      }

      const segment = childPath[binding.prefix.length];
      if (!segment || segment.kind !== "property") {
        continue;
      }

      seen.add(serializePath([segment]));
    }

    return seen.size;
  };

  const serializeCandidateMap = (candidates: ReadonlyMap<string, PathSegment[]>): string => [...candidates.entries()]
    .map(([symbolKey, segments]) => `${symbolKey}=${segments.map((segment) => serializePath([segment])).sort().join(",")}`)
    .sort()
    .join("|");

  const collectFiniteStringCandidates = (
    expression: ts.Expression,
    parameterCandidates = new Map<string, PathSegment[]>(),
    activeCallKeys = new Set<string>(),
  ): PathSegment[] | undefined => {
    const typedCandidates = extractFinitePropertyUnionSegments(project, expression);
    if (typedCandidates) {
      return typedCandidates;
    }

    const node = unwrapExpression(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [propertySegment(node.text)];
    }

    if (ts.isBinaryExpression(node)) {
      if (
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ) {
        return mergeFiniteSegments(
          collectFiniteStringCandidates(node.left, parameterCandidates, activeCallKeys),
          collectFiniteStringCandidates(node.right, parameterCandidates, activeCallKeys),
        );
      }

      return undefined;
    }

    if (ts.isConditionalExpression(node)) {
      return mergeFiniteSegments(
        collectFiniteStringCandidates(node.whenTrue, parameterCandidates, activeCallKeys),
        collectFiniteStringCandidates(node.whenFalse, parameterCandidates, activeCallKeys),
      );
    }

    if (ts.isIdentifier(node)) {
      const symbolKey = getBindingSymbolKey(project, node);
      if (symbolKey) {
        const parameterCandidateSet = parameterCandidates.get(symbolKey);
        if (parameterCandidateSet) {
          return parameterCandidateSet;
        }
      }

      const symbol = project.checker.getSymbolAtLocation(node);
      if (!symbol) {
        return undefined;
      }

      for (const declaration of symbol.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration)
          && declaration.initializer
          && ts.isIdentifier(declaration.name)
          && ts.isVariableDeclarationList(declaration.parent)
          && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
          return collectFiniteStringCandidates(declaration.initializer, parameterCandidates, activeCallKeys);
        }

        if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) {
          const parameterSymbolKey = getBindingSymbolKey(project, declaration.name);
          if (!parameterSymbolKey) {
            return undefined;
          }

          const cached = parameterFiniteCandidateCache.get(parameterSymbolKey);
          if (cached !== undefined) {
            return cached ?? undefined;
          }

          const callable = (
            ts.isFunctionDeclaration(declaration.parent)
            || ts.isFunctionExpression(declaration.parent)
            || ts.isArrowFunction(declaration.parent)
            || ts.isMethodDeclaration(declaration.parent)
          )
            ? declaration.parent
            : undefined;
          const callableBinding = callable
            ? getAnalyzableCallableBindingFromDeclaration(project, callable)
            : undefined;
          const parameterIndex = callable?.parameters.findIndex((candidate) => candidate === declaration) ?? -1;
          if (
            !callable
            || !callableBinding
            || parameterIndex < 0
          ) {
            parameterFiniteCandidateCache.set(parameterSymbolKey, null);
            return undefined;
          }

          const callableIsPublic = publiclyReachableCallableIds.has(callableBinding.symbolKey);

          let sawReachableCall = false;
          let unsupported = false;
          let collected: PathSegment[] | undefined;
          for (const sourceFile of project.sourceFiles) {
            if (!reachableFiles.has(sourceFile.fileName)) {
              continue;
            }

            const visit = (candidate: ts.Node): void => {
              if (unsupported) {
                return;
              }

              if (ts.isCallExpression(candidate)) {
                const resolvedCallable = resolveAnalyzableFunctionDeclaration(project, candidate.expression);
                const resolvedBinding = resolvedCallable
                  ? getAnalyzableCallableBindingFromDeclaration(project, resolvedCallable)
                  : undefined;
                if (resolvedBinding?.symbolKey === callableBinding.symbolKey) {
                  sawReachableCall = true;
                  const argument = candidate.arguments[parameterIndex];
                  const argumentCandidates = argument
                    ? collectFiniteStringCandidates(argument, new Map(), activeCallKeys)
                    : undefined;
                  if (!argumentCandidates) {
                    if (!callableIsPublic) {
                      unsupported = true;
                    }
                    return;
                  }

                  collected = collected
                    ? mergeFiniteSegments(collected, argumentCandidates)
                    : argumentCandidates;
                }
              }

              ts.forEachChild(candidate, visit);
            };

            ts.forEachChild(sourceFile, visit);
            if (unsupported) {
              break;
            }
          }

          const result = (!unsupported || callableIsPublic) && sawReachableCall && collected && collected.length > 1
            ? collected
            : null;
          parameterFiniteCandidateCache.set(parameterSymbolKey, result);
          return result ?? undefined;
        }
      }

      return undefined;
    }

    if (ts.isCallExpression(node)) {
      const callable = resolveAnalyzableFunctionDeclaration(project, node.expression);
      const callableBinding = callable ? getAnalyzableCallableBindingFromDeclaration(project, callable) : undefined;
      if (!callable || !callableBinding || !callable.body) {
        return undefined;
      }

      const callParameterCandidates = new Map<string, PathSegment[]>();
      callable.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) {
          return;
        }

        const parameterSymbolKey = getBindingSymbolKey(project, parameter.name);
        const argument = node.arguments[index];
        const argumentCandidates = argument
          ? collectFiniteStringCandidates(argument, parameterCandidates, activeCallKeys)
          : undefined;
        if (parameterSymbolKey && argumentCandidates) {
          callParameterCandidates.set(parameterSymbolKey, argumentCandidates);
        }
      });

      const callKey = `${callableBinding.symbolKey}:${serializeCandidateMap(callParameterCandidates)}`;
      if (activeCallKeys.has(callKey)) {
        return undefined;
      }

      const cached = helperStringReturnCache.get(callKey);
      if (cached !== undefined) {
        return cached ?? undefined;
      }

      helperStringReturnCache.set(callKey, null);
      const nestedActiveCallKeys = new Set(activeCallKeys);
      nestedActiveCallKeys.add(callKey);

      let sawReturn = false;
      let unsupported = false;
      let collected: PathSegment[] | undefined;
      const visitReturn = (candidate: ts.Node): void => {
        if (unsupported) {
          return;
        }

        if (ts.isFunctionLike(candidate) && candidate !== callable) {
          return;
        }

        if (ts.isReturnStatement(candidate) && candidate.expression) {
          sawReturn = true;
          const returnCandidates = collectFiniteStringCandidates(
            candidate.expression,
            callParameterCandidates,
            nestedActiveCallKeys,
          );
          if (!returnCandidates) {
            unsupported = true;
            return;
          }

          collected = collected
            ? mergeFiniteSegments(collected, returnCandidates)
            : returnCandidates;
        }

        ts.forEachChild(candidate, visitReturn);
      };

      ts.forEachChild(callable.body, visitReturn);
      const result = !unsupported && sawReturn && collected && collected.length > 0
        ? collected
        : null;
      helperStringReturnCache.set(callKey, result);
      return result ?? undefined;
    }

    return undefined;
  };

  const resolveFiniteLookupCandidates = (node: ts.ElementAccessExpression): FiniteLookupCandidate[] | undefined => {
    const nested = resolveTrackedObjectAccess(
      project,
      node.expression,
      trackedBySymbolId,
      functionReturnSummaries,
      trackedObjectsById,
    );
    if (!nested || nested.dynamic) {
      return undefined;
    }

    const collapsedBinding = collapseExactBindingPrefix(extendTrackedBinding(nested.binding, nested.segments));
    if (getCollectionInfo(collapsedBinding.trackedObject, collapsedBinding.prefix)?.kind === TRACKING_COLLECTION_KIND.array) {
      return undefined;
    }

    const candidateSegments = extractFinitePropertyUnionSegments(project, node.argumentExpression)
      ?? collectFiniteStringCandidates(node.argumentExpression);
    if (!candidateSegments) {
      return undefined;
    }

    const exactCandidateSegments = candidateSegments.filter((candidateSegment) => hasExactTrackedPath(
      collapsedBinding,
      [candidateSegment],
    ));
    if (isPublicHelperParameterIdentifier(node.argumentExpression)) {
      const directPropertyCandidateCount = getDirectPropertyCandidateCount(collapsedBinding);
      if (directPropertyCandidateCount === 0 || exactCandidateSegments.length !== directPropertyCandidateCount) {
        return undefined;
      }
    }
    if (exactCandidateSegments.length <= 1) {
      return undefined;
    }

    return exactCandidateSegments.map((candidateSegment) => {
      const aliased = resolveExactPathAlias(
        collapsedBinding,
        [candidateSegment],
        trackedObjectsById,
      );
      return {
        binding: aliased.binding,
        segments: sameTrackedBinding(aliased.binding, collapsedBinding) ? [candidateSegment] : [],
      };
    });
  };

  const getHelperFiniteReturnPlan = (
    callable: ts.FunctionLikeDeclaration,
  ): FiniteLookupReadPlan | undefined => {
    if (!callable.body) {
      return undefined;
    }

    const helperSymbol = getAnalyzableCallableBindingFromDeclaration(project, callable)?.symbolKey;
    if (!helperSymbol) {
      return undefined;
    }

    const cached = helperFiniteReturnCache.get(helperSymbol);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    let plan: FiniteLookupReadPlan | undefined;
    let unsupported = false;
    const visitReturn = (candidate: ts.Node): void => {
      if (unsupported) {
        return;
      }

      if (ts.isFunctionLike(candidate) && candidate !== callable) {
        return;
      }

      if (ts.isReturnStatement(candidate) && candidate.expression) {
        const next = resolveFiniteLookupRead(candidate.expression);
        if (!next) {
          unsupported = true;
          return;
        }

        if (!plan) {
          plan = next;
        } else if (
          plan.suffix.length !== next.suffix.length
          || serializePath(plan.suffix) !== serializePath(next.suffix)
          || plan.candidates.length !== next.candidates.length
          || plan.candidates.some((existing, index) => {
            const other = next.candidates[index];
            return !other
              || existing.binding.trackedObject.id !== other.binding.trackedObject.id
              || serializePath(existing.binding.prefix) !== serializePath(other.binding.prefix)
              || serializePath(existing.segments) !== serializePath(other.segments);
          })
        ) {
          unsupported = true;
        }
      }

      ts.forEachChild(candidate, visitReturn);
    };

    ts.forEachChild(callable.body, visitReturn);
    helperFiniteReturnCache.set(helperSymbol, !unsupported && plan ? plan : null);
    return !unsupported && plan ? plan : undefined;
  };

  const resolveFiniteLookupRead = (node: ts.Expression): FiniteLookupReadPlan | undefined => {
    if (ts.isElementAccessExpression(node)) {
      const candidates = resolveFiniteLookupCandidates(node);
      return candidates ? { candidates, suffix: [] } : undefined;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const directCandidates = ts.isElementAccessExpression(node.expression)
        ? resolveFiniteLookupCandidates(node.expression)
        : undefined;
      const aliasCandidates = !directCandidates && ts.isIdentifier(node.expression)
        ? finiteLookupBindings.get(getBindingSymbolKey(project, node.expression) ?? "")
        : undefined;
      const helperCandidates = !directCandidates && !aliasCandidates && ts.isCallExpression(node.expression)
        ? (() => {
            const callable = resolveAnalyzableCallableBinding(
              project,
              node.expression.expression,
              trackedBySymbolId,
              functionReturnSummaries,
              trackedObjectsById,
            )?.declaration;
            const plan = callable ? getHelperFiniteReturnPlan(callable) : undefined;
            return plan?.suffix.length === 0 ? plan.candidates : undefined;
          })()
        : undefined;
      const candidates = directCandidates ?? aliasCandidates ?? helperCandidates;
      return candidates ? { candidates, suffix: [propertySegment(node.name.text)] } : undefined;
    }

    return undefined;
  };

  return {
    getHelperFiniteReturnPlan,
    resolveFiniteLookupRead,
  };
}
