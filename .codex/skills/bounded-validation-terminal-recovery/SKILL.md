---
name: bounded-validation-terminal-recovery
description: 'Run safe bounded validation and recover from timed-out or hung terminals in this repo. Use when debugging failing tests, self or self:json runs, custom node probes, focused vitest checks, or deciding whether to inspect output, kill a terminal, narrow scope, and run final repo validation gates.'
argument-hint: 'What command, validation slice, or terminal recovery problem are you handling?'
---

# Bounded Validation and Terminal Recovery

Use this skill when the task involves validation, debugging, self-host checks, timed-out terminals, or custom code execution that must stay safe and bounded.

This skill is for two problems:
1. Choosing the narrowest useful validation instead of jumping to broad, slow, or hang-prone commands.
2. Recovering cleanly when a terminal command times out or appears stuck.

## When to Use

- A test, `self`, or `self:json` run timed out or may be hung.
- You need to decide whether to inspect terminal output, keep waiting briefly, or kill the terminal.
- You need a focused validation after editing code.
- You need to run a custom `node` or shell probe safely.
- You are finishing a full implementation and need the repo's final validation order.

## Core Rules

1. Start with the cheapest discriminating check.
2. Do not start with `npm run test` unless the user explicitly asks for broad-suite validation or the bug has already been narrowed to suite scope.
3. Every custom code command must use an explicit timeout.
4. A timeout is not automatically a hang.
5. Never rerun the same timed-out command unchanged. First inspect, classify, and then either narrow, instrument, or kill.
6. Kill stale terminals once you have the result you need.

## Command Selection Ladder

Choose the smallest command that can falsify the current hypothesis.

1. If the edit is local and compile-scoped, run `npm run build`.
2. If behavior is covered by one test or one test name, run `npx vitest run -t "..."`.
3. If self-host or tracking behavior is under investigation, prefer a bounded `node --input-type=module <<'EOF'` probe that prints compact JSON.
4. If machine-readable self-host output is needed, run `npm --silent run self:json`.
5. Use `npm run prep` only at the end of a full task, not as the first debugging step.

## Tool Choice

Use `run_in_terminal` when you need any of the following:
- an explicit timeout
- full output
- terminal lifecycle control
- a live command that might need inspection or termination

Use `execution_subagent` for one-shot execution tasks when summarized output is enough and terminal control is not part of the job.

For this skill, default to `run_in_terminal` for focused validation, self-host commands, and custom probes because timeout and recovery behavior matter.

## Timeout Policy

Do not hardcode one timeout for every command.

Choose a timeout by command class:
- Short probe: just long enough to emit the first useful signal.
- Focused validation: long enough for a healthy single-slice command to finish.
- Broader repo gate: long enough for the intended gate, but still bounded.

If unsure, choose a smaller timeout first, then inspect once instead of leaving the command unbounded.

## Timeout Recovery Protocol

After a timeout, do this in order:

1. Call `get_terminal_output` once.
2. Classify the command state as one of:
   - `completed`
   - `progressing`
   - `stalled`
   - `wrong-scope`
3. Act based on that classification.

### Completed

- Record the result.
- Kill the terminal if it is still persistent.
- Move to the next validation or fix.

### Progressing

Treat the command as slow, not hung, when output shows real forward motion, such as:
- the target test file or command banner started normally
- the selected focused validation is clearly running
- new output appeared since the previous snapshot
- the command matches the current narrow debugging goal

Allow at most one more observation step if the command is still the right command.

### Stalled

Treat the command as stalled when:
- the output snapshot is materially unchanged across checks
- there is no prompt and no meaningful new output
- the command is stuck before the useful phase
- the command is clearly waiting forever without progress

Kill the terminal. Then replace it with a narrower or more instrumented command.

### Wrong-Scope

Treat the command as wrong-scope when it is broader than the current question, such as:
- running the full suite while debugging one engine slice
- rerunning a broad gate when a file probe would answer the question
- using a validation command that does not target the suspected behavior

Kill the terminal immediately and switch to a tighter command.

## Custom Probe Protocol

When normal validation commands are too coarse, run a bounded custom probe.

Use this style:
- `node --input-type=module <<'EOF'`
- import built `dist` entrypoints when possible
- answer one question only
- print compact JSON
- include safety knobs exposed by the repo surface

In this repo, prefer probes that use existing bounded controls such as:
- `maxPasses`
- `tracePasses`
- `maxPassElapsedMs`
- file-scoped summaries
- filtered finding and skip output

Do not write a probe that tries to solve multiple unrelated questions at once.

## Repo-Specific Validation Rules

Use these repo conventions:

1. Prefer `npx vitest run -t "..."` for targeted validation.
2. Use `npm --silent run self:json` for machine-readable self-host output.
3. Use `npm run build` as the default compile gate after code edits.
4. Do not treat docs, tests, or spec artifacts as part of the build scope. Root `tsconfig.json` only emits `src/**/*.ts`.

## Repo Final Validation Ladder

After a full task is implemented, run:

1. `npm run prep`

If the work touched self-host, tracking, direct wiring, literal ownership, or other engine-owned validation surfaces, also run these focused repo gates:

1. `npm --silent run self:json`
2. `npm run lint:direct-wiring`
3. `npm run lint:literals`
4. `npm run build`

Run the narrower gates first if you are still stabilizing the touched slice. Use `npm run prep` when the task is ready for end-of-task validation.

## Validation After Edits

After each substantive edit:

1. Run the narrowest relevant validation first.
2. If it fails, repair the same slice before widening scope.
3. If it passes, only then move to the next adjacent gate.
4. Do not jump from a local fix straight to broad validation unless there is no narrower executable check.

## Completion Criteria

The skill has been applied well when all of the following are true:

1. The chosen validation command matches the current question.
2. Every custom command used an explicit timeout.
3. Any timed-out command was classified before retrying.
4. Stale or completed terminals were cleaned up.
5. The touched slice passed its focused validation.
6. End-of-task validation used the repo's final gate order instead of an ad hoc command list.

## Example Prompts

- `/bounded-validation-terminal-recovery debug this timed out self:json run safely`
- `/bounded-validation-terminal-recovery choose the right validation flow for this tracking fix`
- `/bounded-validation-terminal-recovery help me run a bounded custom node probe for a self-host regression`
- `/bounded-validation-terminal-recovery decide whether this vitest timeout is a hang or just slow progress`