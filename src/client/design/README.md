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
2. **Group with space, a hairline or a rail, not with boxes.** The page is one background. A bordered
   surface (`Panel`) is for a self-contained object such as a question to answer, and is never put
   inside another one. Rows of one list are divided by hairlines (`DS.surface.divided`); content
   opened beneath a row hangs from a rail (`DS.rail`).
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

Colours are theme variables from `index.css`, used by role (`text-text-muted`, `bg-bg-hover`), never
by value, so both themes keep working. Scrollbars and native controls follow the theme globally.

## What to use

| You are showing | Use |
| --- | --- |
| The action the screen exists for | `<Button variant="primary">` (one per screen) |
| Any other action | `<Button>` (secondary), `variant="ghost"`, `variant="danger"`; `IconButton` for an icon alone |
| A choice between a few options | `SegmentedControl` |
| Options that wrap, or a multi-select | `ChoiceButton` in `DS.choice.group` |
| A text field, select, labelled control | `TextInput`, `TextArea`, `Select`, `FormRow` |
| A group of rows with a label | `Section` (`level="page"` on a full-page view) |
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

- Files in `audit-pending.ts` are exempt until they are migrated. **Never add a file to that list.**
  New screens, and screens you change, follow the system.
- When a pending file comes clean the audit fails until you remove it from the list, which is what
  keeps it clean afterwards.
- A real exception takes a comment on the line above, and the reason is required:
  `// design-audit-ignore-next-line: a diff is content, and added lines are green by convention`.
  An exception is for content that has its own conventions, not for a screen that is hard to restyle.

## Migrating a screen

1. `npx tsx src/client/design/audit.ts --explain <file>` lists what it still breaks.
2. Rebuild it from the primitives. Expect to delete more than you add: boxes, borders, pills, labels
   in capitals, and local `Section`/`Card`/`Chip` helpers all go.
3. Check it in both themes and at phone width. Look at the real screen, not only the tests.
4. Remove the file from `audit-pending.ts` and run `npm run check:client`.

The chat transcript (`components/chat/`, `ToolCallBlock`, `SubAgentGroup`), the chat container, the
new-chat screen, the task panel, the task rail and lists, the shared phone navigation, and the task
overview are on the system. Copilot usage is migrated across the quota rail/tooltip/dialog, mobile
quota summary, local usage settings, task analytics, session cost/context details and deferred-work
receipts. Focus, the dashboard, remaining settings, docs, search, Helm and remaining sheets are pending.

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
