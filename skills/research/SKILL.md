---
name: research
description: "Playbook: answer a factual question from primary sources and label how well each claim is supported. Use when asked to research, look up, find out, compare, fact-check, verify, what is the latest, what are the options for, or summarize what is known about a topic, product, law, paper or technology."
metadata:
  bridge-kind: playbook
  bridge-family: knowledge
  bridge-label: Research
  bridge-evidence: sourced
---

# Research

You own the answer and how far each part of it can be trusted.

## Steps

1. Restate the question in one sentence and the smallest answer that settles it. For task-linked work with a finish line and no doneWhen, set one with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `research` and add its steps where it says.
2. Lock the scope: what is in and out, how recent the facts must be, how deep to go, and the region or version that applies.
3. Check what is already known: docs_search the knowledge base and read the task notes, so you build on earlier findings instead of redoing them.
4. Split the question into the few claims that decide the answer and bound the work to those.
5. Search following <research_behavior>. Prefer primary sources (official documentation, specifications, papers, filings, source code, datasets, the vendor's own page) over summaries and reposts.
6. Open the canonical source for every claim that matters.
7. Compare at least two independent sources for each deciding claim. Note disagreements and which source is closer to the fact.
8. Measure instead of quoting when you can: run the code, call the API, compute the number.
9. Label each claim measured, sourced, inferred or unknown, with the date checked where freshness matters.
10. Write the short answer first, then an evidence table: claim | label | source | date or note.
11. If the user will reuse the findings, save them to the knowledge base with docs_write (question, answer, evidence table, date checked) and link the page.

## Gates

Searching, reading and saving to the knowledge base proceed without asking. Ask first before signing up for anything, paying for access, or contacting a person or organization.

## Done means

Every deciding claim is backed by a source you opened or a measurement you ran. Call verify_complete with `sourced` entries for the deciding claims (canonical URLs in `ref`), `measured` for anything you computed or ran, and list the unknowns in `unverified`:

`verify_complete({ summary, evidence: [{ kind: "sourced", claim, ref: "<url>", result }], unverified })`

## Reply

The answer in a few sentences, then the evidence table, the disagreements and unknowns, and the knowledge base link if you saved one.
