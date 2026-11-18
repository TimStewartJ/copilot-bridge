---
name: principles
description: "Design and debugging principles that playbook steps cite by name, such as Build the lever or Prove the safety fact. Load it when a step says (principles skill: Name) and you need more than the step's short summary."
---

# Principles

Each principle is a rule and the test that shows you applied it. Playbooks cite them by name as `(principles skill: Name)`.

## Attack the premise

When two fixes or explanations that share one assumption fail the same check, stop and test the assumption. Write it down in one sentence, then make an observation that would come out differently if it were false. Look at how the failures are spread, not only how big they are. Start the next fix only after the premise has been tested.

## Fix root causes

Fix the first place the system did something wrong, not where the symptom showed. Ask whether the state that triggered it is legitimate: if it is, handle it where the code broke; if it should never exist, find what produced it. A guard, retry, swallowed error or clamped value is a fix only when the state it handles is legitimate. Then look for the same fault elsewhere.

## Build the lever

When work is more than a few obvious edits, write the script, codemod, generator or rerunnable check that does it. Do the first unit by hand, then prove the tool reproduces it, and make it safe to run twice. Keep it the smallest tool that does the job. If no script is in the change, you did not apply this.

## Model the domain

Put the rules in a data structure rather than conditionals spread across files: a state machine instead of booleans that must agree, a table or registry instead of a growing if/else chain, a typed model instead of loose parameters. Keep plain code when the shape is small and local. The sign you skipped this: one more branch, or a second flag that must stay in sync with the first.

## Type-system discipline

Make the compiler or schema reject impossible states. Give values that share a primitive but mean different things their own types, handle every variant explicitly, and derive types from the schema that owns the shape instead of writing a parallel one.

## Boundary discipline

Validate and parse data where it enters: requests, files, config, environment, command arguments, other services. Inside, trust the parsed types and skip repeat checks. Keep the logic in plain functions and the code that talks to the outside thin.

## Make operations idempotent

Every step that changes state should reach the right result however many times it runs and wherever an earlier run stopped. Read the current state and apply only the difference. Anything a run leaves behind (a lock, a temp file, a claimed job) must be recognizable as stale. Ask: what if this runs twice, or crashed halfway?

## Separate before serializing

When several actors might write the same file, key or record, first give each its own and merge where the result is read. Add a lock, single writer or compare-and-swap only when one shared target is a real requirement. An instruction is not concurrency control.

## Minimize reader load

A reader should find where a value comes from and what can change it in under a minute. Inline wrappers with one caller and adapters with one implementation. Prefer return values to mutation and local state to shared state. If a simplification did not reduce layers or state, revert it.

## Redesign from first principles

Fold a new requirement in as if it had been there from the start, rather than bolting it on. Ask what you would build from scratch with it, carry the change through types, docs and examples, then deliver in small steps.

## Experience first

Weigh the experience of whoever uses the result: the end user of a screen, the caller of an API, the next person to maintain the code. Justify every control and option, ship fewer things that work well, and get states, errors and feedback right.

## Prove the safety fact

Most risky-looking changes are safe because of one fact, such as "this call only removes entries that are already dead". Name that fact and push its proof as far down this ladder as is cheap, saying where it stopped: you said so; you cited the line; you showed the bad case cannot happen; you ran code that fails if you are wrong; you reproduced it in the running app. Unproven means say so.

## Explain the number

Before you report or act on a number, know why it is that number. Name what limits it, confirm the work it measures ran without errors, repeat it enough to see the spread, and give a small result as a share of the whole. A gap within the spread is inconclusive, not a win and not proof of no difference. If you cannot explain the number, say so instead of reporting it as a finding.

## Prototype the choice

When a design or behavior choice can be settled by trying it, build throwaway variants in a scratch folder, put them behind one switch (a button, key or flag), observe each on the real surface, then recommend one. The prototype is evidence, not the build: the chosen direction is built properly afterward.
