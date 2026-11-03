---
name: feature
description: "Playbook: design, build and prove a new capability or behavior change in a codebase. Use when asked to add, build, implement, support, wire up, extend or create a feature, option, endpoint, screen, command or integration."
metadata:
  bridge-kind: playbook
  bridge-family: code
  bridge-label: Feature
  bridge-evidence: live
---

# Feature

You own the feature from its data shape to proof on the real surface it changes.

## Steps

1. Restate the feature and the smallest version that meets the user's goal. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition a person could check.
   - Load any skill that <skill_roles> lists as extending `feature` and add its steps where it says.
2. Name the data shape first: the types, records, payloads or files the feature reads and writes, and where each one lives. Write it down before any code.
3. Read the repository's instruction files for the areas you will touch and find the existing pattern for the same kind of thing; reuse it.
4. List what is in scope and what is out, with the assumptions you made.
5. If the change crosses a module boundary (a public API, a storage schema, a protocol, a shared component), compare two designs before writing code: two sub-agents with the task tool, or the `panel-review` helper. Pick one and record the choice and reason with task_history_add.
6. Build in small ordered steps, each leaving the tree working: data shape and storage, then logic, then the surface, then docs. Leave changes uncommitted unless the user asked for commits or the repository's instructions say to commit. If you commit, stay on the current branch unless it is the default branch; then create a working branch named the way the user's instructions say. Never switch branches over uncommitted work.
7. Run the repository's checks for the touched areas after each step and fix failures before the next one.
8. Add tests where the repository's test rules call for them, at the layer that owns the behavior.
9. Verify on the matching real surface: run the app, call the API, run the command. For UI, take screenshots at the widths and themes the project cares about and look at them.
   - Use the skill that fills the `verify` role when <skill_roles> lists one; if none, use the tools available and say which.
10. Update the docs that describe the changed behavior.
11. For pull request mechanics, hand off to the `pr-to-merge-ready` playbook.

## Gates

Proceed without asking: design comparison, edits, commits the user or repository asks for, local runs, test and preview environments, pushing a new branch the user asked a pull request for.

Ask first with ask_user: changing a public API or storage format other people depend on, data migrations that cannot be undone, pushing to a shared or default branch, force-pushing, merging, deploying.

## Done means

The feature works on the real surface, not only in tests. Call verify_complete with a `live` entry per surface you checked (with screenshot paths or output), `tested` for automated runs, and `reviewed` if a design or code review ran:

`verify_complete({ summary, evidence: [{ kind: "live", claim, ref, result }, { kind: "tested", claim, ref, result }], unverified })`

## Reply

What the feature does now, how it was checked (with screenshots published via publish_visual for UI), any commits or pull request, and what is not covered.
