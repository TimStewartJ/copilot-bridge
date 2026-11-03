---
name: pause
description: "Playbook: stop work at a safe point and leave everything needed to resume it on disk. Use when asked to pause, stop here, park this, put this on hold, wrap up for now, save state, pick this up later, or hand off."
metadata:
  bridge-kind: playbook
  bridge-family: meta
  bridge-label: Pause
---

# Pause

You own leaving the work in a state another chat can resume from what is written down, with nothing important left only in your context.

## Steps

1. Restate what is being paused and why, and the smallest safe stopping point. Keep the task's doneWhen as it is; pausing does not change the finish line.
   - Load any skill that <skill_roles> lists as extending `pause` and add its steps where it says.
2. Stop at a safe boundary: finish or cleanly back out of the current small step, and start nothing new. Let a short running command finish; stop a long one and note it.
3. Make code durable: commit work in progress as a WIP commit on the current branch, unless the user said not to commit. Never commit on a default or shared branch; if you are on one, create a working branch named the way the user's instructions say. Never switch branches over uncommitted work you did not make.
   - Push only if the branch already has a remote copy that is yours alone. Never push a branch that was not pushed before.
4. Make other work durable: save drafts, notes and partial results as files or knowledge base pages with docs_write, and note their paths.
5. Decide what happens to automation in flight: defers, schedules and background commands. Cancel what should not run while paused, keep what should, and note which.
6. Write the current state into the task notes with task_update, replacing the old state rather than appending: goal, what is done with evidence, what is in progress, open questions, decisions not yet written down, branch, worktree and file paths.
7. Set the first resume action with task_update_momentum.
8. If the chat has no task, write the same state to a knowledge base page or a file in the session folder and give its path.

## Gates

WIP commits on a working branch, writing notes and drafts, and cancelling automation this chat created proceed without asking. Ask first before pushing to any branch others use, deleting anything, or cancelling automation someone else set up. Do not mark the task done or set it aside unless the user asked.

## Done means

A fresh chat could resume from what is on disk. Call verify_complete with `delivered` entries for the commit, notes and files you wrote, and a summary that says where the work stopped and why; that is the history entry for the pause:

`verify_complete({ summary, evidence: [{ kind: "delivered", claim: "state written to task notes", result }, { kind: "delivered", claim: "WIP commit", ref: "<sha>", result }], unverified })`

## Reply

What is now on disk (commit, branch, notes, files, automation kept or cancelled), anything that is still only in this chat's context and why it was not written, and the first action to take on resume.
