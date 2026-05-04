import ts from "typescript";

import type {
  AuditRecord,
  EntityRecord,
  ProjectContext,
  SourceCommentDirectives,
  SuppressionContext,
} from "./types.js";
import { matchesPatterns } from "./utils.js";

const IGNORE_NEXT = "dead-lint-ignore-next";
const IGNORE_START = "dead-lint-ignore-start";
const IGNORE_END = "dead-lint-ignore-end";
const EXTERNAL_NEXT = "dead-lint-externally-visible";

function parseDirectives(sourceFile: ts.SourceFile): SourceCommentDirectives {
  const directives: SourceCommentDirectives = {
    ignoredLines: new Set<number>(),
    ignoredRanges: [],
    externalLines: new Set<number>(),
  };

  const text = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];
  void ranges;

  const stack: number[] = [];
  const regex = /dead-lint-ignore-next|dead-lint-ignore-start|dead-lint-ignore-end|dead-lint-externally-visible/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    const position = match.index;
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;

    switch (match[0]) {
      case IGNORE_NEXT:
        directives.ignoredLines.add(line + 1);
        break;
      case IGNORE_START:
        stack.push(line + 1);
        break;
      case IGNORE_END: {
        const start = stack.pop();
        if (start !== undefined) {
          directives.ignoredRanges.push({ start, end: line });
        }
        break;
      }
      case EXTERNAL_NEXT:
        directives.externalLines.add(line + 1);
        break;
      default:
        break;
    }
  }

  for (const start of stack) {
    directives.ignoredRanges.push({ start, end: Number.MAX_SAFE_INTEGER });
  }

  return directives;
}

export function buildSuppressionContext(project: ProjectContext): SuppressionContext {
  return {
    directives: new Map(
      project.sourceFiles.map((sourceFile) => [sourceFile.fileName, parseDirectives(sourceFile)]),
    ),
  };
}

function hasJSDocExternalTag(node: ts.Node): boolean {
  return ts
    .getJSDocTags(node)
    .some((tag) => tag.tagName.text === "externallyVisible");
}

export function getSuppressionAudit(
  project: ProjectContext,
  suppressions: SuppressionContext,
  entity: EntityRecord,
  declarationNode?: ts.Node,
): AuditRecord | undefined {
  const directives = suppressions.directives.get(
    declarationNode?.getSourceFile().fileName ?? "",
  );

  if (directives) {
    if (directives.ignoredLines.has(entity.location.line)) {
      return {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        reason: "suppressed by dead-lint-ignore-next",
        location: entity.location,
      };
    }

    if (
      directives.ignoredRanges.some(
        (range) => entity.location.line >= range.start && entity.location.line <= range.end,
      )
    ) {
      return {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        reason: "suppressed by dead-lint-ignore-start/end",
        location: entity.location,
      };
    }

    if (directives.externalLines.has(entity.location.line)) {
      return {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        reason: "marked externally visible by inline directive",
        location: entity.location,
      };
    }
  }

  if (declarationNode && hasJSDocExternalTag(declarationNode)) {
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      reason: "marked externally visible by @externallyVisible",
      location: entity.location,
    };
  }

  const keepConfig = project.config.value.keep;
  const nameTargets = [entity.name, entity.owner ? `${entity.owner}.${entity.name}` : entity.name, entity.id];

  if (keepConfig.entityIds.includes(entity.id) || matchesPatterns(entity.id, keepConfig.entityIds)) {
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      reason: "kept by entity id rule",
      location: entity.location,
    };
  }

  if (
    nameTargets.some((value) => matchesPatterns(value, keepConfig.symbols)) ||
    nameTargets.some((value) => matchesPatterns(value, keepConfig.members))
  ) {
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      reason: "kept by symbol/member rule",
      location: entity.location,
    };
  }

  if (
    matchesPatterns(entity.location.file, keepConfig.files)
  ) {
    return {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      reason: "kept by file rule",
      location: entity.location,
    };
  }

  return undefined;
}
