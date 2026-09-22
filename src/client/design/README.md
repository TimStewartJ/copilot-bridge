# Bridge design system

Every screen in the client is built from this folder. It exists so the app reads as one product:
quiet, dense with information, and calm until something needs attention.

- `tokens.ts` holds the class recipes (`DS`) and `cx()`. One rule, spelled out in classes, in one place.
- `primitives.tsx` holds the components built from them. Reach for one before writing a class string.
- `index.ts` exports the runtime components and tokens, without the development-only audit.
- `audit.ts` is the gate that keeps screens on the system. `audit-pending.ts` lists the screens
  written before it existed; that list only shrinks.

## The rules

1. **Content is the only full-contrast text.** A reply, a task's brief, a document. Every label,
   figure and control around it is one step quieter than the thing it describes (`DS.text`).
2. **Surface levels show hierarchy; rows and values stay simple.** The workspace is a canvas,
   navigation and inspectors are panes, and a significant region gets one opaque neutral group
   (`Section surface`, `DS.surface.group`). Grouping only with whitespace makes loaded task views
   hard to scan. A collection has one boundary and a header band, not a card around every row.
   Individual values remain unboxed; rows use hairlines (`DS.surface.divided`) and expanded content
   uses a rail (`DS.rail`) or an inset. Never nest Panels or two same-level group surfaces.
3. **One line that says what it is, which opens for more.** Closed by default: the reader chooses
   what to open (`DisclosureRow`, `Details`). Rows read as sentences ("Searched for …", "Worked for
   2m · 14 steps") and the raw details are one click away.
4. **Colour carries state, and only on the words or icon that carry it.** A warning does not turn
   its section yellow (`Notice`, `Badge`, `DS.tone`). Something healthy or ordinary has no colour. A
   user's own colours (groups, tags) mark identity with a dot or a tag, never a tinted box.
5. **Accent is never a fill.** It marks what is waiting on the reader (`DS.text.attention`), links,
   and keyboard focus (`DS.focus`). Selection is a neutral fill (`DS.row.selected`,
   `DS.segmented.selected`, `DS.choice.selected`).
6. **One primary action per screen,** in the neutral high-contrast fill (`<Button variant="primary">`).
   On a chat screen it is Send. Everything else is `secondary` (a quiet fill) or `ghost` (text).
7. **Motion means alive.** Shimmer (`DS.motion.live`) for work in flight, reveal (`DS.motion.reveal`)
   for content opening. Nothing moves for decoration, and both stop under reduced motion.
8. **An absent state is said once, quietly** (`EmptyHint`, `Field`'s `empty`), never drawn as a
   dashed empty box.
9. **Numbers are tabular, literal input is mono.** A ticking figure must not jitter; a command, path
   or pattern is shown as itself (`DS.text.meta`, `DS.text.literal`).
10. **Capitals are kept for the label inside a detail panel** (`DS.text.eyebrow`). Section labels are
    sentence case (`DS.text.sectionLabel`, `DS.text.sectionTitle`).
11. **Only what floats has a shadow:** menus, the composer, dialogs, jump controls
    (`DS.surface.floating`, `.composer`, `.dialog`, `.sheet`, `.floatingPill`, `.lift`).
12. **Touch targets are 40px on a phone** (`DS.button.size.md`, `DS.field.inputSize.md`), and a text
    field is 16px there so iOS does not zoom the page.

Colours are theme variables from `index.css`, used by role, never by value. Scrollbars and native
controls follow the theme globally.

The palette is neutral grey with no tint. Text has three levels: `text-primary` for content,
`text-secondary` for labels and detail, `text-faint` for metadata. `text-muted` is an alias of
secondary, kept so existing screens stay readable. Each state colour has a text value, a badge
surface (`*-surface`) and a brighter glyph value (`icon-*`) that only needs 3:1 because it is a
graphic. Group and tag colours are `identity-*` swatches and are never used for state.
`surface-contrast.test.ts` holds the numbers: 4.5:1 for text and badges, 3:1 for glyphs and input
edges, minimum steps between text levels and between surfaces, and an APCA floor for dark text.

## Surface hierarchy

| Level | Purpose | Recipe |
| --- | --- | --- |
| Canvas | Workspace behind panes and groups | `DS.surface.canvas` |
| Pane | Persistent navigation, task rail, task inspector | `DS.surface.pane` |
| Group | A logical region: Momentum, Sessions, a settings category | `Section surface`, `DS.surface.group` |
| Inset | Inputs, raw details, evidence opened inside a group | `DS.field`, `DS.surface.inset` / `.detail` |
| Selected | The active row or choice, visibly distinct from hover | `DS.row.selected`, `DS.surface.selected` |
| Overlay | Menus, dialogs, sheets and the composer | `DS.surface.floating` / `.dialog` / `.sheet` / `.composer` |

Use opaque surfaces, not opacity variants whose appearance changes with the parent. A pane is
separated from the workspace by its tone and an edge; a group by a neutral boundary and consistent
padding. A loaded collection gets a header band (`DS.collection.header`) and divided rows. Do not
use a surface for a count, timestamp, label or individual field value. Shadows remain for overlays
only. Light mode uses white groups on a neutral canvas/pane; dark mode steps from canvas to pane to
group. Selection and control boundaries must remain visible in both themes.

Hierarchy comes from layout, type size/weight and surfaces, not illegibly faint text. Every enabled
text role and semantic state must reach 4.5:1 on the supported surfaces; input boundaries reach 3:1.
Keep these contrast checks in the design tests and verify the actual composed UI, including badges,
hover/selected rows and constrained panes.

## What to use

| You are showing | Use |
| --- | --- |
| The action the screen exists for | `<Button variant="primary">` (one per screen) |
| Any other action | `<Button>` (secondary), `variant="ghost"`, `variant="danger"`; `IconButton` for an icon alone |
| A choice between a few options | `SegmentedControl` |
| Options that wrap, or a multi-select | `ChoiceButton` in `DS.choice.group` |
| A text field, select, labelled control | `TextInput`, `TextArea`, `Select`, `FormRow` |
| A group of rows with a label | `Section` (`surface` for a significant region; `level="page"` on a full-page view) |
| Something that opens to show more | `DisclosureRow`; `Details` when no state is needed |
| Labelled values | `FieldList` + `Field`, not one box per value |
| Headline figures | `StatRow`, not tiles |
| A state in a word or two | `Badge` |
| How many things want attention | `CountBadge` |
| Facts on one quiet line | `MetaLine` |
| Something the reader should know | `Notice` (neutral surface, toned icon and title) |
| Nothing to show | `EmptyHint` |
| A self-contained object to act on | `Panel` (never nested) |
| A proportion | `DS.meter` (neutral fill; a chart is not a call to action) |
| Copilot amounts, tokens, and metering coverage | `lib/usage-presentation.ts`, `components/usage/UsageModelList`, `TokenBreakdown` |
| A user's tag | `TagPill` (`DS.tag`) |
| A row in a list, a menu, a dialog, a sheet | `DS.row`, `DS.surface.floating`, `.dialog` + `.scrim`, `.sheet` |

When a selector's choices already explain its purpose, `FormRow hideLabel` keeps the label available
to assistive technology without displaying it or reserving a label column. Single fields still use
`htmlFor`; button groups still name themselves with `aria-label`, as on the new-chat screen.

If what you need is missing and a second screen will need it too, add it here, with a comment that
says what it is for, and use it from the screen. Do not grow a private copy in a component.

Write every class out in full. Tailwind finds classes by scanning source text, so a name built from
pieces (`"bg-" + tone`) is never generated.

## How it is enforced

`npm run test:design-audit` runs in `check:fast`, `check:client` and `check:pr`. It reads every
client source file outside this folder and fails on the retired patterns: accent fills and outlines,
white-on-colour fills, tinted boxes, `rounded-full` state pills, dashed empty boxes, shadows on
in-page surfaces, uppercase labels, imports of the legacy `shared/design-system` tokens, and nested
`Panel` components. It parses literals and JSX, so multiline recipes and aliased panels are checked,
not just class strings on one line. Each failure names the rule and what to use instead. The audit
also runs in the CI, preview-package and release-package workflows.

- `audit-pending.ts` is now empty, and a regression test requires it to stay empty. **Never add a
  file to that list.** Every runtime screen is held to the system; the legacy token module is retired.
- A real exception takes a comment on the line above, and the reason is required:
  `// design-audit-ignore-next-line: a diff is content, and added lines are green by convention`.
  An exception is for content that has its own conventions, not for a screen that is hard to restyle.

## Migrating a screen

1. `npx tsx src/client/design/audit.ts --explain <file>` lists what it still breaks.
2. Rebuild it from the primitives. Replace redundant nested boxes and per-value tiles with one
   group surface, divided rows and insets. Retire pills, labels in capitals and private copies of
   `Section`/`Card`/`Chip`; do not flatten away meaningful boundaries.
3. Check it in both themes and at phone width. Look at the real screen, not only the tests.
4. Run `npm run check:client`; no screen can be added to an exemption list.

## Migration coverage

The first migration covered task/chat/usage. The second audited the 81 remaining exempt files and
363 literal violations, then moved every file onto the system and removed the legacy tokens.

| Batch | Surfaces |
| --- | --- |
| Shared controls | Docs adapters, settings sections/configuration rows, compound fields, menus, dialogs, notices and feedback |
| Focus and dashboard | Actions, alerts, decisions, coverage, digests, quiet sources, history, lifecycle/launch/protection review and work map |
| Docs and search | Navigation, landing/folders, collections, page reader, editor, fields, tags, contents rail, dialogs and saved-text search |
| Settings | Every category: general/response style, models/effort/workers, appearance, providers/MCP/skills/tags, notifications/devices, speech, updates/jobs/commits and diagnostics |
| Supporting surfaces | Workspace, notes, schedule, task picker/deletion, agent/doc/reference/artifact previews, model-switch prompt, backend banner/toasts, Helm and hands-free |
| Readable surfaces | Loaded task collections, inspector identity/Momentum/Sessions/Checklist/Details and task overview groups, with explicit canvas/pane/group/inset/overlay roles |

Visual migration does not change billing/indexing, task completion, Focus lifecycle/authority,
user-controlled protection, settings save boundaries, docs conflict/draft handling or voice capture.
The audit is a regression guard, not proof of visual quality: use real data and inspect representative
loaded/empty/error states, both themes and phone/container widths before publishing a preview.

## Search and settings

- Search is one top-anchored overlay. Its query and source controls stay outside the single results
  scroller. It grows with content up to a viewport bound, rather than leaving a tall empty panel.
  Source headings, dividers and bounded excerpts do the grouping; do not put result cards inside
  another card. Notes/docs use plain Markdown excerpts; message excerpts remain literal for code
  searches. Query syntax, coverage details and help are available without competing with results.
- Settings uses one neutral category surface with separated sections, not one card per setting.
  Keep common defaults visible, and use disclosures for long instruction text, catalog details and
  optional icon choices. Mobile category selection must expose every category without a sideways
  hunt. Live quota remains one tap away in the mobile header. Long configuration lists follow the
  primary controls; row actions stay in the shared overflow menu instead of crowding phone layouts.
- Draft controls use the page's Save/Discard pair. Save only changed top-level fields; do not write
  unchanged or independently saved values back from an older snapshot. Theme changes are reversible
  previews until Save, and revert on Discard or leaving settings. Model metadata arriving is a read,
  never an implicit edit to the saved draft. Missing/error states offer a real retry.
- Labels must be associated with their input, select or textarea. Field errors are described by the
  affected control, and native dropdown affordances remain visible.

## Copilot usage presentation

- Live account quota is a separate source from local, shutdown-based usage. Say which is being shown.
- SDK-reported metered amounts carry their recorded coverage; price-card estimates are labelled as
  estimates. Neither is presented as an invoice.
- No reading is `Not recorded` or `Unavailable`, never a manufactured zero. A recorded free run is
  a real zero. Small positive costs and credits retain precision so they do not look free.
- Model summaries open onto the full token and pricing breakdown. Cache reads and writes remain
  separate; reasoning is identified as included in output.
- Ordinary usage bars are neutral. Calendar-month pace is a labelled reference, not a prediction.
- Failed refreshes keep the cached reading visible and explicitly mark it as the previous reading.
- Usage sources, units and coverage qualifiers use `DS.usage.meta` / `DS.usage.prose`, not faint
  decorative text. They are essential to interpreting the amount and must remain readable in both themes.
