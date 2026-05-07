# rogue-lint configuration

This guide explains how `rogue-lint` resolves roots, applies filters, and honors preservation rules, based on `src/config.ts`, `src/project.ts`, and `src/module-graph.ts`.

## Quick Reference

Config can come from:

- `--config path/to/file.json`
- `rogue-lint.config.json` at the project root
- `package.json` under `rogueLint`
- built-in defaults

CLI field overrides currently include:

- `--mode`
- `--kinds`

## Config Source Resolution

`rogue-lint` resolves configuration in two stages.

### 1. Choose the config source

The analyzer looks in this order:

1. the path passed with `--config`
2. `rogue-lint.config.json` in the target root
3. `package.json` `rogueLint`
4. built-in defaults

Important nuance:

- `--config` changes where config is loaded from
- it does not merge multiple config files together

### 2. Apply CLI field overrides

After loading the chosen config source, the CLI currently overrides:

- `mode`
- `includeKinds` via `--kinds`

## Built-In Defaults

Current defaults:

```json
{
  "mode": "application",
  "tsconfig": "",
  "entrypoints": [],
  "hiddenRoots": [],
  "include": [],
  "exclude": [],
  "includeKinds": [],
  "findingsExitCode": 1,
  "failureExitCode": 2,
  "keep": {
    "files": [],
    "symbols": [],
    "members": [],
    "entityIds": []
  },
  "objectAnalysis": {
    "enabled": true,
    "maxPathDepth": 5
  }
}
```

## Example Config File

`rogue-lint.config.json`:

```json
{
  "mode": "application",
  "tsconfig": "tsconfig.json",
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

The same config inside `package.json`:

```json
{
  "rogueLint": {
    "mode": "library",
    "entrypoints": ["src/index.ts"]
  }
}
```

## Modes

### `application`

Use this when your configured or inferred entrypoints define the live runtime roots of the project.

Behavior:

- reachable files stay live
- exports still need cross-file justification
- otherwise-unused public exports are not preserved just because they are exported

### `library`

Use this when the project should preserve its public import surface.

Behavior:

- configured entrypoints define the public surface directly
- when entrypoints are inferred, `package.json` `main` and `exports` define public surface roots
- `bin` entries stay reachable but do not automatically make their named exports public API

That last rule matters for CLI packages: a reachable CLI file does not automatically mean every helper it exports is part of the library surface.

## Entrypoint Discovery

If `entrypoints` is configured, those roots are used directly.

If `entrypoints` is empty, `rogue-lint` tries, in order:

1. `package.json` `main`
2. `package.json` `bin`
3. `package.json` `exports`
4. conventional defaults: `src/index.ts`, `src/main.ts`, `index.ts`, `index.js`
5. the first loaded source file

Important nuance from the implementation:

- `exports` are walked recursively, so nested conditional-export entries can resolve to public surface roots
- built paths such as `dist/index.js`, `build/index.js`, `lib/index.js`, or `out/index.js` are reconciled back to likely source paths when possible
- `hiddenRoots` are added on top of discovered entrypoints; they do not replace them

## `hiddenRoots`

Use `hiddenRoots` for files that are live at runtime but not visible through the static module graph.

Typical use cases:

- worker entry files
- convention-loaded scripts
- framework entrypoints discovered by filename rather than imports

If a `hiddenRoots` pattern matches nothing, `rogue-lint` emits a project warning.

## Project Loading And `tsconfig`

`rogue-lint` tries to load the project like this:

1. configured `tsconfig`
2. root `tsconfig.json`
3. root `jsconfig.json`
4. fallback source-file walk when none of the above exist

When no TS or JS config file exists, the fallback walk:

- scans `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs`
- skips `node_modules`, `.git`, `dist`, and `openspec`
- enables a strict TypeScript program with `allowJs`, `checkJs`, `noUnusedLocals`, and `noUnusedParameters`

## `include` And `exclude`

These filters are applied against analyzable source files relative to the target root.

- `include`: if non-empty, only matching files are analyzed
- `exclude`: matching files are removed from analysis

They use glob-style matching.

## `includeKinds`

Use `includeKinds` when you want to restrict the reported findings to a subset.

Example:

```json
{
  "includeKinds": ["unused-file", "unused-export"]
}
```

CLI override:

```bash
npx rogue-lint . --kinds unused-file,unused-export
```

`--kinds` overrides the loaded config value.

## `keep` Rules

Keep rules move otherwise-dead entities into the `kept` bucket with an explicit reason.

Supported rule groups:

- `keep.files`
- `keep.symbols`
- `keep.members`
- `keep.entityIds`

Current matching behavior:

- `entityIds` matches the analyzer's stable entity id directly
- `symbols` and `members` are checked against the plain entity name, the owner-qualified name when present, and the internal entity id
- `files` matches the entity's relative file path

Current precedence in the suppression pipeline:

1. inline ignore-next
2. inline ignore-start/end
3. inline external visibility
4. `@externallyVisible`
5. `keep.entityIds`
6. `keep.symbols` and `keep.members`
7. `keep.files`

## Inline Suppressions And External Visibility

Supported directives:

```ts
// rogue-lint-ignore-next
const ignoredLocal = 1;

/* rogue-lint-ignore-start */
const ignoredA = 1;
const ignoredB = 2;
/* rogue-lint-ignore-end */

// rogue-lint-externally-visible
export const futureApi = 1;

/** @externallyVisible */
export const futureType = 1;
```

Current meanings:

- `rogue-lint-ignore-next`: suppress the next line
- `rogue-lint-ignore-start` and `rogue-lint-ignore-end`: suppress an inclusive line range
- `rogue-lint-externally-visible`: mark the next line as intentionally preserved public surface
- `@externallyVisible`: JSDoc form of intentional external visibility

These entities do not disappear silently. They show up in `kept` with an explicit reason.

## `objectAnalysis`

Current fields:

- `enabled`
- `maxPathDepth`

`enabled` toggles exact object and array path tracking.

`maxPathDepth` limits how far nested path materialization goes for tracked object and array structures. The default is `5`.

## Exit Codes

Current defaults:

- `findingsExitCode`: `1`
- `failureExitCode`: `2`

Example:

```json
{
  "findingsExitCode": 7,
  "failureExitCode": 9
}
```

The CLI tests explicitly cover custom findings and failure exit codes.

## CLI Options

Current CLI surface:

```bash
rogue-lint [targetPath]
rogue-lint [targetPath] --json
rogue-lint [targetPath] --mode application|library
rogue-lint [targetPath] --config path/to/config.json
rogue-lint [targetPath] --kinds unused-file,unused-export
```

For how these settings affect the output buckets and JSON shape, see [docs/OUTPUT.md](OUTPUT.md).
