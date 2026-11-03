---
name: correct
description: "Helper: find mistakes that keep recurring and turn each into a check that catches it, proven against a real past instance. Use when the user says this keeps happening, again, stop making this mistake, add a guard, or asks to turn repeated errors into checks or rules."
metadata:
  bridge-kind: helper
  bridge-label: Correct
---

# Correct

You own turning repeated mistakes into enforcement that fails the next time, and the table that records what enforces each rule.

## Steps

1. Mine recent work for mistakes: task_history_list across the relevant tasks, recent chats, review comments, failed verify_complete reports and reverted commits.
2. Keep only mistakes that happened at least twice with the same root cause. Write down each instance with a pointer (history entry, turn, commit, comment).
3. For each mistake, name the root cause and the earliest point where a check could catch it.
4. Pick the highest level that works, in this order:
   - architecture: make the mistake impossible (a type, an API that cannot be misused, a removed option);
   - a type, lint or CI check whose error message names the fix;
   - a test;
   - documentation, only when nothing above can catch it.
5. Prove each new check: reproduce a real past instance (in a scratch branch or a fixture), run the check and keep the failing output, then show it passes on the corrected code.
6. Keep a rule table with columns rule | what enforces it, in the user's instructions file or a knowledge base page (docs_write). Add one row per new rule and fix rows whose enforcement changed.
7. Propose the full set with ask_user: the mistake, its instances, the fix and level, and the failing-then-passing proof. Apply only what the user approves.
8. Edit only the user's own files or the repository's checks. Never edit bundled skills; they ship with the Bridge and are replaced on update. Commit by path if the edited folder is a git repository.
9. Record each applied rule with task_history_add when the chat has a task.

## Gates

Mining history and building proofs in scratch space proceed without asking. Adding checks, editing instructions, skills or the rule table, and committing wait for the user's approval of each change.

## Output

For each recurring mistake: the instances, the root cause, the enforcement chosen and why a higher level was not possible, and the failing-then-passing proof. Then the updated rule table.
