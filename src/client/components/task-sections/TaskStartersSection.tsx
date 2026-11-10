import { useState } from "react";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import { DS, cx } from "../../design/tokens";
import { EmptyHint, IconButton, Section } from "../../design/primitives";
import { useTaskStartersActions, useTaskStartersQuery } from "../../hooks/queries/useTaskStarters";
import type { TaskStarter } from "../../../shared/task-starters.js";

/** Chats Helm suggests starting next on this task. Tapping one opens a new chat with its prompt. */
export function TaskStartersSection({
  taskId,
  onStart,
}: {
  taskId: string;
  /** Opens the new chat; false when it could not, so the suggestion stays. */
  onStart: (starter: TaskStarter) => boolean;
}) {
  const query = useTaskStartersQuery(taskId);
  const { refresh, dismiss, markUsed } = useTaskStartersActions(taskId);
  const data = query.data;
  const refreshing = !!data?.refreshing || refresh.isPending;
  const starters = data?.starters ?? [];
  const error = data?.error ?? (refresh.error instanceof Error ? refresh.error.message : undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Section
      surface
      label="Suggested"
      action={(
        <IconButton
          label="Refresh suggestions"
          className="-mr-1.5"
          disabled={refreshing}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw size={14} aria-hidden="true" className={cx(refreshing && "animate-spin")} />
        </IconButton>
      )}
    >
      {starters.length > 0 ? (
        <ul className="space-y-0.5">
          {starters.map((starter) => {
            const open = openId === starter.id;
            const promptId = `starter-prompt-${starter.id}`;
            return (
              <li key={starter.id} className="min-w-0">
                <div className="flex min-w-0 items-center gap-1">
                  <IconButton
                    label={open ? `Hide prompt for ${starter.label}` : `Show prompt for ${starter.label}`}
                    aria-expanded={open}
                    aria-controls={open ? promptId : undefined}
                    className="-ml-2 shrink-0"
                    onClick={() => setOpenId(open ? null : starter.id)}
                  >
                    <ChevronRight size={14} aria-hidden="true" className={cx(DS.row.chevron, open && DS.row.chevronOpen)} />
                  </IconButton>
                  <button
                    type="button"
                    onClick={() => { if (onStart(starter)) markUsed(starter.id); }}
                    className={cx(DS.row.base, DS.row.interactive, DS.row.touch, "flex-1")}
                  >
                    <span className="min-w-0 flex-1 text-text-primary">{starter.label}</span>
                  </button>
                  <IconButton
                    label={`Dismiss ${starter.label}`}
                    onClick={() => dismiss.mutate(starter.id)}
                  >
                    <X size={13} aria-hidden="true" />
                  </IconButton>
                </div>
                {open && (
                  <p id={promptId} className={cx(DS.rail, DS.motion.reveal, DS.text.prose, "mb-2 ml-3 whitespace-pre-wrap break-words")}>
                    {starter.prompt}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyHint>{refreshing ? "Asking Helm…" : "None yet"}</EmptyHint>
      )}
      {error && !refreshing && <p className={cx(DS.text.rowDetail, "mt-1")}>{error}</p>}
    </Section>
  );
}
