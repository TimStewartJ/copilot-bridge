---
name: bridge-verify
description: "Verify Copilot Bridge changes live: run the staging preview verification lane, take phone and desktop screenshots in light and dark theme, and prove the changed feature on the running preview. Use when asked to verify the preview, prove it works, check a Bridge change live, or take screenshots of the change."
metadata:
  bridge-roles: verify
---

# Verify Copilot Bridge changes

Tests prove the code; this skill proves the running Bridge. Use it for any change to this repository
once a staging preview exists, and before calling verify_complete.

## Order

1. While iterating, run `npm run check:fast` and the lane for the area you changed: `check:client`,
   `check:server`, `check:packages`, `check:integration`, `check:launcher`, `check:staging` or
   `check:native`.
2. `staging_preview` runs `npm run check:pr`, builds the client and serves the preview at
   `<base>/staging/<prefix>/` with its own backend and a copy of the data. Wait for it with
   `management_job_wait`. Do not run `check:pr` by hand right before it.
3. From the staging worktree, run the lane against the preview:
   `npm run verify:preview -- --url http://127.0.0.1:<port>/staging/<prefix>/ --out <dir>`.
   The shareable URL (for example `https://bridge.example.devtunnels.ms/staging/<prefix>/`) works too.
4. Prove the feature you changed with its row in the feature map below. The lane shows that the app
   starts and its core flows work; it knows nothing about your change.
5. Look at the screenshots yourself, then report.

## The lane: `npm run verify:preview`

Source: `src/server/verify-preview.ts`. Rerun it; do not write a smoke driver in the chat. If a check
is missing for something you keep proving by hand, add it there.

| Flag | Effect |
|---|---|
| `--url <url>` | Preview page root (required) |
| `--out <dir>` | Screenshots and `summary.json` (default: a new temp folder) |
| `--no-screens` | API checks only |
| `--require-screens` | Fail when agent-browser is missing instead of skipping the screenshots |
| `--chat` | One live chat turn on the cheapest enabled model (costs a model call) |
| `--model <id>` | Model for `--chat` |
| `--read-only` | No fixtures and no theme changes; the only mode a non-preview Bridge allows |

API checks: health, runtime status, settings, skills, playbooks catalog (skipped when not served),
sessions, defers of one session, task create and update, schedules of the task, checklist add and
remove, docs page write and read. Fixtures are named `verify-preview <nonce>`, live under the docs
path `verify-preview/`, and are deleted at the end even after a failure; each deletion is a check.
The lane writes only when `/api/server/runtime-status` reports `isStaging`.

Screenshots: home (`/dashboard/home`), tasks (`/`), the fixture task, a chat (the `--chat` session or
the first existing one), the fixture docs page and settings, each at phone 390x844 and desktop
1440x900, in light and dark. Files are `<page>-<phone|desktop>-<light|dark>.png`. The lane switches
the preview's theme setting and restores it afterwards (a `system` theme is emulated instead). A
page fails when `#root` stays empty, when it shows crash text, or when the theme does not apply.

Output: progress on stderr, the JSON summary on stdout and in `<out>/summary.json`, with each check's
`pass`, `fail` or `skip` and every screenshot path. Exit code 0 only when nothing failed.

Screenshots show the preview's copy of real data. Keep them out of the repository, commits and PRs.

## Feature map

| Area | How to prove it live | Automated coverage to cite |
|---|---|---|
| Chat streaming and history | `--chat`: reply streamed, persisted in `/api/sessions/<id>/messages-fast`, chat screenshot. For transcript UI changes, run a turn that produces the changed element (tool row, sub-agent, image) and screenshot it at both widths | `check:server`, `check:client` |
| Tools and MCP connection | In a preview chat, have the agent call the tool and show its result; read `GET /api/sessions/<id>/mcp-status`; the chat header MCP count; Settings › Integrations | `copilot-tool-loading.native.test.ts` via `test:native` |
| Tasks, checklists, history | Lane covers create, update and checklist. For history, add an entry and read `GET /api/tasks/<id>/history`; screenshot the task panel `/tasks/<id>` | `check:integration` |
| Home and attention marks | Create the state that should raise the mark on the preview (overdue checklist item, unread reply, waiting question), screenshot `/dashboard/home` and the sidebar, then remove it and screenshot again | `check:client` |
| Docs | Lane writes and screenshots `verify-preview/<nonce>`. For editor or reader changes, edit the page in the browser and reload | `check:integration` |
| Schedules, defers, check-gated defers | Create the schedule or defer on a fixture task or preview chat; trigger with `POST /api/schedules/<id>/trigger` instead of waiting; read `GET /api/sessions/<id>/defers` and `.../defers/<deferId>/runs`. For a check-gated defer, show one run where the check held it back and one where it ran | `check:server` |
| Settings sections | `/settings?group=<id>` (chat, responses, helm, appearance, device, integrations, tags, voice, system, usage). Change the value, reload, confirm it in `GET /api/settings`, put it back | `check:client` |
| Playbook chip and catalog | `GET /api/playbooks` (the lane checks it when served). In a preview chat, have the agent call `playbook_select`, then screenshot the header chip at both widths | `check:server`, `check:client` |
| Verified completion card | In a preview chat on a fixture task, have the agent call `verify_complete`; screenshot the card and read the task history entry it adds | `check:server`, `check:client` |
| Skills page and skill packs | `GET /api/skills` (lane); Settings › Integrations › Skills. For packs, add one from a fixture folder on the preview, confirm its skills and source show, remove it | `check:server` |
| Voice and Helm | `/helm` and `/helm/memory`, Settings › Voice. Previews never think on a schedule, so use Think again. Real microphone and speaker paths need a device: report them as unverified | voice tests in `src/server/voice/` via `check:server` |
| Mobile layout | The lane's phone screenshots. For sheets, gestures and the keyboard, drive a `browser_session_*` at `set viewport 390 844`; check that `document.documentElement.scrollWidth <= innerWidth` | `test:design-audit` |
| Browser features (live view, upload, download) | Use the feature from a preview chat | `npm run check:browser` (needs agent-browser and a real browser) |
| Preview and staged backend machinery | `npm run preview:smoke` | `check:staging`, `test:native` |

## What the screenshots must show

- The changed element itself in view, not only a page that loaded.
- Both widths and both themes, unless the change cannot differ by width or theme; then say so.
- No crash text and no blank page (the lane fails on these), and no clipped, overlapping or
  unreadable text, which only you can judge. Check contrast in the dark theme.
- For a fix, the before state as well when you can reproduce it on production or an older preview.

## Report

1. Publish the screenshots that show the change with `publish_visual` (kind `image`), a few rather
   than all of them, each captioned with page, width and theme.
2. Call `verify_complete` with a `live` entry per surface you checked: the claim, `ref` set to the
   `summary.json` path and the screenshot paths, and the result. Add `tested` entries for the check
   lanes you ran. Put what you could not check (a phone's push notification, a microphone) in
   `unverified`.
3. In the reply, give the lane's pass, fail and skip counts and any failure; do not paste the JSON.
