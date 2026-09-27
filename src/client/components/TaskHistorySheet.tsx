import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Trash2, X } from "lucide-react";
import {
  addTaskHistoryEntry,
  deleteTaskHistoryEntry,
  fetchTaskHistory,
  type TaskHistoryEntry,
} from "../api";
import { queryKeys } from "../queryClient";
import { timeAgo } from "../time";
import { DS, cx } from "../design/tokens";
import { Button, EmptyHint, IconButton, MetaLine, TextArea } from "../design/primitives";
import { useModalDialog } from "./shared/useModalDialog";

export const TASK_HISTORY_PAGE_SIZE = 50;

export function describeHistoryActor(entry: Pick<TaskHistoryEntry, "source" | "scheduleName" | "sessionId">): string {
  if (entry.source === "user") return "You";
  if (entry.source === "system") return "Bridge";
  if (entry.scheduleName) return entry.scheduleName;
  return entry.sessionId ? "Agent session" : "Agent";
}

/** The latest entries, for a summary line. */
export function useTaskHistory(taskId: string, limit = TASK_HISTORY_PAGE_SIZE, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.taskHistory(taskId), limit],
    queryFn: ({ signal }) => fetchTaskHistory(taskId, { signal, limit }),
    refetchOnWindowFocus: false,
    enabled: enabled && Boolean(taskId),
  });
}

function HistoryEntryRow({
  entry,
  armed,
  deleting,
  onArm,
  onDelete,
  onSelectSession,
}: {
  entry: TaskHistoryEntry;
  armed: boolean;
  deleting: boolean;
  onArm: (armed: boolean) => void;
  onDelete: () => void;
  onSelectSession?: (sessionId: string) => void;
}) {
  const at = new Date(entry.at);
  return (
    <li className="py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <MetaLine items={[
          <span key="actor" className="text-text-secondary">{describeHistoryActor(entry)}</span>,
          <time key="at" dateTime={entry.at} title={at.toLocaleString()}>{timeAgo(entry.at)}</time>,
        ]} />
        <div className="-mr-2 flex shrink-0 items-center gap-1">
          {entry.sessionId && onSelectSession && !armed && (
            <Button size="sm" variant="ghost" onClick={() => onSelectSession(entry.sessionId!)}>
              Open session
            </Button>
          )}
          {armed ? (
            <>
              <Button size="sm" variant="danger" disabled={deleting} onClick={onDelete}>Delete</Button>
              <Button size="sm" variant="ghost" disabled={deleting} onClick={() => onArm(false)}>Keep</Button>
            </>
          ) : (
            <IconButton label="Delete entry" onClick={() => onArm(true)}>
              <Trash2 size={13} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      <p className={cx(DS.text.rowDetail, "mt-1 whitespace-pre-wrap break-words text-text-secondary")}>{entry.text}</p>
    </li>
  );
}

/**
 * A task's history: what happened, newest first. Entries are written once; agents read the latest
 * few in every turn's context and search the rest with a tool.
 */
export default function TaskHistorySheet({
  taskId,
  onClose,
  onSelectSession,
}: {
  taskId: string;
  onClose: () => void;
  onSelectSession?: (sessionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const [draft, setDraft] = useState("");
  const [armedId, setArmedId] = useState<number | null>(null);
  // Pages by entry id, so every entry stays reachable however long the history grows.
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.taskHistory(taskId), "pages"],
    queryFn: ({ signal, pageParam }) => fetchTaskHistory(taskId, {
      signal,
      limit: TASK_HISTORY_PAGE_SIZE,
      ...(pageParam ? { before: pageParam } : {}),
    }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.entries.length === TASK_HISTORY_PAGE_SIZE ? lastPage.entries.at(-1)?.id : undefined),
    refetchOnWindowFocus: false,
  });
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskHistory(taskId) });
  };
  const addMutation = useMutation({
    mutationFn: (text: string) => addTaskHistoryEntry(taskId, text),
    onSuccess: () => {
      setDraft("");
      invalidate();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (entryId: number) => deleteTaskHistoryEntry(taskId, entryId),
    onSuccess: () => {
      setArmedId(null);
      invalidate();
    },
  });

  const submit = () => {
    const text = draft.trim();
    if (!text || addMutation.isPending) return;
    addMutation.mutate(text);
  };
  const mutationError = addMutation.error ?? deleteMutation.error;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        {...dialogProps}
        className={cx(DS.surface.dialog, "relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] rounded-t-2xl md:rounded-xl flex flex-col")}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 id={titleId} className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <History size={14} className="text-text-muted" />
            History
            {total > 0 && <span className="font-normal tabular-nums text-text-faint">{total}</span>}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className={cx(DS.text.meta, "mb-3")}>
            What happened in this task, newest first. Agents see the latest few entries with each message and can search the rest.
          </p>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <TextArea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              maxLength={4000}
              aria-label="New history entry"
              placeholder="Record something that happened or was decided…"
              className="resize-y"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="primary" disabled={!draft.trim() || addMutation.isPending}>
                Add entry
              </Button>
              {mutationError && (
                <span className={cx(DS.text.meta, DS.tone.danger)} role="alert">
                  {mutationError instanceof Error ? mutationError.message : "Something went wrong."}
                </span>
              )}
            </div>
          </form>

          <div className="mt-4">
            {query.isError ? (
              <EmptyHint>History could not be loaded.</EmptyHint>
            ) : query.isPending ? null : entries.length === 0 ? (
              <EmptyHint>Nothing recorded yet.</EmptyHint>
            ) : (
              <ol className={DS.surface.divided} aria-label="Task history">
                {entries.map((entry) => (
                  <HistoryEntryRow
                    key={entry.id}
                    entry={entry}
                    armed={armedId === entry.id}
                    deleting={deleteMutation.isPending}
                    onArm={(armed) => setArmedId(armed ? entry.id : null)}
                    onDelete={() => deleteMutation.mutate(entry.id)}
                    onSelectSession={onSelectSession}
                  />
                ))}
              </ol>
            )}
            {query.hasNextPage && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 -ml-2.5"
                disabled={query.isFetchingNextPage}
                onClick={() => { void query.fetchNextPage(); }}
              >
                Show older entries
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
