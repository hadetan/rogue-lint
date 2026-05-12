---
description: Review code changes in a repository — deep logic analysis with fix capability
---

Review code changes in a repository.

**Input**: Optionally specify a repo and branch (e.g., `/review truelycrack-backend main`). If omitted, you'll be prompted to select.

**Steps**

1. **Select the repository**

   If specified, use it. Otherwise:
   - Auto-select if only one repo exists
   - If multiple, prompt the user to pick one using the **AskUserQuestion tool**

2. **Select the comparison branch**

   Detect the current branch and list available branches. Use the **AskUserQuestion tool** to let the user pick:
   - The base branch (e.g., `main`) as the recommended default
   - Other available branches
   - "Working changes (uncommitted)" for reviewing staged/unstaged changes

3. **Get the diff**

   - Branch comparison: `git diff <branch>...<current> --stat` then full diff
   - Working changes: `git diff` and `git diff --staged`
   - For large diffs (>3000 lines), process in logical groups — always do a full review

4. **Understand the logic BEFORE reviewing** (critical step)

   - Read the **full files** that were changed, not just the diff hunks
   - For deleted files, read the old version from git to understand what was removed
   - Trace execution paths end-to-end: old flow vs new flow
   - Grep for removed identifiers (functions, IPC channels, events, exports) to catch dangling references
   - Read related files the diff doesn't touch if the change affects cross-module behavior

5. **Review the changes** across these dimensions (skip dimensions with zero findings):
   - **Design**: Overall structure, coupling, complexity, over-engineering
   - **Correctness**: Trace actual code paths — state bugs, race conditions, error paths, edge cases, data contract mismatches, removed-code gaps
   - **Security**: Injection, secrets, missing validation, privilege escalation
   - **Performance**: Redundant work, N+1 queries, memory leaks, unbounded operations
   - **Breaking changes**: Removed APIs/channels/events, schema changes, behavior changes
   - **Tests**: Missing tests, broken tests, coverage of edge cases
   - **Style**: Only deviations from existing codebase conventions

6. **Present the review** as a structured report:
   - **What This Change Does**: 2-3 paragraph plain-language explanation of old vs new behavior
   - **Files Changed**: Table with logical descriptions (not just "modified")
   - **Findings**: Grouped by feature area, each with severity, exact location, traced code-flow explanation, impact, and **concrete code fix**
   - **Good Stuff**: Genuinely well-done things (skip if nothing stands out)
   - **Verdict**: Is this safe to merge?

7. **Offer to fix**

   After the review, if there are critical/warning findings with concrete fixes, ask: "Want me to apply fixes?" with options:
   - Fix all critical & warning issues (recommended)
   - Fix critical only
   - Let me pick which to fix
   - No, just the review
