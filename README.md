# dead-lint

Whole-project dead code analysis for JavaScript and TypeScript with agent-friendly output.

`dead-lint` scans an entire project, not just one file, and reports stale code in a compact format that agents can use as a validation step after implementation work.

## Current coverage

The current implementation covers:

- unreachable files
- unused exports, including exports whose only references stay inside their declaring file
- unused exported types, including exported types whose only references stay inside their declaring file
- unused enum members
- unused locals reported by TypeScript semantic analysis
- dead stores for overwritten local assignments in the supported value-flow subset
- unused side-effect-neutral expression results
- write-only outer-scope writes in the supported closure subset
- meaningful call-boundary reads for ordinary external calls and supported local helper usage
- analyzable returned-object propagation across supported same-project helper boundaries
- unused array elements for exact local literal array slots
- unused class members with exact declaration/reference tracking
- unused internal interface members when references remain unambiguous
- unused object keys and nested object paths inside analyzable local object/array graphs
- alias-aware nested path tracking with bounded local helper forwarding
- source/build entrypoint reconciliation for package self-analysis
- hidden roots, include/exclude file filters, grouped text output, and configurable exit codes
- inline suppressions, keep rules, and external visibility declarations

## Install

```bash
npm install dead-lint
```

For local development in this repository:

```bash
npm install
npm run lint
npm run build
```

The repository uses ESLint for code-quality checks. Main package source under `src/` is linted with stricter rules, including `no-console`, while CLI, tests, and fixtures are scoped more permissively where console output is intentional.

## CLI usage

```bash
dead-lint
dead-lint path/to/project
dead-lint path/to/project --json
dead-lint path/to/project --mode library
dead-lint path/to/project --kinds unused-export,unused-file
dead-lint path/to/project --depth surface
dead-lint path/to/project --config dead-lint.config.json
```

### Exit codes

- `0`: no findings
- `1`: findings were produced by default
- `2`: execution failed by default

Both non-zero exit codes are configurable.

## Configuration

Create `dead-lint.config.json` in the target project:

```json
{
  "mode": "application",
  "analysisDepth": "deep",
  "entrypoints": ["src/index.ts"],
  "hiddenRoots": ["src/worker.ts"],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.generated.ts"],
  "includeKinds": ["unused-file", "unused-export"],
  "findingsExitCode": 1,
  "failureExitCode": 2,
  "keep": {
    "files": ["src/generated/**"],
    "symbols": ["futureApi"],
    "members": ["Example.preservedMethod"],
    "entityIds": []
  },
  "objectAnalysis": {
    "enabled": true,
    "maxPathDepth": 5
  }
}
```

### Modes

- `application`: use configured entrypoints as roots and treat the project as a closed world unless code escapes explicitly
- `library`: preserve otherwise-unused declarations that belong to the public package surface or are explicitly marked externally visible

In `library` mode, configured `entrypoints` define the public surface directly. When entrypoints are inferred from `package.json`, importable package roots such as `exports` and `main` define the public surface, while `bin` entrypoints are still treated as reachable roots without making their named exports part of the library API.

### Analysis depth

- `deep`: run declaration analysis plus value-liveness, member, interface-member, and nested-path tiers
- `surface`: keep the run focused on surface-level entities such as files, exports, types, locals, and enum members

## Suppressions and external visibility

Inline directives:

```ts
// dead-lint-ignore-next
const ignoredLocal = 1;

// dead-lint-externally-visible
export const publicFutureApi = 1;

// dead-lint-ignore-next
export function localHelperExposedForNow() {
  return 1;
}

/* dead-lint-ignore-start */
const ignoredA = 1;
const ignoredB = 2;
/* dead-lint-ignore-end */
```

JSDoc external visibility:

```ts
/** @externallyVisible */
export const futureApi = 1;
```

## Agent-oriented JSON output

```bash
dead-lint path/to/project --json
```

The JSON report includes:

- run metadata
- configured exit codes
- summary counts
- findings
- kept entities
- skipped entities
- diagnostics

`kept` contains entities that would otherwise be reported, but were preserved by public-surface rules, ignore comments, or explicit keep/external-visibility directives. Already-used code is omitted from `kept`.

For exports and exported types, only references from other files count as real export usage. If an exported declaration is used only inside its own file, `dead-lint` reports it as unused export surface unless a keep, ignore, or external-visibility rule applies.

This lets an agent distinguish removable code from code that was intentionally preserved or skipped because it escaped exact analysis.

The human-readable report also separates `findings`, `kept`, and `skipped`, and prints the keep/skip reasons inline so the withheld boundaries stay visible outside JSON mode.

## Safe subset and dynamic boundaries

`dead-lint` is most exact when code stays inside analyzable patterns such as:

- explicit entrypoints
- explicit hidden roots for convention-driven files
- static imports/exports
- direct property access
- local object and array literals
- literal array indices and literal `.at(...)` access
- positional array destructuring without opaque rest reconstruction
- bounded local helper forwarding of tracked object paths
- supported same-project helper returns that resolve back to tracked local object bindings
- supported `for...of` and supported inline array callback consumers over local analyzable arrays
- simple overwritten local assignments and discarded pure expressions
- ordinary call-argument consumption at external or built-in call boundaries
- supported same-project helper calls whose parameter usage remains analyzable
- no reflective enumeration on analyzed objects

The analyzer intentionally skips or downgrades exact analysis when code crosses dynamic boundaries such as:

- unknown computed property access
- dynamic array indices and non-literal `.at(...)` access
- `Object.keys`, `Object.values`, `Object.entries`, `Reflect.ownKeys`
- `JSON.stringify`
- opaque external calls that receive a tracked object
- array spreads, unsupported array rest reconstruction, and unsupported mutation-heavy array transforms
- object/path escapes through opaque call boundaries
- decorators that can expose class members indirectly

Skipped entities are reported with boundary-specific reasons so the gaps remain visible.

## End-to-end workflow for agents

Typical agent flow:

```bash
npm run build
dead-lint . --json > dead-lint-report.json
```

An agent can then:

1. inspect `findings`
2. ignore `kept`, which represents intentionally preserved otherwise-unused entities
3. avoid auto-removing `skipped`
4. fail or continue based on the CLI exit code

## Development

```bash
npm run lint
npm run build
npm test
npm run self:validate
npm run check
```

### Self-validation

Run the package against its own repository:

```bash
npm run self:validate
npm run self:validate:json
npm run self:validate:deep
npm run self:validate:deep:json
```

The default self-validation commands run in `library` mode with `--depth surface`, which is the most practical package-level validation for this repository.

Use the `:deep` variants when you want the full deeper analysis tiers as well. Deep self-validation now runs cleanly on this repository without the earlier builtin-resolution noise, broad false-positive finding sets, or helper-boundary skip noise. Deep mode also includes the supported exact array analysis paths described above, while still reporting skips when array usage becomes dynamic or mutation-heavy.

## Release checks

Run these before publishing:

```bash
npm run release:check
```

That sequence verifies:

1. TypeScript build succeeds
2. tests pass
3. deep self-validation succeeds on the package's own source
4. `npm pack --dry-run` succeeds and the package contents are publishable
