---
name: schedule-it
description: "Playbook: find a time, propose it and put it on the calendar, inviting others only with approval. Use when asked to schedule, set up a meeting, find a time, book time with, block time for, remind me at, reschedule, move or cancel a meeting or event."
metadata:
  bridge-kind: playbook
  bridge-family: errand
  bridge-label: Schedule it
---

# Schedule it

You own finding the time and creating the entry. Invitations that go out in the user's name wait for the user.

## Steps

1. Restate what is being scheduled and the smallest calendar change that does it. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition.
   - Load any skill that <skill_roles> lists as extending `schedule-it` and add its steps where it says.
2. Pin the details: title, attendees, duration, the window it must fall in, time zones, location or online link, and any deadline.
3. Read the user's own calendar with calendar_list for the window, and attendees' availability with the connected calendar tools when they exist. If you cannot see someone's availability, say so.
4. Find two or three candidate slots that fit everyone's working hours and time zones, avoid conflicts, and leave buffers around travel or back-to-back meetings.
5. For the user's own reminders and time blocks, create the entry with calendar_event_create on the Bridge calendar and go to step 8.
6. When other people are invited, propose the slots with ask_user, showing the exact attendees, time in each attendee's time zone, title and body.
7. Create the event or send the invitation exactly as approved, with the connected calendar tool that sends invitations. If none exists, say so and give the details for the user to send.
8. Read the event back from the calendar to confirm the time, time zone and attendees are right.
9. If replies matter, create a one-shot defer to check responses before the event.

## Gates

Reading calendars, finding slots and creating Bridge calendar events for the user's own reminders proceed without asking.

Ask first with ask_user: sending invitations, accepting or declining for the user, moving or cancelling events that have other attendees, and booking rooms or paid resources.

## Done means

The event exists with the right details, and invitations had approval. Call verify_complete with `delivered` for the created event (read back), `approved` when invitations went to others, and `live` for the availability you checked:

`verify_complete({ summary, evidence: [{ kind: "delivered", claim, ref, result }], unverified })`

## Reply

The time in the user's time zone (and attendees' where different), who was invited, where it is on the calendar, and any attendee whose availability you could not see.
