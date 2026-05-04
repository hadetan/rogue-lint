# dead-lint

Whole-project dead code analysis for JavaScript and TypeScript with agent-friendly output.

`dead-lint` scans an entire project, not just one file, and reports stale code in a compact format that agents can use as a validation step after implementation work.

## Current coverage

The current implementation covers:

- unreachable files
- unused exports
- unused exported types
- unused enum members
- unused locals reported by TypeScript semantic analysis
- unused class members with exact declaration/reference tracking
- unused object keys and nested object paths inside analyzable local object graphs
- inline suppressions, keep rules, and external visibility declarations

## Install

```bash
npm install dead-lint
```

For local development in this repository:

```bash
npm install
npm run build
```

## CLI usage

```bash
dead-lint
dead-lint path/to/project
dead-lint path/to/project --json
dead-lint path/to/project --mode library
dead-lint path/to/project --kinds unused-export,unused-file
dead-lint path/to/project --config dead-lint.config.json
```

### Exit codes

- `0`: no findings
- `1`: findings were produced
- `2`: execution failed

## Configuration

Create `dead-lint.config.json` in the target project:

```json
{
  "mode": "application",
  "entrypoints": ["src/index.ts"],
  "includeKinds": ["unused-file", "unused-export"],
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
- `library`: preserve configured public entrypoints and externally visible declarations as live surface

## Suppressions and external visibility

Inline directives:

```ts
// dead-lint-ignore-next
const ignoredLocal = 1;

// dead-lint-externally-visible
export const publicFutureApi = 1;

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
- summary counts
- findings
- kept entities
- skipped entities
- diagnostics

This lets an agent distinguish removable code from code that was suppressed or skipped because it escaped exact analysis.

## Safe subset and dynamic boundaries

`dead-lint` is most exact when code stays inside analyzable patterns such as:

- explicit entrypoints
- static imports/exports
- direct property access
- local object literals
- no reflective enumeration on analyzed objects

The analyzer intentionally skips or downgrades exact analysis when code crosses dynamic boundaries such as:

- unknown computed property access
- `Object.keys`, `Object.values`, `Object.entries`, `Reflect.ownKeys`
- `JSON.stringify`
- opaque external calls that receive a tracked object
- decorators that can expose class members indirectly

Skipped entities are reported so the gaps remain visible.

## End-to-end workflow for agents

Typical agent flow:

```bash
npm run build
dead-lint . --json > dead-lint-report.json
```

An agent can then:

1. inspect `findings`
2. ignore `kept`
3. avoid auto-removing `skipped`
4. fail or continue based on the CLI exit code

## Development

```bash
npm run build
npm test
npm run check
```

## Release checks

Run these before publishing:

```bash
npm run release:check
```

That sequence verifies:

1. TypeScript build succeeds
2. tests pass
3. `npm pack --dry-run` succeeds and the package contents are publishable
