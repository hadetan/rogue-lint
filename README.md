# rogue-lint

> The whole-project static analyzer that tracks what is truly live, what has gone rogue, and where JavaScript turns into fog.

`rogue-lint` moves through a codebase like a careful rogue moving through a forest: it starts from entrypoints and public surface, follows only the paths it can actually prove, and keeps track of what is really consumed. It traces same-project reachability, exports, locals, object paths, array slots, returned structures, helper-carried values, callback correlation, retained bindings, discarded results, and selected safety failures. That lets it report the code and values that have gone rogue from real use. When the proof holds, it emits a real finding. When the path disappears into dynamic JavaScript, it emits an explicit conservative boundary instead of pretending it still knows the way.

```text
→ starts from entrypoints and public surface
→ follows proven usage across files, structures, returns, callbacks, and helpers
→ reports dead code, dead structure, dead values, and selected safety failures
→ preserves intentional API surface and explicit keep rules
→ marks dynamic fog with explicit skipped boundaries
→ stays truthful to JavaScript semantics
```

[Quick Start](#quick-start) • [See It In Action](#see-it-in-action) • [Docs](#docs) • [Development](#development)

## Why rogue-lint

Most code analysis tools fail in one of two ways:

- they stay shallow and only see file-local syntax
- they overreach in dynamic JavaScript and turn uncertainty into false positives

`rogue-lint` is built to avoid both.

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
npm install -D rogue-lint
```

Run it:

```bash
npx rogue-lint .
npx rogue-lint . --json
npx rogue-lint . --mode library
npx rogue-lint . --kinds unused-export,unused-file,use-before-init
npx rogue-lint . --config rogue-lint.config.json
```

If you prefer a global install:

```bash
npm install -g rogue-lint
rogue-lint .
```

Default exit codes:

- `0`: no findings
- `1`: findings were produced
- `2`: execution failed

Both non-zero exit codes are configurable.

## See It In Action

A fixture-backed text report looks like this:

```text
rogue-lint

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
    local                        src/index.ts:9:7 ignoredLocal - suppressed by rogue-lint-ignore-next

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

`rogue-lint` currently covers:

- whole-project reachability and API surface: `unused-file`, `unused-export`, `unused-type`, `unused-enum-member`
- local declarations and members: `unused-local`, `unused-class-member`, `unused-interface-member`
- exact structural cleanup: `unused-array-element`, `unused-object-key`, `unused-nested-path`
- value-flow and safety signals: `dead-store`, `unused-value`, `write-only-state`, `use-before-init`, `invalidated-read`, `stale-read-after-mutation`
- same-project namespace or member helpers, callback correlation, awaited returns, and structured-return propagation in the supported exact subset
- retained bindings through supported `Map.set` and `Map.get`, local object-backed static slots, module bindings, and static `globalThis` flows
- JS-truthful value-fate modeling for supported `push`, `unshift`, `slice`, `concat`, `structuredClone`, and bounded single-item consume paths, plus explicit boundaries when those flows stop being exact

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
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): module ownership map and maintenance rules for the refactored engine
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

`npm run self` and `npm run self:json` build the package and run `rogue-lint` against this repository in `library` mode.
The repository regression suite also keeps a normalized self-host baseline for that library-mode output, including the currently accepted conservative skip surface.

## Release Checks

Before publishing:

```bash
npm run prep
```

That gate runs the build, lint, tests, self-analysis, and dry-run pack checks that currently define the package release flow.

## License

This project is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

The public license allows noncommercial use, study, modification, and redistribution. Commercial use is not permitted without separate permission from the licensor.

In practical terms, uses that require separate permission include incorporating `rogue-lint` into paid products, internal company tooling, hosted services, or commercial AI and LLM products or capability bundles.

Because the public license restricts commercial use, this project is not open source under the OSI Open Source Definition.
