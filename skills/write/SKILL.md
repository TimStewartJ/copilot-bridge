---
name: write
description: "Playbook: draft, edit or send a piece of writing for a specific reader and purpose. Use when asked to write, draft, rewrite, edit, tighten, reply to, respond to, announce, summarize for someone, or prepare an email, message, post, doc, description, report or status update."
metadata:
  bridge-kind: playbook
  bridge-family: knowledge
  bridge-label: Write
---

# Write

You own the text from its purpose to its delivery; when it goes out as the user, the user owns the send.

## Steps

1. Restate what the piece is for and the smallest piece that does it. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `write` and add its steps where it says.
2. Pin the audience, purpose, form (email, chat message, doc, post, description), length and destination before drafting.
3. Read the context the piece answers (the thread, the doc, the request) and gather the facts it depends on. Verify facts that change, such as dates, numbers and status, against their source.
4. Load the skill that fills the `writing-style` role when <skill_roles> lists one, and follow the destination's own conventions.
5. Draft: open with what the reader needs, give each paragraph one point, and match the length to the purpose.
6. Self-audit the draft: cut padding, recaps, warm-up openers and closing offers; remove AI writing tells such as stock phrases, mannered metaphors, reflexive hedges and bold-label lists; check each fact against step 3.
7. Check the piece stands alone for a reader who saw none of this chat: names, links and context included.
8. Deliver the draft where asked: in the reply, as a file with send_attachment, or in the knowledge base with docs_write.
9. If it is to be sent or posted as the user, get approval with ask_user for the exact final text and destination.
   - Send with the skill that fills the `messaging` role (see <skill_roles>). If none does, say so and give paste-ready text instead.
10. Right before sending, re-read the destination's newest messages. If they change the ask or make a claim untrue, revise and ask again instead of sending.
11. Send exactly the approved text and read it back from the destination to confirm it arrived.

## Gates

Drafting, editing, saving drafts and writing to the knowledge base proceed without asking.

Ask first with ask_user, every time: sending, posting, replying, commenting or emailing as the user, and editing or deleting something already sent. Approval covers the exact text and destination shown; any change needs a new approval.

## Done means

The draft is delivered where it was meant to go. When nothing is sent (no approval yet, or you declined to send), the chat is the destination: put the full draft text in your final reply and record a `delivered` item that points to it. Never say you drafted something the reader cannot see. Call verify_complete with `delivered` when it was sent, posted or saved (with the link or path), `approved` for each send the user approved (only when something was sent), and `sourced` for facts you checked:

`verify_complete({ summary, evidence: [{ kind: "approved", claim, result }, { kind: "delivered", claim, ref, result }], unverified })`

## Reply

The full draft text (or a link when it was saved elsewhere), where it went or is waiting to go, and any fact you could not verify.
