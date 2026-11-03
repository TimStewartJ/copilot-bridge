---
name: bug-fix
description: "Playbook: reproduce a defect, find its cause with runtime evidence, make the smallest fix and prove it on the same surface. Use when something is broken, crashes, errors, regressed, behaves wrongly, shows the wrong thing, or the user says fix this bug, it stopped working, or this fails."
metadata:
  bridge-kind: playbook
  bridge-family: code
  bridge-label: Bug fix
  bridge-evidence: reproduced, fixed
---

# Bug fix

You own the fix from the first reproduction to before-and-after proof on the surface where the bug shows.

## Steps

1. Restate the bug as observed versus expected behavior and the smallest outcome that fixes it. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition (for example "the repro command exits 0").
   - Load any skill that <skill_roles> lists as extending `bug-fix` and add its steps where it says.
2. Reproduce the bug yourself on the same surface the user saw it (same screen, command, API, environment and data shape) and save the failing output, log or screenshot.
   - Ask the user only when you cannot reach that surface, and give the specific reason (missing access, hardware, a state only they have).
   - If you cannot reproduce it, record what you tried and do not claim a fix.
3. List hypotheses for the cause and binary-search them with runtime evidence: logs, a debugger, temporary instrumentation, a narrowed input. Each check should rule out about half of what remains.
4. When two fixes fail on the same premise, stop fixing and test the premise itself.
5. Revert every change a refuted hypothesis motivated, including temporary instrumentation, before you go on. Once the evidence confirms a root cause, record it and its evidence with task_history_add when the chat has a task.
6. Make the smallest fix the evidence justifies, at the place that causes the bug rather than where the symptom shows.
7. Rerun the exact reproduction from step 2 and keep the failing-then-passing output (or before and after screenshots) to paste in the reply.
8. Add a regression test only where it is cheap and the repository's test rules call for one; extend an existing test before writing a new one. Run the checks for the area you touched.
9. Check the neighbors the fix could break (other callers, the other platform, empty and error inputs) on the real surface.
10. Leave changes uncommitted unless the user asked for commits or the repository's instructions say to commit. If you commit, stay on the current branch unless it is the default branch; then create a working branch named the way the user's instructions say. Never switch branches over uncommitted work. A commit message names the cause.
11. For pull request mechanics, hand off to the `pr-to-merge-ready` playbook, which uses the skill that fills the `code-host` role.

## Gates

Proceed without asking: reading, running locally, instrumentation, edits, commits the user or repository asks for, local tests, pushing a new branch the user asked a pull request for.

Ask first with ask_user: pushing to a shared or default branch, force-pushing, merging, deploying, changing production data or shared configuration, deleting anything you did not create.

## Done means

The same check that failed before passes after. Call verify_complete with a `reproduced` entry (the failing output from step 2) and a `fixed` entry (the same check passing), plus `tested` for automated tests and `live` for the neighbor checks:

`verify_complete({ summary, evidence: [{ kind: "reproduced", claim, ref, result }, { kind: "fixed", claim, ref, result }], unverified })`

A reproduction that shows the bug is `reproduced` with result "pass". If you could not reproduce the bug, record `reproduced` with result "fail", say so in the summary and do not claim it is fixed.

## Reply

The cause, the fix with file references, the failing-then-passing output, what you did not verify, and any commit, branch or pull request.
