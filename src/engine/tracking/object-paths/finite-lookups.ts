import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
  TrackedObject,
} from "../../../types.js";
import { propertySegment, serializePath } from "../../../shared/path-utils.js";
import {
  getBindingSymbolKey,
  resolveAnalyzableCallableBinding,
  resolveTrackedObjectAccess,
} from "../access.js";
import {
  extendTrackedBinding,
  sameTrackedBinding,
} from "../bindings.js";
import { getAnalyzableCallableBindingFromDeclaration } from "../callables.js";
import type {
  CallableReturnSummary,
  TrackedObjectBinding,
} from "../model.js";
import {
  getCollectionInfo,
  resolveExactPathAlias,
} from "../state.js";
import type { FiniteLookupCandidate } from "./types.js";
import { extractFinitePropertyUnionSegments } from "./policy.js";

interface FiniteLookupReadPlan {
  candidates: FiniteLookupCandidate[];
  suffix: PathSegment[];
}

interface FiniteLookupPlannerOptions {
  project: ProjectContext;
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
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    finiteLookupBindings,
    helperFiniteReturnCache,
    hasExactTrackedPath,
    collapseExactBindingPrefix,
  } = options;

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
    if (getCollectionInfo(collapsedBinding.trackedObject, collapsedBinding.prefix)?.kind === "array") {
      return undefined;
    }

    const candidateSegments = extractFinitePropertyUnionSegments(project, node.argumentExpression);
    if (!candidateSegments) {
      return undefined;
    }

    const exactCandidateSegments = candidateSegments.filter((candidateSegment) => hasExactTrackedPath(
      collapsedBinding,
      [candidateSegment],
    ));
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
