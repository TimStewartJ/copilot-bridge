---
name: investigate
description: "Playbook: answer a question about code, logs or a system by reading and running it, without changing anything. Use when asked why something happens, how something works, where something lives, whether a claim is true, are we sure, or to look into, trace, explain, audit or root-cause something before deciding what to change."
metadata:
  bridge-kind: playbook
  bridge-family: code
  bridge-label: Investigate
  bridge-evidence: sourced
---

# Investigate

You own the answer and the evidence behind it. You change nothing: no edits, commits, config changes or writes to shared systems.

## Steps

1. Restate the question and the smallest answer that settles it. For task-linked work with a finish line and no doneWhen, set doneWhen with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `investigate` and add its steps where it says.
2. Write down what would count as an answer: a code path, a log line, a measured value, a reproduction. If the question is really a decision, name the options now.
3. Find the entry points (code search, symbol lookup, logs, docs, task history) and follow the trace yourself to the code or record that decides the behavior.
4. Prefer runtime evidence over reading when it is cheap: run the code, a read-only query, a test or a command, and keep the output.
   - Commands stay read-only. Scratch files go in the session folder, never in the repository.
5. Cite every claim that matters as `path:line`, a commit, a link or a quoted output line, and label it measured, sourced, inferred or unknown.
6. Look for the case that would prove you wrong (another caller, a config override, a different version or platform) and check it.
7. For "are we sure" questions, give your real judgment and the confidence the evidence supports, including "no" or "not proven" when that is what it shows.
8. When the answer feeds a decision, give one recommendation with its main tradeoff and the fact that would change it.
9. If the answer shows a change is needed, stop and name the playbook that should make it (`bug-fix`, `feature` or `refactor`) with the evidence it starts from. Do not make the change here.

## Gates

Everything in this playbook is read-only and proceeds without asking. A command that writes, restarts, deletes, sends or costs money is out of scope: if the answer needs one, say so and move the work to the playbook that owns it.

## Done means

Every claim the answer depends on is backed by a source you opened or output you ran. Call verify_complete with at least one `sourced` entry whose `ref` lists the citations, add `measured` or `live` entries for anything you ran, and list what you could not prove in `unverified`:

`verify_complete({ summary, evidence: [{ kind: "sourced", claim, ref, result }], unverified })`

## Reply

The answer in one or two sentences, then the cited evidence, the confidence, open unknowns, and the next playbook if a change is needed.
