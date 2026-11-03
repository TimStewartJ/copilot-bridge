---
name: sweep
description: "Playbook: review several sources on a cadence, like an inbox pass, and report what is new, worse or resolved since the last sweep. Use when asked to sweep, triage, catch me up, what did I miss, check my queue, morning review, end of day review, or go through inbox, notifications, reviews and tasks."
metadata:
  bridge-kind: playbook
  bridge-family: ongoing
  bridge-label: Sweep
  bridge-evidence: baseline
  bridge-compare-previous: "true"
---

# Sweep

You own one pass over the listed sources and an accurate list of what changed since the previous pass.

## Steps

1. Restate which sources this sweep covers, the period (since the last sweep), and what the user wants surfaced. Sweeps are ongoing, so set doneWhen only if the user gave an end.
   - Load any skill that <skill_roles> lists as extending `sweep` and add its steps where it says.
2. List each source with its read method, loading the skill that fills its role when <skill_roles> lists one (`messaging`, `code-host`, `ci`, `issue-tracker`). If none does, use the tools available and say which.
3. Load the saved state: <previous_run_report>, then the task notes or knowledge base page that holds the last-seen marker per source (time, newest ID).
   - No saved state means this is the first sweep: record markers now and report a short current snapshot.
4. Read each source since its marker. Record each source you could not read and why; a failed read is never "nothing new".
5. Classify each new item: needs the user, needs action you are already authorized to take, for information, or noise.
6. Never invent work. An item becomes a to-do only when someone asked for it or it blocks accepted work.
7. Confirm before reporting: re-open each item you will report and check it is still current (not already answered, merged or withdrawn).
8. Correct task state where verified facts changed it (a reply arrived, a review merged, a date moved) with task_update or task_update_momentum. Do not change task state on an unconfirmed signal.
9. Update the markers in the same place you loaded them from.
10. Write the verify_complete summary as the run's record: counts per source, what you reported, what you corrected, what you could not read. verify_complete adds it to task history, so do not add a separate history entry for the run.
11. Scheduled runs have no one waiting: do not ask questions; report blockers instead.

## Gates

Reading sources, updating markers and correcting task state from verified facts proceed without asking. Replying, sending, accepting, closing, deleting or archiving anything in a source waits for the user's approval, through the playbook that owns that action.

## Done means

This sweep compared every readable source against its saved marker. Call verify_complete with a `baseline` entry for the markers compared or recorded and `live` entries for the sources read, and list unreadable sources in `unverified`:

`verify_complete({ summary, evidence: [{ kind: "baseline", claim: "compared with markers from <time>", ref, result }, { kind: "live", claim, ref, result }], unverified })`

## Reply

New, worse and resolved items since the last sweep, ordered by what the user must act on, each with a link; task state you corrected; sources you could not read. If nothing changed, say so in one sentence.
