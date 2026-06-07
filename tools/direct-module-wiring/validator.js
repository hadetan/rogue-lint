import fs from "node:fs";
import path from "node:path";

import { minimatch } from "minimatch";
import ts from "typescript";

/**
 * @typedef {{
 *   pathGlobs: string[];
 *   category: string;
 *   reason: string;
 * }} ReviewedFacadeException
 */

/**
 * @typedef {{
 *   includeGlobs: string[];
 *   excludeGlobs?: string[];
 *   reviewedFacadeExceptions?: ReviewedFacadeException[];
 * }} DirectModuleWiringConfig
 */

/**
 * @typedef {{
 *   kind: "internal-pass-through-module" | "unchanged-forwarding-wrapper";
 *   relativeFilePath: string;
 *   detail: string;
 * }} DirectModuleWiringViolation
 */

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function matchesAny(globs, value) {
  return globs.some((glob) => minimatch(value, glob, { dot: true }));
}

function walkFiles(rootDir, currentDir, collected) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, collected);
      continue;
    }

    collected.push(normalizeRelativePath(path.relative(rootDir, fullPath)));
  }
}

function listManagedFiles(rootDir, config) {
  const collected = [];
  walkFiles(rootDir, rootDir, collected);

  return collected.filter((relativePath) => {
    if (!matchesAny(config.includeGlobs, relativePath)) {
      return false;
    }

    return !(config.excludeGlobs && matchesAny(config.excludeGlobs, relativePath));
  });
}

function isRelativeInternalModuleSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isReviewedFacade(relativeFilePath, config) {
  return (config.reviewedFacadeExceptions ?? []).some((exception) => matchesAny(exception.pathGlobs, relativeFilePath));
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function getPurePassThroughDetail(sourceFile) {
  const targets = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      return undefined;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!isRelativeInternalModuleSpecifier(specifier)) {
      return undefined;
    }

    targets.push(specifier);
  }

  if (targets.length === 0) {
    return undefined;
  }

  return `only re-exports internal symbols from ${[...new Set(targets)].join(", ")}`;
}

function getImportedValueBindings(sourceFile) {
  const importedBindings = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) {
      continue;
    }

    if (statement.importClause.name) {
      importedBindings.add(statement.importClause.name.text);
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      importedBindings.add(namedBindings.name.text);
      continue;
    }

    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        importedBindings.add(element.name.text);
      }
    }
  }

  return importedBindings;
}

function getForwardedCall(statement) {
  if (ts.isReturnStatement(statement)) {
    return statement.expression && ts.isCallExpression(statement.expression) ? statement.expression : undefined;
  }

  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
    return statement.expression;
  }

  return undefined;
}

function getForwardingWrapperDetail(statement, importedBindings) {
  if (!ts.isFunctionDeclaration(statement) || !hasExportModifier(statement) || !statement.name || !statement.body) {
    return undefined;
  }

  const parameterNames = [];
  for (const parameter of statement.parameters) {
    if (
      !ts.isIdentifier(parameter.name)
      || parameter.dotDotDotToken
      || parameter.initializer
      || parameter.questionToken
    ) {
      return undefined;
    }

    parameterNames.push(parameter.name.text);
  }

  if (statement.body.statements.length !== 1) {
    return undefined;
  }

  const forwardedCall = getForwardedCall(statement.body.statements[0]);
  if (!forwardedCall || !ts.isIdentifier(forwardedCall.expression) || !importedBindings.has(forwardedCall.expression.text)) {
    return undefined;
  }

  if (forwardedCall.arguments.length !== parameterNames.length) {
    return undefined;
  }

  for (const [index, argument] of forwardedCall.arguments.entries()) {
    if (!ts.isIdentifier(argument) || argument.text !== parameterNames[index]) {
      return undefined;
    }
  }

  return `exports ${statement.name.text} only to forward directly to imported ${forwardedCall.expression.text}`;
}

function getUnchangedForwardingWrapperDetail(sourceFile) {
  const importedBindings = getImportedValueBindings(sourceFile);
  if (importedBindings.size === 0) {
    return undefined;
  }

  const details = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue;
    }

    const detail = getForwardingWrapperDetail(statement, importedBindings);
    if (!detail) {
      return undefined;
    }

    details.push(detail);
  }

  if (details.length === 0) {
    return undefined;
  }

  return details.join("; ");
}

export function validateDirectModuleWiring(rootDir, config) {
  const managedFiles = listManagedFiles(rootDir, config);
  const violations = [];

  for (const relativeFilePath of managedFiles) {
    if (isReviewedFacade(relativeFilePath, config)) {
      continue;
    }

    const absoluteFilePath = path.join(rootDir, relativeFilePath);
    const sourceText = fs.readFileSync(absoluteFilePath, "utf8");
    const sourceFile = ts.createSourceFile(absoluteFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const purePassThroughDetail = getPurePassThroughDetail(sourceFile);
    if (purePassThroughDetail) {
      violations.push({
        kind: "internal-pass-through-module",
        relativeFilePath,
        detail: purePassThroughDetail,
      });
      continue;
    }

    const forwardingWrapperDetail = getUnchangedForwardingWrapperDetail(sourceFile);
    if (forwardingWrapperDetail) {
      violations.push({
        kind: "unchanged-forwarding-wrapper",
        relativeFilePath,
        detail: forwardingWrapperDetail,
      });
    }
  }

  return {
    scannedFiles: managedFiles.length,
    violations,
  };
}

export function formatDirectModuleWiringViolations(violations) {
  if (violations.length === 0) {
    return "";
  }

  const lines = ["Direct module wiring violations:"];

  for (const violation of violations) {
    switch (violation.kind) {
      case "internal-pass-through-module":
        lines.push(`- ${violation.relativeFilePath} ${violation.detail}; import the owner module directly instead`);
        break;
      case "unchanged-forwarding-wrapper":
        lines.push(`- ${violation.relativeFilePath} ${violation.detail}; wire callers to the owner module directly instead`);
        break;
      default:
        break;
    }
  }

  return lines.join("\n");
}