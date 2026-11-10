import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Trash2 } from "lucide-react";
import { fetchTaskPage, removeTaskPage, taskPageUrl } from "../api";
import { queryKeys } from "../queryClient";
import { useToast } from "../useToast";
import { DS, cx } from "../design/tokens";
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

function useTaskPage(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskPage(taskId),
    queryFn: ({ signal }) => fetchTaskPage(taskId, { signal }),
  }).data;
}

/**
 * The page itself, drawn at phone width and shrunk to a thumbnail, as the chat's cards show an HTML
 * file. It only shows: taps go to the row around it.
 */
function PageThumbnail({ url }: { url: string }) {
  return (
    <span aria-hidden="true" className="relative h-16 w-12 shrink-0 overflow-hidden rounded-md border border-surface-edge bg-surface-inset">
      <iframe
        src={inlineFileUrl(url)}
        sandbox={HTML_SANDBOX_PERMISSIONS}
        title="Page thumbnail"
        tabIndex={-1}
        loading="lazy"
        scrolling="no"
        className="pointer-events-none absolute left-0 top-0 h-[520px] w-[390px] origin-top-left scale-[0.123] border-0"
      />
    </span>
  );
}

/**
 * A task's page in its panel, when a chat has published one. A task has one page, so the page is
 * the row itself: it opens full screen, and the button at its end opens it in a tab of its own.
 */
export default function TaskPageSection({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const page = useTaskPage(taskId);
  if (!page) return null;
  const updated = formatUpdated(page.updatedAt);
  const file = { url: `${taskPageUrl(taskId)}?v=${encodeURIComponent(page.updatedAt)}`, name: "page.html", title: taskTitle };
  const tabUrl = fileTabUrl(file);
  return (
    <section aria-label="Page" className={cx(DS.layout.section, "flex items-center gap-1 py-2 sm:py-2")}>
      <button
        type="button"
        onClick={() => showFile(file)}
        className={cx(DS.row.base, DS.row.interactive, "min-h-11 flex-1 gap-3 py-1.5")}
      >
        <PageThumbnail url={file.url} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">Page</span>
          <span className={cx("block", DS.text.meta)}>Updated {updated}</span>
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
    </section>
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
