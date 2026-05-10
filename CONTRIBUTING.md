# Contributing to rogue-lint

`rogue-lint` is a trust-sensitive analyzer. The standard for new work is not just "does it run" but "does it stay conservative enough to deserve its findings."

If you are contributing code or docs, keep one rule in mind:

- stay true to the codebase and the tests; do not document or claim behavior that is not implemented and verified

## Local setup

Requirements:

- Node.js 20 or newer
- npm

Install dependencies:

```bash
npm install
```

Common commands:

```bash
npm run build
npm run lint
npm test
npm run self
npm run self:json
npm run check
npm run pack:check
npm run prep
```

For a narrow test slice, use Vitest's test-name filter:

```bash
npx vitest run -t "supports exact and conservative array analysis"
```

## Project layout

Important files and directories:

- `src/index.ts`: thin package root that re-exports the documented public API surface
- `src/cli.ts`: executable entrypoint that hands off to the internal CLI runner
- `src/api/`: package-facing analysis wrapper and public types
- `src/cli/`: CLI option parsing and shell-oriented execution flow
- `src/engine/run-analysis.ts`: orchestration for project loading, reachability, stage execution, and result assembly
- `src/engine/analyzers/`: stage entrypoints and shared low-coupling analyzer helpers
- `src/engine/tracking/core.ts`: shared tracked-object kernel for value-liveness and object-path analysis
- `src/engine/internal-types.ts`: engine-only shared types
- `src/module-graph.ts`: import and export graph construction and entrypoint discovery helpers
- `src/project.ts`: project loading, tsconfig resolution, and source selection
- `src/config.ts`: config resolution from `rogue-lint.config.json` or the `rogueLint` field in `package.json`
- `src/output/render-result.ts`: text and JSON report rendering
- `docs/ARCHITECTURE.md`: module ownership map and maintenance rules for the refactored engine
- `docs/CONFIGURATION.md`: config precedence, modes, entrypoint discovery, and suppressions
- `docs/OUTPUT.md`: report buckets, JSON shape, and skip-category reference
- `test/analyze.test.ts`: behavior-level regression tests
- `test/fixtures/`: fixture projects that define expected analyzer behavior

In practice, `test/analyze.test.ts` and `test/fixtures/` are the best map of what the tool actually supports today.

## Contribution principles

### Prefer conservative correctness over aggressive coverage

False positives damage trust faster than missing one more edge case.

If a pattern is not modeled well enough to stay exact, prefer:

- a clear `skipped` boundary with a useful reason

over:

- a speculative finding that happens to look correct in one fixture

### Keep JavaScript semantics truthful

The analyzer can be Rust-inspired without inventing Rust semantics for JS. Avoid wording or implementation shortcuts that imply ownership transfer, borrow checking, or guarantees the runtime does not actually provide.

### Extend narrowly before generalizing

The codebase is strongest when a new behavior starts as a tightly bounded exact path, gets regression coverage, and only then expands to adjacent patterns.

### Keep docs tied to verified behavior

If you change user-visible behavior:

- update tests first or alongside the change
- update `README.md` when the user-facing positioning or workflow changes
- update `CAPABILITIES.md` when supported coverage or boundaries change
- update `docs/CONFIGURATION.md` when config, modes, entrypoint discovery, or suppression semantics change
- update `docs/OUTPUT.md` when report buckets, JSON shape, entity kinds, or skip categories change

## Working on analyzer behavior

Recommended workflow for a new analysis rule or boundary refinement:

1. Identify the smallest fixture that demonstrates the behavior.
2. Add or update a focused case in `test/analyze.test.ts`.
3. Add or update the fixture under `test/fixtures/`.
4. Implement the smallest change needed in the owning module under `src/`.
5. Run a narrow Vitest check first.
6. Run broader validation before finishing.

That order matters. `rogue-lint` behavior is easiest to reason about when the expected outcome is locked before the implementation expands.

## Adding or changing fixtures

Fixtures are first-class documentation for this repository.

When adding a fixture:

- keep it minimal
- isolate one behavior or one interaction between behaviors
- use readable symbol names such as `live`, `dead`, `stale`, `keep`, `unusedExport`, or `futureApi`
- avoid adding unrelated language features to the same fixture
- make sure the expected result is asserted explicitly in `test/analyze.test.ts`

If a behavior needs more than one boundary to be meaningful, prefer multiple small fixtures over one large scenario.

## When to run which validation

Use the cheapest check that can falsify your change.

Narrow validation:

```bash
npx vitest run -t "your test name"
```

Standard repository validation:

```bash
npm run check
```

Self-host validation after changing whole-project semantics, reporting, or public-surface behavior:

```bash
npm run self
npm run self:json
```

The enforced self-host baseline now expects zero findings, zero skips, and zero diagnostics in library mode. If you intentionally change that contract, update the normalized baseline in `test/analyze.test.ts` alongside the implementation.

Release-style gate:

```bash
npm run prep
```

## Areas that need extra care

Changes in these areas can affect trust disproportionately and should get especially focused tests:

- reachability and entrypoint discovery
- library mode versus application mode
- export liveness rules
- exact object and array path tracking
- helper summaries and retained-binding propagation
- `kept` versus `skipped` classification
- JSON output shape and grouped text rendering
- exit-code behavior

## Documentation expectations

When documenting behavior, prefer statements like:

- "the current test suite covers"
- "the analyzer reports this in the supported exact subset"
- "this becomes a boundary"

Avoid statements like:

- "rogue-lint fully understands"
- "rogue-lint guarantees"
- "this always works"

This project benefits from precise language more than promotional language.

## Before opening a change

A good change usually includes:

- a focused fixture or fixture update
- a regression test in `test/analyze.test.ts`
- the smallest viable implementation change
- updated docs when user-visible behavior changed
- the validation command or commands you used

## Release checks

Before publishing or preparing a release, run:

```bash
npm run prep
```

That sequence runs the build, lint, tests, self-analysis, and dry-run pack checks that currently define this repository's release gate.