import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronRight, ExternalLink, FileText, Sparkles, Trash2 } from "lucide-react";
import { fetchTaskPage, removeTaskPage, taskPageUrl } from "../api";
import { queryKeys } from "../queryClient";
import { useToast } from "../useToast";
import { DS, cx } from "../design/tokens";
import { Button } from "../design/primitives";
import { CtxItem } from "./ContextMenu";
import { fileTabUrl, inlineFileUrl, showFile } from "./file-preview";
import { HTML_SANDBOX_PERMISSIONS } from "./visualDisplay";

/** The time for a page updated today, else the day, so it fits a narrow side panel. */
function formatUpdated(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function useTaskPageQuery(taskId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taskPage(taskId),
    queryFn: ({ signal }) => fetchTaskPage(taskId, { signal }),
    enabled,
  });
}

function useTaskPage(taskId: string) {
  return useTaskPageQuery(taskId).data;
}

/**
 * The page itself, drawn at phone width and shrunk to a thumbnail, as the chat's cards show an HTML
 * file. It only shows: taps go to the row around it.
 */
function PageThumbnail({ url }: { url: string }) {
  return (
    <span aria-hidden="true" className="relative h-12 w-9 shrink-0 overflow-hidden rounded-md border border-surface-edge bg-surface-inset">
      <iframe
        src={inlineFileUrl(url)}
        sandbox={HTML_SANDBOX_PERMISSIONS}
        title="Page thumbnail"
        tabIndex={-1}
        loading="lazy"
        scrolling="no"
        className="pointer-events-none absolute left-0 top-0 h-[520px] w-[390px] origin-top-left scale-[0.0923] border-0"
      />
    </span>
  );
}

/** The open page row: a thumbnail that opens the page full screen, and a button for a tab of its own. */
function PageRow({ taskId, taskTitle, updatedAt }: { taskId: string; taskTitle: string; updatedAt: string }) {
  const file = { url: `${taskPageUrl(taskId)}?v=${encodeURIComponent(updatedAt)}`, name: "page.html", title: taskTitle };
  const tabUrl = fileTabUrl(file);
  return (
    <div role="group" aria-label="Page" className="-mx-1.5 flex h-14 min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => showFile(file)}
        className={cx(DS.row.base, DS.row.interactive, "h-full flex-1 gap-2.5 px-1.5 py-1")}
      >
        <PageThumbnail url={file.url} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text-primary">Page</span>
          <span className={cx("block", DS.text.meta)}>Updated {formatUpdated(updatedAt)}</span>
        </span>
        <ChevronRight size={14} aria-hidden="true" className={DS.row.chevron} />
      </button>
      {tabUrl && (
        <a
          href={tabUrl}
          target="_blank"
          rel="noreferrer"
          className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost, "shrink-0")}
          aria-label="Open page in a new tab"
          title="Open in new tab"
        >
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * A task's page as a row among the task's linked things, when a chat has published one. A task has
 * one page, so the row opens it full screen, and the button at its end opens it in a tab of its own.
 */
export default function TaskPageSection({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const page = useTaskPage(taskId);
  if (!page) return null;
  return <PageRow taskId={taskId} taskTitle={taskTitle} updatedAt={page.updatedAt} />;
}

/**
 * The task's page in its Status, always one row tall so nothing below moves while it loads: the
 * page when there is one, otherwise a button that starts a chat to make it.
 */
export function TaskPageSlot({ taskId, taskTitle, onMakePage }: {
  taskId: string;
  taskTitle: string;
  /** Starts the chat that makes the page; resolves once it has started or failed. */
  onMakePage: () => Promise<void>;
}) {
  const query = useTaskPageQuery(taskId);
  const [starting, setStarting] = useState(false);
  if (query.isPending) return <div className="h-14" aria-busy="true" aria-label="Page" />;
  if (query.data) return <PageRow taskId={taskId} taskTitle={taskTitle} updatedAt={query.data.updatedAt} />;
  const make = async () => {
    setStarting(true);
    try { await onMakePage(); } finally { setStarting(false); }
  };
  return (
    <div role="group" aria-label="Page" className="flex h-14 min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="flex h-12 w-9 shrink-0 items-center justify-center rounded-md border border-surface-edge bg-surface-inset text-text-faint">
        <FileText size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text-primary">Page</span>
        <span className={cx("block", DS.text.meta)}>None yet</span>
      </span>
      <Button
        size="sm"
        disabled={starting}
        icon={<Sparkles size={13} aria-hidden="true" />}
        onClick={() => { void make(); }}
      >
        {starting ? "Starting…" : "Make page"}
      </Button>
    </div>
  );
}

/** "Remove page" in the task's menu, when the task has a page. */
export function RemoveTaskPageItem({ taskId, closeMenu }: { taskId: string; closeMenu: () => void }) {
  const page = useTaskPage(taskId);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  if (!page) return null;
  const remove = async () => {
    closeMenu();
    if (!window.confirm("Remove this task's page? A chat can publish it again.")) return;
    try {
      await removeTaskPage(taskId);
      queryClient.setQueryData(queryKeys.taskPage(taskId), null);
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't remove the page", description: error instanceof Error ? error.message : String(error) });
    }
  };
  return <CtxItem icon={<Trash2 size={14} />} label="Remove page" onClick={() => { void remove(); }} />;
}
