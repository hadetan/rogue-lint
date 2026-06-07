# rogue-lint

Whole-project dead code analysis for JavaScript and TypeScript with agent-friendly output.

`rogue-lint` starts from real project roots, follows usage it can actually justify, and reports what has gone dead without pretending dynamic JavaScript is more knowable than it is. When analysis stays exact, it emits a finding. When the proof breaks, it emits an explicit conservative boundary in `skipped`.

## What It Does

- Finds dead code across a project, not just inside one file
- Distinguishes actionable `findings` from intentional preservation in `kept`
- Surfaces exactness limits explicitly in `skipped`
- Supports both application-style reachability and library public-surface analysis
- Emits output that works for humans in the terminal and tools in JSON

Current finding families include:

- `unused-file`, `unused-export`, `unused-import`, `unused-type`, `unused-enum-member`
- `unused-local`, `unused-class-member`, `unused-interface-member`
- `unused-array-element`, `unused-object-key`, `unused-nested-path`
- `dead-store`, `unused-value`, `write-only-state`
- `use-before-init`, `invalidated-read`, `stale-read-after-mutation`

For the grounded coverage map and known conservative boundaries, see [CAPABILITIES.md](CAPABILITIES.md).

## Why Another Dead-Code Tool

Most dead-code tooling picks one of two bad tradeoffs:

- stay shallow and miss cross-file reality
- over-approximate dynamic code and generate noise

`rogue-lint` is built around a stricter trust model:

- `findings` means the analyzer has justification
- `kept` means the entity would otherwise look dead but is intentionally preserved
- `skipped` means exact reasoning stopped and the tool is being explicit about that limit
- `diagnostics` means the project itself had loading or analysis issues worth surfacing

That separation matters if you want output you can automate against without flattening uncertainty into false positives.

## Install

Node.js 20 or newer is required.

```bash
npm install -D rogue-lint
```

You can also install it globally:

```bash
npm install -g rogue-lint
```

## Quick Start

Run against the current project:

```bash
npx rogue-lint .
```

Useful variants:

```bash
npx rogue-lint . --json
npx rogue-lint . --kept
npx rogue-lint . --mode library
npx rogue-lint . --kinds unused-file,unused-export
npx rogue-lint . --config rogue-lint.config.json
```

Default exit codes:

- `0`: no findings
- `1`: findings were produced
- `2`: execution failed

Both non-zero exit codes are configurable.

## Example Text Output

```text
rogue-lint

Mode: application
Files analyzed: 4
Reachable files: 3
Findings: 2
Skipped: 1

Findings:
unused-export
  src/lib.ts
    unusedExport - exported declaration has no non-declaration references outside its declaring file
unused-file
  src/unused.ts
    unused.ts - file is unreachable from configured entrypoints

Skipped:
object-key
  src/index.ts
    maybe - computed property access prevents exact path analysis
```

`--kept` adds the preservation audit bucket to both text and CLI JSON output.

## Modes

`rogue-lint` has two operating modes:

- `application`: entrypoints are runtime roots; otherwise-unused exports are not preserved just because they are exported
- `library`: the package public surface is preserved while internal-only code remains analyzable

In `library` mode, configured entrypoints define the public surface directly. When roots are inferred, `package.json` `main` and `exports` are treated as public surface, while `bin` entries remain runtime roots without making every export part of the API.

## Configuration

Configuration can come from:

1. `--config path/to/file.json`
2. `rogue-lint.config.json`
3. `package.json#rogueLint`
4. built-in defaults

Example `rogue-lint.config.json`:

```json
{
  "mode": "application",
  "tsconfig": "tsconfig.json",
  "entrypoints": ["src/index.ts"],
  "hiddenRoots": ["src/worker.ts"],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.generated.ts"],
  "includeKinds": ["unused-file", "unused-export"],
  "keep": {
    "files": ["src/generated/**"],
    "symbols": ["futureApi"],
    "members": ["Example.preservedMethod"]
  },
  "findingsExitCode": 1,
  "failureExitCode": 2,
  "objectAnalysis": {
    "enabled": true,
    "maxPathDepth": 5
  }
}
```

The same config can live in `package.json`:

```json
{
  "rogueLint": {
    "mode": "library",
    "entrypoints": ["src/index.ts"]
  }
}
```

Inline preservation directives are also supported:

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

Detailed config semantics live in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Output Model

Every run can produce four top-level buckets:

- `findings`: dead code or suspicious flows the analyzer can justify
- `kept`: otherwise-dead entities intentionally preserved by API rules, suppressions, or keep rules
- `skipped`: explicit conservative boundaries where exact reasoning stopped
- `diagnostics`: project warnings or errors from loading and analysis

CLI JSON mode:

```bash
npx rogue-lint . --json
```

Programmatic consumers always receive the full `AnalysisResult`, including `kept`.

See [docs/OUTPUT.md](docs/OUTPUT.md) for the exact report shape, entity kinds, and skip categories.

## Library API

`rogue-lint` can also be used as a library:

```ts
import { analyzeProject } from "rogue-lint";

const result = await analyzeProject({
  cwd: process.cwd(),
  mode: "library",
  includeKinds: ["unused-export", "unused-file"],
});

console.log(result.summary.findings);
console.log(result.findings);
console.log(result.skipped);
```

The package exports:

- `analyzeProject`
- `AnalysisOptions`
- `AnalysisResult`
- `RogueLintConfig`
- `FindingKind`
- `ReportFormat`

## How Analysis Works

At a high level, `rogue-lint`:

1. Loads the project from `tsconfig.json`, `jsconfig.json`, or a source-file fallback walk
2. Discovers roots from config, package metadata, or conventional defaults
3. Builds the same-project module graph
4. Computes reachability
5. Layers symbol, value, return, helper, and structural-path analysis on top
6. Emits `findings`, `kept`, `skipped`, and `diagnostics`

Architecture details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository Development

For local development in this repository:

```bash
npm install
npm run lint
npm run build
npm test
```

Primary repo gates:

```bash
npm run check
npm run self
npm run self:json
npm run prep
```

- `npm run check` runs lint, build, and tests
- `npm run self` analyzes this repository in `library` mode
- `npm run prep` runs the current release gate, including a dry-run package check

The repository keeps a self-host baseline with zero findings, zero skips, and zero diagnostics.

Contribution workflow and fixture-first expectations are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Benchmarking

The repo also includes an offline benchmark harness for running `rogue-lint` against locally installed real-project corpora:

```bash
npm run benchmark
```

See [benchmark/README.md](benchmark/README.md) for corpus layout, manifest fields, and benchmark contract rules.

## License

This project is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Noncommercial use, study, modification, and redistribution are allowed under that license. Commercial use requires separate permission from the licensor.
