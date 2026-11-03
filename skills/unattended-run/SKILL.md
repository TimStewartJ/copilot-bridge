---
name: unattended-run
description: "Playbook: work toward a pass/fail goal over many iterations while the user is away, with a decision trail and a cross-model review at the end. Use when asked to keep going until, run overnight, work on this while I am away, iterate until it passes, grind on this, or run autonomously or unattended."
metadata:
  bridge-kind: playbook
  bridge-family: meta
  bridge-label: Unattended run
  bridge-evidence: reviewed
---

# Unattended run

You own a bounded run toward one pass/fail condition, every decision along the way, and an honest report at the end.

## Steps

1. Restate the goal and the smallest outcome that meets it. Step 2 sets the task doneWhen if it is absent.
   - Load any skill that <skill_roles> lists as extending `unattended-run` and add its steps where it says.
2. Before starting, state the exit condition as a pass/fail check and set it as the task doneWhen with task_update. A duration or iteration count is a budget that stops the run, not a finish condition.
3. State the permissions and the escape hatch, and write both into the task instructions with task_update:
   - what you may do without asking (for example edit, run tests, commit on the working branch);
   - what stays gated (sending, spending, deleting, deploying, merging, force-pushing);
   - when you stop and wait: a gated action is needed, the condition proves impossible, or the budget runs out.
   - If the user is still present, confirm these with ask_user before starting.
4. For code, work in an isolated workspace: a separate worktree and working branch, never the user's checkout or a default branch.
5. Measure the starting point against the exit condition and record it with task_history_add.
6. Each iteration: make the smallest change the evidence justifies, verify it against the condition, keep it if it helps and discard it if not, then add one task_history_add row with the decision, why, the evidence and the result.
7. On a plateau, change the approach (a different hypothesis, a different lens, a sub-agent's idea) rather than stopping.
8. Never relax the condition: do not edit the tests, thresholds or doneWhen to make the run pass.
9. Schedule each wake with defer_create: a one-shot defer (delaySeconds) for the next step, or, for an external wait, a recurring defer (intervalSeconds of at least 300, with maxRuns or expiresAt) whose `check` command wakes the worker only when its exit code or output changes.
   - Example: `check: { command: ["gh", "run", "view", "4567", "--json", "status,conclusion"] }`. The command is an argument array with the executable first and no shell; `cwd` must be an absolute path.
10. Do not ask questions mid-run. When a gated action is needed, ask with ask_user and keep doing work that does not depend on the answer, or stop at the escape hatch.
11. When the condition passes or the escape hatch triggers, verify the exit condition once more on the real system.
12. Run the `review-unattended` helper, which reviews on a different model family, and keep its Attention section for the reply.

## Gates

Everything listed as permitted in step 3 proceeds without asking. Everything gated in step 3 waits for the user's explicit approval, even if the run stalls. Changing the exit condition or the permissions needs the user.

## Done means

The exit condition passed on the real system, or the run stopped at the escape hatch with the reason recorded, and a reviewer on a different model family checked the trail. Call verify_complete with `reviewed` for the review, `measured` or `tested` for the final check of the condition, and the result "fail" when the condition did not pass. Its completion entry closes the history trail; the per-iteration rows from step 6 stay as they are:

`verify_complete({ summary, evidence: [{ kind: "measured", claim: "exit condition", ref, result }, { kind: "reviewed", claim: "reviewed by <model>", result }], unverified })`

## Reply

Whether the exit condition passed, the starting and final measurements, the key decisions with history pointers, what is gated and waiting on the user, and the reviewer's Attention section unchanged.
