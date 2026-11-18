---
name: measure
description: "Playbook: produce a performance, cost or agent-behavior number you can trust, from new runs or from records such as CI timings, logs and usage data, or improve one: baseline, find what limits it, compare runs and report the spread; also test whether a prompt or skill change helps before it ships. Use when asked to benchmark, profile, time, is it faster, did it regress, how long does a build, test or CI run take, how many tokens, speed up, optimize, reduce cost, or does this prompt or skill change help."
metadata:
  bridge-kind: playbook
  bridge-family: code
  bridge-label: Measure
  bridge-evidence: measured
---

# Measure

You own the number: what it measures, why it is what it is, and whether a difference is real. Diagnosing a cause belongs to `investigate`, choosing between options to `decide`, and judging changes on live chats to `improve`.

## Steps

1. Write the claim you expect to make in the words you would ship, such as "the Windows CI job takes 9 minutes at the median of the last 7 runs". Name the metric, the direction that counts as better, the workload, and the smallest difference that would matter. When improving toward a target on a task with no doneWhen, set the target as doneWhen with task_update.
   - Load any skill that <skill_roles> lists as extending `measure` and add its steps where it says.
2. Pick the mode: report one number, compare two sides, improve a number toward a target (steps 6 and 7), or test a prompt or skill change (step 8). Set a run budget before measuring: how many runs, and the time or money they may take.
3. Find the source of the number. Prefer a record the system already keeps (CI run times, usage records, logs, traces) over a new timer; for records, state which runs you included and why, and do not invent reruns. Otherwise read the measuring script and note what it times, counts and ignores. Note what else is running on the machine; if you cannot stop it, interleave the sides so both see the same noise.
4. Take the baseline before any change, on the same machine, data and settings, with each side configured the way it runs for real (release build, production flags, warm or cold as users see it). Check that whatever drives the load is not itself the bottleneck. Write each run's raw values to a file in the session folder.
5. Vet the number before trusting it (principles skill: Explain the number):
   - It happened: the work ran inside the timed region, outputs were correct and used, and errors were counted. Fast failures and skipped work make a fast number.
   - Limiter: say what stops it being twice as fast, from a profile or trace in a run you do not report. For records you cannot rerun, say the limiter is unknown.
   - Limits: check the arithmetic against disk, network and cores. A part that takes 10% of the whole can save at most 10%.
   - Repeats: within the budget, at least five runs per side, alternating A, B, A, B. Report the median and range. When the gap is smaller than the spread or the difference that matters, the result is inconclusive, not "the same".
   - Matters: give a micro result as a share of the end-to-end time a user waits.
   - A ballpark the user asked for can be one run: still check that it happened and errors, and say it is one run. A choice between options is never a ballpark.
6. To make a number better, try ideas cheapest first and stop at the first that meets the target: do not do the work, do not do it twice, do less, do it later, do it when nobody waits, do it concurrently, do it cheaper.
7. For a series of attempts, build the harness first: it reports work done and errors, separates a slow case from a fast one, and the tests pass on the baseline. Then freeze it (principles skill: Build the lever).
   - One change per measurement, each in its own commit or worktree. Keep it only when the metric moves by more than the spread and the tests stay green; otherwise revert that change and nothing else.
   - Add one task_history_add row per attempt: hypothesis, change, before, after, kept or reverted.
   - On a stall, try a different kind of idea before concluding. Stop at the target, the budget, or when no worthwhile idea is left, and report an unmet target rather than changing it. For a long run, use the `unattended-run` playbook for wakes and review.
8. To test a prompt, skill or playbook change before it ships:
   - Write one task as a user would type it. Candidates never see words such as eval, test, judge or candidate, and never learn other runs exist. Use project-like folder names.
   - Run both variants in matching environments: same model, effort, tools, data and skills. For this Bridge's prompts and bundled skills, use two staging previews built the same way, one of the current commit and one with the change, and start scratch chats on each with `POST /api/sessions` then `POST /api/chat`. Confirm from each chat's record that the intended text loaded. If the environments differ in a way that could change the result, the comparison is inconclusive.
   - Run at least three chats per variant, alternating, within the budget.
   - Write a rubric of three to six concrete criteria for the judge only. One judge on a different model family from <model_roles> scores every output in one pass under neutral labels, never model or variant names.
   - Grade what each agent did from its record (`GET /api/sessions/<id>/messages-fast` lists every tool call with its arguments and result), not from what it says it did. Save what you need before scratch chats expire after a day idle.
   - Read every output yourself. If you disagree with the judge, suspect the rubric first.
9. Report the verdict first: better, worse, no difference beyond the one that matters, or inconclusive. Then the median and range per side, n, the machine and data, the limiter, and what you did not check, with a link to the raw values. Save a measurement that will be repeated (a scorecard, a benchmark) to the knowledge base so the next run compares against it.

## Gates

Measuring, profiling, scratch chats, scratch experiments and staging previews proceed without asking. Ask first before load on shared or production systems, or runs that spend money beyond the budget the user set. Code changes kept by the loop follow the `feature` gates.

## Done means

Every number reported has a baseline, n and spread, or is labeled a single run or a record you could not rerun. Call verify_complete with a `measured` entry per number (ref to the raw values), `tested` when code changed, and `reviewed` when a judge ran:

`verify_complete({ summary, evidence: [{ kind: "measured", claim, ref, result }], unverified })`

## Reply

The verdict in one sentence, then the numbers with spread and n, the limiter, and the link to the raw values. Leave the run-by-run detail in the file.
