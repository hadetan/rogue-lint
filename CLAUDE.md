# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps (Node 20+ required)
npm run build        # clean + tsc
npm run lint         # ESLint, zero warnings allowed
npm run lint:fix     # auto-fix lint issues
npm test             # vitest run
npm run check        # lint + build + test (standard gate)
npm run self         # run rogue-lint on itself (library mode)
npm run prep         # full release gate: check + self + pack validation
```

Single test by name:
```bash
npx vitest run -t "your test name"
```

## Architecture

**rogue-lint** is a whole-project static analyzer for TypeScript/JavaScript that tracks dead code via proven reachability — starting from configured entrypoints, following usage across files, structures, returns, and callbacks, then reporting what was never reached.

### Analysis pipeline (`src/engine/run-analysis.ts` orchestrates):

1. **Project loading** (`src/project.ts`) — tsconfig resolution, source selection
2. **Module graph** (`src/module-graph.ts`) — import/export graph, entrypoint discovery
3. **Six analysis stages** (`src/engine/analyzers/`):
   - `analyzeUnusedFiles` — file-level reachability
   - `analyzeCompilerSafetyDiagnostics` — TypeScript diagnostics
   - `analyzeSymbolLiveness` — import/export/local/member liveness
   - Tracking graph build
   - `analyzeValueLiveness` — local value-flow
   - `analyzeObjectPaths` — exact structural path tracking
4. **Capability providers** (`src/engine/capabilities/`) — map evidence to finding categories
5. **Output rendering** (`src/output/render-result.ts`) — text and JSON reports

### Key module boundaries

| Path | Responsibility |
|------|---------------|
| `src/index.ts` | Stable public API re-exports — keep thin |
| `src/cli.ts` | Executable entrypoint — keep thin |
| `src/api/analyze-project.ts` | Public API wrapper |
| `src/engine/run-analysis.ts` | Orchestration only |
| `src/engine/tracking/` | Exactness-sensitive value/object-path subsystem |
| `src/engine/tracking/object-paths/` | Structural path tracking (current hotspot) |
| `src/engine/internal-types.ts` | Engine-only shared types |
| `src/config.ts` | Config from `rogue-lint.config.json` or `package.json#rogueLint` |
| `src/suppressions.ts` | Keep rules and inline ignore directives |

Dependency direction: `public entrypoints → api/cli → engine → analyzers → tracking → focused helpers`. Never import upward.

### Two operating modes

- **Application mode**: entrypoints are runtime roots; unreached exports are dead
- **Library mode**: public API surface is preserved; internal-only symbols are candidates

### Test structure

`test/analyze.test.ts` + `test/fixtures/` are the authoritative map of supported behavior. Each fixture is a minimal TypeScript project under `test/fixtures/<behavior-name>/` with its own `tsconfig.json` and `rogue-lint.config.json`, isolating one behavior or boundary.

Other test files: `test/analyze-self-host.test.ts` (zero findings/skips/diagnostics baseline), `test/tracking-contract.test.ts`, `test/capability-providers.test.ts`.

## Development workflow for new behavior

1. Write or update the test case in `test/analyze.test.ts` first
2. Add or update the fixture under `test/fixtures/`
3. Implement the smallest change in the owning module
4. Run narrowly: `npx vitest run -t "your test name"`
5. Run broadly: `npm run check`
6. If changing whole-project semantics or public surface: `npm run self`

## Contribution principles

- **Conservative correctness over aggressive coverage** — if a pattern isn't modeled well enough to stay exact, emit a `skipped` boundary with a clear reason rather than a speculative finding
- **Owner-based modules** — put shared helpers in the domain that owns the behavior, not generic `util`/`helpers` buckets
- **Hotspots requiring focused tests**: reachability/entrypoint discovery, library vs application mode, export liveness, exact object/array path tracking, helper summaries, `kept` vs `skipped` classification, JSON output shape, exit-code behavior
- **Current refactor hotspots** (mixed ownership, split carefully): `src/engine/tracking/object-paths/visitor.ts`, `src/engine/tracking/access.ts`, `src/engine/tracking/graph.ts`

## Docs to update when changing behavior

| What changed | Update |
|---|---|
| User-facing positioning or workflow | `README.md` |
| Supported coverage or boundaries | `CAPABILITIES.md` |
| Config, modes, entrypoint discovery, suppressions | `docs/CONFIGURATION.md` |
| Report buckets, JSON shape, entity kinds, skip categories | `docs/OUTPUT.md` |
| Module ownership or invariants | `docs/ARCHITECTURE.md` |
