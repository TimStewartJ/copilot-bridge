import type { TaskAttentionHealth } from "../hooks/useTaskAttention";
import { Details, IconButton, StatusIcon } from "../design/primitives";
import { DS, cx } from "../design/tokens";

export default function TaskAttentionNotice({ health, collapsed = false, compact = false, onExpand }: {
  health: TaskAttentionHealth | null;
  collapsed?: boolean;
  compact?: boolean;
  onExpand?: () => void;
}) {
  if (!health) return null;
  const label = health.state === "loading" ? "Loading task activity"
    : health.state === "stale" ? "Activity refresh failed"
      : health.state === "unavailable" ? "Activity data unavailable" : "Activity data incomplete";
  const count = health.affectedTasks.length;
  const countLabel = `${count} ${count === 1 ? "task" : "tasks"}`;
  if (collapsed) return <IconButton label={`${label}. Expand the task list for details.`} onClick={onExpand}>
    <StatusIcon kind="unknown" decorative />
  </IconButton>;
  return <div data-task-attention-notice={health.state} className="min-w-0" role="status">
    {health.state === "loading" ? <p className={cx(DS.text.meta, "px-3 py-1")}>{label}...</p>
      : <Details label={label} detail={count ? compact ? <span aria-label={countLabel}>{count}</span> : countLabel : undefined}>
        {health.state === "stale" && <p className={DS.text.meta}>
          Showing the last reading{health.updatedAt ? ` from ${new Date(health.updatedAt).toLocaleString()}` : ""}.
        </p>}
        {health.messages.map(message => <p key={message} className={cx(DS.text.meta, "break-words")}>{message}</p>)}
        <p className={DS.text.meta}>Missing information does not create a Needs a look suggestion.</p>
        {health.affectedTasks.length > 0 && <ul className="mt-2 space-y-1">
          {health.affectedTasks.map(task => <li key={task.id} className={cx(DS.text.meta, "break-words")}>
            <span className="text-text-secondary">{task.title}</span>
            {!health.messages.includes(task.reason) && <>: {task.reason}</>}
          </li>)}
        </ul>}
      </Details>}
  </div>;
}
