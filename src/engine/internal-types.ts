import type ts from "typescript";

import type {
  DiagnosticRecord,
  EntityRecord,
  FindingKind,
  RogueLintConfig,
  SkipCategory,
} from "../api/public-types.js";

/**
 * Internal engine-only types shared across project loading, graph traversal, suppressions, and tracking.
 * Public API contracts belong in `src/api/public-types.ts`.
 */

export interface ResolvedConfig {
  value: Required<Omit<RogueLintConfig, "keep" | "objectAnalysis">> & {
    keep: Required<NonNullable<RogueLintConfig["keep"]>>;
    objectAnalysis: Required<NonNullable<RogueLintConfig["objectAnalysis"]>>;
  };
}

export interface ModuleEdge {
  from: string;
  to: string;
  specifier: string;
  dynamic: boolean;
}

export interface ModuleGraph {
  outgoing: Map<string, ModuleEdge[]>;
  unresolved: DiagnosticRecord[];
}

export interface SourceCommentDirectives {
  ignoredLines: Set<number>;
  ignoredRanges: Array<{ start: number; end: number }>;
  externalLines: Set<number>;
}

export interface SuppressionContext {
  directives: Map<string, SourceCommentDirectives>;
}

/**
 * Fully resolved analysis context shared by orchestration and analyzer stages.
 */
export interface ProjectContext {
  rootPath: string;
  packageJson: Record<string, unknown> | null;
  config: ResolvedConfig;
  analyzableFiles: Set<string>;
  sourceFiles: ts.SourceFile[];
  program: ts.Program;
  checker: ts.TypeChecker;
  languageService: ts.LanguageService;
  compilerOptions: ts.CompilerOptions;
}

interface ObjectNode {
  entity: EntityRecord;
  fullPath: PathSegment[];
  origin: "property" | "method" | "array-element";
}

export interface EscapedPathRecord {
  category: SkipCategory;
  reason: string;
}

export interface CollectionBoundaryRecord {
  entity: EntityRecord;
  path: PathSegment[];
  category: SkipCategory;
  reason: string;
}

export type PathSegment =
  | { kind: "property"; value: string }
  | { kind: "index"; value: number };

export interface TrackedCollectionInfo {
  kind: "object" | "array";
  path: PathSegment[];
  childPaths: PathSegment[][];
  arrayLength?: number;
}

export interface TrackedCollectionState {
  path: PathSegment[];
  epoch: number;
  arrayLength?: number;
}

export type TrackedPlaceState = "uninitialized" | "initialized" | "invalidated" | "escaped" | "unknown";

export interface InvalidatedPathRecord {
  reason: string;
  findingKind?: Extract<FindingKind, "invalidated-read" | "stale-read-after-mutation">;
}

export type TrackedObjectStructuralRole = "record" | "state-holder" | "structural-record" | "structural-record-array";

/**
 * Canonical structured object tracked across exact path, collection, and value-fate analysis.
 */
export interface TrackedObject {
  id: string;
  reportingOwnerId?: string;
  canonicalSymbolKey: string;
  rootName: string;
  sourceFile: string;
  rootEntity: EntityRecord;
  structuralRole?: TrackedObjectStructuralRole;
  nodes: Map<string, ObjectNode>;
  callablePaths: Map<string, {
    symbolKey: string;
    declaration: ts.FunctionLikeDeclaration;
  }>;
  descendantNodeKeys: Map<string, string[]>;
  collections: Map<string, TrackedCollectionInfo>;
  collectionStates: Map<string, TrackedCollectionState>;
  collectionBoundaries: Map<string, CollectionBoundaryRecord>;
  invalidatedCollectionPaths: Set<string>;
  invalidatedPaths: Map<string, InvalidatedPathRecord>;
  placeStates: Map<string, TrackedPlaceState>;
  observedSubtrees: Set<string>;
  escapedPaths: Map<string, EscapedPathRecord>;
  exactPathAliases: Map<string, {
    fate: "inserted-by-reference";
    sourceObjectId: string;
    sourcePath: PathSegment[];
    observed: boolean;
  }>;
  valueFates: Array<{
    fate:
      | "observed"
      | "inserted-by-reference"
      | "shallow-cloned"
      | "deep-cloned"
      | "resource-transferred"
      | "escaped-opaquely"
      | "overwritten"
      | "invalidated";
    path: PathSegment[];
    reason: string;
    relatedObjectId?: string;
    relatedPath?: PathSegment[];
  }>;
  reads: Set<string>;
  writes: Set<string>;
}
