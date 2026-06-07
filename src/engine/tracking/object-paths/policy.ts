import ts from "typescript";

import type {
  PathSegment,
  ProjectContext,
} from "../../../types.js";
import { propertySegment } from "../../../shared/path-utils.js";
import { unwrapExpression } from "../syntax.js";

const runtimeInvalidFormatExtraSegmentsCache = new WeakMap<object, PathSegment[]>();

function getStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function getObjectLiteralPropertyInitializer(
  node: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    if (getStaticPropertyName(property.name) === propertyName) {
      return property.initializer;
    }
  }

  return undefined;
}

function getStaticStringLiteralValue(expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function collectStringLiteralCandidates(expression: ts.Expression): string[] {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const candidates = new Set<string>();
    candidates.add(node.text);
    return Array.from(candidates);
  }

  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return [...new Set([
        ...collectStringLiteralCandidates(node.left),
        ...collectStringLiteralCandidates(node.right),
      ])];
    }

    return [];
  }

  if (ts.isConditionalExpression(node)) {
    return [...new Set([
      ...collectStringLiteralCandidates(node.whenTrue),
      ...collectStringLiteralCandidates(node.whenFalse),
    ])];
  }

  return [];
}

function getRuntimeInvalidFormatExtraSegments(project: ProjectContext): PathSegment[] {
  const cached = runtimeInvalidFormatExtraSegmentsCache.get(project.checker);
  if (cached) {
    return cached;
  }

  const declaredFormats = new Set<string>();
  const emittedFormats = new Set<string>();

  for (const sourceFile of project.sourceFiles) {
    if (sourceFile.fileName.includes("/tests/") || sourceFile.fileName.includes("/locales/")) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text.endsWith("StringFormats") && ts.isUnionTypeNode(node.type)) {
        for (const member of node.type.types) {
          if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
            declaredFormats.add(member.literal.text);
          }
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        const code = getObjectLiteralPropertyInitializer(node, "code");
        const check = getObjectLiteralPropertyInitializer(node, "check");
        const format = getObjectLiteralPropertyInitializer(node, "format");
        if (format) {
          const codeValue = code ? getStaticStringLiteralValue(code) : undefined;
          const checkValue = check ? getStaticStringLiteralValue(check) : undefined;
          if (codeValue === "invalid_format" || checkValue === "string_format") {
            for (const candidate of collectStringLiteralCandidates(format)) {
              emittedFormats.add(candidate);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  const extras = [...emittedFormats]
    .filter((format) => !declaredFormats.has(format))
    .sort()
    .map((format) => propertySegment(format));
  runtimeInvalidFormatExtraSegmentsCache.set(project.checker, extras);
  return extras;
}

export function extractFinitePropertyUnionSegments(
  project: ProjectContext,
  argument: ts.Expression | undefined,
): PathSegment[] | undefined {
  if (!argument) {
    return undefined;
  }

  const node = unwrapExpression(argument);
  const type = project.checker.getTypeAtLocation(node);
  const candidateTypes = type.isUnion() ? type.types : [type];
  const segments: PathSegment[] = [];
  const seen = new Set<string>();
  const candidateValues = new Set<string>();

  for (const candidateType of candidateTypes) {
    if (!(candidateType.flags & ts.TypeFlags.StringLiteral)) {
      return undefined;
    }

    const value = (candidateType as ts.StringLiteralType).value;
    const segment = propertySegment(value);
    const key = `${segment.kind}:${segment.value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidateValues.add(value);
    segments.push(segment);
  }

  if (
    ts.isPropertyAccessExpression(node)
    && node.name.text === "format"
    && candidateValues.size >= 2
  ) {
    for (const segment of getRuntimeInvalidFormatExtraSegments(project)) {
      const key = `${segment.kind}:${segment.value}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      segments.push(segment);
    }
  }

  return segments.length > 1 ? segments : undefined;
}
