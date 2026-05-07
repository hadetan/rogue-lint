import ts from "typescript";

import type { EntityKind, EntityRecord, FindingKind, Location } from "../types.js";
import { normalizeSlashes, toRelative } from "./path-utils.js";

function createEntityId(
  kind: EntityKind,
  file: string,
  position: number,
  name: string,
): string {
  return `${kind}:${normalizeSlashes(file)}:${position}:${name}`;
}

function toLocation(
  rootPath: string,
  sourceFile: ts.SourceFile,
  position: number,
): Location {
  const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    file: toRelative(rootPath, sourceFile.fileName),
    line: lineAndCharacter.line + 1,
    column: lineAndCharacter.character + 1,
  };
}

export function makeEntity(
  rootPath: string,
  kind: EntityKind,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  owner?: string,
): EntityRecord {
  return {
    id: createEntityId(kind, toRelative(rootPath, sourceFile.fileName), node.getStart(sourceFile), name),
    kind,
    name,
    owner,
    location: toLocation(rootPath, sourceFile, node.getStart(sourceFile)),
  };
}

export function kindToFinding(kind: EntityKind): FindingKind | undefined {
  switch (kind) {
    case "file":
      return "unused-file";
    case "export":
      return "unused-export";
    case "local":
      return "unused-local";
    case "type":
      return "unused-type";
    case "enum-member":
      return "unused-enum-member";
    case "class-member":
      return "unused-class-member";
    case "array-element":
      return "unused-array-element";
    case "interface-member":
      return "unused-interface-member";
    case "object-key":
      return "unused-object-key";
    case "nested-path":
      return "unused-nested-path";
    default:
      return undefined;
  }
}
