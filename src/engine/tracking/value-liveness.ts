import ts from "typescript";

import { getSuppressionAudit } from "../../suppressions.js";
import type {
  ProjectContext,
  SuppressionContext,
} from "../../types.js";
import {
  getSymbolKey,
  isReadLikeUse,
} from "../../compiler/ast-utils.js";
import { makeEntity } from "../../shared/entity-utils.js";
import {
  addAudit,
  addFinding,
  addSkipped,
  type AnalysisState,
} from "../analysis-state.js";
import type { AnalysisArtifacts } from "../analysis-artifacts.js";
import { isTrackablePureExpression } from "./graph.js";
import type {
  ValueAccess,
} from "./model.js";
import {
  getCallArgumentUse,
  getIgnoredResultReason,
  isExportedVariableDeclaration,
} from "./semantics.js";
import {
  getControlFlowDepth,
  getControlFlowSignature,
  getFunctionDepth,
} from "./syntax.js";
import { createValueLivenessStageContext } from "./value-liveness-context.js";

/**
 * Exactness-gated local value-fate analysis built on top of the shared tracked-object graph.
 */

function isUpdateRead(node: ts.Identifier): boolean {
  return (ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken);
}

function expressionMayObservePreviousValue(
  project: ProjectContext,
  expression: ts.Expression,
  targetSymbolKey: string,
): boolean {
  let observed = false;

  const visit = (node: ts.Node): void => {
    if (observed) {
      return;
    }

    if (ts.isIdentifier(node)) {
      const symbol = project.checker.getSymbolAtLocation(node);
      if (symbol && getSymbolKey(symbol) === targetSymbolKey && isReadLikeUse(node)) {
        observed = true;
        return;
      }
    }

    if (
      ts.isCallExpression(node)
      || ts.isNewExpression(node)
      || ts.isTaggedTemplateExpression(node)
      || ts.isAwaitExpression(node)
      || ts.isYieldExpression(node)
    ) {
      observed = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(expression);
  return observed;
}

export function analyzeValueLiveness(
  project: ProjectContext,
  reachableFiles: Set<string>,
  state: AnalysisState,
  suppressionContext: SuppressionContext,
  artifacts: AnalysisArtifacts,
): void {
  const stageContext = createValueLivenessStageContext(
    project,
    reachableFiles,
    state,
    suppressionContext,
    artifacts,
  );
  const {
    functionReturnSummaries,
  } = stageContext;

  for (const sourceFile of project.sourceFiles) {
    if (!stageContext.reachableFiles.has(sourceFile.fileName)) {
      continue;
    }

    const sourceFileContext = stageContext.createSourceFileContext(sourceFile);
    const {
      trackedBindings,
      accesses,
      parameterMeaningfulUse,
      callablePurity,
    } = sourceFileContext;
    const valueAnalysisCaches = {
      parameterMeaningfulUse,
      callablePurity,
    };

    const pushAccess = (symbolKey: string, access: ValueAccess): void => {
      const entries = accesses.get(symbolKey) ?? [];
      entries.push(access);
      accesses.set(symbolKey, entries);
    };

    const trackBinding = (identifier: ts.Identifier): void => {
      const symbol = project.checker.getSymbolAtLocation(identifier);
      if (!symbol) {
        return;
      }

      trackedBindings.set(getSymbolKey(symbol), {
        declaration: identifier,
        name: identifier.text,
        declarationDepth: getFunctionDepth(identifier),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !isExportedVariableDeclaration(node)) {
        trackBinding(node.name);
        const symbol = project.checker.getSymbolAtLocation(node.name);
        const functionDepth = getFunctionDepth(node);
        const controlFlowDepth = getControlFlowDepth(node);
        const flowSignature = getControlFlowSignature(node);
        if (symbol && node.initializer) {
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.name, node.name.text),
            position: node.name.getStart(sourceFile),
            kind: "write",
            mayObservePreviousValue: false,
            nestedWrite: false,
            controlFlowDepth,
            functionDepth,
            flowSignature,
          });
        }
      }

      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
        const symbol = project.checker.getSymbolAtLocation(node.left);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (symbol && tracked) {
          const functionDepth = getFunctionDepth(node);
          const flowSignature = getControlFlowSignature(node);
          const symbolKey = getSymbolKey(symbol);
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.left, tracked.name),
            position: node.left.getStart(sourceFile),
            kind: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "write" : "read-write",
            mayObservePreviousValue:
              node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
              || expressionMayObservePreviousValue(project, node.right, symbolKey),
            nestedWrite: functionDepth > tracked.declarationDepth,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth,
            flowSignature,
          });
        }
      }

      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
        const symbol = project.checker.getSymbolAtLocation(node.operand);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (
          symbol
          && tracked
          && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          const functionDepth = getFunctionDepth(node);
          const flowSignature = getControlFlowSignature(node);
          pushAccess(getSymbolKey(symbol), {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, node.operand, tracked.name),
            position: node.operand.getStart(sourceFile),
            kind: "read-write",
            mayObservePreviousValue: true,
            nestedWrite: functionDepth > tracked.declarationDepth,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth,
            flowSignature,
          });
        }
      }

      const ignoredResultReason = ts.isExpressionStatement(node)
        ? getIgnoredResultReason(project, node.expression, functionReturnSummaries, valueAnalysisCaches)
        : undefined;
      if (
        ts.isExpressionStatement(node)
        && (isTrackablePureExpression(node.expression) || ignoredResultReason)
      ) {
        const entity = makeEntity(
          project.rootPath,
          "expression",
          sourceFile,
          node.expression,
          node.expression.getText(sourceFile),
        );
        const suppression = getSuppressionAudit(project, suppressionContext, entity, node.expression);
        if (addAudit(state.kept, suppression)) {
          return ts.forEachChild(node, visit);
        }

        addFinding(
          state,
          entity,
          "unused-value",
          ignoredResultReason ?? "side-effect-neutral expression result is discarded",
          ignoredResultReason ? `Ignored result ${entity.name}` : `Unused value ${entity.name}`,
          "review",
        );
      }

      if (ts.isIdentifier(node)) {
        const symbol = project.checker.getSymbolAtLocation(node);
        const tracked = symbol ? trackedBindings.get(getSymbolKey(symbol)) : undefined;
        if (!symbol || !tracked || tracked.declaration === node) {
          return ts.forEachChild(node, visit);
        }

        if ((ts.isBinaryExpression(node.parent) && node.parent.left === node) || isUpdateRead(node)) {
          return ts.forEachChild(node, visit);
        }

        const symbolKey = getSymbolKey(symbol);
        const callArgumentUse = getCallArgumentUse(project, node, valueAnalysisCaches);
        if (callArgumentUse === "read") {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "read",
            mayObservePreviousValue: false,
            nestedWrite: false,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth: getFunctionDepth(node),
            flowSignature: getControlFlowSignature(node),
          });
          return ts.forEachChild(node, visit);
        }
        if (callArgumentUse === "ignore") {
          return ts.forEachChild(node, visit);
        }

        if (isReadLikeUse(node)) {
          pushAccess(symbolKey, {
            entity: makeEntity(project.rootPath, "assignment", sourceFile, tracked.declaration, tracked.name),
            position: node.getStart(sourceFile),
            kind: "read",
            mayObservePreviousValue: false,
            nestedWrite: false,
            controlFlowDepth: getControlFlowDepth(node),
            functionDepth: getFunctionDepth(node),
            flowSignature: getControlFlowSignature(node),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    for (const [symbolKey, symbolAccesses] of accesses) {
      const binding = trackedBindings.get(symbolKey);
      if (!binding) {
        continue;
      }

      const ordered = symbolAccesses.sort((left, right) => left.position - right.position);
      let pendingWrite: ValueAccess | undefined;
      let hasAnyRead = false;
      const canProveOverwrite = (current: ValueAccess, next: ValueAccess): boolean =>
        current.functionDepth === next.functionDepth
        && current.flowSignature === next.flowSignature
        && !next.mayObservePreviousValue;

      for (const access of ordered) {
        if (access.kind === "read") {
          hasAnyRead = true;
          pendingWrite = undefined;
          continue;
        }

        if (access.kind === "read-write") {
          hasAnyRead = true;
          pendingWrite = access;
          continue;
        }

        if (access.kind === "write") {
          if (pendingWrite && canProveOverwrite(pendingWrite, access)) {
            const suppression = getSuppressionAudit(
              project,
              suppressionContext,
              pendingWrite.entity,
              binding.declaration,
            );
            if (!addAudit(state.kept, suppression)) {
              addFinding(
                state,
                pendingWrite.entity,
                "dead-store",
                "assigned value is overwritten before any supported read occurs",
                `Dead store for ${binding.name}`,
              );
            }
          }

          pendingWrite = access;
          continue;
        }

        if (access.kind === "escape" && pendingWrite) {
          addSkipped(state, pendingWrite.entity, "opaque-object-call", access.escapeReason ?? "value escaped exact analysis");
          pendingWrite = undefined;
        }
      }

      if (pendingWrite && pendingWrite.nestedWrite && !hasAnyRead) {
        const suppression = getSuppressionAudit(
          project,
          suppressionContext,
          pendingWrite.entity,
          binding.declaration,
        );
        if (!addAudit(state.kept, suppression)) {
          addFinding(
            state,
            pendingWrite.entity,
            "write-only-state",
            "outer-scope write never becomes observable through a supported read",
            `Write-only state for ${binding.name}`,
          );
        }
      }
    }
  }
}
