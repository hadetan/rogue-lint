import type ts from "typescript";

import { FINDING_KIND } from "../shared/finding-vocabulary.js";
import {
  PATH_SEGMENT_KIND,
  TRACKED_OBJECT_NODE_ORIGIN,
} from "../shared/path-vocabulary.js";
import { TRACKING_STRUCTURAL_ROLE } from "./tracking/ownership.js";
import { TRACKING_COLLECTION_KIND } from "./tracking/vocabulary.js";
import {
  TRACKING_PLACE_STATE,
  TRACKING_VALUE_FATE,
} from "./tracking/vocabulary.js";
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
  origin:
    | typeof TRACKED_OBJECT_NODE_ORIGIN.property
    | typeof TRACKED_OBJECT_NODE_ORIGIN.method
    | typeof TRACKED_OBJECT_NODE_ORIGIN.arrayElement;
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
  | { kind: typeof PATH_SEGMENT_KIND.property; value: string }
  | { kind: typeof PATH_SEGMENT_KIND.index; value: number };

export interface TrackedCollectionInfo {
  kind: typeof TRACKING_COLLECTION_KIND.object | typeof TRACKING_COLLECTION_KIND.array;
  path: PathSegment[];
  childPaths: PathSegment[][];
  arrayLength?: number;
}

export interface TrackedCollectionState {
  path: PathSegment[];
  epoch: number;
  arrayLength?: number;
}

export type TrackedPlaceState = (typeof TRACKING_PLACE_STATE)[keyof typeof TRACKING_PLACE_STATE];

export interface InvalidatedPathRecord {
  reason: string;
  findingKind?: Extract<FindingKind, typeof FINDING_KIND.invalidatedRead | typeof FINDING_KIND.staleReadAfterMutation>;
}

export type TrackedObjectStructuralRole = (typeof TRACKING_STRUCTURAL_ROLE)[keyof typeof TRACKING_STRUCTURAL_ROLE];

/**
 * Canonical structured object tracked across exact path, collection, and value-fate analysis.
 */
export interface TrackedObject {
  id: string;
  reportingOwnerId?: string;
  derivedStateRevision: number;
  specializationSourceRevision?: number;
  specializationBindingSignature?: string;
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
    fate: typeof TRACKING_VALUE_FATE.insertedByReference;
    sourceObjectId: string;
    sourcePath: PathSegment[];
    observed: boolean;
  }>;
  valueFates: Array<{
    fate: (typeof TRACKING_VALUE_FATE)[keyof typeof TRACKING_VALUE_FATE];
    path: PathSegment[];
    reason: string;
    relatedObjectId?: string;
    relatedPath?: PathSegment[];
  }>;
  reads: Set<string>;
  writes: Set<string>;
}
