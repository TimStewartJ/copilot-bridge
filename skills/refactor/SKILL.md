---
name: refactor
description: "Playbook: restructure code without changing what it does, and prove the behavior is identical afterward. Use when asked to refactor, clean up, simplify, rename, move, split, merge, extract, dedupe, remove dead code or migrate callers off an old API."
metadata:
  bridge-kind: playbook
  bridge-family: code
  bridge-label: Refactor
  bridge-evidence: tested
---

# Refactor

You own a behavior-preserving change: the code is different afterward and nothing it does is.

## Steps

1. Restate the structural goal and the smallest change that reaches it. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `refactor` and add its steps where it says.
   - If the user also wants behavior to change, split that part out to `feature` or `bug-fix`.
2. Name the boundary: which code moves or changes shape, and which public behavior (outputs, APIs, file formats, UI) must stay the same.
3. Run the existing tests for the area. Where coverage is thin, capture representative results at the boundary from step 2, not a trace of how the old code produced them.
4. Subtract first: remove dead code, unused exports and stale flags as a separate step, proving each is unused with a search and a passing check.
5. Introduce the new structure next to the old one.
6. Migrate every caller, then delete the old API in the same wave. Keep a compatibility shim only when callers outside the repository need it.
7. Keep steps small and ordered, each one passing the repository's checks. Leave changes uncommitted unless the user asked for commits or the repository's instructions say to commit. If you commit, stay on the current branch unless it is the default branch; then create a working branch named the way the user's instructions say. Never switch branches over uncommitted work.
8. Rerun the checks and compare results at the named boundary. A difference there is a behavior change. If a test fails only because a private call changed, check the outcome it protected rather than restoring the old call. Keep call counts when they are the promise, such as sending a payment only once.
9. Run the broader check lane and the type checker for the repository.
10. For pull request mechanics, hand off to the `pr-to-merge-ready` playbook.

## Gates

Proceed without asking: edits, commits the user or repository asks for, characterization tests, local runs, deleting code you proved unused.

Ask first with ask_user: removing or renaming an API used outside the repository, keeping a behavior difference found in step 8, pushing to a shared branch, force-pushing, merging, deploying.

## Done means

Checks of the named public behavior give the same results before and after. Call verify_complete with a `tested` entry naming the before and after runs, plus `fixed` if step 8 found and fixed a difference:

`verify_complete({ summary, evidence: [{ kind: "tested", claim: "same results before and after", ref, result }], unverified })`

## Reply

What changed structurally, what was deleted, the before and after comparison, and any behavior difference with its approval.
