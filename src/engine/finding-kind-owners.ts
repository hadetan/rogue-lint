import {
  FINDING_KIND_OWNER,
  FINDING_KIND_VALUES,
} from "../shared/finding-vocabulary.js";

export function validateFindingKindOwners(): void {
  const mappedKinds = Object.keys(FINDING_KIND_OWNER).sort();
  const declaredKinds = [...FINDING_KIND_VALUES].sort();

  if (mappedKinds.length !== declaredKinds.length) {
    throw new Error(`Finding owner matrix mismatch: expected ${declaredKinds.length} kinds, found ${mappedKinds.length}`);
  }

  for (let index = 0; index < declaredKinds.length; index += 1) {
    if (mappedKinds[index] !== declaredKinds[index]) {
      throw new Error(`Finding owner matrix mismatch: expected ${declaredKinds[index]}, found ${mappedKinds[index] ?? "(missing)"}`);
    }
  }
}
