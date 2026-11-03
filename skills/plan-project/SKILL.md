---
name: plan-project
description: "Playbook: turn a goal into a plan with a finish line, milestones, dependencies, risks and a first action, and track it on the task. Use when asked to plan, scope, break down, roadmap, organize, set up a project, figure out the steps for, or get started on something with several parts."
metadata:
  bridge-kind: playbook
  bridge-family: knowledge
  bridge-label: Plan a project
---

# Plan a project

You own the plan until the user accepts it, then its upkeep on the task.

## Steps

1. Restate the goal and the smallest outcome that meets it. If the task already has a doneWhen, plan toward it, otherwise step 2 proposes one.
   - Load any skill that <skill_roles> lists as extending `plan-project` and add its steps where it says.
2. Write the finish line as a pass/fail condition a person could check. Once the user accepts it, set it as the task doneWhen with task_update.
3. Gather the constraints: deadline, budget, who is involved, what already exists, and what the user ruled out. Read task notes, history and related knowledge base pages first.
4. Break the work into 3 to 8 milestones, each a checkable outcome rather than an activity.
5. Order the milestones by dependency and name the outside people or systems each one waits on.
6. List the top risks with an early warning sign and a mitigation for each. Settle cheap unknowns now with a quick experiment or lookup instead of planning around them.
7. Pick the first action: one step that can start now.
8. Present the plan for acceptance with ask_user or in the reply, marking what is your proposal and what the user already decided.
9. After acceptance, add only the accepted milestones to the task checklist (action_add or the checklist tools), not every step.
10. Write the current plan and state into the task notes with task_update and set the first action with task_update_momentum. verify_complete records the acceptance in task history.
    - If there is no task and the user wants tracking, create one with task_create first.
    - Put a long plan in the knowledge base with docs_write and link it from the notes.
11. Add hard deadlines the user gave to the calendar with calendar_event_create when they asked for reminders.

## Gates

Drafting the plan and quick read-only lookups proceed without asking. Creating tasks, checklist items and calendar entries waits until the user accepts the plan. Ask first before committing anyone else's time, spending money, or contacting people.

## Done means

The user accepted a plan and it lives on the task. Call verify_complete with `approved` for the accepted plan and `delivered` for the task notes, checklist and doc you wrote:

`verify_complete({ summary, evidence: [{ kind: "approved", claim: "plan accepted", result }, { kind: "delivered", claim, ref, result }], unverified })`

## Reply

The finish line, the milestones with dependencies, the top risks, the first action, and where the plan is stored.
