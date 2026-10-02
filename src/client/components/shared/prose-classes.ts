/**
 * Shared prose/markdown styling constants.
 *
 * APP_PROSE — compact markdown for sheets, modals, and message bubbles.
 *   Consumers must add `prose-pre:bg-*` and `prose-th:bg-*` to match
 *   their container background (e.g. bg-bg-secondary for sheets on a
 *   bg-bg-primary container, or bg-bg-primary for message bubbles on
 *   a bg-bg-surface container).
 *
 * The Docs view styles its full-page markdown with the .docs-prose rules in index.css.
 *
 * AGENT_PROSE — smaller still, for an agent's brief and report opened beneath its row in the
 *   transcript or the agents list.
 */

export const AGENT_PROSE = "ds-prose prose prose-invert prose-xs max-w-none text-xs leading-relaxed text-text-secondary prose-headings:mb-1 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-pre:rounded prose-pre:bg-bg-primary prose-pre:p-2 prose-pre:text-[11px] prose-code:text-[11px]";

export const APP_PROSE = [
  "prose prose-invert prose-sm",
  "prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full",
  "prose-code:text-accent prose-code:text-xs prose-code:font-mono",
  "prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5",
  "prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5",
  "prose-table:block prose-table:overflow-x-auto prose-table:max-w-full",
  "prose-a:text-accent prose-a:no-underline hover:prose-a:underline",
  "prose-img:my-2 prose-img:max-w-full prose-img:rounded-md prose-img:border prose-img:border-border",
  "prose-headings:mt-3 prose-headings:mb-1",
  "prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5",
  "prose-li:my-0.5",
].join(" ");
