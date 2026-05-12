# rogue-lint capabilities

> Grounded coverage map for the current implementation.

This document describes what `rogue-lint` can actually map today. It is intentionally about implemented behavior, not roadmap ideas.

## How To Read This Document

- `test-backed` means the behavior is covered by `test/analyze.test.ts` and named fixtures under `test/fixtures/`
- `code-backed` means the behavior is directly modeled in `src/` and safe to document, even if it is not front-and-center in a dedicated fixture headline
- if this document and the tests disagree, the tests win
- if this document and the code disagree, the code wins

For config semantics, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md). For report buckets, JSON shape, and skip categories, see [docs/OUTPUT.md](docs/OUTPUT.md).

## Coverage At A Glance

Current finding kinds:

- `unused-file`
- `unused-export`
- `unused-import`
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

Current report buckets:

- `findings`
- `kept`
- `skipped`
- `diagnostics`

Normalized symbol-liveness ownership currently covers:

- `unused-import`
- `unused-export`
- `unused-type`
- `unused-enum-member`
- `unused-local`
- `unused-class-member`
- `unused-interface-member`

## 1. Whole-Project Reachability And Public Surface

Test-backed fixtures:

- `app-basic`
- `library-basic`
- `library-referenced-basic`
- `export-scope-basic`
- `bulk-basic`
- `controls-basic`
- `package-roots-basic`

What the current implementation can prove:

- unreachable files from the discovered root set
- unused exports whose only references stay inside their own file
- unused exported types
- unused enum members
- application mode versus library mode differences
- inferred roots from `package.json` `main`, `exports`, and `bin`
- reconciliation from built package paths such as `dist/...` back to source entrypoints
- `hiddenRoots`, include filters, and exclude filters

Example:

```ts
// src/lib.ts
export const usedExport = 1;
export const unusedExport = 2;

export interface UnusedShape {
  value: string;
}

export enum usedEnum {
  Red = "red",
  Blue = "blue"
}

// src/index.ts
import { usedExport, usedEnum } from "./lib.js";

console.log(usedExport, usedEnum.Red);
```

`rogue-lint` can report:

- `unused-export:unusedExport`
- `unused-type:UnusedShape`
- `unused-enum-member:Blue`

Important nuances:

- an export only counts as live export surface when another file references it; same-file-only references still allow `unused-export` and `unused-type`
- in `library` mode, configured entrypoints define the public surface directly
- when roots are inferred from `package.json`, `main` and `exports` count as public surface, while `bin` only makes those files reachable
- if no configured or inferred roots exist, the analyzer falls back to conventional defaults and then to the first loaded source file; this last fallback is code-backed from `src/module-graph.ts`

## 2. Exact Object And Array Path Tracking

Test-backed fixtures:

- `app-basic`
- `array-basic`
- `collection-state-basic`
- `cross-file-exact-basic`
- `cross-file-public-surface-basic`
- `deep-coverage-basic`

What the current implementation can prove:

- exact unused object keys inside local object literals
- exact unused nested paths such as `nested.stale` or `[0].items[0].dead`
- exact unused literal array slots such as `[1]`
- preservation of live siblings while adjacent siblings remain reportable as dead
- cross-file path preservation when the imported structure stays inside the supported exact subset
- root-owned collection boundary reporting when a collection stops being exact

Example:

```ts
const rows = [
  { enabled: true, stale: 1, nested: { keep: "a", dead: "x" } },
  { enabled: false, stale: 2, nested: { keep: "b", dead: "y" } },
];

for (const row of rows) {
  console.log(row.enabled, row.nested.keep);
}
```

This supports findings such as:

- `unused-nested-path:[0].stale`
- `unused-nested-path:[1].stale`
- `unused-nested-path:[0].nested.dead`
- `unused-nested-path:[1].nested.dead`

while leaving `row.enabled` and `row.nested.keep` live.

Important nuances:

- the analyzer tracks nested path segments, not just top-level object keys
- when one branch of a tracked collection escapes exact analysis, other safe branches can stay precise; `collection-state-basic` is the main regression for that behavior
- path tracking depth is bounded by `objectAnalysis.maxPathDepth`; configuration details live in [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## 3. Same-Project Propagation Across Imports, Returns, And Helpers

Test-backed fixtures:

- `cross-file-exact-basic`
- `returned-object-basic`
- `returned-literal-basic`
- `cross-file-return-structure-basic`
- `helper-readonly-basic`
- `helper-mutation-basic`
- `helper-async-propagation-basic`
- `helper-storage-basic`
- `helper-closure-capture-basic`

What the current implementation can prove:

- exact imported object and array usage across same-project files
- direct returned object and array literals
- returned aliases when the result can still be tied back to an exact tracked binding
- same-project namespace-style, member-style, and direct helper observers that only read supported paths
- same-project namespace-style, member-style, and direct helper mutations that stay within modeled exact flows
- awaited helper returns and wrapper helpers when the returned binding identity stays exact
- conservative boundaries when helpers store, forward, or capture values in unsupported ways

Cross-file structured-return example:

```ts
// shared.ts
export function buildShared() {
  return {
    live: "ok",
    dead: "stale",
    nested: {
      read: 1,
      stale: 2,
    },
  };
}

// index.ts
import { buildShared } from "./shared.js";

const shared = buildShared();
console.log(shared.live);
console.log(shared.nested.read);
```

This keeps `shared.live` and `shared.nested.read` live while still allowing:

- `unused-object-key:dead`
- `unused-nested-path:nested.stale`

Helper observer example:

```ts
function observe(items: number[]): void {
  console.log(items[0]);
}

const items = [1, 2];
observe(items);
```

This keeps `items[0]` live and still allows `items[1]` to remain reportable.

Important nuances:

- internally, returned values are summarized as `value`, `structured`, `returned-alias`, or `opaque`; that summary drives cross-file and helper precision
- statically resolved property-style callees and namespace-like helper access participate in the same helper-summary and return-summary model; unresolved dispatch still stays conservative
- conditional and nullish return expressions stay exact only when both branches collapse to the same tracked binding or to compatible pure-value summaries; that is code-backed in `src/engine/tracking/graph.ts`
- helper storage by reference and nested helper closure capture remain explicit conservative boundaries rather than speculative exactness

## 4. Helpers, Callback Correlation, And Retained Bindings

Test-backed fixtures:

- `callback-correlation-basic`
- `container-retention-basic`
- `object-retention-basic`
- `helper-retained-binding-basic`
- `helper-global-this-basic`
- `helper-queue-basic`
- `queue-lifecycle-basic`

What the current implementation can prove:

- exact callback index correlation for supported local array callbacks
- retained bindings through supported `Map.set` and `Map.get` flows
- retained bindings through supported local object-backed static slots
- supported retention through same-project module bindings
- supported retention through static `globalThis` properties
- exact single-item queue or worklist consume after a modeled exact append
- conservative queue and worklist boundaries when mutations reorder or rebuild arrays beyond the exact subset

Callback-correlation example:

```ts
const rows = [
  { live: 1, dead: 2 },
  { live: 3, dead: 4 },
];

function rowsMatch(items: typeof rows) {
  return items.every((item, index) => item.live === items[index].live);
}

console.log(rowsMatch(rows));
```

This is specific enough for the analyzer to preserve `item.live` without dropping to a generic dynamic-index boundary.

Retained-binding example:

```ts
function retainRecord(record: { live: number; dead: number }, key: string) {
  const retained = new Map<string, { live: number; dead: number }>();
  retained.set(key, record);
  const restored = retained.get(key);
  if (!restored) {
    throw new Error("missing retained record");
  }
  return restored;
}

const record = { live: 1, dead: 2 };
const restored = retainRecord(record, "chosen");
console.log(restored.live);
```

This keeps `live` meaningful while still allowing `dead` to remain reportable.

Important nuances:

- exact callback support is intentionally allowlisted; the current code models `every`, `filter`, `find`, `findIndex`, `findLast`, `findLastIndex`, `flatMap`, `forEach`, `map`, `reduce`, `reduceRight`, and `some`
- object-backed retained storage stays exact only when the container is locally owned and the slot identity is a static property name or literal element access
- queue-like mutations such as `shift`, `sort`, `splice`, and `reverse` are deliberately treated as reorder boundaries once exact slot mapping can no longer be preserved; a single-item `shift()` consume can stay exact because the removed slot is deterministic

## 5. Value-Flow, Discarded Results, And Safety Findings

Test-backed fixtures:

- `value-flow-basic`
- `call-return-basic`
- `safety-basic`
- `self-host-trust-basic`

What the current implementation can prove:

- dead stores for overwritten local assignments in supported flows
- discarded pure or side-effect-neutral expression results
- write-only outer-scope state updates in supported closure patterns
- compiler-backed `use-before-init` promotion in the current allowlist
- exact invalidated reads after supported replacement-style mutations
- exact stale reads after supported reorder-style mutations
- meaningful call boundaries when values are actually consumed
- purity gating so ignored returns are only reported when it is defensible to treat them as dead

Example:

```ts
let count = 1;
count = 2;
console.log(count);

let status = 0;

function update(): void {
  status = 1;
}

update();

1 + 2;
```

This can support:

- `dead-store:count`
- `write-only-state:status`
- `unused-value:1 + 2`

Call-boundary nuance:

```ts
let helperRead = 1;
consume(helperRead);
helperRead = 2;
console.log(helperRead);

let helperIgnored = 1;
ignore(helperIgnored);
helperIgnored = 2;
console.log(helperIgnored);
```

The first path counts as a meaningful read. The second does not. That difference is why one path can avoid a `dead-store` finding and the other cannot.

Safety nuance:

- the current compiler-backed safety allowlist only promotes TypeScript diagnostic `2454`, which maps to `use-before-init`
- invalidated and stale-read findings only appear when the analyzer can tie the read back to a supported exact mutation path

## 6. Value Fate, Clone Modeling, And Structural Heuristics

Test-backed fixtures:

- `value-fate-basic`
- `spread-append-basic`
- `append-growth-basic`
- `append-alias-observation-basic`
- `append-boundary-basic`
- `self-host-trust-basic`

What the current implementation can prove:

- exact `push(value)` growth for scalar values and direct alias insertion
- exact `push(...array)` spread append when the spread source stays exact
- allowlisted whole-value observation that makes inserted aliases count as used
- shallow-clone reasoning for `slice()` and `concat()`
- deep-clone reasoning for `structuredClone()`
- ignored-result findings for allowlisted clone-style APIs
- structural bookkeeping heuristics that suppress noisy metadata findings on record-like and state-holder-like objects

Exact spread-append example:

```ts
// source.ts
export const numbers = [1, 2];

// index.ts
import { numbers } from "./source.js";

const sink: number[] = [];
sink.push(...numbers);

console.log(sink[0]);
```

This lets the analyzer materialize exact append slots. `sink[0]` stays live and `sink[1]` can still remain reportable.

Whole-value observation nuance:

- allowlisted observation-only calls currently include `console.log`, `console.info`, `console.debug`, `console.warn`, `console.error`, and `console.dir`
- these calls can mark inserted-by-reference aliases as meaningfully observed instead of producing false write-only findings

Structural heuristic nuance:

- `self-host-trust-basic` protects record-like or state-holder-like objects from noisy dead metadata reporting
- in code, this is driven by structural role detection for object shapes with fields such as `kind`, `state`, `findings`, `diagnostics`, `reads`, and `writes`

Code-backed nuance not highlighted by a dedicated fixture headline:

- `unshift` is modeled, but only while exact slot remapping stays safe; once the receiver already has elements, it becomes a reorder boundary
- `Object.assign` is explicitly modeled so source objects count as read, while the target merge itself becomes a conservative boundary rather than a fake exact merge

## 7. Controls, Preservation, And Report Identity

Test-backed fixtures:

- `keep-basic`
- `controls-basic`
- `identity-basic`
- `export-scope-basic`
- grouped-output and exit-code assertions in `test/analyze.test.ts`

What the current implementation can prove or preserve:

- include and exclude file filters
- `hiddenRoots`
- keep rules for files, symbols, members, and entity ids
- inline ignore directives
- inline external-visibility directives and `@externallyVisible`
- stable finding ids for similarly named findings across files
- grouped text output and structured JSON output
- configurable exit codes for findings and failures
- owner metadata for class members and nested object paths

These controls are central to trust, but they are documented in detail in:

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/OUTPUT.md](docs/OUTPUT.md)

## Conservative Boundaries

When `rogue-lint` stops being exact, it emits `skipped` records instead of speculative findings.

The current codebase explicitly models boundary families such as:

- dynamic property and member access
- dynamic array indexing and non-literal `.at(...)`
- array reorder, replacement, truncate, rebuild, and opaque mutation paths
- array and object rest and spread escapes
- helper storage, opaque helper escape, and nested closure capture
- reflective enumeration such as `Object.keys` and related patterns
- serialization paths such as `JSON.stringify`
- decorator-driven visibility changes

For the full `SkipCategory` reference, see [docs/OUTPUT.md](docs/OUTPUT.md).

## Fixture Index

If you want the closest thing to a ground-truth tour of the package, read these fixtures alongside `test/analyze.test.ts`.

### Reachability And Public Surface

- `app-basic`: baseline whole-project report plus computed-property boundaries
- `library-basic`: library-mode preservation of public entrypoint exports
- `library-referenced-basic`: cross-file referenced public exports stay used and do not appear in `kept`
- `export-scope-basic`: same-file-only export usage still reports unused export surface and honors ignore directives
- `bulk-basic`: larger module graph traversal
- `controls-basic`: include, exclude, hidden-roots, and configurable exit codes
- `package-roots-basic`: reconciliation from built package roots back to source entrypoints, with `bin` reachability separate from public API

### Exact Arrays And Objects

- `array-basic`: exact local array slots and nested paths, plus dynamic index, `.at`, reorder, and rest boundaries
- `collection-state-basic`: root-owned collection boundaries while safe siblings stay exact
- `cross-file-exact-basic`: exact imported object and array propagation across files
- `cross-file-public-surface-basic`: public exports stay live in library mode without hiding dead imported paths
- `deep-coverage-basic`: internal interface members, safe forwarded paths, and reflective-enumeration boundaries

### Returns, Helpers, And Retention

- `returned-object-basic`: tracked object returns across same-project helpers
- `returned-literal-basic`: direct returned literals for whole-result and nested structured usage
- `cross-file-return-structure-basic`: structured return usage preserved across imports
- `helper-readonly-basic`: read-only helper observers preserve exact array reads
- `helper-mutation-basic`: helper-local append mutations remain exact when later reads stay modeled
- `helper-storage-basic`: helper storage by reference becomes a boundary instead of a false unused-slot report
- `helper-retained-binding-basic`: retained module bindings through same-project helpers
- `helper-global-this-basic`: static `globalThis` retention
- `helper-queue-basic`: queue and worklist mutations remain conservative
- `helper-closure-capture-basic`: nested helper closure capture becomes a boundary
- `callback-correlation-basic`: exact callback index correlation for supported local array callbacks
- `container-retention-basic`: retained bindings through supported `Map.set` and `Map.get`

### Value Flow, Safety, And Value Fate

- `value-flow-basic`: dead stores, meaningful call boundaries, write-only state, and unused pure expressions
- `call-return-basic`: analyzable discarded call results without duplicating unread saved returns
- `safety-basic`: `use-before-init`, invalidated reads, stale reads, and serialization boundaries
- `value-fate-basic`: JS-truthful value fate plus ignored-result findings for clone-style APIs
- `spread-append-basic`: exact spread append slots
- `append-growth-basic`: exact append growth for scalars and direct aliases
- `append-alias-observation-basic`: allowlisted whole-receiver observation of inserted aliases
- `append-boundary-basic`: opaque iterable spread append boundary

### Controls, Reporting, And Self-Host Trust

- `keep-basic`: keep rules and external visibility declarations
- `identity-basic`: stable unique ids across similarly named findings
- `self-host-trust-basic`: purity-gated ignored returns and structural dead-metadata suppression
- `self-host-hardening-basic`: external imports treated as boundaries without false unresolved-module noise
- repository self-host run: the repository itself is expected to analyze cleanly in `library` mode with `runCli` preserved in `kept`
