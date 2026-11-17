---
name: verify-setup
description: "Helper: write a project-local verify skill that launches a project, drives it like a user and captures evidence, proven once end to end. Use when a project has no scripted way to prove its behavior on the real surface, or when asked to set up verification for a repo."
metadata:
  bridge-kind: helper
  bridge-label: Verify setup
---

# Verify setup

You own a project skill that a later agent, reading it cold in the middle of a task, can follow to prove the project works on its real surface.

## Steps

1. Learn the project from the repository, and ask the user only what you cannot observe:
   - surface: what a user touches (web UI, command line, API, desktop or mobile app, library); pick the main one and note the others;
   - run: the repository's own start command, ports, environment variables, seed data and sign-in;
   - drive: existing harnesses first (browser tests, scripts, HTTP endpoints), then a generic recipe such as a browser for web, a terminal session for a command line, plain HTTP for a service;
   - observe: screenshots, transcripts, response bodies, logs, exit codes, stored data.
2. Settle isolation before writing anything: its own data folder, ports and profile, and test or sandbox accounts for outside services. Check what a dry run or test mode really touches by watching files and network, not by its name. If it cannot run without touching real data, accounts or other people, stop and report that instead of writing the skill.
3. If the project does not build or start as it is, fix that or report exactly what fails first.
4. Write `<project>-verify/SKILL.md` in the repository's skill folder (`.github/skills`, or `.agents/skills` or `.claude/skills` if the repository already uses one), with frontmatter `name`, a `description` that names the project and when to use it, and `bridge-roles: verify` under `metadata`. Give it these sections, filled from what step 1 found, with no placeholders:
   - Launch: the exact command from an empty state, how to tell it is ready to use, and how to stop it.
   - Doctor: one read-only check that the running copy is the right build, uses the isolated data, ports and accounts from step 2, and owns its port. Every run starts with it and stops if it fails.
   - Drive: the real commands and stable handles (labels, data attributes, prompts, routes), not coordinates.
   - Evidence: what to capture and where it goes. Drive the real user path, capture the action and its result, and check side effects as well as the screen.
   - Cleanup: stop only what the run started, never by process name, and keep the evidence.
   - Any helper script it ships, with its exact invocation.
5. Add a short feature map in `features/` beside it: a README index and one file per main user-facing feature (three to five to start), each saying how to reach it as a user, how to drive it, and the end state that proves it works. If seed data lacks what a journey needs, record the gap rather than weakening the journey. Tell the skill's reader to update the map when they change a feature.
6. Prove the skill once by following it exactly: launch, doctor, drive one mapped feature, capture evidence, clean up, then confirm the evidence still exists. Run cleanup after every failed attempt too. A skill that was never run is a draft.
7. Leave it uncommitted unless the user or the repository says to commit, and tell the user where it is.

## Gates

Reading the repository, local runs in isolated folders and writing the skill files proceed without asking. Ask first before anything that uses real accounts, sends anything, or changes shared systems.

## Output

The skill's path, the feature it was proven on with the evidence path, what it cannot verify, and any setup that stays unproven.
