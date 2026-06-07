/**
 * Repository-owned direct-wiring rules for managed product code.
 *
 * Allowed facade categories:
 * - `package-entrypoint`: stable public surface for external library consumers
 * - `executable-entrypoint`: shell-facing runnable entrypoint
 * - `compatibility-facade`: reviewed compatibility or migration shim
 *
 * Current reviewed exceptions are intentionally narrow: the public package entrypoint
 * the CLI executable entrypoint, and the temporary shared type facade that still
 * centralizes mixed public and engine-only type exports.
 */
export const DIRECT_MODULE_WIRING_FACADE_CATEGORY = Object.freeze({
  packageEntrypoint: "package-entrypoint",
  executableEntrypoint: "executable-entrypoint",
  compatibilityFacade: "compatibility-facade",
});

export const repoDirectModuleWiringConfig = {
  includeGlobs: ["src/**/*.ts"],
  excludeGlobs: [],
  reviewedFacadeExceptions: [
    {
      pathGlobs: ["src/index.ts"],
      category: DIRECT_MODULE_WIRING_FACADE_CATEGORY.packageEntrypoint,
      reason: "Public package surface for external consumers.",
    },
    {
      pathGlobs: ["src/cli.ts"],
      category: DIRECT_MODULE_WIRING_FACADE_CATEGORY.executableEntrypoint,
      reason: "Shell entrypoint that intentionally re-exports runCli.",
    },
    {
      pathGlobs: ["src/types.ts"],
      category: DIRECT_MODULE_WIRING_FACADE_CATEGORY.compatibilityFacade,
      reason: "Shared type facade retained while public and engine-only type imports still converge on one path.",
    },
  ],
};