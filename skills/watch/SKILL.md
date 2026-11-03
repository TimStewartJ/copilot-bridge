---
name: watch
description: "Playbook: watch one source over time and report only confirmed changes since the last check. Use when asked to watch, monitor, track, keep an eye on, check daily, alert me when, tell me if, or let me know when a price, stock, status, page, release, build, filing or feed changes."
metadata:
  bridge-kind: playbook
  bridge-family: ongoing
  bridge-label: Watch
  bridge-evidence: baseline
  bridge-compare-previous: "true"
---

# Watch

You own one source, its saved state, and the report of what changed since the last run.

## Steps

1. Restate what is watched, what counts as a change that matters, and who must act on it. Set task doneWhen with task_update only when the watch has an end (for example "stop once the item is back in stock").
   - Load any skill that <skill_roles> lists as extending `watch` and add its steps where it says.
2. Define the read: the exact URL, command, API call or query, the fields to compare, and the volatile fields to ignore (timestamps, ordering, view counts, ads).
3. Load the saved state: <previous_run_report>, then the task notes or the knowledge base page this watch uses.
   - No saved state means this is the first run: record a baseline (values and time) in the task notes or with docs_write, report the current state briefly, and say later runs report changes.
4. Read the source now, the same way that worked last time.
5. Compare the new read with the saved state field by field.
6. Confirm each apparent change before reporting it: re-read the source and rule out noise such as caching, reordering, formatting, partial loads and transient errors.
   - A failed read is "could not check", never "no change". Say what failed and why.
7. Update the saved state with what you saw and when, in the same place you loaded it from.
8. Write the verify_complete summary as the run's record: changed or not, the change if any, and a pointer to the evidence. verify_complete adds it to task history, so do not add a separate history entry for the run.
9. Notify only for changes the user must act on. Routine runs with no change stay quiet in the chat.
10. Make sure the next run is scheduled, choosing the cheapest mechanism that fits:
    - A machine-checkable source: a recurring defer (intervalSeconds of at least 300, with maxRuns or expiresAt) whose `check` runs a command that prints only the compared fields. The worker wakes only when the exit code or output changes; set `wakeOnFirstRun: true` when the first output should be checked against the baseline.
    - Example: `check: { command: ["gh", "release", "view", "--repo", "example-org/example-app", "--json", "tagName"] }`. The command is an argument array with the executable first and no shell; for anything that needs normalizing, point it at a script, such as `["node", "<absolute path>/check-price.mjs"]`.
    - A source that needs judgment or a fresh session each time: schedule_create with this playbook pinned.
11. Scheduled runs have no one waiting: do not ask questions; work around blockers and report what you could not check.

## Gates

Reading the source, updating saved state and scheduling the next check proceed without asking once the user asked for the watch. Acting on a change (buying, replying, filing, cancelling) is a separate action that needs its own approval through the playbook that owns it.

## Done means

This run compared against a recorded baseline, or recorded the first one. Call verify_complete with a `baseline` entry naming the state compared against (or recorded) and a `live` entry for the read:

`verify_complete({ summary, evidence: [{ kind: "baseline", claim: "compared with the run of <time>", ref, result }, { kind: "live", claim, ref, result }], unverified })`

## Reply

The first sentence answers whether anything that matters changed since the last check. For each confirmed change: what changed, where and when you saw it, the evidence, and what the user should do. If nothing changed, stop after one or two sentences.
