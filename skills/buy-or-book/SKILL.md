---
name: buy-or-book
description: "Playbook: find, compare and, only with explicit approval, buy, book, reserve or subscribe to something. Use when asked to buy, order, purchase, book, reserve, renew, subscribe, find the best price, find a flight, hotel, table, ticket or appointment, or compare products to get."
metadata:
  bridge-kind: playbook
  bridge-family: errand
  bridge-label: Buy or book
  bridge-evidence: sourced, approved
---

# Buy or book

You own the search, the comparison and the paperwork. The user owns every payment, booking and submission.

## Steps

1. Restate what the user wants and the smallest purchase or booking that meets it. For task-linked work with no doneWhen, set one with task_update as a pass/fail condition (for example "booked and confirmation number recorded").
   - Load any skill that <skill_roles> lists as extending `buy-or-book` and add its steps where it says.
2. Pin the requirements: must-haves, nice-to-haves, budget, dates and times, location, quantity, which account or payment method, and the deadline.
3. Check context first: task notes, the knowledge base and earlier purchases or bookings for preferences, loyalty accounts and things to avoid.
4. Search for options and verify each one live on the seller's own page: current price, total with fees and taxes, availability for the exact dates, and cancellation or return terms. Follow <browser_escalation> for pages that need a browser.
5. Shortlist two to four options in a table: option | total price | availability (checked at what time) | key terms | link.
6. Recommend one with its main tradeoff. If the user only wanted a recommendation, stop here and go to Done means.
7. Before any payment, booking, subscription or form submission, ask with ask_user and show the exact item, total price, dates, account or payment method and cancellation terms.
8. Right before acting, re-check price and availability. If either changed, ask again with the new numbers.
9. Complete the purchase or booking exactly as approved, handling sign-in and human checks per <browser_blocks>.
10. Keep the confirmation number, total charged, dates and cancellation deadline for the verify_complete summary and `approved` ref, which put them in task history. Send the receipt or confirmation page with send_attachment when there is one.
11. Add the date, and the cancellation deadline if there is one, to the calendar with calendar_event_create when it helps the user.

## Gates

Searching, comparing, reading reviews and filling forms up to the final submit proceed without asking.

Ask first with ask_user, every time: paying, booking, reserving, subscribing, submitting a form, creating an account, accepting terms, and cancelling or changing an existing order. Approval covers the exact item, price and account shown; any change needs a new approval.

## Done means

Prices and availability were checked live, and every gated action had explicit approval. Call verify_complete with `sourced` entries for the live checks (seller URLs and time) and an `approved` entry for the purchase or booking, with the confirmation number in `ref`. If the user stopped at the recommendation, record `approved` with result "not_run" and say no purchase was requested:

`verify_complete({ summary, evidence: [{ kind: "sourced", claim, ref, result }, { kind: "approved", claim, ref: "<confirmation>", result }], unverified })`

## Reply

The recommendation or what was bought or booked, the total, the confirmation number and cancellation deadline, and anything still waiting on the user.
