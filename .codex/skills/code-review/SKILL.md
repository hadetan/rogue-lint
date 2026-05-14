---
name: code-review
description: Review code changes in a repository against a branch or working tree. Produce a persistent markdown review artifact first, verify touched-file behavior and dead surface, then optionally fix issues from that artifact.
license: MIT
metadata:
  author: hadetan
  version: "3.0"
---

Review code changes by creating a persistent markdown review artifact first, then filling it with verified findings. Read changed code in full. Cross-check dead surface. Trace real control flow. If the user wants fixes, use the artifact as the only source of truth.

**Input**: Optional repo name and/or comparison branch. If omitted, ask the user.

## Core Contract

- Create the review artifact before deep analysis. Keep it updated as each file is verified.
- Touched-file scan is mandatory. Start from concrete anchors in the changed files.
- Dead-surface scan is mandatory on every touched file: exports, returned object members, public helpers, IPC/event names, config keys, compatibility shims, fallback branches.
- Large diffs must be triaged before deep reading. Use stats first. Raw repo-wide diff later only when the size is safe.
- A symbol is live only when you verify a real consumer or a real external contract.
- Declaration-only, self-only, docs-only, spec-only, and historical-comment hits do not count as live usage.
- Test-only usage does not justify runtime public surface unless a nearby runtime contract proves the API is intentionally external.
- Unreachable fallback code counts as dead code.
- Every finding needs evidence from code, search, or tool output. No guesses. No “might be”.
- Write short, direct findings. High signal. No filler.
- If you later fix issues, reread the review artifact first. If the artifact is wrong, re-verify and update it before editing code.

## 1. Pick The Repository

Detect git repositories in the workspace:

```bash
find . -maxdepth 2 -name ".git" -type d 2>/dev/null | sed 's|/\.git$||' | sed 's|^\./||' | sort
```

- If the user named a repo, use it.
- If only one repo exists, auto-select it and announce it.
- If multiple repos exist, use `vscode_askQuestions`:
  - Header: `Repository`
  - Question: `Which repository do you want reviewed?`
  - Options: one per repo

Announce the selected repo clearly.

## 2. Pick The Comparison Target

Get current branch and nearby local branches:

```bash
git -C <repo_path> rev-parse --abbrev-ref HEAD
git -C <repo_path> branch --list --format='%(refname:short)' | head -30
```

Use `vscode_askQuestions` when the user did not specify a target:

- Header: `Compare against`
- Question: `Review <current_branch> against which target?`
- Options:
  - default branch such as `main` or `master` — recommended
  - other local branches, excluding current branch
  - `Working changes (uncommitted)`

Comparison modes:

- Branch review:

```bash
git -C <repo_path> diff --stat <base_branch>...<current_branch>
git -C <repo_path> diff --numstat <base_branch>...<current_branch>
git -C <repo_path> diff --name-status <base_branch>...<current_branch>
git -C <repo_path> diff --summary <base_branch>...<current_branch>
git -C <repo_path> diff --dirstat=files,0 <base_branch>...<current_branch>
```

- Working tree review:

```bash
git -C <repo_path> diff --stat
git -C <repo_path> diff --numstat
git -C <repo_path> diff --staged --stat
git -C <repo_path> diff --staged --numstat
git -C <repo_path> diff --name-status
git -C <repo_path> diff --staged --name-status
git -C <repo_path> diff --summary
git -C <repo_path> diff --staged --summary
git -C <repo_path> diff --dirstat=files,0
git -C <repo_path> diff --staged --dirstat=files,0
```

## 2b. Decide Standard Mode vs Large-Diff Mode

Do not load the full raw diff yet. Decide the review mode from size first.

Enter `large-diff` mode when any of these is true:

- raw diff output would be truncated or clearly too large to read safely
- total changed lines are roughly `2000+`
- touched files are roughly `25+`
- any single file changes roughly `800+` lines
- the change spans multiple feature areas, runtime boundaries, or directories

Use `standard` mode only when the full diff is still small enough to inspect without losing control of the review.

### Standard mode

- You may read the full diff after the inventory commands above.
- Still verify files one by one and write the artifact incrementally.

### Large-diff mode

Large-diff mode changes the algorithm. Scope stays the same. Reading strategy changes.

1. Build a batch plan before deep reads.
2. Batch by feature area, runtime boundary, risk, or owning directory. Do not batch alphabetically.
3. Keep each batch small enough to reason about. Target `3-8` files or roughly `400-1200` changed lines.
4. If one hot file dominates a batch, isolate it.
5. Review batch-scoped diffs, not the whole repo diff.
6. Update the artifact after each batch.
7. Run one cross-batch integration pass at the end.

Use these batch types:

- `high-risk logic`: auth, IPC, preload/bridge, permissions, migrations, concurrency, lifecycle, cleanup, public APIs
- `public surface`: exports, return contracts, routes, commands, config, event names
- `mechanical`: generated files, lockfiles, snapshots, formatting-only moves, mass renames, docs

Large-diff rules:

- Prioritize high-risk batches first.
- For generated, minified, vendored, or lock files, do not waste budget on line-by-line reading unless the file is hand-edited or is the real source of truth.
- Prefer reviewing the generator, source file, or build config that produced a mechanical artifact.
- For delete- or rename-heavy batches, verify dangling references before reading deep implementation details.
- If a batch still feels too large, split again by owning abstraction or boundary.
- Never reduce scope. Batching is how you finish the whole review safely.

Suggested commands for large-diff batches:

```bash
# Branch review
git -C <repo_path> diff -U0 <base_branch>...<current_branch> -- <path_or_paths>
git -C <repo_path> diff --stat <base_branch>...<current_branch> -- <path_or_paths>
git -C <repo_path> diff --numstat <base_branch>...<current_branch> -- <path_or_paths>
git -C <repo_path> diff --summary <base_branch>...<current_branch> -- <path_or_paths>

# Working tree review
git -C <repo_path> diff -U0 -- <path_or_paths>
git -C <repo_path> diff --stat -- <path_or_paths>
git -C <repo_path> diff --numstat -- <path_or_paths>
git -C <repo_path> diff --staged -U0 -- <path_or_paths>
git -C <repo_path> diff --staged --stat -- <path_or_paths>
git -C <repo_path> diff --staged --numstat -- <path_or_paths>
```

Read full files only after a batch or file is chosen for real verification.

## 3. Create The Review Artifact First

The review file lives under a clean `reviews/` tree.

Path rule:

- Create `reviews/` at the workspace root you started the review from.
- If the workspace root contains more than one project/repo, use `reviews/<repo_name>/`.
- If the workspace root contains only the selected repo, use `reviews/`.

Name rule:

- Use a stable, descriptive markdown filename.
- Recommended pattern:

```text
YYYY-MM-DD-<repo_name>-<head>-vs-<target>.md
```

- For uncommitted review, use `working-tree` as the target.
- Reuse the same file only when clearly continuing the same review. Otherwise create a new file.

Git-ignore rule:

- Check the directory where `reviews/` will be created.
- If that directory is inside a git repository, ignore the generated review tree explicitly.
- Prefer `.git/info/exclude` so tracked files stay clean.
- If `.git/info/exclude` is unavailable, update `.gitignore` carefully.
- Never duplicate ignore entries.
- If the directory that will contain `reviews/` is not under git, skip ignore handling.

Seed the artifact immediately with frontmatter and empty sections.

Use this template:

```markdown
---
repo: <repo_name>
compare_mode: branch | working-tree
review_mode: standard | large-diff
base: <base_branch_or_working_tree>
head: <current_branch_or_working_tree>
status: in-progress
created_at: <iso8601>
updated_at: <iso8601>
touched_files: <count>
batch_count: 0
finding_counts:
  critical: 0
  warning: 0
  suggestion: 0
  uncertain: 0
---

# Code Review: <repo_name>

## Scope

- Repo: `<repo_name>`
- Compare: `<head>` vs `<base_or_working_tree>`
- Review artifact: `<review_path>`

Decision rule used throughout this document:

- Exported symbols, returned members, IPC/event names, public helpers, compatibility shims, config keys, and fallback branches must have a verified live consumer or a verified external contract.
- Declaration-only, self-only, docs-only, spec-only, and tests-only references do not count by themselves.
- Published package entrypoints, CLI registrations, framework hooks, route registration, preload exposure, and other verified external boundaries do count when you prove that boundary exists.
- Fallback code that cannot execute in real control flow counts as dead code.
- If later implementation proves this file wrong, re-verify and update this file first.

## Touched Files

## Review Batches

## File Findings

## Cross-File Findings

## Risk Summary

## Fix Plan

## Execution Outcome
```

## 4. Build The Touched-File Inventory

Write the scope into `## Touched Files` before deep analysis.

For each changed file, record:

- path
- change type: added, modified, deleted, renamed
- changed lines or size hint from `--numstat`
- risk level: high, medium, low
- batch id when `large-diff` mode is active
- short purpose note

This inventory is the review boundary. Do not drift broadly. Leave the boundary only for one-hop verification reads.

Concrete anchors to extract from touched files:

- exports and default exports
- changed functions, methods, classes, hooks
- returned object members from factories, registrars, hooks, services
- IPC channels, event names, commands, routes, preload exposures
- config keys, env names, feature flags
- fallback branches, compatibility helpers, legacy adapters

When `large-diff` mode is active, fill `## Review Batches` before deep reads.

Use a short structure like this:

```markdown
### Batch 1: IPC and preload surface
- Risk: high
- Paths: `server/electron/ipc/*`, `server/electron/preload.js`
- Why grouped: shared runtime boundary
- Status: pending | in-progress | done

### Batch 2: Mechanical outputs
- Risk: low
- Paths: `pnpm-lock.yaml`, `docs/*`
- Why grouped: generated or documentation-heavy
- Status: pending | in-progress | done
```

Process one batch at a time. After each batch:

- update batch status
- add file findings for completed files
- add cross-file findings discovered inside that batch
- note new follow-up reads needed for later batches

## 5. Verify Each Touched File

For each touched file, do the full check before moving on. Write the file section into the artifact immediately after verification. Do not wait until the end.

### 5a. Read Full Context

- In `large-diff` mode, start from the current batch only. Do not jump across the entire diff.
- Read the full current file, not just diff hunks.
- For deleted files, read the old version from git.
- Use `<comparison_ref>`:
  - `<base_branch>` for branch review
  - `HEAD` for working-tree review

```bash
git -C <repo_path> show <comparison_ref>:<file_path>
```

- If the touched file mostly wires or forwards behavior, hop once to the owning logic that actually computes, mutates, or decides the behavior.
- Read neighboring callers or callees only as needed to prove or disprove a concrete claim.

### 5b. Cross-Check Live Surface

For every touched file, verify whether changed public surface is live, stale, or externally contracted.

Always inspect:

- exported values, functions, classes, constants, types, default exports
- members returned from `return { ... }`
- registration side effects such as routes, commands, IPC handlers, event listeners, preload exposure
- fallback branches and compatibility paths

Use concrete searches. Examples:

```bash
git -C <repo_path> grep -rn "<identifier>" -- '*.js' '*.jsx' '*.ts' '*.tsx' '*.json' '*.md'
git -C <repo_path> grep -rn "<event_or_ipc_name>" -- '*'
```

For large diffs, prefer searching first and then reading only the owning files instead of sweeping broad directories repeatedly.

Use symbol-usage tooling when available for exact call sites.

Decision rules:

- Exported symbol with no verified consumer and no verified external boundary: dead surface.
- Returned member never read by callers: dead returned surface.
- Public helper used only inside its own file: make it local or remove it.
- Compatibility helper kept only for deleted call paths: dead code.
- Test-only public method with no runtime consumer: stale runtime surface unless the external contract is proven.
- Fallback branch blocked by earlier guards, exhaustive branching, platform constraints, or registration flow: dead code.
- If you cannot prove liveness or deadness from the current file, take one nearby read. If still unresolved, mark `uncertain` and explain why.

### 5c. Trace Real Behavior

Review actual behavior, not diff text. Trace the changed flow end to end.

Check for:

- correctness bugs, stale state, missed resets, wrong defaults
- async ordering bugs and race conditions
- error-path leaks and missing cleanup
- boundary mismatches: sender vs receiver, caller vs callee, renderer vs main, client vs server
- removed logic gaps where old behavior handled a case and new behavior does not
- upcoming bugs implied by the new control flow

### 5d. Scan Security And Trust Boundaries

Review security with project context, not generic fear.

Check project instructions and security docs when present, then verify touched boundaries for:

- injection: SQL, shell, path, template, HTML
- missing validation on IPC, API, CLI, file system, URL, env, or settings boundaries
- privilege escalation or overexposed bridge/preload surface
- auth and authorization gaps
- secret leakage in code, logs, errors, telemetry, or fixtures
- vulnerable fallback behavior such as permissive defaults after failures

### 5e. Scan Performance And Resource Lifetime

Only flag issues with real impact.

Check for:

- N+1 or repeated heavy work
- unbounded loops, queries, retries, or buffers
- event listeners, streams, timers, subscriptions, windows, sessions, or sockets not cleaned up
- unnecessary main-thread or hot-path work

### 5f. Check Compatibility, Tests, And Bad Practice

Check for:

- breaking changes to public APIs, IPC names, config shapes, migrations, entrypoints
- missing or stale tests for newly introduced behavior or edge cases
- bad practices only when they create real bug, security, performance, or maintenance risk

Do not spend review budget on formatting or personal-preference style complaints.

### 5g. Write The File Section Immediately

Use this per-file structure in `## File Findings`:

```markdown
### path/to/file

Verified surface:
- <exports, returned members, handlers, fallbacks, or other public surface checked>

Cross-check performed:
- <searches, readers, runtime-owner checks, or contract verification used>

Findings:
- [warning][dead-surface] <short direct claim>
- [critical][security] <short direct claim>
- `None.` when the file is clean after verification

Decision:
- <keep / remove / localize / rename / rewire / add test / no change>
```

Write in short, direct sentences. Evidence first. No padded prose.

## 6. Re-Read The Artifact Before Presenting The Review

After all touched files are written:

- read the artifact back in full
- if `large-diff` mode was active, confirm every batch is marked `done` or explicitly `uncertain`
- build the final chat summary from that artifact only
- do not invent new findings in chat that are not in the file

Final review response should include:

- what changed, briefly
- highest-severity findings first
- dead-surface summary when relevant
- security or vulnerability findings when relevant
- overall verdict: safe, needs fixes, or blocked
- review artifact path

If there are no findings, say so plainly and mention any residual validation gaps.

## 7. Fix Mode: Use The Artifact As The Source Of Truth

If the user wants fixes or cleanup:

- reread `## File Findings`, `## Cross-File Findings`, and `## Fix Plan`
- apply fixes only for issues recorded there
- if implementation reveals the review file is wrong or incomplete, re-verify that file, update the artifact, then continue
- after each substantive edit, run the narrowest validation available
- update `## Execution Outcome` with what changed, what was validated, and what remains

Ask the user with `vscode_askQuestions` when there are multiple fixable findings:

- Header: `Fix issues`
- Question: `I found fixable issues. What should I fix?`
- Options:
  - `Fix all critical and warning issues` — recommended
  - `Fix critical issues only`
  - `Let me choose specific findings`
  - `No fixes, review only`

If the user chooses specific findings, let them multi-select from the artifact entries.

## Severity Levels

- `critical`: incorrect behavior, data loss, security vulnerability, crash, broken contract, or serious resource leak
- `warning`: real bug risk, dead surface, unreachable fallback, missing cleanup, performance problem, or test gap that should be fixed
- `suggestion`: lower-risk simplification or design improvement with concrete payoff
- `uncertain`: only when the codebase cannot prove the claim after targeted verification

## Critical Rules

- Understand before judging. Read full files and trace real flow.
- The review file comes first. No chat-only review.
- Every touched file gets a written cross-check section.
- Dead-surface verification is required, not optional.
- External contract claims must be proven by real boundaries such as package exports, framework entrypoints, route registration, CLI registration, or preload exposure.
- Docs, specs, and tests can support a claim. They cannot create liveness by themselves.
- Drop non-issues silently.
- Skip empty categories. No filler praise.
- Show concrete fixes for `critical` and `warning` findings when feasible.
- For large diffs, group the final summary by feature area. Keep the artifact file-by-file.
- Do not pull the whole raw diff early just because it exists. Inventory first, batch when needed, then read deeply.
