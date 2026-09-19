import { useId, useMemo, useState, type FormEvent } from "react";
import type { DbSchema } from "../../api";
import { useToast } from "../../useToast";
import { EntryFieldsForm } from "./DocsEntryFields";
import { useDocsShell } from "./docs-shell";
import { useCreateEntryMutation, useDbSchemaQuery, useDeletePageMutation, useSavePageMutation } from "./docs-queries";
import { DocsBanner, DocsButton, DocsDialog, DocsField, DocsInput, DocsTextarea } from "./docs-ui";
import {
  entryFieldsPayload,
  entryFormValues,
  joinDocPath,
  listPageFolders,
  slugifyPageName,
  validateEntryForm,
  validateNewPagePath,
  type EntryFormValues,
} from "./docs-model";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── New page ──────────────────────────────────────────────────────

function humanizeSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

export function NewPageDialog({ initialFolder, initialSlug = "", onClose }: { initialFolder: string; initialSlug?: string; onClose: () => void }) {
  const { index, goTo } = useDocsShell();
  const createPage = useSavePageMutation();
  const titleId = useId();
  const folderId = useId();
  const slugId = useId();
  const folderListId = useId();
  const [title, setTitle] = useState(() => humanizeSlug(initialSlug));
  const [folder, setFolder] = useState(initialFolder);
  const [slug, setSlug] = useState(initialSlug);
  const [slugEdited, setSlugEdited] = useState(Boolean(initialSlug));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folders = useMemo(() => listPageFolders(index), [index]);
  const effectiveSlug = slugEdited ? slug.trim() : slugifyPageName(title);
  const path = joinDocPath(folder.replace(/^\/+|\/+$/g, ""), effectiveSlug);
  const pathProblem = effectiveSlug ? validateNewPagePath(path, index) : null;
  const titleProblem = submitted && !title.trim() ? "Give the page a title." : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (!title.trim() || !effectiveSlug || pathProblem) return;
    try {
      const result = await createPage.mutateAsync({ path, frontmatter: { title: title.trim() }, body: "" });
      onClose();
      goTo(result.path, { edit: true });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <DocsDialog
      title="New page"
      onClose={onClose}
      busy={createPage.isPending}
      footer={(
        <>
          <DocsButton size="md" variant="ghost" onClick={onClose} disabled={createPage.isPending}>Cancel</DocsButton>
          <DocsButton size="md" variant="primary" type="submit" form={`${titleId}-form`} loading={createPage.isPending}>Create page</DocsButton>
        </>
      )}
    >
      <form id={`${titleId}-form`} onSubmit={submit} className="space-y-4" noValidate>
        {error && <DocsBanner tone="error">{error}</DocsBanner>}
        <DocsField label="Title" htmlFor={titleId} required error={titleProblem}>
          <DocsInput
            id={titleId}
            data-autofocus
            value={title}
            invalid={Boolean(titleProblem)}
            placeholder="Release checklist"
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        </DocsField>
        <div className="grid gap-4 sm:grid-cols-2">
          <DocsField label="Folder" htmlFor={folderId} hint="Leave empty for the top level. A new folder name creates it.">
            <DocsInput
              id={folderId}
              list={folderListId}
              value={folder}
              placeholder="Top level"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setFolder(event.target.value)}
            />
            <datalist id={folderListId}>
              {folders.map((option) => <option key={option} value={option} />)}
            </datalist>
          </DocsField>
          <DocsField label="Address" htmlFor={slugId} hint="The page's name in links and URLs.">
            <DocsInput
              id={slugId}
              value={effectiveSlug}
              placeholder="release-checklist"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
            />
          </DocsField>
        </div>
        <div role={pathProblem ? "alert" : undefined} className={`rounded-md border px-3 py-2 text-[13px] ${pathProblem ? "border-error/30 bg-error/10 text-error" : "border-border bg-bg-primary text-text-muted"}`}>
          {pathProblem ?? (
            <>Will be created at <span className="break-all font-mono text-text-secondary">docs/{path || "…"}</span></>
          )}
        </div>
      </form>
    </DocsDialog>
  );
}

// ── New collection entry ──────────────────────────────────────────

function NewEntryForm({ folder, schema, onClose }: { folder: string; schema: DbSchema; onClose: () => void }) {
  const { goTo } = useDocsShell();
  const createEntry = useCreateEntryMutation();
  const titleId = useId();
  const bodyId = useId();
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<EntryFormValues>(() => entryFormValues(schema, {}));
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const problems = validateEntryForm(schema, title, values);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    try {
      const result = await createEntry.mutateAsync({
        folder,
        fields: { title: title.trim(), ...entryFieldsPayload(schema, values, "create") },
        ...(body.trim() ? { body } : {}),
      });
      onClose();
      goTo(result.path);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <DocsDialog
      title={`New entry in ${schema.name}`}
      size="lg"
      onClose={onClose}
      busy={createEntry.isPending}
      footer={(
        <>
          <DocsButton size="md" variant="ghost" onClick={onClose} disabled={createEntry.isPending}>Cancel</DocsButton>
          <DocsButton size="md" variant="primary" type="submit" form={`${titleId}-form`} loading={createEntry.isPending}>Add entry</DocsButton>
        </>
      )}
    >
      <form id={`${titleId}-form`} onSubmit={submit} className="space-y-4" noValidate>
        {error && <DocsBanner tone="error">{error}</DocsBanner>}
        <DocsField label="Title" htmlFor={titleId} required error={errors.title}>
          <DocsInput id={titleId} data-autofocus value={title} invalid={Boolean(errors.title)} autoComplete="off" onChange={(event) => setTitle(event.target.value)} />
        </DocsField>
        <EntryFieldsForm
          schema={schema}
          values={values}
          errors={errors}
          disabled={createEntry.isPending}
          onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        />
        <DocsField label="Notes" htmlFor={bodyId} hint="Optional. Markdown; you can keep writing on the entry's page afterwards.">
          <DocsTextarea id={bodyId} rows={4} value={body} onChange={(event) => setBody(event.target.value)} className="resize-y" />
        </DocsField>
      </form>
    </DocsDialog>
  );
}

export function NewEntryDialog({ folder, onClose }: { folder: string; onClose: () => void }) {
  const schemaQuery = useDbSchemaQuery(folder);
  if (schemaQuery.data) return <NewEntryForm folder={folder} schema={schemaQuery.data} onClose={onClose} />;
  return (
    <DocsDialog title="New entry" onClose={onClose} size="lg">
      {schemaQuery.isError
        ? <DocsBanner tone="error">This collection's fields could not be loaded. {errorMessage(schemaQuery.error)}</DocsBanner>
        : <p className="py-6 text-center text-sm text-text-muted">Loading fields…</p>}
    </DocsDialog>
  );
}

// ── Delete ────────────────────────────────────────────────────────

export interface DeleteTarget {
  path: string;
  title: string;
  isEntry: boolean;
}

export function DeletePageDialog({ target, onClose, onDeleted }: { target: DeleteTarget; onClose: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const deletePage = useDeletePageMutation();
  const [error, setError] = useState<string | null>(null);
  const noun = target.isEntry ? "entry" : "page";

  const confirm = async () => {
    setError(null);
    try {
      await deletePage.mutateAsync({ path: target.path, isEntry: target.isEntry });
      showToast({ tone: "success", title: `Deleted “${target.title}”`, durationMs: 4000 });
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <DocsDialog
      title={`Delete this ${noun}?`}
      size="sm"
      onClose={onClose}
      busy={deletePage.isPending}
      footer={(
        <>
          <DocsButton size="md" variant="ghost" onClick={onClose} disabled={deletePage.isPending} data-autofocus>Cancel</DocsButton>
          <DocsButton size="md" variant="danger" onClick={() => void confirm()} loading={deletePage.isPending}>Delete {noun}</DocsButton>
        </>
      )}
    >
      <div className="space-y-3">
        {error && <DocsBanner tone="error">{error}</DocsBanner>}
        <p className="text-sm leading-6 text-text-secondary">
          <span className="font-medium text-text-primary">{target.title}</span> will be removed from your docs. Links to it from other pages will stop working.
        </p>
        <p className="text-[13px] leading-5 text-text-muted">
          Bridge keeps snapshots of your docs, so an agent can usually restore a deleted {noun} if you change your mind.
        </p>
      </div>
    </DocsDialog>
  );
}
