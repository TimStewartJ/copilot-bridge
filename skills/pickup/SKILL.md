---
name: pickup
description: "Playbook: resume earlier work by rebuilding its state from the trail it left, then continue with the right playbook. Use when asked to pick up, resume, continue, carry on, where were we, where did we leave off, take over from another chat, or finish what was started."
metadata:
  bridge-kind: playbook
  bridge-family: meta
  bridge-label: Pick up
---

# Pick up

You own rebuilding the state of earlier work accurately enough to continue it without redoing or losing anything.

## Steps

1. Restate the goal of the earlier work as far as you know it and the smallest outcome that would let you continue. If the task has no doneWhen and the work has a finish line, propose one in step 7.
   - Load any skill that <skill_roles> lists as extending `pickup` and add its steps where it says.
2. Locate the trail. Read task_get_info (instructions, notes, doneWhen, momentum, linked chats, pull requests, work items), task_history_list, and any knowledge base pages the notes link.
   - Read the prior chat when a tool for its history is available; otherwise use the chat previews from task_get_info.
   - For code, inspect the branch and worktree: status, recent commits, uncommitted changes, stashes, and whether the branch is pushed.
3. Check what is still in flight: defer_list, schedule_list, background commands and open pull requests or runs.
4. Reconstruct the state: the goal, accepted decisions, what was done and with what evidence, what was pending, and what was in progress when it stopped.
5. Write a short done-versus-pending table: item | state | evidence.
6. Re-verify inherited claims on the real artifact only where the outcome depends on them (tests passing before a merge, a branch being pushed, a price still holding). Trust the rest and mark any claim you found stale.
7. Do not redo work that has verified evidence. Name the resume point: the one next action. If the task has no doneWhen and the work has a finish line, set one with task_update as a pass/fail condition.
8. Update the task notes with the reconstructed state if they were missing or wrong, and set the next action with task_update_momentum.
9. Route the remaining work to the matching playbook with playbook_select, and copy only its steps that are not already done with evidence into your todo list.

## Gates

Reading the trail, re-running read-only checks and correcting task notes proceed without asking. Any action the earlier work left gated (a send, a merge, a purchase, a deploy) still needs fresh approval: an approval given in an earlier chat does not carry over unless the task instructions say it does.

## Done means

The state is rebuilt and the work is routed. Pickup usually hands off to another playbook rather than finishing on its own. When it does finish here, call verify_complete with `live` entries for the inherited claims you re-verified and list the ones you trusted without checking in `unverified`:

`verify_complete({ summary, evidence: [{ kind: "live", claim, ref, result }], unverified })`

## Reply

What the work was, what is done (with evidence) and what is pending, any stale claims you found, the resume point, and the playbook you routed to.
