import ts from "typescript";

import type { PathSegment, ProjectContext, TrackedObject } from "../../../types.js";
import { getSymbolKey, isReadLikeUse } from "../../../compiler/ast-utils.js";
import { propertySegment, serializePath } from "../../../shared/path-utils.js";
import { getBindingSymbolKey, resolveTrackedObjectAccess } from "../access.js";
import { extendTrackedBinding, getCanonicalSymbolKey } from "../bindings.js";
import { getAnalyzableCallableBinding, resolveAnalyzableFunctionDeclaration } from "../callables.js";
import type { CallableReturnSummary, ExactAppendSlotPlan, HelperParameterSummary, TrackedObjectBinding } from "../model.js";
import type { TrackingAppendMethodName } from "../vocabulary.js";
import { TRACKING_ARRAY_EXACT_APPEND_METHODS, TRACKING_COLLECTION_KIND, TRACKING_METHOD_NAME } from "../vocabulary.js";
import { summarizeHelperParameterUse } from "../semantics.js";
import { unwrapExpression } from "../syntax.js";
import { getCollectionInfo } from "../state.js";
import type {
  BoundedHelperExecutionStep, BoundedHelperExecutionSnapshot, HelperExactAppendPlan,
  HelperProjectedUsagePlan, HigherOrderCallableReturnSummary
} from "./types.js";
import { HigherOrderCallableReturnSummaryState } from "./types.js";

interface HelperPlanningOptions {
  project: ProjectContext;
  trackedBySymbolId: Map<string, TrackedObjectBinding>;
  functionReturnSummaries: ReadonlyMap<string, CallableReturnSummary>;
  trackedObjectsById: Map<string, TrackedObject>;
  parameterMeaningfulUse: Map<string, boolean | null>;
  parameterSummaryCache: Map<string, HelperParameterSummary | null>;
  helperExecutionSnapshotCache: Map<string, BoundedHelperExecutionSnapshot | null>;
  helperExactAppendPlanCache: Map<string, HelperExactAppendPlan[] | null>;
  helperProjectedUsagePlanCache: Map<string, HelperProjectedUsagePlan[] | null>;
  higherOrderCallableReturnSummaryCache: Map<string, HigherOrderCallableReturnSummary | null>;
}

/**
 * Creates helper-planning utilities used by the object-path stage.
 */
export function createHelperPlanningHelpers(options: HelperPlanningOptions): {
  getHigherOrderCallableReturnSummary: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ) => HigherOrderCallableReturnSummary;
  getBoundedHelperExecutionSnapshot: (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ) => BoundedHelperExecutionSnapshot | undefined;
  resolveCallableArgumentBinding: (expression: ts.Expression) => ReturnType<typeof getAnalyzableCallableBinding>;
} {
  const {
    project,
    trackedBySymbolId,
    functionReturnSummaries,
    trackedObjectsById,
    parameterMeaningfulUse,
    parameterSummaryCache,
    helperExecutionSnapshotCache,
    helperExactAppendPlanCache,
    helperProjectedUsagePlanCache,
    higherOrderCallableReturnSummaryCache,
  } = options;

  const observeHigherOrderCallableReturnSummaryShape = (
    summary: HigherOrderCallableReturnSummary,
  ): void => {
    summary.exactReadPaths;
    summary.boundaryReason;
  };

  const observeBoundedHelperExecutionStepShape = (step: BoundedHelperExecutionStep): void => {
    switch (step.kind) {
      case "projected-iteration-binding":
        step.statement;
        step.relativeCollectionPath;
        step.elementSymbolKey;
        return;
      case "alias-write":
        step.statement;
        step.targetSymbolKey;
        step.sourceSymbolKey;
        step.operator;
        return;
      case "exact-append-mutation":
        step.call;
        step.sourceFile;
        step.methodName;
        step.relativeCollectionPath;
        step.slotPlans;
        return;
      case "spread-materialization-prerequisite":
        step.expression;
        step.sourceSymbolKey;
        return;
      case "returned-carrier-emission":
        step.statement;
        step.sourceSymbolKey;
        return;
    }
  };

  const EMPTY_HIGHER_ORDER_CALLABLE_RETURN_SUMMARY = new HigherOrderCallableReturnSummaryState();
  observeHigherOrderCallableReturnSummaryShape(EMPTY_HIGHER_ORDER_CALLABLE_RETURN_SUMMARY);

  const createHigherOrderCallableReturnSummary = (
    exactReadPaths: PathSegment[][],
    boundaryReason?: string,
  ): HigherOrderCallableReturnSummary => {
    const summary = new HigherOrderCallableReturnSummaryState(exactReadPaths, boundaryReason);
    observeHigherOrderCallableReturnSummaryShape(summary);
    return summary;
  };

  const addExactReadPath = (
    exactReadPaths: PathSegment[][],
    segments: PathSegment[],
  ): void => {
    const serialized = serializePath(segments);
    if (exactReadPaths.some((candidate) => serializePath(candidate) === serialized)) {
      return;
    }

    exactReadPaths.push(segments);
  };

  const collectDirectReadPath = (identifier: ts.Identifier): PathSegment[] | undefined => {
    let current: ts.Expression = identifier;
    const segments: PathSegment[] = [];

    while (true) {
      const parent = current.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
        if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
          break;
        }

        segments.push(propertySegment(parent.name.text));
        current = parent;
        continue;
      }

      break;
    }

    return segments.length > 0 && isReadLikeUse(current) ? segments : undefined;
  };

  const getHigherOrderCallableReturnSummary = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): HigherOrderCallableReturnSummary => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey || !callable.body) {
      return EMPTY_HIGHER_ORDER_CALLABLE_RETURN_SUMMARY;
    }

    const cached = higherOrderCallableReturnSummaryCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? EMPTY_HIGHER_ORDER_CALLABLE_RETURN_SUMMARY;
    }

    higherOrderCallableReturnSummaryCache.set(parameterSymbolKey, null);
    const exactReadPaths: PathSegment[][] = [];
    let boundaryReason: string | undefined;
    const callableAliasKeys = new Set<string>([parameterSymbolKey]);
    const returnArrayAliasKeys = new Set<string>();
    const returnValueAliasKeys = new Set<string>();

    const setBoundary = (reason: string): void => {
      if (!boundaryReason) {
        boundaryReason = reason;
      }
    };

    const containsCallableAlias = (candidate: ts.Node): boolean => {
      let found = false;
      const inspect = (nested: ts.Node): void => {
        if (found || (ts.isFunctionLike(nested) && nested !== callable)) {
          return;
        }
        if (isCallableAliasIdentifier(nested)) {
          found = true;
          return;
        }
        ts.forEachChild(nested, inspect);
      };
      inspect(candidate);
      return found;
    };

    const addSymbolKey = (keys: Set<string>, name: ts.BindingName): void => {
      if (!ts.isIdentifier(name)) {
        return;
      }

      const symbol = project.checker.getSymbolAtLocation(name);
      if (symbol) {
        keys.add(getCanonicalSymbolKey(project, symbol));
      }
    };

    const getCanonicalKey = (node: ts.Node): string | undefined => {
      if (!ts.isIdentifier(node)) {
        return undefined;
      }

      const symbol = project.checker.getSymbolAtLocation(node);
      return symbol ? getCanonicalSymbolKey(project, symbol) : undefined;
    };

    const isCallableAliasIdentifier = (node: ts.Node): node is ts.Identifier => {
      const key = getCanonicalKey(node);
      return Boolean(key && callableAliasKeys.has(key));
    };

    const isReturnArrayAliasIdentifier = (node: ts.Node): node is ts.Identifier => {
      const key = getCanonicalKey(node);
      return Boolean(key && returnArrayAliasKeys.has(key));
    };

    const isReturnValueAliasIdentifier = (node: ts.Node): node is ts.Identifier => {
      const key = getCanonicalKey(node);
      return Boolean(key && returnValueAliasKeys.has(key));
    };

    const addConsumerHelperReadPaths = (consumer: ts.FunctionLikeDeclaration, index: number): void => {
      const consumerParameter = consumer.parameters[index];
      if (!consumerParameter || !ts.isIdentifier(consumerParameter.name)) {
        setBoundary("higher-order helper return is consumed through an unsupported helper parameter shape");
        return;
      }

      const consumerSummary = summarizeHelperParameterUse(
        project,
        consumer,
        consumerParameter.name,
        parameterMeaningfulUse,
        parameterSummaryCache,
      );
      consumerSummary.exactReadPaths.forEach((path) => addExactReadPath(exactReadPaths, path));
      if (consumerSummary.boundaryReason) {
        setBoundary(`higher-order helper return escapes exact analysis through ${consumerSummary.boundaryReason}`);
      }
    };

    const collectCallableReturnArrayComparators = (
      expression: ts.Expression,
    ): boolean => {
      const current = unwrapExpression(expression);

      if (
        ts.isCallExpression(current)
        && ts.isPropertyAccessExpression(current.expression)
        && current.expression.name.text === "sort"
      ) {
        if (!collectCallableReturnArrayComparators(current.expression.expression)) {
          return false;
        }

        if (current.arguments.length > 1) {
          setBoundary("higher-order helper return array sort uses an unsupported comparator shape");
          return false;
        }

        const comparator = current.arguments[0];
        if (!comparator) {
          return true;
        }

        const comparatorCallable = (
          ts.isIdentifier(comparator) || ts.isPropertyAccessExpression(comparator) || ts.isElementAccessExpression(comparator)
        )
          ? resolveAnalyzableFunctionDeclaration(project, comparator)
          : undefined;
        if (!comparatorCallable) {
          setBoundary("higher-order helper return array sort uses an unsupported comparator carrier");
          return false;
        }

        addConsumerHelperReadPaths(comparatorCallable, 0);
        addConsumerHelperReadPaths(comparatorCallable, 1);
        return true;
      }

      if (
        !ts.isCallExpression(current)
        || !ts.isPropertyAccessExpression(current.expression)
        || current.expression.name.text !== TRACKING_METHOD_NAME.map
      ) {
        return false;
      }

      const callback = current.arguments[0];
      if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
        return false;
      }

      const callbackBody = ts.isBlock(callback.body)
        ? callback.body.statements.find(ts.isReturnStatement)?.expression
        : callback.body;
      if (!callbackBody) {
        return false;
      }

      const callbackReturn = unwrapExpression(callbackBody);
      if (!ts.isCallExpression(callbackReturn)) {
        return false;
      }

      const callbackCallee = unwrapExpression(callbackReturn.expression);
      if (!ts.isIdentifier(callbackCallee) || !isCallableAliasIdentifier(callbackCallee)) {
        return false;
      }

      return true;
    };

    const visit = (node: ts.Node): void => {
      if (boundaryReason && exactReadPaths.length === 0) {
        return;
      }

      if (ts.isFunctionLike(node) && node !== callable) {
        return;
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && isCallableAliasIdentifier(node.initializer)) {
          addSymbolKey(callableAliasKeys, node.name);
          return;
        }

        if (
          ts.isIdentifier(node.name)
          && (
            ts.isConditionalExpression(unwrapExpression(node.initializer))
            || ts.isObjectLiteralExpression(unwrapExpression(node.initializer))
            || ts.isArrayLiteralExpression(unwrapExpression(node.initializer))
          )
          && containsCallableAlias(unwrapExpression(node.initializer))
        ) {
          setBoundary("higher-order callable parameter leaves bounded local alias transport");
        }

        if (ts.isIdentifier(node.name)) {
          if (collectCallableReturnArrayComparators(node.initializer)) {
            addSymbolKey(returnArrayAliasKeys, node.name);
            return;
          }

          const initializer = unwrapExpression(node.initializer);
          if (ts.isCallExpression(initializer)) {
            const callee = unwrapExpression(initializer.expression);
            if (ts.isIdentifier(callee) && isCallableAliasIdentifier(callee)) {
              addSymbolKey(returnValueAliasKeys, node.name);
              return;
            }
          }

          if (ts.isIdentifier(initializer) && isReturnValueAliasIdentifier(initializer)) {
            addSymbolKey(returnValueAliasKeys, node.name);
            return;
          }

          if (ts.isIdentifier(initializer) && isReturnArrayAliasIdentifier(initializer)) {
            addSymbolKey(returnArrayAliasKeys, node.name);
            return;
          }
        }
      }

      if (ts.isForOfStatement(node) && ts.isIdentifier(node.initializer) && ts.isIdentifier(node.expression) && isReturnArrayAliasIdentifier(node.expression)) {
        addSymbolKey(returnValueAliasKeys, node.initializer);
      }

      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "sort"
          && ts.isIdentifier(node.expression.expression)
          && isReturnArrayAliasIdentifier(node.expression.expression)
        ) {
          const comparator = node.arguments[0];
          const comparatorCallable = comparator && (
            ts.isIdentifier(comparator) || ts.isPropertyAccessExpression(comparator) || ts.isElementAccessExpression(comparator)
          )
            ? resolveAnalyzableFunctionDeclaration(project, comparator)
            : undefined;
          if (comparatorCallable) {
            addConsumerHelperReadPaths(comparatorCallable, 0);
            addConsumerHelperReadPaths(comparatorCallable, 1);
          } else if (comparator) {
            setBoundary("higher-order helper return array sort uses an unsupported comparator carrier");
          }
        }

        for (const [index, argument] of node.arguments.entries()) {
          if (!ts.isIdentifier(argument) || !isReturnValueAliasIdentifier(argument)) {
            continue;
          }

          const consumer = resolveAnalyzableFunctionDeclaration(project, node.expression);
          if (!consumer) {
            setBoundary("higher-order helper return is passed to an unsupported consumer call");
            continue;
          }

          addConsumerHelperReadPaths(consumer, index);
        }
      }

      if (ts.isIdentifier(node) && isReturnValueAliasIdentifier(node)) {
        const directReadPath = collectDirectReadPath(node);
        if (directReadPath) {
          addExactReadPath(exactReadPaths, directReadPath);
        }
      }

      if (
        ts.isConditionalExpression(node)
        || ts.isArrayLiteralExpression(node)
        || ts.isObjectLiteralExpression(node)
      ) {
        if (containsCallableAlias(node)) {
          setBoundary("higher-order callable parameter leaves bounded local alias transport");
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(callable.body, visit);
    const summary = createHigherOrderCallableReturnSummary(exactReadPaths, boundaryReason);
    higherOrderCallableReturnSummaryCache.set(parameterSymbolKey, summary);
    return summary;
  };

  const resolveCallableArgumentBinding = (expression: ts.Expression): ReturnType<typeof getAnalyzableCallableBinding> => {
    const unwrapped = unwrapExpression(expression);
    return (
      ts.isIdentifier(unwrapped) || ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)
    )
      ? getAnalyzableCallableBinding(project, unwrapped)
      : undefined;
  };

  const getBoundedHelperExecutionSnapshot = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): BoundedHelperExecutionSnapshot | undefined => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey || !callable.body) {
      return undefined;
    }

    const cached = helperExecutionSnapshotCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const summary = summarizeHelperParameterUse(
      project,
      callable,
      parameter,
      parameterMeaningfulUse,
      parameterSummaryCache,
    );
    const orderedSteps: BoundedHelperExecutionStep[] = [];
    const queuedStepsByStart = new Map<number, BoundedHelperExecutionStep[]>();

    const appendStep = (step: BoundedHelperExecutionStep): void => {
      observeBoundedHelperExecutionStepShape(step);
      orderedSteps.push(step);
    };

    const queueStep = (start: number, step: BoundedHelperExecutionStep): void => {
      observeBoundedHelperExecutionStepShape(step);
      const queuedSteps = queuedStepsByStart.get(start);
      if (queuedSteps) {
        queuedSteps.push(step);
        return;
      }

      queuedStepsByStart.set(start, [step]);
    };

    const flushQueuedSteps = (start: number): void => {
      const queuedSteps = queuedStepsByStart.get(start);
      if (!queuedSteps) {
        return;
      }

      queuedStepsByStart.delete(start);
      for (const step of queuedSteps) {
        orderedSteps.push(step);
      }
    };

    for (const plan of getHelperProjectedUsagePlans(callable, parameter)) {
      queueStep(plan.statement.getStart(), {
        kind: "projected-iteration-binding",
        statement: plan.statement,
        relativeCollectionPath: [...plan.relativeCollectionPath],
        elementSymbolKey: plan.elementSymbolKey,
      });
    }

    for (const plan of getHelperExactAppendPlans(callable, parameter)) {
      queueStep(plan.call.getStart(), {
        kind: "exact-append-mutation",
        call: plan.call,
        sourceFile: plan.sourceFile,
        methodName: plan.methodName,
        relativeCollectionPath: [...plan.relativeCollectionPath],
        slotPlans: [...plan.slotPlans],
      });
    }

    const captureSymbolKey = (identifier: ts.Identifier): string | undefined => {
      const symbol = project.checker.getSymbolAtLocation(identifier);
      return symbol ? getCanonicalSymbolKey(project, symbol) : undefined;
    };

    const visitHelperExecution = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      flushQueuedSteps(candidate.getStart());

      if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.initializer) {
        const initializer = unwrapExpression(candidate.initializer);
        if (ts.isIdentifier(initializer)) {
          const targetSymbolKey = captureSymbolKey(candidate.name);
          const sourceSymbolKey = captureSymbolKey(initializer);
          const statement = ts.findAncestor(candidate, ts.isStatement);
          if (targetSymbolKey && sourceSymbolKey && statement) {
            appendStep({
              kind: "alias-write",
              statement,
              targetSymbolKey,
              sourceSymbolKey,
              operator: "assign",
            });
          }
        }
      }

      if (
        ts.isBinaryExpression(candidate)
        && ts.isIdentifier(candidate.left)
        && (
          candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
          || candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
        )
      ) {
        const right = unwrapExpression(candidate.right);
        if (ts.isIdentifier(right)) {
          const targetSymbolKey = captureSymbolKey(candidate.left);
          const sourceSymbolKey = captureSymbolKey(right);
          const statement = ts.findAncestor(candidate, ts.isStatement);
          if (targetSymbolKey && sourceSymbolKey && statement) {
            appendStep({
              kind: "alias-write",
              statement,
              targetSymbolKey,
              sourceSymbolKey,
              operator: candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
                ? "coalesce-assign"
                : "assign",
            });
          }
        }
      }

      if (ts.isObjectLiteralExpression(candidate)) {
        for (const property of candidate.properties) {
          if (!ts.isSpreadAssignment(property)) {
            continue;
          }

          const expression = unwrapExpression(property.expression);
          if (!ts.isIdentifier(expression)) {
            continue;
          }

          const sourceSymbolKey = captureSymbolKey(expression);
          if (sourceSymbolKey) {
            appendStep({
              kind: "spread-materialization-prerequisite",
              expression: property.expression,
              sourceSymbolKey,
            });
          }
        }
      }

      if (ts.isReturnStatement(candidate) && candidate.expression) {
        const returned = unwrapExpression(candidate.expression);
        appendStep({
          kind: "returned-carrier-emission",
          statement: candidate,
          sourceSymbolKey: ts.isIdentifier(returned) ? captureSymbolKey(returned) : undefined,
        });
      }

      ts.forEachChild(candidate, visitHelperExecution);
    };

    ts.forEachChild(callable.body, visitHelperExecution);
    const steps: BoundedHelperExecutionStep[] = [];
    for (const step of orderedSteps) {
      observeBoundedHelperExecutionStepShape(step);
      steps.push(step);
    }
    for (const step of steps) {
      observeBoundedHelperExecutionStepShape(step);
    }

    const snapshot = summary.boundaryReason || summary.exactReadPaths.length > 0 || steps.length > 0
      ? {
        exactReadPaths: summary.exactReadPaths.map((path) => [...path]),
        boundaryReason: summary.boundaryReason,
        steps,
      }
      : undefined;

    helperExecutionSnapshotCache.set(parameterSymbolKey, snapshot ?? null);
    return snapshot;
  };

  const getHelperExactAppendPlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): HelperExactAppendPlan[] => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey) {
      return [];
    }

    const cached = helperExactAppendPlanCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? [];
    }

    const baseBinding = trackedBySymbolId.get(parameterSymbolKey);
    if (!baseBinding || !callable.body) {
      helperExactAppendPlanCache.set(parameterSymbolKey, null);
      return [];
    }

    const basePrefix = serializePath(baseBinding.prefix);
    const plans: HelperExactAppendPlan[] = [];
    const helperSourceFile = callable.getSourceFile();

    const visitHelper = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      if (
        ts.isCallExpression(candidate)
        && ts.isPropertyAccessExpression(candidate.expression)
        && TRACKING_ARRAY_EXACT_APPEND_METHODS.has(candidate.expression.name.text)
      ) {
        const resolvedReceiver = resolveTrackedObjectAccess(
          project,
          candidate.expression.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        if (resolvedReceiver && !resolvedReceiver.dynamic) {
          const receiverBinding = extendTrackedBinding(resolvedReceiver.binding, resolvedReceiver.segments);
          const receiverPrefix = serializePath(receiverBinding.prefix.slice(0, baseBinding.prefix.length));
          const receiverCollection = getCollectionInfo(receiverBinding.trackedObject, receiverBinding.prefix);
          if (
            receiverBinding.trackedObject.id === baseBinding.trackedObject.id
            && receiverPrefix === basePrefix
            && receiverCollection?.kind === TRACKING_COLLECTION_KIND.array
          ) {
            const slotPlans: ExactAppendSlotPlan[] = [];
            let exactStructuredAppend = candidate.arguments.length > 0;

            for (const argument of candidate.arguments) {
              const structuredLiteral = unwrapExpression(argument);
              if (ts.isObjectLiteralExpression(structuredLiteral) || ts.isArrayLiteralExpression(structuredLiteral)) {
                slotPlans.push({
                  kind: "structured",
                  literal: structuredLiteral,
                  insertReason: `${candidate.expression.name.text} appends a structured value into an exact receiver slot`,
                });
                continue;
              }

              exactStructuredAppend = false;
              break;
            }

            if (exactStructuredAppend) {
              plans.push({
                call: candidate,
                sourceFile: helperSourceFile,
                methodName: candidate.expression.name.text as TrackingAppendMethodName,
                relativeCollectionPath: receiverBinding.prefix.slice(baseBinding.prefix.length),
                slotPlans,
              });
            }
          }
        }
      }

      ts.forEachChild(candidate, visitHelper);
    };

    visitHelper(callable.body);
    helperExactAppendPlanCache.set(parameterSymbolKey, plans.length > 0 ? plans : null);
    return plans;
  };

  const getHelperProjectedUsagePlans = (
    callable: ts.FunctionLikeDeclaration,
    parameter: ts.Identifier,
  ): HelperProjectedUsagePlan[] => {
    const parameterSymbol = project.checker.getSymbolAtLocation(parameter);
    const parameterSymbolKey = parameterSymbol ? getSymbolKey(parameterSymbol) : undefined;
    if (!parameterSymbolKey) {
      return [];
    }

    const cached = helperProjectedUsagePlanCache.get(parameterSymbolKey);
    if (cached !== undefined) {
      return cached ?? [];
    }

    const baseBinding = trackedBySymbolId.get(parameterSymbolKey);
    if (!baseBinding || !callable.body) {
      helperProjectedUsagePlanCache.set(parameterSymbolKey, null);
      return [];
    }

    const basePrefix = serializePath(baseBinding.prefix);
    const plans: HelperProjectedUsagePlan[] = [];

    const visitHelper = (candidate: ts.Node): void => {
      if (candidate !== callable.body && ts.isFunctionLike(candidate)) {
        return;
      }

      if (ts.isForOfStatement(candidate)) {
        const resolved = resolveTrackedObjectAccess(
          project,
          candidate.expression,
          trackedBySymbolId,
          functionReturnSummaries,
          trackedObjectsById,
        );
        const elementSymbolKey = getBindingSymbolKey(project, candidate.initializer);
        if (resolved && !resolved.dynamic && elementSymbolKey) {
          const receiverBinding = extendTrackedBinding(resolved.binding, resolved.segments);
          const receiverPrefix = serializePath(receiverBinding.prefix.slice(0, baseBinding.prefix.length));
          const receiverCollection = getCollectionInfo(receiverBinding.trackedObject, receiverBinding.prefix);
          if (
            receiverBinding.trackedObject.id === baseBinding.trackedObject.id
            && receiverPrefix === basePrefix
            && receiverCollection?.kind === TRACKING_COLLECTION_KIND.array
          ) {
            plans.push({
              statement: candidate.statement,
              relativeCollectionPath: receiverBinding.prefix.slice(baseBinding.prefix.length),
              elementSymbolKey,
            });
          }
        }
      }

      ts.forEachChild(candidate, visitHelper);
    };

    visitHelper(callable.body);
    helperProjectedUsagePlanCache.set(parameterSymbolKey, plans.length > 0 ? plans : null);
    return plans;
  };

  return {
    getHigherOrderCallableReturnSummary,
    getBoundedHelperExecutionSnapshot,
    resolveCallableArgumentBinding,
  };
}
