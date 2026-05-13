# rogue-lint architecture

This guide maps the major module groups in the refactored engine so maintainers can find the owning code for a change quickly.

## Top-Level Flow

The package keeps two thin entrypoints:

- `src/index.ts`: package root exports for the public API and public types
- `src/cli.ts`: executable entrypoint that wires process arguments into the internal CLI runner

Everything else should depend inward from those surfaces.

## Module Groups

### `src/api/`

Owns the package-facing API contract.

- `public-types.ts`: exported result, config, audit, and finding types
- `analyze-project.ts`: documented public wrapper around the engine orchestrator

Put package-facing type and function docs here. Do not widen the root export surface from deeper engine modules unless the package API is intentionally changing.

### `src/cli/`

Owns CLI argument handling and shell-oriented execution behavior.

- `parse-cli-options.ts`: normalizes raw argv into internal options
- `run-cli.ts`: resolves config, executes analysis, renders output, and returns exit codes

Keep process and stdout/stderr concerns here. Analyzer stages should not know about terminal behavior.

### `src/compiler/`

Owns AST and symbol helpers that depend directly on TypeScript syntax APIs.

Move reusable syntax-tree helpers here when they are compiler-facing but not stage-specific.

### `src/engine/run-analysis.ts`

Owns orchestration only.

This module is responsible for:

- loading the project context
- discovering entrypoints and reachable files
- creating shared per-run analysis artifacts, caches, and mutable state
- executing analyzer stages in order
- adapting internal tracking diagnostics into the normal analysis diagnostics surface
- executing provider-owned capability analysis over shared tracking facts
- assembling the final `AnalysisResult`

Do not move stage-specific semantics back into this file.

### `src/engine/analysis-artifacts.ts`

Owns shared per-run evidence.

- compiler-diagnostic access used by low-coupling analyzers
- lazy tracking-artifact construction shared by the exactness-sensitive tracking stages
- the run-scoped tracking diagnostics surface exposed through `getTrackingRunArtifacts()`, plus stage-scoped accessors exposed through `getTrackingStageArtifacts(...)`
- internal test seams for tracking convergence validation without widening the public analysis API

Put reusable per-run analysis evidence here when more than one stage needs the same derived view.

### `src/engine/analyzers/`

Owns stage entrypoints.

- low-coupling stages such as `unused-files`, `compiler-safety`, and `symbol-liveness` live directly here
- `symbol-liveness.ts` owns import, export, type, enum-member, local, class-member, and interface-member findings through helpers such as `unused-imports.ts`, `unused-exports.ts`, `unused-locals.ts`, `class-members.ts`, and `interface-members.ts`
- `support.ts` holds shared export/reference helpers used across those stages
- `value-liveness.ts` and `object-paths.ts` stay thin and delegate to stable tracking stage exports behind `src/engine/tracking/core.ts`, sharing the same tracked-graph artifacts per run

Add a new module here when a concern can be executed as one stage in the orchestration pipeline.

### `src/engine/capabilities/`

Owns the provider-owned evidence kernel that sits between tracking facts and public report projection.

- `types.ts`: capability ids, provider-owned obligation records, evidence and boundary records, and ledger indexes consumed by benchmark evaluation
- `providers.ts`: provider execution context, provider registry, obligation-backed and boundary-backed capability providers, and the result-attached capability ledger
- `summary-models.ts`: declarative summary-model registry for same-project return summaries and modeled library transport or barrier surfaces
- `report-assembly.ts`: projection adapter that keeps the public `findings`, `kept`, `skipped`, and `diagnostics` result categories stable while provider provenance stays internal

Start here when a change affects:

- capability-owned obligation seeding or resolution
- capability evidence or conservative-boundary provenance
- summary-model registration for helper or library transport
- capability-first benchmark prioritization details

Keep provider-owned provenance here. Analyzer and tracking stages may seed obligations or emit public records, but the capability modules own how those surfaces are attributed, labeled, and projected downstream.

### `src/engine/tracking/`

Owns the exactness-sensitive tracking subsystem used by the value-liveness and object-path stages.

- `core.ts`: stable internal facade that re-exports tracking stage entrypoints for analyzer wrappers
- `contracts.ts`: explicit run-scoped and stage-scoped tracking artifact contracts, readonly ownership surfaces, runtime summaries, and internal diagnostics for stage consumers
- `convergence.ts`: bounded convergence driver and guard policy for tracked bindings and callable return summaries
- `diagnostics.ts`: adapter that turns tracking warnings and contract diagnostics into the normal analysis diagnostics flow
- `value-liveness.ts`: exactness-gated local value-fate stage implementation
- `value-liveness-context.ts`: explicit stage and source-file context builders for value-liveness-owned mutable bookkeeping
- `object-paths.ts`: object-path stage orchestrator
- `object-paths/`: stage-private helpers for object-path effects, projections, traversal, policy, and reporting
- `object-paths/context.ts`: explicit stage and source-file context builders for object-path-owned mutable bookkeeping
- `object-paths/policy.ts`: bounded source-shaped recovery helpers consumed by generic object-path traversal
- `model.ts`, `syntax.ts`, `bindings.ts`: shared tracking vocabulary, structural helpers, and binding identity rules
- `state.ts`, `access.ts`, `callables.ts`, `graph.ts`, `semantics.ts`: shared mutation, resolution, callable, graph, and helper-summary primitives

`graph.ts` owns tracked-object seeding and snapshot construction, while `convergence.ts` owns pass-budget enforcement and churn signaling. Stage modules should consume those facts through readonly snapshot surfaces, keep source-file-local mutation inside their stage contexts, and route source-shaped bounded recovery through dedicated policy helpers instead of embedding those heuristics in generic traversal. The object-path stage currently seeds its writable binding and tracked-object registries from the snapshot so call-site specialization stays stage-local instead of reusing kernel-owned maps as the contract. Tracking warnings and contract violations should surface through `tracking/diagnostics.ts`, while richer runtime summaries stay available through the run-scoped tracking artifacts for focused validation.

Start in the owning module here when a change affects:

- tracked-object identity or structure
- helper return or parameter summaries, including member-style and namespace-style same-project call resolution
- exact path propagation or projection traversal
- collection boundaries, invalidation, retained binding, object-backed retained storage, and mutation semantics
- awaited structured returns or bounded queue and worklist consume rules inside the exact subset
- the line between exact reasoning and conservative skips
- object-path stage traversal or reporting behavior

If a change widens the supported exact subset, add or update fixture coverage first and document the new boundary.

The tracking layer remains the shared fact source. The capability layer above it owns provider-facing summary models and provenance; do not duplicate that attribution logic back into generic tracking helpers.

### `src/engine/internal-types.ts`

Owns engine-only shared types.

Keep internal project, graph, suppression, and tracked-object types here when they are used across engine modules. Public package types belong in `src/api/public-types.ts` instead.

### `src/output/`

Owns report rendering.

- `render-result.ts`: stable JSON output and grouped text output

Formatting changes belong here, not in CLI or analyzer modules.

### `src/shared/`

Owns general helpers that are not stage-specific.

- `entity-utils.ts`: entity construction and entity-kind to finding-kind mapping
- `path-utils.ts`: relative-path and path-segment helpers
- `general-utils.ts`: generic helper functions with no AST or reporting responsibility

Keep this folder focused. If a helper only serves one analyzer or one compiler-facing concern, prefer the owning module instead.

## Dependency Rules

The intended direction is:

1. public entrypoints depend on `api` or `cli`
2. `api` and `cli` depend on `engine`, `config`, and `output`
3. analyzer stages depend on `compiler`, `shared`, `references`, `suppressions`, and `engine/internal-types`
4. exactness-sensitive analyzer wrappers depend on `engine/tracking/core.ts`, while tracking stage implementations depend on focused helpers under `engine/tracking/`
5. `output` depends on public result types only

Avoid the reverse direction. In particular:

- `output` should not import analyzer internals
- analyzer modules should not import CLI helpers
- `run-analysis.ts` should coordinate stages, not re-implement them

## Maintenance Checklist

When adding a new analyzer capability:

1. decide whether it is a low-coupling stage, a shared tracking-helper change, or a stage-private tracking change
2. add or update focused fixtures and assertions in `test/analyze.test.ts`
3. implement the owning module change
4. register the stage in `src/engine/run-analysis.ts` if needed
5. update docs when the supported exact subset or conservative boundary changes

When changing public behavior:

1. update `src/api/public-types.ts` or the documented API wrapper
2. update `README.md` and the relevant docs under `docs/`
3. rerun the full repo validation flow

## Validation

The standard repo-wide validation flow for architecture-sensitive changes is:

```bash
npm run prep
```

For narrow stage work, start with a focused Vitest name filter and the self-host check before widening out to the full flow.