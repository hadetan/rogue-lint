import type { EntityKind } from "../api/public-types.js";
import { ENTITY_KIND } from "./entity-vocabulary.js";

/**
 * Canonical runtime vocabulary for package finding kinds and their ownership.
 */
export const FINDING_KIND = {
  unusedFile: "unused-file",
  unusedExport: "unused-export",
  unusedImport: "unused-import",
  unusedLocal: "unused-local",
  unusedType: "unused-type",
  unusedEnumMember: "unused-enum-member",
  unusedClassMember: "unused-class-member",
  unusedArrayElement: "unused-array-element",
  unusedObjectKey: "unused-object-key",
  unusedNestedPath: "unused-nested-path",
  unusedInterfaceMember: "unused-interface-member",
  useBeforeInit: "use-before-init",
  invalidatedRead: "invalidated-read",
  staleReadAfterMutation: "stale-read-after-mutation",
  deadStore: "dead-store",
  unusedValue: "unused-value",
  writeOnlyState: "write-only-state",
} as const;

type FindingKind = (typeof FINDING_KIND)[keyof typeof FINDING_KIND];

export const FINDING_KIND_VALUES = Object.values(FINDING_KIND) as ReadonlyArray<FindingKind>;

type FindingCapabilityOwner =
  | "reachability"
  | "symbol-liveness"
  | "structural-exactness"
  | "value-fate"
  | "compiler-safety";

export const FINDING_KIND_OWNER = {
  [FINDING_KIND.unusedFile]: "reachability",
  [FINDING_KIND.unusedExport]: "symbol-liveness",
  [FINDING_KIND.unusedImport]: "symbol-liveness",
  [FINDING_KIND.unusedLocal]: "symbol-liveness",
  [FINDING_KIND.unusedType]: "symbol-liveness",
  [FINDING_KIND.unusedEnumMember]: "symbol-liveness",
  [FINDING_KIND.unusedClassMember]: "symbol-liveness",
  [FINDING_KIND.unusedArrayElement]: "structural-exactness",
  [FINDING_KIND.unusedObjectKey]: "structural-exactness",
  [FINDING_KIND.unusedNestedPath]: "structural-exactness",
  [FINDING_KIND.unusedInterfaceMember]: "symbol-liveness",
  [FINDING_KIND.useBeforeInit]: "compiler-safety",
  [FINDING_KIND.invalidatedRead]: "value-fate",
  [FINDING_KIND.staleReadAfterMutation]: "value-fate",
  [FINDING_KIND.deadStore]: "value-fate",
  [FINDING_KIND.unusedValue]: "value-fate",
  [FINDING_KIND.writeOnlyState]: "value-fate",
} as const satisfies Record<FindingKind, FindingCapabilityOwner>;

type FindingMappedEntityKind = Extract<
  EntityKind,
  | typeof ENTITY_KIND.file
  | typeof ENTITY_KIND.export
  | typeof ENTITY_KIND.import
  | typeof ENTITY_KIND.local
  | typeof ENTITY_KIND.type
  | typeof ENTITY_KIND.enumMember
  | typeof ENTITY_KIND.classMember
  | typeof ENTITY_KIND.arrayElement
  | typeof ENTITY_KIND.interfaceMember
  | typeof ENTITY_KIND.objectKey
  | typeof ENTITY_KIND.nestedPath
>;

const FINDING_KIND_BY_ENTITY_KIND = {
  [ENTITY_KIND.file]: FINDING_KIND.unusedFile,
  [ENTITY_KIND.export]: FINDING_KIND.unusedExport,
  [ENTITY_KIND.import]: FINDING_KIND.unusedImport,
  [ENTITY_KIND.local]: FINDING_KIND.unusedLocal,
  [ENTITY_KIND.type]: FINDING_KIND.unusedType,
  [ENTITY_KIND.enumMember]: FINDING_KIND.unusedEnumMember,
  [ENTITY_KIND.classMember]: FINDING_KIND.unusedClassMember,
  [ENTITY_KIND.arrayElement]: FINDING_KIND.unusedArrayElement,
  [ENTITY_KIND.interfaceMember]: FINDING_KIND.unusedInterfaceMember,
  [ENTITY_KIND.objectKey]: FINDING_KIND.unusedObjectKey,
  [ENTITY_KIND.nestedPath]: FINDING_KIND.unusedNestedPath,
} as const satisfies Record<FindingMappedEntityKind, FindingKind>;

export function getFindingKindForEntityKind(kind: EntityKind): FindingKind | undefined {
  return kind in FINDING_KIND_BY_ENTITY_KIND
    ? FINDING_KIND_BY_ENTITY_KIND[kind as FindingMappedEntityKind]
    : undefined;
}
