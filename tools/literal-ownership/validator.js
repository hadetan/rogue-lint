import fs from "node:fs";
import path from "node:path";

import { minimatch } from "minimatch";
import ts from "typescript";

/**
 * @typedef {{
 *   literal: string;
 *   relativeFilePath: string;
 *   line: number;
 *   column: number;
 * }} LiteralOccurrence
 */

/**
 * @typedef {{
 *   literal: string;
 *   ownerGlobs: string[];
 *   allowOwnerDuplicates?: boolean;
 * }} OwnedLiteralRule
 */

/**
 * @typedef {{
 *   literal?: string;
 *   pathGlobs: string[];
 *   reason: string;
 * }} ReviewedLiteralExclusion
 */

/**
 * @typedef {{
 *   includeGlobs: string[];
 *   excludeGlobs?: string[];
 *   enforceUnownedDuplicates?: boolean;
 *   ownedLiteralRules?: OwnedLiteralRule[];
 *   reviewedLiteralExclusions?: ReviewedLiteralExclusion[];
 * }} LiteralOwnershipConfig
 */

/**
 * @typedef {{
 *   kind: "unowned-duplicate" | "literal-outside-owner" | "owner-surface-duplicates";
 *   literal: string;
 *   occurrences: LiteralOccurrence[];
 *   ownerRule?: OwnedLiteralRule;
 * }} LiteralOwnershipViolation
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

function isDirectiveLiteral(node) {
  return ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent);
}

function isIgnoredStringLiteralNode(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (isDirectiveLiteral(node)) {
    return true;
  }

  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) {
    return true;
  }

  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) {
    return true;
  }

  if (ts.isExternalModuleReference(parent) && parent.expression === node) {
    return true;
  }

  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) {
    return true;
  }

  if (
    ts.isCallExpression(parent)
    && parent.arguments[0] === node
    && (
      parent.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(parent.expression) && parent.expression.text === "require")
    )
  ) {
    return true;
  }

  return false;
}

function collectLiteralOccurrences(rootDir, config) {
  const occurrencesByLiteral = new Map();
  const managedFiles = listManagedFiles(rootDir, config);

  for (const relativeFilePath of managedFiles) {
    const absoluteFilePath = path.join(rootDir, relativeFilePath);
    const sourceText = fs.readFileSync(absoluteFilePath, "utf8");
    const sourceFile = ts.createSourceFile(absoluteFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    /** @param {ts.Node} node */
    const visit = (node) => {
      if (ts.isStringLiteralLike(node) && !isIgnoredStringLiteralNode(node)) {
        const literal = node.text;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const occurrence = {
          literal,
          relativeFilePath,
          line: position.line + 1,
          column: position.character + 1,
        };

        const occurrences = occurrencesByLiteral.get(literal) ?? [];
        occurrences.push(occurrence);
        occurrencesByLiteral.set(literal, occurrences);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { managedFiles, occurrencesByLiteral };
}

function isReviewedExclusionMatch(occurrence, exclusion) {
  if (exclusion.literal !== undefined && exclusion.literal !== occurrence.literal) {
    return false;
  }

  return matchesAny(exclusion.pathGlobs, occurrence.relativeFilePath);
}

function filterReviewedExclusions(occurrences, config) {
  const exclusions = config.reviewedLiteralExclusions ?? [];
  if (exclusions.length === 0) {
    return occurrences;
  }

  return occurrences.filter((occurrence) => !exclusions.some((exclusion) => isReviewedExclusionMatch(occurrence, exclusion)));
}

function findOwnerRule(literal, config) {
  return (config.ownedLiteralRules ?? []).find((rule) => rule.literal === literal);
}

export function validateLiteralOwnership(rootDir, config) {
  const { managedFiles, occurrencesByLiteral } = collectLiteralOccurrences(rootDir, config);
  const violations = [];

  for (const [literal, rawOccurrences] of [...occurrencesByLiteral.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const occurrences = filterReviewedExclusions(rawOccurrences, config);
    if (occurrences.length < 2) {
      continue;
    }

    const ownerRule = findOwnerRule(literal, config);
    if (!ownerRule) {
      if (!config.enforceUnownedDuplicates) {
        continue;
      }

      violations.push({
        kind: "unowned-duplicate",
        literal,
        occurrences,
      });
      continue;
    }

    const outsideOwner = occurrences.filter((occurrence) => !matchesAny(ownerRule.ownerGlobs, occurrence.relativeFilePath));
    if (outsideOwner.length > 0) {
      violations.push({
        kind: "literal-outside-owner",
        literal,
        occurrences,
        ownerRule,
      });
      continue;
    }

    if (!ownerRule.allowOwnerDuplicates) {
      violations.push({
        kind: "owner-surface-duplicates",
        literal,
        occurrences,
        ownerRule,
      });
    }
  }

  return {
    scannedFiles: managedFiles.length,
    occurrencesByLiteral,
    violations,
  };
}

function formatOccurrence(occurrence) {
  return `${occurrence.relativeFilePath}:${occurrence.line}:${occurrence.column}`;
}

export function formatLiteralOwnershipViolations(violations) {
  if (violations.length === 0) {
    return "";
  }

  const lines = ["Literal ownership violations:"];

  for (const violation of violations) {
    const locationSummary = violation.occurrences.map(formatOccurrence).join(", ");
    switch (violation.kind) {
      case "unowned-duplicate":
        lines.push(`- ${JSON.stringify(violation.literal)} is repeated without an owning surface at ${locationSummary}`);
        break;
      case "literal-outside-owner":
        lines.push(
          `- ${JSON.stringify(violation.literal)} is owned by ${violation.ownerRule?.ownerGlobs.join(", ")} but still appears outside that owner at ${locationSummary}`,
        );
        break;
      case "owner-surface-duplicates":
        lines.push(
          `- ${JSON.stringify(violation.literal)} is repeated inside its owner surface; derive related structures from one canonical source instead: ${locationSummary}`,
        );
        break;
      default:
        break;
    }
  }

  return lines.join("\n");
}