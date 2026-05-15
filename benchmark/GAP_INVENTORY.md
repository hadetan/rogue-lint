# Real-World Gap Inventory

This inventory records every finding and skip family surfaced by the real-world benchmark contract across `zod-main` and `dayjs-core`, plus the measured effect of the remediation work in this change. The checked-in manifests now keep only hard `must*` anchors and leave debt budgets empty, so unresolved families surface as unexpected benchmark output.

Snapshot source:
- benchmark command: `npm run benchmark`
- baseline benchmark date: `2026-05-09`
- post-remediation benchmark date: `2026-05-10`
- latest follow-up benchmark date: `2026-05-14`
- benchmark targets: `zod-main`, `dayjs-core`

The detailed classifications below reflect the last fully source-verified snapshot from `2026-05-10`. A later rerun on `2026-05-11` after the recursive helper forwarding fix still left `zod-main` failing (`276` unexpected findings, `1010` unexpected skips), but that output has not been fully reclassified yet and should not overwrite the verified snapshot in this document without a follow-up review.

Follow-up note:
- A targeted follow-up exploration on `2026-05-14` completed the missing source-backed classification for the next benchmark remediation slice. That follow-up isolated three confirmed false-positive implementation families: same-project helper aggregate forwarding, returned-carrier readback, and symbol-liveness alias accounting.
- The same follow-up also confirmed that the largest remaining non-locale skip clusters in `src/v3/types.ts`, `src/v4/core/json-schema-processors.ts`, and `src/v4/classic/from-json-schema.ts` are still honest conservative boundaries or contract-sensitive cases rather than newly proven false positives.
- The current working-tree implementation landed narrow fixes and focused regression coverage for same-project helper aggregate forwarding, exported type-alias public-surface accounting, and same-file namespace re-export import liveness, but it does not finish the broader benchmark remediation slice.
- The latest `2026-05-14` benchmark rerun is still red. `dayjs-root` fails `must-not-skip` clean `0/1`, and `zod-main` fails `must-not-find` clean `20/23` plus `must-not-skip` clean `0/4`.
- The detailed classifications below therefore remain anchored to the last fully source-verified snapshot until another source-backed reclassification pass confirms the residual benchmark surface.

Classification labels used here:
- `confirmed false positive`: engine-reported deadness that source-backed verification shows is actually live
- `confirmed true detection`: engine-reported deadness that remains correct under the current exported package surface and benchmark contract
- `open contract-sensitive`: source-backed case whose final classification depends on an explicit package-surface or compatibility decision rather than engine exactness alone
- `verified boundary`: current conservative skip boundary that remains a real capability gap
- `mixed`: family includes both confirmed false positives and confirmed true or contract-sensitive entries
- `benchmark mistake`: incorrect benchmark expectation that must not drive remediation as a true positive
- `resolved in this change`: family or benchmark anchor that this change removed from the current benchmark gap signal

## Measured Outcome

- Latest follow-up outcome (`2026-05-14`) - benchmark still failing. `dayjs-root` remains red on `must-not-skip` clean `0/1`, and `zod-main` remains red on `must-not-find` clean `20/23` plus `must-not-skip` clean `0/4`. The current tree should not be treated as a clean real-world benchmark pass yet.

- `unused-local` - baseline `1`, current `0`. Resolved benchmark mistake; the Day.js `meridiemFunc` false positive remains guarded by `mustNotFind`.
- `dead-store` - baseline `2`, current `0`. Resolved and still guarded by `mustNotFind` anchors.
- `unused-enum-member` - baseline `36`, current `0`. Resolved and still guarded by `mustNotFind` anchors.
- `unused-class-member` - baseline `154`, current `0`. Resolved in this change by following bounded local prototype alias chains from exported factory entrypoints; the `unused-class-member` family is now clean in Day.js while the required `unused-export` anchors in `src/constant.js` stay visible.
- `unused-array-element` - baseline `9`, current `1`. Reduced to the remaining Zod `unrecognized[0]` case in `src/v4/core/schemas.ts`; current source-backed verification still says this is a false positive caused by bounded issue-array readback loss.
- `unused-object-key` - baseline `59`, current `245`. The family is still mixed, but the returned-carrier subfamily is now resolved. The remaining confirmed false positives are concentrated in the `allProcessors` dispatch-table flow, while most residual locale entries now verify as true or contract-sensitive compatibility labels rather than keyed-read misses.
- `unused-nested-path` - current `8`. The current `src/v4/locales/he.ts` `label` and `gender` findings on `regex`, `starts_with`, `ends_with`, and `includes` are now verified true detections: those specific dictionary entries are bypassed by earlier direct returns, so the child paths are genuinely unread under the current source.
- `write-only-state` - baseline `4`, current `0`. Resolved in this change by preserving returned-carrier readback through same-project wrapper flows.
- `unused-export` - baseline `64`, current `4`. Reduced to the four required Day.js constants in `src/constant.js`; the prior Zod export-heavy families are no longer present and are now guarded by `mustNotFind` anchors.
- `unused-type` - baseline `39`, current `3`. Reduced to `EmitParams`, `StandardSchemaWithJSON`, and `StandardTypedV1`; these remain contract-sensitive because they are source-backed but not currently re-exported from the published `./v4/core` barrel.
- `unused-file` - baseline `2`, current `2`. Unchanged: one required real detection (`src/v4/core/config.ts`) plus one additional internal-only file (`src/v4/core/zsf.ts`) that remains a correct unexpected finding under the current contract.
- `computed-property-access` - baseline `2444`, current `970`. Reduced by resolving finite string-literal union keyed object reads in Zod locale format tables; the residual signal remains the broader dynamic lookup family and now surfaces as unexpected skips.
- `object-spread` - current `12`. New unexpected skip family. These are honest conservative boundaries where spread-built wrapper objects still stop exact field propagation.
- `dynamic-array-index` - baseline `2`, current `2`. Unchanged verified boundary.
- `returned-object` - baseline `3`, current `4`. The residual skip family is still concentrated in bounded returned-wrapper and keyed-read flows.
- `opaque-object-call` - current `2`. New unexpected skip family. These are still honest conservative boundaries around object helper calls that escape the current exact subset.
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
- `finite-dispatch-recursive-basic` guards against recursive same-project helper reuse destabilizing the exact tracking fixpoint.

## Resolved In This Change

- `unused-class-member` - the remaining Day.js instance-method false positives are gone. The `unused-class-member` family is now clean while the required `src/constant.js` `unused-export` anchors remain visible.
- `write-only-state` - the returned-carrier false positives in `flattenError`, `flatten`, `mergeValues`, and registry `toJSONSchema` are gone. The paired wrapper-field findings on `{ valid, data }`, `{ formErrors, fieldErrors }`, and `{ schemas }` are no longer in the live benchmark output.
- `unused-import` - the `export { z }` namespace re-export false positives in `src/mini/index.ts`, `src/v4/mini/index.ts`, and `src/v4-mini/index.ts` are gone and are now pinned by `mustNotFind` anchors.
- `unused-export` - the compat-layer exported-alias regression on `src/v4/classic/compat.ts` is gone and is now pinned by a `mustNotFind` anchor on `ZodType`.
- `opaque-object-call` on the `issueData` helper path - the same-project aggregate-forwarding false positives routed through `src/v3/helpers/parseUtil.ts` are gone and no longer surface as unexpected helper-boundary output.

## Remaining Confirmed False Positives

- `unused-array-element` - 1 current unexpected finding in `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts` on `unrecognized[0]`. This remains the bounded heterogeneous issue-array false positive.

## Remaining Confirmed True Detections

- `unused-file` - `benchmark/corpus/zod-main/packages/zod/src/v4/core/config.ts` remains a required real detection, and `benchmark/corpus/zod-main/packages/zod/src/v4/core/zsf.ts` also remains unreachable and unreferenced under the current package-surface contract.
- `unused-export` - the four Day.js constants in `benchmark/corpus/dayjs-root/src/constant.js` remain trusted required detections and continue to guard against over-preserving exported-but-internal values.
- `unused-nested-path` - the 8 current unexpected `label` and `gender` findings in `benchmark/corpus/zod-main/packages/zod/src/v4/locales/he.ts` are now verified true detections because the matching `regex`, `starts_with`, `ends_with`, and `includes` entries are bypassed by earlier direct-format returns.

## Mixed Or Contract-Sensitive Finding Families

- `unused-object-key` - 245 current unexpected findings. This family is mixed. The returned-carrier false positives are gone; the remaining confirmed false positives are concentrated in the `allProcessors` dispatch table flow. Verified true detections include locale entries like `regex`, `starts_with`, `ends_with`, and `includes` in files that return early before the dictionary fallback. Contract-sensitive compatibility entries remain where locale dictionaries carry labels such as `uuidv4`, `uuidv6`, `template_literal`, and `mac` that the current `_issue.format` type surface does not emit.
- `unused-type` - 3 current unexpected findings remain in `benchmark/corpus/zod-main/packages/zod/src/v4/core/json-schema-generator.ts` and `benchmark/corpus/zod-main/packages/zod/src/v4/core/standard-schema.ts`. These are source-backed but contract-sensitive because they depend on whether the benchmark should treat non-reexported deep types under `./v4/core` as public.

## Remaining Verified Conservative Boundaries

- `computed-property-access` - 970 current unexpected skips across the remaining Zod locale lookup tables and related dynamic reads. Finite `_issue.format` lookups now resolve exactly; the residual boundary is still verified and concentrated in broader string-key and other non-finite lookup families. Representative examples: `benchmark/corpus/zod-main/packages/zod/src/v4/locales/he.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/locales/ar.ts`, `benchmark/corpus/zod-main/packages/zod/src/v4/core/schemas.ts`.
- `object-spread` - 12 current unexpected skips. Verified conservative boundary around spread-built object wrappers whose exact child propagation is still intentionally cut off.
- `dynamic-array-index` - 2 required skips in `benchmark/corpus/dayjs-root/src/locale/en.js`. Verified conservative boundary around indexed collection access.
- `returned-object` - 4 current unexpected skips. These remain the honest conservative boundary for bounded returned values whose later readback is not yet preserved through the exact subset. The current bucket now also includes the spread-built `util.issue(...)` wrapper flow that no longer misreports direct dead fields but still stops at an explicit boundary.
- `opaque-object-call` - 2 current unexpected skips. Verified conservative boundary around object helper calls that still escape exact local analysis.
- `array-append-mutation` - 1 required skip in `benchmark/corpus/zod-main/packages/zod/src/v4/core/json-schema-processors.ts`. Verified conservative boundary around append-driven collection growth.
- `array-opaque-mutation` - 1 residual unexpected skip at `benchmark/corpus/zod-main/packages/zod/src/v3/types.ts` where `createZodEnum()` stores the `keys` array by reference beyond exact local analysis.

## Benchmark Mistakes

- `unused-local` - the former Day.js required finding was a benchmark mistake. `meridiemFunc` in `benchmark/corpus/dayjs-root/src/index.js` is directly called by the `a` and `A` format cases, so the benchmark now treats it as `mustNotFind`.

## Next Change Sequence

1. Resolve the returned-carrier and bounded issue-array readback false positives so `write-only-state` falls from `4`, the non-locale `unused-object-key` subfamily keeps shrinking, and `unused-array-element` falls from `1`.
2. Extend finite keyed-read precision only for the remaining `allProcessors` false-positive subfamily while keeping genuinely dead or compatibility-only locale entries such as `uuidv4`, `uuidv6`, `template_literal`, and `mac` reportable.
3. Tackle the conservative boundary families in explicit follow-up slices: `computed-property-access` (`970`), `object-spread` (`12`), `returned-object` (`4`), `array-spread` (`2`), `opaque-object-call` (`2`), `dynamic-array-index` (`2`), `array-opaque-mutation` (`1`), and `array-append-mutation` (`1`).
4. Revisit the contract-sensitive `unused-type` family only after the package-surface decision is explicit, so a later change does not accidentally erase correct internal-only detections.
5. Keep rerunning `npm run benchmark` after each slice and append the observed family deltas here so no benchmark family drops out of follow-up planning.