# dead-lint

> Whole-project dead code and conservative static safety analysis for JavaScript and TypeScript.

`dead-lint` starts from entrypoints, builds the same-project module graph, and reports code it can actually justify removing. It also surfaces a narrow set of compiler-backed and exactness-backed safety issues such as `use-before-init`, `invalidated-read`, and `stale-read-after-mutation`. When the current model stops being exact, it does not guess. It records a boundary.

```text
→ whole-project, not file-local
→ exact when provable
→ conservative when dynamic code breaks exactness
→ truthful to JavaScript semantics
→ useful for engineers and coding agents
```

[Quick Start](#quick-start) • [See It In Action](#see-it-in-action) • [Docs](#docs) • [Development](#development)

## Why dead-lint

Most dead-code tools fail in one of two ways:

- they stay shallow and only see file-local syntax
- they overreach in dynamic JavaScript and turn uncertainty into false positives

`dead-lint` is built to avoid both.

Use it when you want:

- whole-project reachability instead of isolated lint warnings
- export and type-surface analysis that understands application mode versus library mode
- exact object and array path cleanup in the supported subset
- explicit `findings`, `kept`, and `skipped` buckets so trust is inspectable
- output that humans can read and agents can automate against

## Quick Start

Requires Node.js 20 or newer.

Install in a project:

```bash
npm install -D dead-lint
```

Run it:

```bash
npx dead-lint .
npx dead-lint . --json
npx dead-lint . --mode library
npx dead-lint . --kinds unused-export,unused-file,use-before-init
npx dead-lint . --config dead-lint.config.json
```

If you prefer a global install:

```bash
npm install -g dead-lint
dead-lint .
```

Default exit codes:

- `0`: no findings
- `1`: findings were produced
- `2`: execution failed

Both non-zero exit codes are configurable.

## See It In Action

A fixture-backed text report looks like this:

```text
dead-lint

Mode: application
Files analyzed: 4
Reachable files: 3
Findings: 9
Kept: 1
Skipped: 2

Findings:
unused-export
  src/lib.ts
    unused-export                src/lib.ts:2:14 unusedExport - exported declaration has no non-declaration references outside its declaring file
unused-file
  src/unused.ts
    unused-file                  src/unused.ts:1:1 unused.ts - file is unreachable from configured entrypoints

Kept:
local
  src/index.ts
    local                        src/index.ts:9:7 ignoredLocal - suppressed by dead-lint-ignore-next

Skipped:
object-key
  src/index.ts
    object-key                   src/index.ts:24:3 maybe - computed property access prevents exact path analysis
```

That structure is the trust model in practice:

- `findings`: stale code or suspicious flows the analyzer can justify
- `kept`: otherwise-dead entities intentionally preserved by public-surface rules, suppressions, or keep rules
- `skipped`: explicit conservative boundaries where exact reasoning stopped

## What It Can Catch

`dead-lint` currently covers:

- whole-project reachability and API surface: `unused-file`, `unused-export`, `unused-type`, `unused-enum-member`
- local declarations and members: `unused-local`, `unused-class-member`, `unused-interface-member`
- exact structural cleanup: `unused-array-element`, `unused-object-key`, `unused-nested-path`
- value-flow and safety signals: `dead-store`, `unused-value`, `write-only-state`, `use-before-init`, `invalidated-read`, `stale-read-after-mutation`
- same-project helper, callback, and structured-return propagation in the supported exact subset
- retained bindings through supported `Map.set` and `Map.get`, module bindings, and static `globalThis` flows
- JS-truthful value-fate modeling for supported `push`, `unshift`, `slice`, `concat`, and `structuredClone` paths, plus explicit boundaries when those flows stop being exact

For the detailed coverage map and fixture-backed examples, see [CAPABILITIES.md](CAPABILITIES.md).

## How It Works

1. Load the project through TypeScript and the current `tsconfig` or `jsconfig` when present.
2. Build the same-project module graph.
3. Discover roots from configured entrypoints, package metadata, or conventional defaults.
4. Compute reachable files.
5. Layer exactness-gated object, array, helper, return, and value-flow analysis on top of semantic data.
6. Emit `findings`, `kept`, `skipped`, and `diagnostics`.

In `application` mode, entrypoints define runtime roots. In `library` mode, the analyzer preserves the public package surface inferred from configured entrypoints or from `package.json` `main` and `exports`, while still treating `bin` entrypoints as reachable roots.

## Docs

- [CAPABILITIES.md](CAPABILITIES.md): tested coverage map, examples, and conservative boundaries
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): modes, entrypoint discovery, filters, keep rules, suppressions, and config precedence
- [docs/OUTPUT.md](docs/OUTPUT.md): text and JSON reports, `findings` versus `kept` versus `skipped`, `collection-boundary`, and skip-category reference
- [CONTRIBUTING.md](CONTRIBUTING.md): repo workflow, fixture-first changes, and validation expectations

## Development

For local development in this repository:

```bash
npm install
npm run lint
npm run build
npm test
```

Helpful repo-local commands:

```bash
npm run self
npm run self:json
npm run check
npm run pack:check
npm run prep
```

`npm run self` and `npm run self:json` build the package and run `dead-lint` against this repository in `library` mode.

## Release Checks

Before publishing:

```bash
npm run prep
```

That gate runs the build, lint, tests, self-analysis, and dry-run pack checks that currently define the package release flow.

## License

ISC
