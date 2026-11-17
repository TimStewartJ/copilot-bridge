---
name: voice
description: "Helper: capture how the user writes into a personal style skill that fills the writing-style role, from their own messages and samples, written only after they approve it. Use when asked to learn my writing style, write like me, or create or update my voice skill."
disable-model-invocation: true
metadata:
  bridge-kind: helper
  bridge-label: Voice
---

# Voice

You own a short personal style skill that makes drafts sound like the user, built from evidence of how they write.

## Steps

1. Check for an existing style skill: one that <skill_roles> lists for `writing-style`, or a `*-voice` skill in the user's home skills. If one exists, update it in place and mine only what came after it was last changed.
2. Ask with ask_user which sources to use and their scope: their messages in past chats, pasted samples, sent mail or documents a skill here can read, and whether to cover work, personal writing or both. Only their own writing counts.
3. Collect the samples read-only. For past chats, the Bridge's chat search index holds them: rows of `search_chat_messages` with role `user` in `bridge.db` under `$BRIDGE_DATA_DIR`. Skip text the Bridge or a trigger wrote, which starts with a tag such as `<trigger>`, `<defer>` or `<bridge_notice>`, and each chat's first message unless it is clearly the user's, because triggers and other agents start chats too. Keep raw samples in the session folder only.
4. Split the samples into three or more slices by time or source and look in each for length, openings and sign-offs, sentence shape, word choices, formatting, and corrections they made to drafts. Keep a pattern only when two slices show it.
5. Draft the skill: a `description` naming the user and when to use it, `bridge-roles: writing-style` under `metadata`, and short sections only where the user has a specific rule, each with one real example phrase. Leave out private details, other people's names and anything a reader of the skill should not see.
6. Show the full draft with ask_user and revise it until the user approves.
7. Write it to `<name>-voice/SKILL.md` in the user's home skills: the `skills` folder of the Copilot home the Bridge runs with (`~/.copilot/skills` by default). A shell's `$COPILOT_HOME` may be a scratch copy, so do not trust it. Then confirm the skill shows up as a home skill in Settings › Skills.

## Gates

Reading samples proceeds without asking. Choosing sources waits for the user's answer in step 2, and writing the skill waits for approval of the exact text.

## Output

The skill's path, the sources and date range used, and the patterns kept with how many slices showed each.
