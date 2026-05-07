# rogue-lint output reference

This guide explains how to read the text and JSON output `rogue-lint` emits today, based on `src/output/render-result.ts`, `src/api/public-types.ts`, and the regression suite.

## The Four Top-Level Output Buckets

Every run can produce four kinds of records:

- `findings`: stale code or suspicious flows the analyzer can justify
- `kept`: otherwise-dead entities intentionally preserved by public-surface rules, suppressions, or keep rules
- `skipped`: explicit conservative boundaries where exact reasoning stopped
- `diagnostics`: project warnings or errors such as unresolved same-project imports or config issues

These buckets are the trust model. `rogue-lint` is not trying to flatten everything into one removal list.

## Text Output

Example text report:

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

Current text rendering behavior:

- summary lines appear first
- `Findings`, `Kept`, and `Skipped` are grouped by kind and then by file
- each line includes the reason string inline
- `Diagnostics` appear at the end when present

## JSON Output

Run JSON mode with:

```bash
npx rogue-lint . --json
```

Example shape:

```json
{
  "tool": "rogue-lint",
  "version": "x.y.z",
  "target": "/path/to/project",
  "mode": "application",
  "exitCodes": {
    "findings": 1,
    "failure": 2
  },
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "summary": {
    "filesAnalyzed": 4,
    "reachableFiles": 3,
    "findings": 9,
    "kept": 1,
    "skipped": 2,
    "byKind": {
      "unused-file": 1,
      "unused-export": 1
    }
  },
  "findings": [],
  "kept": [],
  "skipped": [],
  "diagnostics": []
}
```

## Findings

Each finding record has this shape:

```json
{
  "id": "export:src/lib.ts:42:unusedExport",
  "kind": "unused-export",
  "entity": {
    "id": "export:src/lib.ts:42:unusedExport",
    "kind": "export",
    "name": "unusedExport",
    "owner": "OptionalOwner",
    "location": {
      "file": "src/lib.ts",
      "line": 2,
      "column": 14
    }
  },
  "reason": "exported declaration has no non-declaration references outside its declaring file",
  "message": "Unused exported unusedExport",
  "suggestion": "remove"
}
```

Current `suggestion` values:

- `remove`
- `review`

Current finding kinds:

- `unused-file`
- `unused-export`
- `unused-type`
- `unused-enum-member`
- `unused-local`
- `unused-class-member`
- `unused-interface-member`
- `unused-array-element`
- `unused-object-key`
- `unused-nested-path`
- `dead-store`
- `unused-value`
- `write-only-state`
- `use-before-init`
- `invalidated-read`
- `stale-read-after-mutation`

For what each finding kind actually means in supported code patterns, see [CAPABILITIES.md](../CAPABILITIES.md).

## Kept

`kept` records use the audit shape:

```json
{
  "id": "local:src/index.ts:123:ignoredLocal",
  "kind": "local",
  "name": "ignoredLocal",
  "reason": "suppressed by rogue-lint-ignore-next",
  "location": {
    "file": "src/index.ts",
    "line": 9,
    "column": 7
  }
}
```

Typical `kept` reasons:

- `suppressed by rogue-lint-ignore-next`
- `suppressed by rogue-lint-ignore-start/end`
- `marked externally visible by inline directive`
- `marked externally visible by @externallyVisible`
- `kept by entity id rule`
- `kept by symbol/member rule`
- `kept by file rule`

Library-mode public-surface preservation also uses `kept` rather than hiding those entities completely.

## Skipped

`skipped` records use the same audit shape with an added `category` field:

```json
{
  "id": "object-key:src/index.ts:456:maybe",
  "kind": "object-key",
  "name": "maybe",
  "category": "computed-property-access",
  "reason": "computed property access prevents exact path analysis",
  "location": {
    "file": "src/index.ts",
    "line": 24,
    "column": 3
  }
}
```

Important interpretation rule:

- `skipped` does not mean safe to delete
- `skipped` means the current analyzer intentionally stopped claiming exactness

### `collection-boundary`

One important skipped entity kind is `collection-boundary`.

This is how `rogue-lint` reports that a tracked array or object collection left the exact subset at the collection root rather than on a stale child slot.

Typical scenarios:

- append mutation with opaque source
- reorder mutation such as `sort`, `shift`, or `splice`
- helper storage by reference
- reflective or serialization escape

If you see a `collection-boundary`, treat it as a signal that the owning collection crossed an analysis frontier.

## Diagnostics

Diagnostics use this shape:

```json
{
  "kind": "project-warning",
  "message": "Could not resolve module './missing.js' from /path/to/file.ts",
  "file": "/path/to/file.ts"
}
```

Current diagnostic kinds:

- `project-warning`
- `project-error`

The test suite verifies that:

- builtin modules such as `node:path` do not produce false unresolved warnings
- installed external packages such as `minimatch` do not produce false unresolved warnings
- missing same-project imports still surface as diagnostics

## Entity Kinds

Current entity kinds in the report model:

- `file`
- `export`
- `local`
- `type`
- `enum-member`
- `class-member`
- `array-element`
- `collection-boundary`
- `interface-member`
- `object-key`
- `nested-path`
- `assignment`
- `expression`

`owner` is optional and appears when the analyzer can associate an entity with a parent, such as a class member owner or root object name.

## SkipCategory Reference

Current `SkipCategory` values defined in `src/types.ts`:

| Category | Current meaning |
| --- | --- |
| `decorator-visibility` | decorators can expose or retain members indirectly |
| `computed-member-name` | computed class member names break exact member tracking |
| `computed-property-name` | computed object literal property names break exact path tracking |
| `computed-property-access` | non-literal property access such as `obj[key]` |
| `dynamic-array-index` | non-literal array indexing |
| `array-at-call` | `.at(...)` with non-literal or non-exact access semantics |
| `array-append-mutation` | append path left the exact modeled subset |
| `array-mutation` | generic array mutation boundary |
| `array-truncate-mutation` | truncate mutation such as `pop()` |
| `array-replacement-mutation` | replacement mutation such as `fill()` |
| `array-reorder-mutation` | reorder mutation such as `sort`, `reverse`, `shift`, `splice`, `copyWithin`, or exactness-breaking `unshift` |
| `array-rebuild-mutation` | array reconstruction beyond the current exact subset |
| `array-opaque-mutation` | mutation that cannot be modeled exactly |
| `array-callback-escape` | callback behavior escaped the allowlisted exact subset |
| `object-spread` | object spread escaped exact path tracking |
| `array-spread` | array-literal spread escaped exact slot tracking |
| `returned-object` | returned value could not be kept exact as a tracked structure |
| `reflective-enumeration` | reflective enumeration such as `Object.keys()` |
| `serialization` | serialization such as `JSON.stringify()` |
| `opaque-object-call` | unsupported object call boundary |
| `spread-escape` | spread caused the value to escape the exact subset |
| `object-rest` | object rest reconstruction |
| `array-rest` | array rest reconstruction |

## How To Use The Output

For engineers:

- remove or review `findings`
- inspect `kept` to confirm intentional preservation rules are doing what you expect
- inspect `skipped` when you need to understand why a suspected dead path was not reported
- inspect `diagnostics` before trusting a run with unresolved same-project imports

For coding agents:

- act on `findings`
- do not auto-remove `kept`
- do not auto-remove `skipped`
- use `summary.byKind` and stable `id` fields for machine-readable follow-up

## Related Docs

- [CAPABILITIES.md](../CAPABILITIES.md)
- [docs/CONFIGURATION.md](CONFIGURATION.md)
