import { Clock, Pause, Play, Plus } from "lucide-react";
import type { TriggerView } from "../../api";
import { timeAgo } from "../../time";
import TaskPanelSummaryDisclosure from "../TaskPanelSummaryDisclosure";
import type { TaskPanelSummaryChip } from "../TaskPanelSummaryRow";
import { IconButton, MetaLine, StatusIcon } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import type { TriggerAction } from "../../hooks/queries/useTriggers";
import { formatTriggerWhen, isTriggerLive, triggerLabel, triggerStatusKind, triggerStatusLabel } from "../../lib/trigger-presentation";

export interface TriggerSectionProps {
  /** The task's triggers, as the server sorts them: live ones first, by next run. */
  triggers: TriggerView[];
  taskId: string;
  onAdd: () => void;
  onOpen: (trigger: TriggerView) => void;
  onAction: (action: TriggerAction, id: string) => void;
}

function triggerSummary(trigger: TriggerView): string {
  if (trigger.status === "active" && trigger.nextRunAt) return `Next ${timeAgo(trigger.nextRunAt)}`;
  if (trigger.lastRunAt) return `${triggerStatusLabel(trigger.status)} · last run ${timeAgo(trigger.lastRunAt)}`;
  return triggerStatusLabel(trigger.status);
}

function TriggerRow({ trigger, onOpen, onAction }: { trigger: TriggerView; onOpen: () => void; onAction: TriggerSectionProps["onAction"] }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" onClick={onOpen} className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "flex-1 gap-2")}>
        <StatusIcon kind={triggerStatusKind(trigger.status)} label={triggerStatusLabel(trigger.status)} />
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate", isTriggerLive(trigger.status) ? "text-text-primary" : "text-text-secondary")}>
            {triggerLabel(trigger)}
          </span>
          <MetaLine items={[
            formatTriggerWhen(trigger.when, trigger.whenLabel),
            trigger.status === "active" && trigger.nextRunAt && `Next ${timeAgo(trigger.nextRunAt)}`,
            trigger.runCount > 0 && `${trigger.runCount} run${trigger.runCount === 1 ? "" : "s"}`,
          ]} />
        </span>
      </button>
      {trigger.canRun && (
        <IconButton label="Run now" onClick={() => onAction("run", trigger.id)}>
          <Play size={12} aria-hidden="true" />
        </IconButton>
      )}
      {trigger.canPause && (
        <IconButton label="Pause" onClick={() => onAction("pause", trigger.id)}>
          <Pause size={12} aria-hidden="true" />
        </IconButton>
      )}
      {trigger.canResume && (
        <IconButton label="Resume" onClick={() => onAction("resume", trigger.id)}>
          <Play size={12} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}

/** The task's triggers on one summary line that opens to a row per trigger. */
export default function TriggerSection({ triggers, taskId, onAdd, onOpen, onAction }: TriggerSectionProps) {
  if (triggers.length === 0) return null;
  const primary = triggers[0]!;
  const active = triggers.filter((trigger) => trigger.status === "active" || trigger.status === "running").length;
  const paused = triggers.filter((trigger) => trigger.status === "paused").length;
  const stopped = triggers.length - active - paused;
  const chips: TaskPanelSummaryChip[] = [
    active > 0 ? { label: `${active} active` } : null,
    paused > 0 ? { label: `${paused} paused` } : null,
    stopped > 0 ? { label: `${stopped} stopped` } : null,
  ].filter((chip): chip is TaskPanelSummaryChip => chip !== null);

  return (
    <TaskPanelSummaryDisclosure
      label="Triggers"
      icon={<Clock size={14} className={active > 0 ? "text-text-secondary" : "text-text-faint"} />}
      title={triggers.length === 1 ? triggerLabel(primary) : `${triggers.length} triggers`}
      subtitle={triggers.length === 1 ? triggerSummary(primary) : `${triggerLabel(primary)} · ${triggerSummary(primary)}`}
      chips={chips}
      itemCount={triggers.length}
      taskId={taskId}
      disclosureId="triggers"
      onOpenSingle={() => onOpen(primary)}
      trailing={(
        <IconButton label="Add trigger" onClick={onAdd}>
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      )}
    >
      {triggers.map((trigger) => (
        <TriggerRow key={trigger.id} trigger={trigger} onOpen={() => onOpen(trigger)} onAction={onAction} />
      ))}
    </TaskPanelSummaryDisclosure>
  );
}
