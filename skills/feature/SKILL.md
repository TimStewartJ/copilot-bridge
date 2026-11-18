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
   - Shape it so wrong states cannot be built and data is checked once where it enters (principles skill: Model the domain, Type-system discipline, Boundary discipline).
3. Read the repository's instruction files for the areas you will touch and find the existing pattern for the same kind of thing; reuse it.
4. List what is in scope and what is out, with the assumptions you made.
5. If the change crosses a module boundary (a public API, a storage schema, a protocol, a shared component), compare two designs before writing code: two sub-agents with the task tool, or the `panel-review` helper. Pick one and record the choice and reason with task_history_add.
   - Prefer the design where each piece of state has one owner, each task has one way to do it, and callers need to know least. Fold the requirement in as if it was always there (principles skill: Redesign from first principles).
   - When a UI or behavior choice can be settled by trying it, try variants before choosing (principles skill: Prototype the choice).
6. Build in small ordered steps, each leaving the tree working: data shape and storage, then logic, then the surface, then docs. Leave changes uncommitted unless the user asked for commits or the repository's instructions say to commit. If you commit, stay on the current branch unless it is the default branch; then create a working branch named the way the user's instructions say. Never switch branches over uncommitted work.
   - Steps that change state must be safe to retry: a rerun after a crash converges, while a new request stays new. Concurrent writers get separate targets before any lock (principles skill: Make operations idempotent, Separate before serializing).
   - For a UI change meant to look the same, capture baseline screenshots before the first edit. Step 9 compares by image diff; never edit the baseline to make it pass.
   - For a screen, weigh the user's experience over implementation convenience (principles skill: Experience first) and keep the purpose, layout and implementation simple. Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout. Keep a sentence only where the reader would otherwise get a consequence wrong, and for errors.
7. Run the repository's checks for the touched areas after each step and fix failures before the next one.
8. Test the failure that matters to a caller or user, at the layer that owns the behavior. Reuse an existing check when it already catches that failure; add a case for a distinct risk, following the repository’s test rules.
   - Name the one fact the change is safe because of and prove it by running code (principles skill: Prove the safety fact).
9. Verify on the matching real surface: run the app, call the API, run the command. For UI, take screenshots at the widths and themes the project cares about and check them against the screen rule in step 6.
   - Use the skill that fills the `verify` role when <skill_roles> lists one, or the project's own verify skill in the skill list. If there is none, use the tools available, say which, and suggest the `verify-setup` helper when the project will be verified again.
   - When the change is about speed, size or cost, report the number with n and spread, or say it is a single run (principles skill: Explain the number).
10. Update the guide someone uses to do the work today. Remove obsolete directions or mark a retained decision as superseded; an old design note alone is not a reason to keep its implementation.
11. For pull request mechanics, hand off to the `pr-to-merge-ready` playbook.

## Gates

Proceed without asking: design comparison, edits, commits the user or repository asks for, local runs, test and preview environments, pushing a new branch the user asked a pull request for.

Ask first with ask_user: changing a public API or storage format other people depend on, data migrations that cannot be undone, pushing to a shared or default branch, force-pushing, merging, deploying.

## Done means

The feature works on the real surface, not only in tests. Call verify_complete with a `live` entry per surface you checked (with screenshot paths or output), `tested` for automated runs, and `reviewed` if a design or code review ran:

`verify_complete({ summary, evidence: [{ kind: "live", claim, ref, result }, { kind: "tested", claim, ref, result }], unverified })`

## Reply

What the feature does now, any preview, commit or pull request link (with UI screenshots published via publish_visual), and any material gap not covered. When a verify_complete card is in the chat, leave the check-by-check proof to the card unless asked; sub-agents return their evidence directly.
