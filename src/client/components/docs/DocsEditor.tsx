import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Columns2, Eye, PenLine, X, type LucideIcon } from "lucide-react";
import { DocConflictError, type DbSchema, type DocPage } from "../../api";
import { useTagsQuery } from "../../hooks/queries/useTags";
import { useToast } from "../../useToast";
import DocsMarkdown from "./DocsMarkdown";
import DocsTagsInput from "./DocsTagsInput";
import MarkdownEditor from "./MarkdownEditor";
import { EntryFieldsForm } from "./DocsEntryFields";
import { DocsTopBar, useDocsShell } from "./docs-shell";
import { useSaveEntryMutation, useSavePageMutation } from "./docs-queries";
import { clearDraft, loadDraft, loadEditorMode, saveDraft, saveEditorMode, type EditorMode } from "./docs-storage";
import { cx, DocsBanner, DocsButton, DocsDialog, DocsField, DocsIconButton, DocsInput, DocsTextarea, useElementWidth } from "./docs-ui";
import {
  arePageDraftsEqual,
  buildBreadcrumbs,
  entryFieldsPayload,
  entryFormValues,
  extractHeadings,
  formatRelativeTime,
  leadingTitle,
  mergePageFrontmatter,
  pageDraftFromFrontmatter,
  stripLeadingTitle,
  tagsMatch,
  validateEntryForm,
  validatePageDraft,
  type EntryFormValues,
  type PageDraftFields,
} from "./docs-model";
import { DS } from "../../design/tokens";

const DRAFT_SAVE_DELAY_MS = 500;
/** The preview re-renders the whole document; on a long page that must wait for a pause in typing. */
const PREVIEW_DELAY_MS = 200;
/** Side-by-side writing and preview needs two readable columns. */
const SPLIT_MIN_PANE_WIDTH = 1000;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const MODES: { mode: EditorMode; label: string; icon: LucideIcon }[] = [
  { mode: "write", label: "Write", icon: PenLine },
  { mode: "split", label: "Split", icon: Columns2 },
  { mode: "preview", label: "Preview", icon: Eye },
];

function sameFieldValues(a: EntryFormValues, b: EntryFormValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

/** A page whose leading H1 mirrors its title keeps mirroring it after the title is edited. */
function syncLeadingTitle(body: string, previousTitle: string, nextTitle: string): string {
  if (previousTitle === nextTitle || leadingTitle(body) !== previousTitle) return body;
  return body.replace(/^(\s*#\s+).*$/m, (_line, marker: string) => `${marker}${nextTitle}`);
}

export interface DocsEditorProps {
  /** Latest copy of the page. It keeps updating while editing, which is how outside changes are noticed. */
  page: DocPage;
  schema: DbSchema | null;
  onClose: () => void;
}

export default function DocsEditor({ page, schema, onClose }: DocsEditorProps) {
  const { index, isMobile } = useDocsShell();
  const { showToast } = useToast();
  const { data: bridgeTags } = useTagsQuery();

  const titleId = useId();
  const descriptionId = useId();
  const tagsId = useId();
  const bodyId = useId();
  const isEntry = page.isDbItem && schema !== null;

  // Everything below is captured once: the editor works from the revision it was opened on.
  const [base] = useState(() => ({ frontmatter: page.frontmatter, body: page.body, title: page.title }));
  const [initialDraft] = useState<PageDraftFields>(() => pageDraftFromFrontmatter(page.frontmatter, page.body, page.title));
  const [initialFields] = useState<EntryFormValues>(() => (schema ? entryFormValues(schema, page.frontmatter) : {}));
  const [restored] = useState(() => loadDraft(page.path));

  const [draft, setDraft] = useState<PageDraftFields>(() => (restored
    ? { title: restored.title, description: restored.description, tags: restored.tags, body: restored.body }
    : initialDraft));
  const [fieldValues, setFieldValues] = useState<EntryFormValues>(() => ({ ...initialFields, ...(restored?.fields ?? {}) }));
  const [baseModified, setBaseModified] = useState(() => restored?.baseModified ?? page.modified);
  const [showRestored, setShowRestored] = useState(restored !== null);
  const [mode, setModeState] = useState<EditorMode>(() => loadEditorMode() ?? "write");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<DocConflictError | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const savePage = useSavePageMutation();
  const saveEntry = useSaveEntryMutation();
  const saving = savePage.isPending || saveEntry.isPending;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const editorCardRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSplit = useElementWidth(scrollRef) >= SPLIT_MIN_PANE_WIDTH;

  const effectiveMode: EditorMode = mode === "split" && (!canSplit || isMobile) ? "write" : mode;
  const dirty = !arePageDraftsEqual(draft, initialDraft) || !sameFieldValues(fieldValues, initialFields);
  const changedElsewhere = Boolean(page.modified) && page.modified !== baseModified;

  const setMode = (next: EditorMode) => {
    setModeState(next);
    saveEditorMode(next);
  };

  const tagSuggestions = useMemo(() => {
    const names: string[] = [];
    const add = (name: string) => {
      if (name && !names.some((existing) => tagsMatch(existing, name))) names.push(name);
    };
    bridgeTags?.forEach((tag) => add(tag.name));
    index.pages.forEach((entry) => entry.tags.forEach(add));
    return names.sort((a, b) => a.localeCompare(b));
  }, [bridgeTags, index]);

  // Unsaved work survives navigation, reloads and crashes as a local draft.
  useEffect(() => {
    if (!dirty) {
      clearDraft(page.path);
      return;
    }
    const timer = setTimeout(() => {
      saveDraft(page.path, { ...draft, fields: isEntry ? fieldValues : undefined, baseModified, savedAt: new Date().toISOString() });
    }, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, draft, fieldValues, baseModified, isEntry, page.path]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // In split view the preview follows the writer's position through the document.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (effectiveMode !== "split" || !scroller) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const card = editorCardRef.current;
      const preview = previewRef.current;
      if (!card || !preview) return;
      const range = card.offsetHeight - scroller.clientHeight;
      const ratio = range > 0 ? Math.min(1, Math.max(0, (scroller.scrollTop - card.offsetTop) / range)) : 0;
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
    };
  }, [effectiveMode]);

  const finish = useCallback(() => {
    clearDraft(page.path);
    onClose();
  }, [onClose, page.path]);

  const save = useCallback(async (overwrite = false) => {
    if (saving) return;
    setError(null);
    const title = draft.title.trim();

    if (isEntry && schema) {
      const errors = validateEntryForm(schema, title, fieldValues);
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) {
        setError("Fix the highlighted fields before saving.");
        return;
      }
    } else {
      const problem = validatePageDraft(draft);
      if (problem) {
        setError(problem);
        return;
      }
    }

    const body = syncLeadingTitle(draft.body, base.title, title);
    const revision = overwrite ? undefined : baseModified || undefined;
    try {
      if (isEntry && schema) {
        await saveEntry.mutateAsync({
          path: page.path,
          fields: { title, ...entryFieldsPayload(schema, fieldValues, "update") },
          body,
          baseModified: revision,
        });
      } else {
        await savePage.mutateAsync({
          path: page.path,
          frontmatter: mergePageFrontmatter(base.frontmatter, { ...draft, title }),
          body,
          baseModified: revision,
        });
      }
      showToast({ tone: "success", title: "Saved", description: title, durationMs: 2500 });
      finish();
    } catch (cause) {
      if (cause instanceof DocConflictError) setConflict(cause);
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [saving, draft, isEntry, schema, fieldValues, base, baseModified, saveEntry, savePage, page.path, showToast, finish]);

  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else finish();
  };

  const startOver = () => {
    setDraft(initialDraft);
    setFieldValues(initialFields);
    setBaseModified(page.modified);
    setShowRestored(false);
    clearDraft(page.path);
  };

  // Ctrl/Cmd+S saves from anywhere in the editor, not only from inside the text area.
  const handleShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const debouncedBody = useDebouncedValue(draft.body, PREVIEW_DELAY_MS);
  // Switching to the preview tab should show the latest text at once, not the debounced copy.
  const previewSource = effectiveMode === "preview" ? draft.body : debouncedBody;
  const previewBody = useMemo(() => stripLeadingTitle(previewSource), [previewSource]);
  const previewHeadings = useMemo(() => extractHeadings(previewBody), [previewBody]);
  const crumbs = useMemo(() => buildBreadcrumbs(page.path, index, draft.title || page.title), [page.path, index, draft.title, page.title]);

  const status = saving ? "Saving…" : dirty ? "Unsaved changes" : "No changes";
  const saveLabel = isMobile ? "Save" : "Save changes";

  const preview = (
    <div className="px-5 py-5 sm:px-6">
      {previewBody.trim() ? (
        <DocsMarkdown markdown={previewBody} headings={previewHeadings} currentPath={page.path} currentIsDirectory={page.isFolderIndex} index={index} />
      ) : (
        <p className="text-sm text-text-faint">Nothing to preview yet.</p>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleShortcut}>
      <DocsTopBar
        crumbs={crumbs}
        title={isEntry ? "Edit entry" : "Edit page"}
        mobileLeading={<DocsIconButton icon={X} label="Stop editing" size={20} onClick={requestClose} className="h-10 w-10" />}
        actions={(
          <>
            {!isMobile && <span className="mr-1.5 text-xs text-text-muted" aria-live="polite">{status}</span>}
            {!isMobile && <DocsButton variant="ghost" onClick={requestClose} disabled={saving}>Cancel</DocsButton>}
            <DocsButton variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty && !saving}>{saveLabel}</DocsButton>
          </>
        )}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={cx("mx-auto w-full px-4 pb-24 pt-6 sm:px-8", effectiveMode === "split" ? "max-w-[100rem]" : "max-w-[52rem]")}>
          {(error || changedElsewhere || (showRestored && restored)) && (
            <div className={cx("mb-5 space-y-3", effectiveMode === "split" && "max-w-[52rem]")}>
              {error && <DocsBanner tone="error">{error}</DocsBanner>}
              {changedElsewhere && (
                <DocsBanner tone="warning">
                  This page was changed {formatRelativeTime(page.modified)} while you were editing. Saving will ask before replacing that version.
                </DocsBanner>
              )}
              {showRestored && restored && (
                <DocsBanner
                  tone="info"
                  actions={(
                    <>
                      <DocsButton variant="ghost" onClick={startOver}>Discard them</DocsButton>
                      <DocsButton variant="ghost" onClick={() => setShowRestored(false)}>Got it</DocsButton>
                    </>
                  )}
                >
                  Picked up your unsaved edits from {formatRelativeTime(restored.savedAt)}.
                </DocsBanner>
              )}
            </div>
          )}

          <div className={cx("space-y-4", effectiveMode === "split" && "max-w-[52rem]")}>
            <DocsField label="Title" htmlFor={titleId} required error={fieldErrors.title}>
              <DocsInput
                id={titleId}
                value={draft.title}
                disabled={saving}
                invalid={Boolean(fieldErrors.title)}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                className="h-11 text-lg font-semibold"
              />
            </DocsField>

            {isEntry && schema ? (
              <EntryFieldsForm
                schema={schema}
                values={fieldValues}
                errors={fieldErrors}
                disabled={saving}
                onChange={(name, value) => setFieldValues((current) => ({ ...current, [name]: value }))}
              />
            ) : (
              <>
                <DocsField label="Description" htmlFor={descriptionId} hint="One or two sentences. Shown under the title, in search, and to agents deciding whether to read the page.">
                  <DocsTextarea
                    id={descriptionId}
                    rows={2}
                    value={draft.description}
                    disabled={saving}
                    onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    className="resize-y"
                  />
                </DocsField>
                <DocsField label="Tags" htmlFor={tagsId}>
                  <DocsTagsInput
                    id={tagsId}
                    tags={draft.tags}
                    suggestions={tagSuggestions}
                    disabled={saving}
                    onChange={(tags) => setDraft((current) => ({ ...current, tags }))}
                  />
                </DocsField>
              </>
            )}
          </div>

          <div className="mb-2 mt-7 flex items-center justify-between gap-3">
            <label htmlFor={bodyId} className="text-[13px] font-medium text-text-secondary">Content</label>
            <div role="group" aria-label="Editor layout" className="flex rounded-md border border-border bg-bg-secondary p-0.5">
              {MODES.filter((option) => option.mode !== "split" || (canSplit && !isMobile)).map(({ mode: option, label, icon: Icon }) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={effectiveMode === option}
                  onClick={() => setMode(option)}
                  className={cx(DS.button.base, DS.button.size.sm, DS.segmented.option, "gap-1.5", effectiveMode === option ? cx(DS.button.base, DS.button.size.sm, DS.segmented.option, "bg-bg-hover text-text-primary") : cx(DS.button.base, DS.button.size.sm, DS.segmented.option, "text-text-muted hover:text-text-primary"))}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div
            ref={editorCardRef}
            className={cx("rounded-xl border border-border bg-bg-primary [overflow:clip]", effectiveMode === "split" && "grid grid-cols-2 divide-x divide-border")}
          >
            {effectiveMode !== "preview" && (
              <MarkdownEditor id={bodyId} value={draft.body} disabled={saving} textareaRef={textareaRef} onSave={() => void save()} onChange={(body) => setDraft((current) => ({ ...current, body }))} />
            )}
            {effectiveMode === "split" && (
              <div ref={previewRef} className="sticky top-0 h-[calc(100dvh-3rem)] min-w-0 overflow-y-auto" aria-label="Preview">
                {preview}
              </div>
            )}
            {effectiveMode === "preview" && <div className="min-h-[50vh]">{preview}</div>}
          </div>

          <p className="mt-3 text-xs text-text-faint">
            Markdown with GitHub extras: tables, task lists and <code className="font-mono">[[page name]]</code> links to other docs. Unsaved work is kept on this device.
          </p>
        </div>
      </div>

      {confirmingDiscard && (
        <DocsDialog
          title="Discard your changes?"
          description="Your edits to this page have not been saved."
          size="sm"
          onClose={() => setConfirmingDiscard(false)}
          footer={(
            <>
              <DocsButton size="md" variant="ghost" onClick={() => setConfirmingDiscard(false)} data-autofocus>Keep editing</DocsButton>
              <DocsButton size="md" variant="danger" onClick={finish}>Discard changes</DocsButton>
            </>
          )}
        >
          <p className="text-sm leading-6 text-text-secondary">Discarding returns the page to its last saved version.</p>
        </DocsDialog>
      )}

      {conflict && (
        <DocsDialog
          title="This page changed while you were editing"
          size="md"
          busy={saving}
          onClose={() => setConflict(null)}
          footer={(
            <>
              <DocsButton size="md" variant="ghost" onClick={() => setConflict(null)} disabled={saving} data-autofocus>Keep editing</DocsButton>
              <DocsButton size="md" variant="danger" loading={saving} onClick={() => { setConflict(null); void save(true); }}>Replace with my version</DocsButton>
            </>
          )}
        >
          <p className="text-sm leading-6 text-text-secondary">
            Someone else, most likely an agent, saved a newer version
            {conflict.currentModified ? ` ${formatRelativeTime(conflict.currentModified)}` : ""}. Replacing it overwrites their changes with yours.
            To merge by hand instead, keep editing, copy your text, and reopen the page.
          </p>
        </DocsDialog>
      )}
    </div>
  );
}
