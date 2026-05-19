/**
 * Reviewed baseline for current repeated literals in managed source.
 * Tighten this file by replacing exclusions with owned literal surfaces over time.
 */
export const reviewedLiteralExclusions = [
  {
    literal: "0",
    pathGlobs: ["src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "",
    pathGlobs: ["src/benchmark/manifests.ts","src/benchmark/reporting.ts","src/config.ts","src/engine/capabilities/providers.ts","src/engine/capabilities/types.ts","src/engine/tracking/access.ts","src/engine/tracking/convergence.ts","src/engine/tracking/diagnostics.ts","src/engine/tracking/graph.ts","src/engine/tracking/object-paths/finite-lookups.ts","src/module-graph.ts","src/output/render-result.ts","src/shared/path-utils.ts","src/suppressions.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "\n",
    pathGlobs: ["src/benchmark/reporting.ts","src/output/render-result.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ",",
    pathGlobs: ["src/cli/parse-cli-options.ts","src/engine/tracking/object-paths/finite-lookups.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ", ",
    pathGlobs: ["src/benchmark/reporting.ts","src/engine/tracking/convergence.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "; ",
    pathGlobs: ["src/engine/tracking/convergence.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".cjs",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".cts",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".js",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".jsx",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".mjs",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".mts",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".ts",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: ".tsx",
    pathGlobs: ["src/module-graph.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "()",
    pathGlobs: ["src/engine/tracking/graph.ts","src/engine/tracking/object-paths/reporting.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "[",
    pathGlobs: ["src/benchmark/reporting.ts","src/output/render-result.ts","src/shared/path-utils.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "/",
    pathGlobs: ["src/compiler/ast-utils.ts","src/output/render-result.ts","src/references.ts","src/shared/path-utils.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "|",
    pathGlobs: ["src/engine/tracking/object-paths/finite-lookups.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "alias",
    pathGlobs: ["src/engine/tracking/model.ts","src/engine/tracking/object-paths/effects.ts","src/engine/tracking/state.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "alias-write",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "aliases",
    pathGlobs: ["src/engine/tracking/object-paths/stage-context.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "application",
    pathGlobs: ["src/api/public-types.ts","src/benchmark/types.ts","src/config.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array",
    pathGlobs: ["src/engine/tracking/access.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array callback escapes exact local analysis",
    pathGlobs: ["src/engine/tracking/object-paths/projections.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array projection escapes exact local analysis",
    pathGlobs: ["src/engine/tracking/object-paths/projection-traversal.ts","src/engine/tracking/object-paths/projections.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array-append-mutation",
    pathGlobs: ["src/engine/tracking/object-paths/collection-operations.ts","src/engine/tracking/object-paths/effects.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array-reorder-mutation",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array-replacement-mutation",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array-rest",
    pathGlobs: ["src/engine/tracking/object-paths/destructuring.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "array-truncate-mutation",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "assign",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "binding-changes",
    pathGlobs: ["src/benchmark/reporting.ts","src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "bindings",
    pathGlobs: ["src/engine/tracking/object-paths/stage-context.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "body",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "boolean",
    pathGlobs: ["src/benchmark/manifests.ts","src/cli/parse-cli-options.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "boundaries",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/tracking/object-paths/stage-context.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "call-site structured return keeps this nested binding exact",
    pathGlobs: ["src/engine/tracking/access.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "callSiteSpecializations",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "capabilityObligations",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "catch",
    pathGlobs: ["src/engine/tracking/object-paths/returned-structures.ts","src/engine/tracking/return-summaries.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "category",
    pathGlobs: ["src/benchmark/manifests.ts","src/engine/capabilities/providers.ts","src/engine/capabilities/summary-models.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "children",
    pathGlobs: ["src/engine/tracking/object-paths/overlay.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "coalesce-assign",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "code",
    pathGlobs: ["src/engine/tracking/contracts.ts","src/engine/tracking/graph.ts","src/engine/tracking/object-paths/policy.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "collection-boundary",
    pathGlobs: ["src/engine/tracking/state.ts","src/shared/entity-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "compiler-safety",
    pathGlobs: ["src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "computed property access prevents exact path analysis",
    pathGlobs: ["src/engine/tracking/access.ts","src/engine/tracking/object-paths/visitor.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "computed property names are not eligible for exact analysis",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "computed-member-name",
    pathGlobs: ["src/engine/analyzers/class-members.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "computed-property-name",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "concat",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "condition",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "coverageClass",
    pathGlobs: ["src/benchmark/evaluate.ts","src/benchmark/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "decorator-visibility",
    pathGlobs: ["src/engine/analyzers/class-members.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "detailHint",
    pathGlobs: ["src/engine/capabilities/summary-models.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "diagnostic",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/capabilities/report-assembly.ts","src/engine/capabilities/vocabulary.ts","src/engine/tracking/contracts.ts","src/engine/tracking/graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "dynamic array index prevents exact element analysis",
    pathGlobs: ["src/engine/tracking/access.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "elapsed-ms",
    pathGlobs: ["src/benchmark/reporting.ts","src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "enforced",
    pathGlobs: ["src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "exact-append-mutation",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts","src/engine/tracking/object-paths/visitor.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "expression",
    pathGlobs: ["src/engine/tracking/syntax.ts","src/shared/entity-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "external",
    pathGlobs: ["src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "fact",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/capabilities/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "file",
    pathGlobs: ["src/engine/tracking/syntax.ts","src/shared/entity-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "findings",
    pathGlobs: ["src/benchmark/manifests.ts","src/engine/capabilities/providers.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "format",
    pathGlobs: ["src/engine/tracking/object-paths/policy.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "helper stores this value in an unsupported retained location",
    pathGlobs: ["src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "helper stores this value inside an aggregate literal beyond exact local analysis",
    pathGlobs: ["src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "higher-order callable parameter leaves bounded local alias transport",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "higher-order helper return array sort uses an unsupported comparator carrier",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "id",
    pathGlobs: ["src/engine/capabilities/types.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "ignore",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/value-liveness.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "index",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts","src/engine/tracking/object-paths/visitor.ts","src/shared/path-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "informational",
    pathGlobs: ["src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "initializer",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "interface-member",
    pathGlobs: ["src/engine/analyzers/interface-members.ts","src/shared/entity-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "internal",
    pathGlobs: ["src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "json",
    pathGlobs: ["src/api/public-types.ts","src/cli/parse-cli-options.ts","src/output/render-result.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "keep",
    pathGlobs: ["src/engine/internal-types.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "kept",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/capabilities/vocabulary.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "kind",
    pathGlobs: ["src/benchmark/manifests.ts","src/benchmark/types.ts","src/engine/tracking/model.ts","src/engine/tracking/state.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "library",
    pathGlobs: ["src/api/public-types.ts","src/benchmark/evaluate.ts","src/benchmark/types.ts","src/engine/analyzers/interface-members.ts","src/engine/analyzers/support.ts","src/engine/tracking/object-paths/returned-structures.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "literalBindingCacheEntries",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "literalBindingCacheGrowth",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "map-like",
    pathGlobs: ["src/engine/tracking/retained-bindings.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "maxCount",
    pathGlobs: ["src/benchmark/manifests.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "message",
    pathGlobs: ["src/engine/tracking/contracts.ts","src/engine/tracking/graph.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "method",
    pathGlobs: ["src/engine/tracking/object-paths/reporting.ts","src/shared/path-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "minCount",
    pathGlobs: ["src/benchmark/manifests.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "mode",
    pathGlobs: ["src/benchmark/types.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "mutation",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "non-literal .at(...) prevents exact array slot analysis",
    pathGlobs: ["src/engine/tracking/access.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "non-runtime-support",
    pathGlobs: ["src/references.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "non-runtime-test",
    pathGlobs: ["src/references.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "number",
    pathGlobs: ["src/benchmark/manifests.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "object",
    pathGlobs: ["src/benchmark/manifests.ts","src/config.ts","src/engine/tracking/access.ts","src/engine/tracking/contracts.ts","src/engine/tracking/graph.ts","src/engine/tracking/vocabulary.ts","src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "object spread introduces opaque properties",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "object spread may overwrite this property",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "object-backed",
    pathGlobs: ["src/engine/tracking/retained-bindings.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "object-rest",
    pathGlobs: ["src/engine/tracking/object-paths/destructuring.ts","src/shared/skip-category-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "objectAnalysis",
    pathGlobs: ["src/benchmark/types.ts","src/engine/internal-types.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "obligation",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/capabilities/report-assembly.ts","src/engine/capabilities/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "observe-keys",
    pathGlobs: ["src/engine/tracking/object-paths/projection-traversal.ts","src/engine/tracking/object-paths/projections.ts","src/engine/tracking/object-paths/visitor.ts","src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "observe-subtree",
    pathGlobs: ["src/engine/tracking/object-paths/projection-traversal.ts","src/engine/tracking/object-paths/projections.ts","src/engine/tracking/object-paths/visitor.ts","src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "observe-values",
    pathGlobs: ["src/engine/tracking/object-paths/projection-traversal.ts","src/engine/tracking/object-paths/projections.ts","src/engine/tracking/object-paths/visitor.ts","src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "observed",
    pathGlobs: ["src/engine/tracking/state.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "opaque",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "opaque-escape",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "passes",
    pathGlobs: ["src/benchmark/reporting.ts","src/engine/tracking/syntax.ts","src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "project-error",
    pathGlobs: ["src/api/public-types.ts","src/cli/run-cli.ts","src/engine/tracking/diagnostics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "project-warning",
    pathGlobs: ["src/api/public-types.ts","src/engine/analysis-state.ts","src/engine/capabilities/providers.ts","src/engine/tracking/diagnostics.ts","src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "projected-iteration-binding",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts","src/engine/tracking/object-paths/visitor.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "property",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts","src/engine/tracking/object-paths/finite-lookups.ts","src/engine/tracking/object-paths/projections.ts","src/engine/tracking/object-paths/visitor.ts","src/shared/path-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "prototype",
    pathGlobs: ["src/engine/analyzers/support.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "reachability",
    pathGlobs: ["src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "read",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "remove",
    pathGlobs: ["src/api/public-types.ts","src/engine/analysis-state.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "retained-binding",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "return-summary-changes",
    pathGlobs: ["src/benchmark/reporting.ts","src/engine/tracking/upgrade-safety.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returned structure keeps this nested binding exact",
    pathGlobs: ["src/engine/tracking/literal-materialization.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returned-alias",
    pathGlobs: ["src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returned-carrier-emission",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returnLiteralBindingCacheEntries",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returnLiteralBindingCacheGrowth",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "returnSummaries",
    pathGlobs: ["src/engine/tracking/object-paths/stage-context.ts","src/engine/tracking/syntax.ts","src/engine/tracking/value-liveness-context.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "review",
    pathGlobs: ["src/api/public-types.ts","src/engine/analyzers/compiler-safety.ts","src/engine/tracking/object-paths/effects.ts","src/engine/tracking/object-paths/reporting.ts","src/engine/tracking/value-liveness.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "rogue-lint",
    pathGlobs: ["src/api/public-types.ts","src/engine/run-analysis.ts","src/output/render-result.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "rogue-lint.config.json",
    pathGlobs: ["src/benchmark/run-benchmark.ts","src/config.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "runtimeSummary",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "s",
    pathGlobs: ["src/benchmark/reporting.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "same-project helper receives this collection beyond exact local analysis",
    pathGlobs: ["src/engine/tracking/object-paths/helper-transport.ts","src/engine/tracking/object-paths/visitor.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "segments",
    pathGlobs: ["src/engine/tracking/graph.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "self",
    pathGlobs: ["src/engine/tracking/object-paths/overlay.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "skipped",
    pathGlobs: ["src/engine/capabilities/providers.ts","src/engine/capabilities/vocabulary.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "skips",
    pathGlobs: ["src/benchmark/manifests.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "slice",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/engine/tracking/semantics.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "solverState",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "sort",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "spread-materialization-prerequisite",
    pathGlobs: ["src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/object-paths/types.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "stage",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "stageTimingsMs",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "stores this value by reference",
    pathGlobs: ["src/engine/tracking/object-paths/helper-transport.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "string",
    pathGlobs: ["src/benchmark/manifests.ts","src/cli/parse-cli-options.ts","src/engine/tracking/object-paths/collection-operations.ts","src/engine/tracking/object-paths/effects.ts","src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "structural-exactness",
    pathGlobs: ["src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "structured",
    pathGlobs: ["src/engine/tracking/model.ts","src/engine/tracking/object-paths/effects.ts","src/engine/tracking/object-paths/helper-plans.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "structuredClone",
    pathGlobs: ["src/engine/tracking/object-paths/effects.ts","src/engine/tracking/semantics.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "subtree",
    pathGlobs: ["src/engine/tracking/object-paths/overlay.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "symbol-liveness",
    pathGlobs: ["src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "text",
    pathGlobs: ["src/api/public-types.ts","src/benchmark/reporting.ts","src/cli/parse-cli-options.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "then",
    pathGlobs: ["src/engine/tracking/object-paths/returned-structures.ts","src/engine/tracking/return-summaries.ts","src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "trackedObjectRegistryEntries",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "trackedObjectRegistryGrowth",
    pathGlobs: ["src/engine/tracking/syntax.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "trusted-runtime",
    pathGlobs: ["src/references.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unresolved",
    pathGlobs: ["src/engine/tracking/syntax.ts","src/module-graph.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unused-class-member",
    pathGlobs: ["src/engine/analyzers/class-members.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unused-file",
    pathGlobs: ["src/engine/analyzers/unused-files.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unused-import",
    pathGlobs: ["src/engine/analyzers/unused-imports.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unused-interface-member",
    pathGlobs: ["src/engine/analyzers/interface-members.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "unused-local",
    pathGlobs: ["src/engine/analyzers/unused-locals.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "use-before-init",
    pathGlobs: ["src/engine/analyzers/compiler-safety.ts","src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "utf8",
    pathGlobs: ["src/benchmark/manifests.ts","src/config.ts","src/project.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "value",
    pathGlobs: ["src/config.ts","src/engine/tracking/model.ts","src/engine/tracking/object-paths/effects.ts","src/engine/tracking/syntax.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "value-fate",
    pathGlobs: ["src/shared/finding-vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
  {
    literal: "write",
    pathGlobs: ["src/engine/tracking/object-paths/overlay.ts","src/engine/tracking/vocabulary.ts"],
    reason: "Reviewed baseline for the initial literal-ownership ratchet; replace with owner surfaces incrementally.",
  },
];