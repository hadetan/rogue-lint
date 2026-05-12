import type { FindingKind } from "../types.js";

type CapabilityOwner =
  | "reachability"
  | "symbol-liveness"
  | "structural-exactness"
  | "value-fate"
  | "compiler-safety";

const ALL_FINDING_KINDS = [
  "unused-file",
  "unused-export",
  "unused-import",
  "unused-local",
  "unused-type",
  "unused-enum-member",
  "unused-class-member",
  "unused-array-element",
  "unused-object-key",
  "unused-nested-path",
  "unused-interface-member",
  "use-before-init",
  "invalidated-read",
  "stale-read-after-mutation",
  "dead-store",
  "unused-value",
  "write-only-state",
] as const satisfies readonly FindingKind[];

const FINDING_KIND_OWNERS = {
  "unused-file": "reachability",
  "unused-export": "symbol-liveness",
  "unused-import": "symbol-liveness",
  "unused-local": "symbol-liveness",
  "unused-type": "symbol-liveness",
  "unused-enum-member": "symbol-liveness",
  "unused-class-member": "symbol-liveness",
  "unused-array-element": "structural-exactness",
  "unused-object-key": "structural-exactness",
  "unused-nested-path": "structural-exactness",
  "unused-interface-member": "symbol-liveness",
  "use-before-init": "compiler-safety",
  "invalidated-read": "value-fate",
  "stale-read-after-mutation": "value-fate",
  "dead-store": "value-fate",
  "unused-value": "value-fate",
  "write-only-state": "value-fate",
} as const satisfies Record<FindingKind, CapabilityOwner>;

export function validateFindingKindOwners(): void {
  const mappedKinds = Object.keys(FINDING_KIND_OWNERS).sort();
  const declaredKinds = [...ALL_FINDING_KINDS].sort();

  if (mappedKinds.length !== declaredKinds.length) {
    throw new Error(`Finding owner matrix mismatch: expected ${declaredKinds.length} kinds, found ${mappedKinds.length}`);
  }

  for (let index = 0; index < declaredKinds.length; index += 1) {
    if (mappedKinds[index] !== declaredKinds[index]) {
      throw new Error(`Finding owner matrix mismatch: expected ${declaredKinds[index]}, found ${mappedKinds[index] ?? "(missing)"}`);
    }
  }
}
