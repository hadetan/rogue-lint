import ts from "typescript";

import {
  ASSIGNMENT_OPERATORS,
  isStructurallySimpleExpression,
  unwrapExpression,
} from "./syntax.js";

/**
 * Reports whether an expression can be treated as an exact, side-effect-free value.
 */
export function isTrackablePureExpression(expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (
    ts.isNumericLiteral(node)
    || ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.BigIntLiteral
    || ts.isIdentifier(node)
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    return ![
      ts.SyntaxKind.PlusPlusToken,
      ts.SyntaxKind.MinusMinusToken,
      ts.SyntaxKind.DeleteKeyword,
    ].includes(node.operator)
      && isTrackablePureExpression(node.operand);
  }

  if (ts.isConditionalExpression(node)) {
    return isTrackablePureExpression(node.condition)
      && isTrackablePureExpression(node.whenTrue)
      && isTrackablePureExpression(node.whenFalse);
  }

  if (ts.isBinaryExpression(node)) {
    return node.operatorToken.kind !== ts.SyntaxKind.CommaToken
      && !ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
      && isTrackablePureExpression(node.left)
      && isTrackablePureExpression(node.right);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) =>
      !ts.isSpreadElement(element) && isTrackablePureExpression(element as ts.Expression),
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return true;
      }
      if (ts.isPropertyAssignment(property)) {
        return isTrackablePureExpression(property.initializer);
      }
      return false;
    });
  }

  return false;
}

/**
 * Reports whether an expression keeps exact object/array structure when tracked as a value.
 */
function isTrackableObjectValue(node: ts.Expression): boolean {
  const unwrapped = unwrapExpression(node);

  if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) {
    return true;
  }

  if (
    ts.isBinaryExpression(unwrapped)
    && (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return isTrackableObjectValue(unwrapped.left) && isTrackableObjectValue(unwrapped.right);
  }

  if (ts.isConditionalExpression(unwrapped)) {
    return isStructurallySimpleExpression(unwrapped.condition)
      && isTrackableObjectValue(unwrapped.whenTrue)
      && isTrackableObjectValue(unwrapped.whenFalse);
  }

  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return isTrackableObjectStructure(node);
  }

  return isStructurallySimpleExpression(unwrapped);
}

/**
 * Reports whether an expression is eligible for returned-structure exact tracking.
 */
function isTrackableReturnObjectValue(node: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return isTrackableReturnObjectStructure(node);
  }

  return isTrackableObjectValue(node);
}

/**
 * Reports whether a returned object or array literal can be summarized structurally.
 */
export function isTrackableReturnObjectStructure(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return true;
      }

      if (ts.isMethodDeclaration(property)) {
        return true;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        return true;
      }

      if (
        ts.isPropertyAssignment(property)
        && (ts.isFunctionExpression(unwrapExpression(property.initializer)) || ts.isArrowFunction(unwrapExpression(property.initializer)))
      ) {
        return true;
      }

      return ts.isPropertyAssignment(property) && isTrackableReturnObjectValue(property.initializer);
    });
  }

  const hasSpread = node.elements.some((element) => ts.isSpreadElement(element));
  const hasConcreteElement = node.elements.some((element) => element && !ts.isSpreadElement(element));
  if (hasSpread && !hasConcreteElement) {
    return false;
  }

  return node.elements.every(
    (element) => ts.isSpreadElement(element) || isTrackableReturnObjectValue(element as ts.Expression),
  );
}

/**
 * Reports whether a local object or array literal can remain exact in the tracked graph.
 */
export function isTrackableObjectStructure(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return true;
      }

      if (ts.isMethodDeclaration(property)) {
        return true;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        return true;
      }

      if (
        ts.isPropertyAssignment(property)
        && (ts.isFunctionExpression(unwrapExpression(property.initializer)) || ts.isArrowFunction(unwrapExpression(property.initializer)))
      ) {
        return true;
      }

      return ts.isPropertyAssignment(property) && isTrackableObjectValue(property.initializer);
    });
  }

  return node.elements.every(
    (element) => !ts.isSpreadElement(element) && isTrackableObjectValue(element as ts.Expression),
  );
}

/**
 * Returns the structured literal when an expression is eligible for exact local tracking.
 */
export function getTrackableStructuredLiteralExpression(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  const initializer = unwrapExpression(expression);
  return (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer))
    && isTrackableObjectStructure(initializer)
    ? initializer
    : undefined;
}
