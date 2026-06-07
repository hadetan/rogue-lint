# Proof Perimeter

This document defines what is **inside** and **outside** the proof perimeter for the `rogue-lint` analysis engine. It is a binding invariant, not a guideline.

## The Rule

> The engine MAY emit a `finding` only for code that is fully resolvable through static type-graph traversal, without invoking inference across opaque call boundaries, dynamic access, or cross-function runtime state.
>
> Everything else MUST emit an explicit `skipped` entry with a named `category` and a human-readable `reason`.

Silently omitting a `skipped` entry at a known boundary is a bug, not a conservative choice.

## Inside the Perimeter

The engine may emit findings for these patterns:

| Pattern | Notes |
|---------|-------|
| File reachability from declared entrypoints | Module graph traversal — purely syntactic |
| Import / export / type / enum symbol liveness | TypeScript symbol table — no inference required |
| Local value liveness within a single function body | Only when the value does not escape into callbacks or closures |
| Class and interface member liveness | Only when references are statically typed to the declaring type |
| Object and array literal keys/elements | Only when access is by exact static string/index in the same or immediately outer scope |
| `write-only-state` for local variables | Only when the variable is never read in any path, provably within the same function body |

## Outside the Perimeter (must emit `skipped`)

The engine must NOT emit findings for these patterns — emit `skipped` instead:

| Pattern | Skip Category |
|---------|---------------|
| Helper-call return-shape transport across function boundaries | `helper-call-boundary` |
| Object-path overlays propagated through callback arguments | `callback-argument` |
| Value transport through `Array.push` / `Map.set` or other mutating collection methods | `collection-mutation-boundary` |
| Returned-wrapper or returned-structure transport beyond one call site | `returned-structure-transport` |
| Finite-dynamic-key reasoning (even "bounded" — requires corpus assumptions) | `computed-property-access` |
| Any value whose liveness requires tracking through more than one object literal indirection | `multi-hop-object-transport` |
| Carrier method transport (even when carrier config is present) | `carrier-transport-boundary` |
| Fixpoint-based inference that cannot terminate in a single pass | `unbounded-fixpoint` |

## Corpus-Specific Code is Prohibited

The engine MUST NOT contain branching logic that names a specific library, framework, or package (e.g., Zod, Day.js, React) as a condition for applying a different analysis strategy.

All carrier, helper, or transport configurations must flow through the project's `rogue-lint.config.json` without the engine having opinions about the specific namespace or method names.

## Expanding the Perimeter

Any future expansion of the proof perimeter — promoting a previously-`skipped` pattern to a `finding` — requires ALL of the following before merging:

1. A **synthesized fixture** under `test/fixtures/` that demonstrates the pattern in isolation (not borrowed from a real project corpus).
2. A **proven bound** on iteration and recursion depth for the new analysis path (no new unbounded fixpoints).
3. **Zero new findings** on existing benchmark snapshots — only `skipped→finding` transitions, each manually auditable.
4. The pattern must be expressible without naming any specific library or npm package in a branch condition.

Failing any one of these four gates means the pattern stays in `skipped`.
