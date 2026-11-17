---
name: catch-up
description: "Helper: catch the user up on this chat since their last message, then list each decision waiting on them with a pick, evidence and risk. Use when asked to catch me up on this chat, what changed here, what's waiting on me, or what do you need from me."
metadata:
  bridge-kind: helper
  bridge-label: Catch up
---

# Catch up

You own a reply that lets the user understand what changed in this chat and make every call waiting on them from the reply alone. This turn is read-only.

## Steps

1. Find the cutoff: the user's last message before this request. Notifications, trigger messages and sub-agent results are not the user's messages. Assume they remember that message and nothing after it.
2. Collect what happened since: your own work, sub-agent results and anything else posted in the chat. Check the current state of each pull request, preview, run, trigger or agent the chat touched, and check every number you will repeat against its source.
3. Collect the action items: calls only the user can make, such as a product choice, an approval, an irreversible or outward action, or access you lack. Include items raised before the cutoff that still wait. Work you can still do yourself is not an action item, and never invent one to fill the reply.
4. Write the reply in plain words: say what changed for the user, not how you did it, and leave out ids, paths and commands unless the user needs one to act.
   - Open with one sentence naming what waits on the user, or saying nothing does. If nothing happened and nothing waits, say so and stop.
   - Then what happened, in under 100 words: one line per thing the user asked for, with what came of it and whether it is done, running, failed or not checked. Show screenshots the work already produced with publish_visual; never draw a screen you did not capture.
   - Then one line naming work left that you can do yourself, if any.
   - Then each action item: the call, your pick, what it changes for the user, the evidence behind the pick, and its risk (even when low). When several items share one call, state the call and pick once, then one line per item, riskiest first. For a choice between options, give each option's gain and cost.
5. Do not start work, change anything or open ask_user forms unless the user asks to decide now.

## Gates

Everything here is read-only and proceeds without asking.

## Output

The reply described in step 4. Never mark something done that still waits on the user, and never cut an action item to keep the reply short.
