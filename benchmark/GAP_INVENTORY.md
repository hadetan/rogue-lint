# Real-World Gap Inventory

This inventory records every finding and skip family surfaced by the real-world benchmark contract across `zod-main` and `dayjs-core`, plus the measured effect of the remediation work in this change. The checked-in manifests now keep only hard `must*` anchors and leave debt budgets empty, so unresolved families surface as unexpected benchmark output.

Snapshot source:
- benchmark command: `npm run benchmark`
- baseline benchmark date: `2026-05-09`
- post-remediation benchmark date: `2026-05-09`
- benchmark targets: `zod-main`, `dayjs-core`

Classification labels used here:
- `verified gap`: source-backed engine behavior that still needs improvement
- `verified boundary`: current conservative skip boundary that remains a real capability gap
- `mixed`: family includes both source-backed real findings and scope-sensitive or track-splitting cases
- `benchmark mistake`: incorrect benchmark expectation that must not drive remediation as a true positive
- `resolved in this change`: family or benchmark anchor that this change removed from the current benchmark gap signal

## Measured Outcome

- `unused-local` - baseline `1`, current `0`. Resolved benchmark mistake; the Day.js `meridiemFunc` false positive remains guarded by `mustNotFind`.
- `dead-store` - baseline `2`, current `0`. Resolved and still guarded by `mustNotFind` anchors.
- `unused-enum-member` - baseline `36`, current `0`. Resolved and still guarded by `mustNotFind` anchors.
- `unused-class-member` - baseline `154`, current `14`. Reduced to the remaining Day.js public instance-method precision gap; the current benchmark now reports these as unexpected findings.
- `unused-array-element` - baseline `9`, current `1`. Reduced to the remaining Zod `unrecognized[0]` returned-array case in `src/v4/core/schemas.ts`; it now surfaces as an unexpected finding.
- `unused-object-key` - baseline `59`, current `263`. Increased by converting `204` previously skipped Zod locale `FormatDictionary` entries into source-backed findings via finite string-literal union keyed-access tracking; the current benchmark now reports the full family as unexpected findings.
- `unused-nested-path` - current `8`. Exact keyed-access tracking now also exposes nested locale object branches in `src/v4/locales/he.ts` as distinct unexpected findings instead of hiding them inside a broader dynamic lookup bucket.
- `unused-export` - baseline `64`, current `4`. Reduced to the four required Day.js constants in `src/constant.js`; the prior Zod export-heavy families are no longer present and are now guarded by `mustNotFind` anchors.
- `unused-type` - baseline `39`, current `3`. Reduced to `EmitParams`, `StandardSchemaWithJSON`, and `StandardTypedV1`.
- `unused-file` - baseline `2`, current `2`. Unchanged: one required real detection (`src/v4/core/config.ts`) plus one residual scope-sensitive file (`src/v4/core/zsf.ts`) that currently surfaces as an unexpected finding.
- `computed-property-access` - baseline `2444`, current `970`. Reduced by resolving finite string-literal union keyed object reads in Zod locale format tables; the residual signal remains the broader dynamic lookup family and now surfaces as unexpected skips.
- `dynamic-array-index` - baseline `2`, current `2`. Unchanged verified boundary.
- `returned-object` - baseline `3`, current `2`. Reduced by resolving the conditional helper fallback return in Zod's `objectKeys` polyfill path.
- `array-append-mutation` - baseline `1`, current `1`. Unchanged verified boundary.
- `array-opaque-mutation` - baseline `2`, current `1`. Reduced by treating `Promise.all(results)` as a supported whole-array observation in Zod union parsing; the remaining residual is the `keys` collection escape in `src/v3/types.ts` and now surfaces as an unexpected skip.

## Regression Anchors Added In This Change

- `library-fluent-api-basic` reproduces public fluent API and exported enum-member preservation in library mode.
- `value-flow-staged-basic` reproduces both staged self-rewrite and sentinel write-flow patterns from the Zod benchmark.
- `dynamic-benchmark-patterns-basic` reproduces benchmark-like conditional whole-array consumption and exported lookup-table usage.
- `library-factory-prototype-basic`, `library-namespace-export-basic`, and `library-returned-issues-basic` reproduce the public-surface and returned-value patterns validated in this change.
- The real-world manifests now pin resolved Day.js and Zod finding families with `mustNotFind` anchors, keep a small set of trusted `mustFind` and `mustSkip` anchors, and intentionally leave remaining debt unbudgeted so it appears as unexpected benchmark output.
- Existing focused fixtures continue to cover conservative boundary families for `dynamic-array-index`, `returned-object`, `array-append-mutation`, and `array-opaque-mutation`.
- `returned-object-conditional-helper-basic` reproduces the conditional helper fallback return that now resolves through supported same-project whole-array observation.
- `promise-all-array-basic` reproduces the benchmarked `Promise.all(results)` array aggregation path that no longer needs an `array-opaque-mutation` boundary.
- `finite-union-keyed-access-basic` reproduces exact read tracking for finite string-literal union keyed object lookups while keeping unrelated object branches dead.

## Remaining Verified Library-Surface Gaps

- `unused-class-member` - 14 current unexpected findings, all in `benchmark/corpus/dayjs-root/src/index.js`. Verified library-surface precision gap on public instance methods that still appear unused under current same-project reference analysis.

## Remaining Verified Dynamic-Structure Gaps

- `unused-object-key` - 263 current unexpected findings. The signal now includes `204` source-backed Zod locale `FormatDictionary` keys that sit outside the actual `_issue.format` literal union, plus the existing public-return and helper-threaded object shapes in `benchmark/corpus/zod-main/packages/zod/src/v3/types.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/json-schema-processors.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/util.ts`, and the `flatten` / `flattenError` helpers.
- `unused-nested-path` - 8 current unexpected findings in `benchmark/corpus/zod-main/packages/zod/src/v4/locales/he.ts` (`regex.label`, `regex.gender`, `ends_with.label`, `ends_with.gender`, `includes.label`, `includes.gender`, `starts_with.label`, `starts_with.gender`). These are the nested counterparts of the remaining locale dictionary object-shape debt.
- `unused-array-element` - 1 current unexpected finding in `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts` on `unrecognized[0]`. The Day.js array-receiver portion is resolved; the remaining case belongs entirely to the Zod dynamic-structure track.

## Remaining Verified Conservative Boundaries

- `computed-property-access` - 970 current unexpected skips across the remaining Zod locale lookup tables and related dynamic reads. Finite `_issue.format` lookups now resolve exactly; the residual boundary is still verified and concentrated in broader string-key and other non-finite lookup families. Representative examples: `benchmark/corpus/zod-main/packages/zod/src/v4/locales/he.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/locales/ar.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts`.
- `dynamic-array-index` - 2 required skips in `benchmark/corpus/dayjs-root/src/locale/en.js`. Verified conservative boundary around indexed collection access.
- `returned-object` - 2 current unexpected skips. Verified conservative boundary on values returned before later nested-path or object-key reads. Representative examples: `benchmark/corpus/zod-main/packages/zod/src/v4/locales/he.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts`.
- `array-append-mutation` - 1 required skip in `benchmark/corpus/zod-main/packages/zod/src/v4/core/json-schema-processors.ts`. Verified conservative boundary around append-driven collection growth.
- `array-opaque-mutation` - 1 residual unexpected skip at `benchmark/corpus/zod-main/packages/zod/src/v3/types.ts` where `createZodEnum()` stores the `keys` array by reference beyond exact local analysis.

## Mixed Or Scope-Sensitive Families

- `unused-type` - 3 current unexpected findings remain in `benchmark/corpus/zod-main/packages/zod/src/v4/core/json-schema-generator.ts` and `benchmark/corpus/zod-main/packages/zod/src/v4/core/standard-schema.ts`. These still need a source-backed call on whether they are true residual library-surface debt or another public-type precision gap.
- `unused-file` - 2 findings total. `benchmark/corpus/zod-main/packages/zod/src/v4/core/config.ts` remains a source-backed required detection, while `benchmark/corpus/zod-main/packages/zod/src/v4/core/zsf.ts` still depends on target-scope and export-reachability interpretation.

## Benchmark Mistakes

- `unused-local` - the former Day.js required finding was a benchmark mistake. `meridiemFunc` in `benchmark/corpus/dayjs-root/src/index.js` is directly called by the `a` and `A` format cases, so the benchmark now treats it as `mustNotFind`.

## Next Change Sequence

1. Finish the remaining Day.js public instance-method surface so `unused-class-member` falls from `14` to `0` without regressing real dead-member detection elsewhere.
2. Resolve the remaining Zod object-shape and returned-object flow cases so the current unexpected `unused-object-key` total falls from `263`, `unused-nested-path` falls from `8`, and `unused-array-element` falls from `1`.
3. Tackle the conservative boundary families in explicit follow-up slices: `computed-property-access` (`970`), `returned-object` (`2`), `dynamic-array-index` (`2`), `array-opaque-mutation` (`1`), and `array-append-mutation` (`1`).
4. Revisit the mixed library-surface families `unused-type` and `unused-file` after the remaining public-surface and object-shape fixes land, so scope-sensitive cases are not collapsed into one bucket.
5. Keep rerunning `npm run benchmark` after each slice and append the observed family deltas here so no benchmark family drops out of follow-up planning.