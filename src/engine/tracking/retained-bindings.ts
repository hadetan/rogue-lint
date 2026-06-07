import ts from "typescript";

import type { ProjectContext } from "../../types.js";
import {
  getCanonicalSymbol,
  getCanonicalSymbolKey,
} from "./bindings.js";
import { unwrapExpression } from "./syntax.js";
import {
  TRACKING_CONTAINER_TYPE_NAME,
  TRACKING_RETAINED_BINDING_CONTAINER_TYPE_NAMES,
} from "./vocabulary.js";

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
      && TRACKING_RETAINED_BINDING_CONTAINER_TYPE_NAMES.has(initializer.expression.text)
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

/**
 * Reports whether a receiver can safely carry retained binding slots across helper boundaries.
 */
export function isSupportedRetainedBindingContainerType(
  project: ProjectContext,
  expression: ts.Expression,
): boolean {
  const typeName = getContainerTypeName(project, expression);
  return typeName === TRACKING_CONTAINER_TYPE_NAME.map
    || typeName === TRACKING_CONTAINER_TYPE_NAME.weakMap
    || getLocallyOwnedRetainedBindingContainerKind(project, expression) === "object-backed";
}

/**
 * Reports whether a receiver is a locally created retained-binding container we can model precisely.
 */
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

/**
 * Builds the stable retained-binding slot identity for supported container and key pairs.
 */
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

/**
 * Resolves retained-binding slot identity from object-backed property or element access.
 */
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
