---
name: decide
description: "Playbook: compare options against the criteria that matter and recommend one, settling factual questions by experiment rather than opinion. Use when asked should we, should I, which is better, help me choose, compare X and Y, pros and cons, weigh the tradeoffs, or make a call on something."
metadata:
  bridge-kind: playbook
  bridge-family: knowledge
  bridge-label: Decide
---

# Decide

You own the recommendation and the evidence under it. The user owns the decision.

## Steps

1. Restate the decision, who makes it, by when, and what happens if nothing is decided. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `decide` and add its steps where it says.
2. List the options, always including doing nothing or waiting.
3. Name the criteria the user cares about (cost, time, risk, reversibility, effort, quality) from the request, task notes and earlier decisions in task history.
4. Find the factual forks: questions whose answer would change the recommendation. Settle each one by experiment, measurement or an opened source.
5. Gather evidence for each option against each criterion and label it measured, sourced, inferred or unknown.
6. Note for each option how reversible it is and what being wrong would cost.
7. For close or high-stakes calls, run the `panel-review` helper on the recommendation before presenting it.
8. Make one recommendation with its main tradeoff and the fact that would change the answer.
9. Present a compact table of options against criteria, with the recommendation above it.
10. When the user makes the decision, record it and its reason with task_history_add (a decision, separate from this playbook's completion entry), and put any standing rule it creates in the task instructions. Until then it stays a proposal.

## Gates

Analysis, experiments in scratch space and reversible trials proceed without asking. Ask first before any experiment that spends money, touches shared or production systems, or contacts other people; acting on the decision belongs to the playbook that owns that action.

## Done means

The recommendation rests on evidence for the forks that decide it. Call verify_complete with `sourced` or `measured` entries for each settled fork, `reviewed` if a panel ran, and list unsettled forks in `unverified`:

`verify_complete({ summary, evidence: [{ kind: "measured", claim, ref, result }, { kind: "sourced", claim, ref, result }], unverified })`

## Reply

The recommendation and its main tradeoff first, then the options table, what would change the answer, and the decision the user still needs to make.
