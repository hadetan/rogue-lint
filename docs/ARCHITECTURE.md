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
- creating shared per-run caches and mutable state
- executing analyzer stages in order
- assembling the final `AnalysisResult`

Do not move stage-specific semantics back into this file.

### `src/engine/analyzers/`

Owns stage entrypoints.

- low-coupling stages such as `unused-files`, `unused-exports`, `unused-locals`, `class-members`, and `interface-members` live directly here
- `support.ts` holds shared export/reference helpers used across those stages
- `value-liveness.ts` and `object-paths.ts` stay thin and delegate to the shared tracking kernel

Add a new module here when a concern can be executed as one stage in the orchestration pipeline.

### `src/engine/tracking/`

Owns the heavy shared tracking kernel used by the exactness-sensitive stages.

- `core.ts`: tracked-object construction, helper-summary propagation, value-fate rules, object-path reasoning, and conservative-boundary handling

This is the place to update when a change affects:

- tracked-object identity or structure
- helper return or parameter summaries
- exact path propagation
- collection boundaries, invalidation, and mutation semantics
- the line between exact reasoning and conservative skips

If a change widens the supported exact subset, add or update fixture coverage first and document the new boundary.

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
4. heavy stages may additionally depend on `engine/tracking/core.ts`
5. `output` depends on public result types only

Avoid the reverse direction. In particular:

- `output` should not import analyzer internals
- analyzer modules should not import CLI helpers
- `run-analysis.ts` should coordinate stages, not re-implement them

## Maintenance Checklist

When adding a new analyzer capability:

1. decide whether it is a low-coupling stage or a tracking-kernel change
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