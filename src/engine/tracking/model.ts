import type ts from "typescript";

import type {
  EntityRecord,
  PathSegment,
  SkipCategory,
  TrackedCollectionInfo,
  TrackedCollectionState,
  TrackedObject,
} from "../../types.js";

/**
 * Shared local model types and constant tables for the exact tracking kernel.
 *
 * These declarations form the vocabulary used across state mutation, access resolution,
 * helper summary inference, and stage-specific tracking analysis.
 */

export type TrackedValueFate =
  | "observed"
  | "inserted-by-reference"
  | "shallow-cloned"
  | "deep-cloned"
  | "resource-transferred"
  | "escaped-opaquely"
  | "overwritten"
  | "invalidated";

export interface ValueAccess {
  entity: EntityRecord;
  position: number;
  kind: "write" | "read" | "read-write" | "escape";
  mayObservePreviousValue: boolean;
  nestedWrite: boolean;
  controlFlowDepth: number;
  functionDepth: number;
  flowSignature: string;
  escapeReason?: string;
}

export interface TrackedValueBinding {
  declaration: ts.Identifier;
  name: string;
  declarationDepth: number;
}

export interface ValueAnalysisCaches {
  parameterMeaningfulUse: Map<string, boolean | null>;
  callablePurity: Map<string, boolean | null>;
}

export interface TrackedObjectBinding {
  trackedObject: TrackedObject;
  prefix: PathSegment[];
}

export class TrackedObjectBindingRecord implements TrackedObjectBinding {
  constructor(
    public trackedObject: TrackedObject,
    public prefix: PathSegment[],
  ) {}
}

export type CallableReturnSummary =
  | { kind: "value" }
  | { kind: "structured"; binding: TrackedObjectBinding }
  | { kind: "returned-alias"; binding: TrackedObjectBinding }
  | { kind: "opaque" };

export interface ForwardedParameterBinding {
  index: number;
  paramSymbolKey: string;
  binding: TrackedObjectBinding;
}

export interface AnalyzableCallableBinding {
  declaration: ts.FunctionLikeDeclaration;
  symbolKey: string;
}

export interface ResolvedTrackedObjectAccess {
  binding: TrackedObjectBinding;
  dynamic: boolean;
  segments: PathSegment[];
  boundaryCategory?: SkipCategory;
  boundaryReason?: string;
  viaAliasObjectId?: string;
  viaAliasPath?: PathSegment[];
}

export interface ArrayProjectionBinding {
  trackedObject: TrackedObject;
  sourcePath: PathSegment[];
  elementPaths: PathSegment[][];
}

export interface ProjectedArrayUsageContext {
  elementBindings: Map<string, ArrayProjectionBinding>;
  receiverBindings: Map<string, ArrayProjectionBinding>;
  indexBindings: Map<string, ArrayProjectionBinding>;
}

interface ExactAppendAliasSlotPlan {
  kind: "alias";
  binding: TrackedObjectBinding;
  observeSourceAtInsert: boolean;
  insertReason: string;
  sourceObservationReason?: string;
}

interface ExactAppendValueSlotPlan {
  kind: "value";
  insertReason: string;
}

interface ExactAppendStructuredSlotPlan {
  kind: "structured";
  literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
  insertReason: string;
}

export type ExactAppendSlotPlan = ExactAppendAliasSlotPlan | ExactAppendValueSlotPlan | ExactAppendStructuredSlotPlan;

export const STRUCTURAL_RECORD_FIELD_NAMES = new Set([
  "binding",
  "crossFileReferences",
  "dynamic",
  "findingKind",
  "kind",
  "reads",
  "reason",
  "references",
  "root",
  "sameFileReferences",
  "segments",
  "value",
  "viaAliasObjectId",
  "viaAliasPath",
  "writes",
]);

export const STRUCTURAL_HELPER_FIELD_NAMES = new Set([
  ...STRUCTURAL_RECORD_FIELD_NAMES,
  "elementPaths",
  "file",
  "from",
  "insertReason",
  "literal",
  "message",
  "observeSourceAtInsert",
  "sourceObservationReason",
  "sourcePath",
  "specifier",
  "to",
  "trackedObject",
]);

export const STRUCTURAL_STATE_FIELD_NAMES = new Set([
  "diagnostics",
  "findings",
  "kept",
  "outgoing",
  "skipped",
  "unresolved",
]);

export interface ResolvedProjectionAccess {
  projection: ArrayProjectionBinding;
  suffix: PathSegment[];
  dynamic: boolean;
  boundaryCategory?: SkipCategory;
  boundaryReason?: string;
}

export type HelperParameterEffectKind =
  | "read"
  | "mutation"
  | "returned-alias"
  | "retained-binding"
  | "opaque-escape";

export interface HelperParameterSummary {
  effectKinds: Set<HelperParameterEffectKind>;
  exactReadPaths: PathSegment[][];
  boundaryNode?: ts.Node;
  boundaryReason?: string;
}

export class HelperParameterSummaryState implements HelperParameterSummary {
  readonly effectKinds = new Set<HelperParameterEffectKind>();
  readonly exactReadPaths: PathSegment[][] = [];

  constructor(
    public boundaryNode?: ts.Node,
    public boundaryReason?: string,
  ) {}
}

export class CollectionInfoRecord implements TrackedCollectionInfo {
  readonly childPaths: PathSegment[][] = [];

  constructor(
    public kind: "object" | "array",
    public path: PathSegment[],
    public arrayLength?: number,
  ) {}
}

export class CollectionState implements TrackedCollectionState {
  constructor(
    public path: PathSegment[],
    public epoch = 0,
    public arrayLength?: number,
  ) {}
}
