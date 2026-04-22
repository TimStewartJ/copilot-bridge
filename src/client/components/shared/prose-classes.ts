/**
 * Shared prose/markdown styling constants.
 *
 * APP_PROSE — compact markdown for sheets, modals, and message bubbles.
 *   Consumers must add `prose-pre:bg-*` and `prose-th:bg-*` to match
 *   their container background (e.g. bg-bg-secondary for sheets on a
 *   bg-bg-primary container, or bg-bg-primary for message bubbles on
 *   a bg-bg-surface container).
 *
 * DOCS_PROSE — rich, full-page markdown for the Docs view.
 */

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

export const DOCS_PROSE = `
  prose prose-invert max-w-none text-text-primary
  prose-headings:scroll-mt-28 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-text-primary
  prose-h1:text-3xl prose-h1:mt-0 prose-h1:mb-5
  prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-t prose-h2:border-border prose-h2:pt-6
  prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3
  prose-h4:text-lg prose-h4:mt-6 prose-h4:mb-2
  prose-p:my-4 prose-p:leading-7 prose-p:text-text-primary/95
  prose-li:my-1.5 prose-li:text-text-primary/95
  prose-ul:my-4 prose-ol:my-4
  prose-hr:border-border prose-hr:my-8
  prose-blockquote:my-6 prose-blockquote:rounded-2xl prose-blockquote:border prose-blockquote:border-border prose-blockquote:bg-bg-secondary/70 prose-blockquote:px-5 prose-blockquote:py-4 prose-blockquote:text-text-secondary
  prose-a:text-accent prose-a:no-underline hover:prose-a:underline
  prose-strong:text-text-primary prose-code:text-text-primary prose-code:bg-bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none
  prose-pre:bg-transparent prose-pre:border-0 prose-pre:p-0
  prose-table:my-6 prose-table:w-full
  prose-th:border prose-th:border-border prose-th:bg-bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-text-secondary
  prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2
  prose-img:rounded-2xl prose-img:border prose-img:border-border prose-img:shadow-sm
  [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full
  [&_thead]:bg-bg-secondary/70
  [&_h1+a]:mt-0 [&_h2+a]:mt-0 [&_h3+a]:mt-0
`;
