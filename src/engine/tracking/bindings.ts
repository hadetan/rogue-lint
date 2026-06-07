import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
} from "../../types.js";
import { getSymbolKey } from "../../compiler/ast-utils.js";
import { samePath } from "../../shared/path-utils.js";
import type { TrackedObjectBinding } from "./model.js";

/**
 * Binding and canonical-symbol helpers shared across tracking analysis.
 *
 * These helpers keep alias normalization and tracked-binding identity rules centralized so
 * stage code and graph construction share the same notion of binding equivalence.
 */

/**
 * Maximum allowed depth for a tracked-binding prefix before the binding is widened to "untracked".
 *
 * Path extension (extendTrackedBinding) has no natural fixed point: any code pattern that
 * re-binds a symbol to itself extended by additional segments produces an infinite ascending
 * chain in the binding lattice (A -> A.x -> A.x.x -> ...). Capping the depth turns the lattice
 * into one of bounded height so the convergence loop is guaranteed to terminate. The cap is
 * deliberately deeper than typical legitimate paths observed in fixtures.
 */
const MAX_BINDING_PREFIX_DEPTH = 8;

export function sameTrackedBinding(left: TrackedObjectBinding, right: TrackedObjectBinding): boolean {
  return left.trackedObject.id === right.trackedObject.id && samePath(left.prefix, right.prefix);
}

export function extendTrackedBinding(
  binding: TrackedObjectBinding,
  segments: PathSegment[],
): TrackedObjectBinding {
  return {
    trackedObject: binding.trackedObject,
    prefix: [...binding.prefix, ...segments],
  };
}

function isBindingPrefixOverDepth(binding: TrackedObjectBinding): boolean {
  return binding.prefix.length > MAX_BINDING_PREFIX_DEPTH;
}

function describeBindingDepthWidening(binding: TrackedObjectBinding): string {
  return `binding prefix depth ${binding.prefix.length} exceeded cap ${MAX_BINDING_PREFIX_DEPTH}; widened to untracked`;
}

export interface TrackingMapDiff {
  changedCount: number;
  sampleKeys: string[];
}

export function diffTrackedBindingMaps(
  left: Map<string, TrackedObjectBinding>,
  right: Map<string, TrackedObjectBinding>,
  sampleLimit: number,
  heartbeat?: () => void,
): TrackingMapDiff {
  let changedCount = 0;
  const sampleKeys: string[] = [];
  const keys = new Set<string>([...left.keys(), ...right.keys()]);
  let heartbeatCounter = 0;

  for (const key of keys) {
    heartbeatCounter += 1;
    if (heartbeatCounter >= 2048) {
      heartbeatCounter = 0;
      heartbeat?.();
    }

    const current = left.get(key);
    const next = right.get(key);
    if (!current || !next || !sameTrackedBinding(current, next)) {
      changedCount += 1;
      if (sampleKeys.length < sampleLimit) {
        sampleKeys.push(key);
      }
    }
  }

  return {
    changedCount,
    sampleKeys,
  };
}

export function mergeTrackedBinding(
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
  conflictedSymbolIds: Set<string>,
  symbolKey: string,
  binding: TrackedObjectBinding,
  onWidenedToTop?: (symbolKey: string, reason: string) => void,
): void {
  if (conflictedSymbolIds.has(symbolKey)) {
    return;
  }

  if (isBindingPrefixOverDepth(binding)) {
    trackedBySymbolId.delete(symbolKey);
    conflictedSymbolIds.add(symbolKey);
    onWidenedToTop?.(symbolKey, describeBindingDepthWidening(binding));
    return;
  }

  const existing = trackedBySymbolId.get(symbolKey);
  if (!existing) {
    trackedBySymbolId.set(symbolKey, binding);
    return;
  }

  if (sameTrackedBinding(existing, binding)) {
    return;
  }

  trackedBySymbolId.delete(symbolKey);
  conflictedSymbolIds.add(symbolKey);
}

export function getCanonicalSymbol(project: ProjectContext, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const visited = new Set<string>();

  while (current.flags & ts.SymbolFlags.Alias) {
    const symbolKey = getSymbolKey(current);
    if (visited.has(symbolKey)) {
      break;
    }
    visited.add(symbolKey);

    const aliased = project.checker.getAliasedSymbol(current);
    if (!aliased || aliased === current) {
      break;
    }

    current = aliased;
  }

  return current;
}

export function getCanonicalSymbolKey(project: ProjectContext, symbol: ts.Symbol): string {
  return getSymbolKey(getCanonicalSymbol(project, symbol));
}

export function getGlobalThisBindingKey(propertyName: string): string {
  return `globalThis:${propertyName}`;
}

export function isGlobalThisIdentifier(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === "globalThis";
}

export function getStaticGlobalThisPropertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isGlobalThisIdentifier(node.expression)) {
    return node.name.text;
  }

  if (
    ts.isElementAccessExpression(node)
    && isGlobalThisIdentifier(node.expression)
    && ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }

  return undefined;
}

/**
 * Resolves a stable binding for an AST node, including shorthand object properties that borrow another symbol.
 */
export function getBindingByNode(
  project: ProjectContext,
  node: ts.Node,
  trackedBySymbolId: Map<string, TrackedObjectBinding>,
): TrackedObjectBinding | undefined {
  if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    const valueSymbol = project.checker.getShorthandAssignmentValueSymbol(node.parent);
    if (valueSymbol) {
      return trackedBySymbolId.get(getCanonicalSymbolKey(project, valueSymbol));
    }
  }

  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  return trackedBySymbolId.get(getCanonicalSymbolKey(project, symbol));
}
