# dead-lint

<!--__Rust-inspired safety analysis for JS/TS__-->

Whole-project dead code and Rust-inspired static safety analysis for JavaScript and TypeScript with agent-friendly output.

`dead-lint` scans an entire project, not just one file, and reports stale code in a compact format that agents can use as a validation step after implementation work.

## Current coverage

The current implementation covers:

- unreachable files
- unused exports, including exports whose only references stay inside their declaring file
- unused exported types, including exported types whose only references stay inside their declaring file
- unused enum members
- unused locals reported by TypeScript semantic analysis
- compiler-backed `use-before-init` findings for allow-listed TypeScript safety diagnostics
- dead stores for overwritten local assignments in the supported value-flow subset
- unused side-effect-neutral expression results, including purity-gated discarded analyzable same-project function returns
- write-only outer-scope writes in the supported closure subset
- `invalidated-read` and `stale-read-after-mutation` findings for supported exact tracked-path mutations
- meaningful call-boundary reads for ordinary external calls and supported local helper usage
- exact same-project helper lifecycle analysis for supported array reads, append mutations, and returned aliases
- exact callback index-correlation for supported local array callback patterns such as `items.every((item, index) => items[index]...)`
- analyzable same-project function return summaries for scalar values, structured literals, and returned aliases
- analyzable returned object/array propagation across supported same-project helper and import/export boundaries, including direct returned literals
- exact same-project import/export propagation for imported array/object aliases, property reads, and imported array destructuring
- retained-binding preservation through supported `Map.set`/`Map.get` container handoffs in the exact local subset
- allowlisted whole-value observational calls such as `console.log` for exact arrays/objects, including inserted-by-reference alias observation
- unused array elements for exact local literal array slots
- root-owned collection boundary reporting when tracked arrays leave the exact subset
- supported retained-binding propagation through statically analyzable same-project module bindings and static `globalThis` properties
- unused class members with exact declaration/reference tracking
- unused internal interface members when references remain unambiguous
- unused object keys and nested object paths inside analyzable local object/array graphs
- structural bookkeeping heuristics for discriminated records, helper summaries, path/token-style objects, and state-holder records so trusted findings stay focused on provably unread metadata
- alias-aware nested path tracking with bounded local helper forwarding
- JS-truthful value-fate summaries for supported exact `push(...array)`, `push(value)`, guarded `unshift`, `concat`, `slice`, array/object spread, `Object.assign`, and `structuredClone` paths
- write-only accumulation findings for exact supported receiver paths and allow-listed ignored-result findings for supported clone-style APIs
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

For repo-local analyzer runs, `npm run self` and `npm run self:json` build the package and run the local CLI against this repository.

## CLI usage

```bash
dead-lint
dead-lint path/to/project
dead-lint path/to/project --json
dead-lint path/to/project --mode library
dead-lint path/to/project --kinds unused-export,unused-file,use-before-init
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

The human-readable report also separates `findings`, `kept`, and `skipped`, and now prints finding reasons inline too, so exact value-fate and abstention decisions stay visible outside JSON mode.

## Rust-inspired safety contract

`dead-lint` brings a conservative subset of Rust-like compile-time assistance to JS/TS projects. It can now promote selected compiler-backed safety diagnostics, report exact invalidated reads in supported local object or collection flows, and describe common JS collection/object operations with JS-truthful semantics instead of fake ownership language.

That contract is intentionally narrow:

- supported exact flows produce first-class safety findings such as `use-before-init`, `invalidated-read`, and `stale-read-after-mutation`
- supported same-project imports and supported collection/object operations can preserve exact partial usage, reference insertion, shallow clone, deep clone, and write-only accumulation conclusions
- allowlisted whole-value observation can count inserted-by-reference aliases as meaningful use without pretending JS transferred ownership
- unsupported aliasing, reflective access, and opaque escapes remain `skipped`
- the tool is Rust-inspired, not a replacement for `rustc` ownership, borrow checking, or full memory-safety guarantees

## Safe subset and dynamic boundaries

`dead-lint` is most exact when code stays inside analyzable patterns such as:

- explicit entrypoints
- explicit hidden roots for convention-driven files
- static imports/exports
- same-project imported aliases that resolve back to exact tracked object/array literals
- direct property access
- local object and array literals
- literal array indices and literal `.at(...)` access
- positional array destructuring without opaque rest reconstruction
- bounded local helper forwarding of tracked object paths
- supported same-project helper reads and exact append-style mutations over tracked local arrays
- supported callback index correlation when the callback receiver and index stay inside the exact local array subset
- supported same-project helper or imported function returns that resolve back to analyzable scalar results or tracked local object/array bindings
- supported `Map.set`/`Map.get` retained-binding handoffs for statically known local container slots
- supported same-project retained-binding propagation through static local/module bindings and static `globalThis` properties
- supported `for...of` and supported inline array callback consumers over local analyzable arrays
- supported exact receiver observation after `push`/`unshift` reference insertion, exact spread append, and scalar append growth
- allowlisted whole-value observational calls such as `console.log(receiver)` over exact arrays/objects
- same-project helper calls over exact local arrays emit one callsite-owned boundary with helper-cause context when the helper stores or forwards the collection beyond exact local analysis
- supported `concat`, `slice`, array/object spread, `Object.assign`, and `structuredClone` summaries with JS-truthful clone/escape wording
- simple overwritten local assignments and discarded pure expressions, plus purity-gated discarded analyzable same-project call results
- allow-listed ignored-result reporting for supported clone-style APIs such as `slice`, `concat`, and `structuredClone`
- allow-listed compiler diagnostics such as TypeScript's "used before being assigned"
- ordinary call-argument consumption at external or built-in call boundaries
- supported same-project helper calls whose parameter usage remains analyzable
- no reflective enumeration on analyzed objects

The analyzer intentionally skips or downgrades exact analysis when code crosses dynamic boundaries such as:

- unknown computed property access
- dynamic array indices and non-literal `.at(...)` access
- `Object.keys`, `Object.values`, `Object.entries`, `Reflect.ownKeys`
- `JSON.stringify`
- opaque external calls that receive a tracked object
- unsupported nested aliasing after collection/object transforms, unsupported array rest reconstruction, and collection mutations that replace, reorder, rebuild, or otherwise escape exact reasoning
- object/path escapes through opaque call boundaries
- decorators that can expose class members indirectly

Skipped entities are reported with boundary-specific reasons so the gaps remain visible. When a tracked array becomes non-exact, `dead-lint` reports that boundary on the owning collection path instead of on a stale child slot. Structural/internal record shapes also bias toward conservative abstention instead of speculative dead-path findings, while still leaving provably unread metadata fields reportable. Recent boundary messaging also distinguishes ordinary analyzer frontier limits, such as unsupported callback/container correlation, from inherently dynamic code.

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
npm run self
npm run check
```

### Self-validation

Run the package against its own repository:

```bash
npm run self
npm run self:json
```

Self-validation runs in `library` mode and always includes the full analysis tiers. Repository self-validation now runs cleanly with zero findings and zero skips while still exercising the same supported helper-lifecycle, retained-binding, return-observability, and invalidated-read paths described above. Remaining intentionally conservative boundary shapes, such as queue/worklist mutations or opaque iterable spread append, are covered by focused regression fixtures rather than by the repository's own source.

## Release checks

Run these before publishing:

```bash
npm run prep
```

The full lint, test, self-validation, and packability gate runs through `prep`.

That sequence verifies:

1. TypeScript build succeeds
2. tests pass
3. self-validation succeeds on the package's own source
4. `npm pack --dry-run` succeeds and the package contents are publishable
