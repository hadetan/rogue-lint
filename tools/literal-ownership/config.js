/**
 * Repository-owned ratchet configuration for repeated literal validation.
 *
 * The validator starts with managed product code under `src/**` and tightens as
 * individual domains migrate repeated literals behind explicit owner surfaces.
 */
export const repoLiteralOwnershipConfig = {
  includeGlobs: ["src/**/*.ts"],
  excludeGlobs: [],
  enforceUnownedDuplicates: true,
  ownedLiteralRules: [],
  reviewedLiteralExclusions: [],
};