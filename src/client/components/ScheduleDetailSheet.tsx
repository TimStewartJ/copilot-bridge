import { useState, useEffect } from "react";
import type { Schedule, ScheduleCreateInput, ScheduleRun, ScheduleSessionMode, Session } from "../api";
import { createSchedule, patchSchedule, fetchServerTimezone, getSessionRunState } from "../api";
import { useScheduleSessionsQuery } from "../hooks/queries/useScheduleSessions";
import { useSessionsQuery } from "../hooks/queries/useSessions";
import { useTasksQuery } from "../hooks/queries/useTasks";
import type { ScheduleSheetMode } from "../hooks/useScheduleDetail";
import { timeAgo } from "../time";
import {
  X,
  Clock,
  Play,
  Pause,
  Pencil,
  Trash2,
  MoreVertical,
  ExternalLink,
  ChevronDown,
  RefreshCw,
  Calendar,
  Repeat,
  MessageSquare,
  Globe,
} from "lucide-react";
import EmptyState from "./shared/EmptyState";

const CRON_PRESETS = [
  { label: "Every weekday at 8 AM", cron: "0 8 * * 1-5" },
  { label: "Every day at 8 AM", cron: "0 8 * * *" },
  { label: "Every day at 6 PM", cron: "0 18 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 2 hours", cron: "0 */2 * * *" },
  { label: "Every 4 hours", cron: "0 */4 * * *" },
  { label: "Every Monday at 9 AM", cron: "0 9 * * 1" },
  { label: "Every Friday at 5 PM", cron: "0 17 * * 5" },
  { label: "Custom", cron: "" },
];

const SESSION_MODE_OPTIONS: Array<{ value: ScheduleSessionMode; label: string; description: string }> = [
  {
    value: "new",
    label: "New session every run",
    description: "Create a fresh task session each time the schedule fires.",
  },
  {
    value: "reuse-last",
    label: "Reuse last schedule session",
    description: "Continue the most recent session previously used by this schedule.",
  },
  {
    value: "reuse-target",
    label: "Reuse target session",
    description: "Always send work to a specific linked session on this task.",
  },
];

function formatSessionMode(mode: ScheduleSessionMode): string {
  switch (mode) {
    case "reuse-last":
      return "Reuse last schedule session";
    case "reuse-target":
      return "Reuse target session";
    default:
      return "New session every run";
  }
}

function getSessionOptionLabel(session: Session): string {
  const base = session.summary?.trim() || "Untitled session";
  const shortId = session.sessionId.slice(0, 8);
  const runState = getSessionRunState(session);
  const suffix = session.archived ? " [archived]" : runState === "stalled" ? " [stalled]" : runState === "busy" ? " [busy]" : "";
  return `${base} (${shortId})${suffix}`;
}

function useTaskSessionOptions(taskId: string, targetSessionId?: string) {
  const { data: tasks = [] } = useTasksQuery();
  const { data: allSessions = [] } = useSessionsQuery(true);
  const task = tasks.find((candidate) => candidate.id === taskId);
  const sessionById = new Map(allSessions.map((session) => [session.sessionId, session]));
  const linkedSessions = (task?.sessionIds ?? []).map((sessionId) =>
    sessionById.get(sessionId) ?? ({
      sessionId,
      summary: `Missing session (${sessionId.slice(0, 8)})`,
      archived: true,
    } satisfies Session),
  );
  const selectedTargetSession = targetSessionId
    ? linkedSessions.find((session) => session.sessionId === targetSessionId)
      ?? sessionById.get(targetSessionId)
      ?? ({
        sessionId: targetSessionId,
        summary: `Missing session (${targetSessionId.slice(0, 8)})`,
        archived: true,
      } satisfies Session)
    : undefined;

  const selectedTargetSessionMissing = !!targetSessionId && !sessionById.has(targetSessionId);

  return { linkedSessions, selectedTargetSession, selectedTargetSessionMissing };
}

// ── Props ────────────────────────────────────────────────────────

interface ScheduleDetailSheetProps {
  schedule: Schedule | null;         // null when creating
  taskId: string;                    // needed for create
  taskTitle?: string | null;
  mode: ScheduleSheetMode;
  onClose: () => void;
  onSwitchToEdit: () => void;
  onSwitchToView: () => void;
  onTrigger: (id: string) => void;
  onToggle: (schedule: Schedule) => void;
  onDelete: (id: string) => void;
  onSaved: () => void;
  onSelectSession?: (sessionId: string) => void;
  onSelectTask?: (taskId: string) => void;
}

export default function ScheduleDetailSheet({
  schedule,
  taskId,
  taskTitle,
  mode,
  onClose,
  onSwitchToEdit,
  onSwitchToView,
  onTrigger,
  onToggle,
  onDelete,
  onSaved,
  onSelectSession,
  onSelectTask,
}: ScheduleDetailSheetProps) {
  const isEditing = mode === "edit" || mode === "create";
  const isCreating = mode === "create";

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full md:max-w-lg md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-bg-primary rounded-t-2xl md:rounded-xl border border-border flex flex-col shadow-2xl">
        {isEditing ? (
          <EditMode
            schedule={schedule}
            taskId={taskId}
            isCreating={isCreating}
            onClose={isCreating ? onClose : onSwitchToView}
            onSaved={onSaved}
          />
        ) : schedule ? (
          <ViewMode
            schedule={schedule}
            taskTitle={taskTitle}
            onClose={onClose}
            onSwitchToEdit={onSwitchToEdit}
            onTrigger={onTrigger}
            onToggle={onToggle}
            onDelete={onDelete}
            onSelectSession={onSelectSession}
            onSelectTask={onSelectTask}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── View Mode ────────────────────────────────────────────────────

function ViewMode({
  schedule,
  taskTitle,
  onClose,
  onSwitchToEdit,
  onTrigger,
  onToggle,
  onDelete,
  onSelectSession,
  onSelectTask,
}: {
  schedule: Schedule;
  taskTitle?: string | null;
  onClose: () => void;
  onSwitchToEdit: () => void;
  onTrigger: (id: string) => void;
  onToggle: (schedule: Schedule) => void;
  onDelete: (id: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onSelectTask?: (taskId: string) => void;
}) {
  const { data: sessionData } = useScheduleSessionsQuery(schedule.id);
  const { selectedTargetSession, selectedTargetSessionMissing } = useTaskSessionOptions(schedule.taskId, schedule.targetSessionId);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  const sessions = sessionData?.sessions ?? [];
  const totalRuns = sessionData?.total ?? 0;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5 truncate min-w-0">
          <Clock size={14} className={schedule.enabled ? "text-accent" : "text-text-faint"} />
          <span className="truncate">{schedule.name}</span>
        </h2>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="relative">
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              className="p-1 text-text-muted hover:text-text-secondary transition-colors rounded"
              aria-label="More actions"
            >
              <MoreVertical size={14} />
            </button>
            {showOverflow && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowOverflow(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                  <button
                    onClick={() => { onToggle(schedule); setShowOverflow(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover transition-colors flex items-center gap-2"
                  >
                    {schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
                    {schedule.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() => { setShowDeleteConfirm(true); setShowOverflow(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-bg-hover transition-colors flex items-center gap-2"
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-secondary transition-colors" aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Config summary */}
        <div className="px-5 py-4 space-y-3 border-b border-border">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-text-faint block mb-0.5">Status</span>
              <span className={`inline-flex items-center gap-1 font-medium ${schedule.enabled ? "text-success" : "text-text-muted"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${schedule.enabled ? "bg-success" : "bg-text-faint"}`} />
                {schedule.enabled ? "Active" : "Paused"}
              </span>
            </div>
            <div>
              <span className="text-text-faint block mb-0.5">Type</span>
              <span className="text-text-secondary flex items-center gap-1">
                {schedule.type === "cron" ? <Repeat size={11} /> : <Calendar size={11} />}
                {schedule.type === "cron" ? "Recurring" : "One-time"}
              </span>
            </div>
            {taskTitle && (
              <div>
                <span className="text-text-faint block mb-0.5">Task</span>
                <button
                  onClick={() => onSelectTask?.(schedule.taskId)}
                  className="text-accent hover:text-accent-hover transition-colors truncate block max-w-full text-left flex items-center gap-1"
                >
                  {taskTitle}
                  <ExternalLink size={10} className="shrink-0" />
                </button>
              </div>
            )}
            <div>
              <span className="text-text-faint block mb-0.5">Schedule</span>
              <span className="text-text-secondary">
                {schedule.type === "cron"
                  ? schedule.cron
                  : schedule.runAt
                    ? new Date(schedule.runAt).toLocaleString()
                    : "—"}
              </span>
              {schedule.timezone && (
                <span className="text-[10px] text-text-faint ml-1.5" title={schedule.timezone}>
                  <Globe size={9} className="inline -mt-px mr-0.5" />{schedule.timezone.replace(/^.*\//, "").replace(/_/g, " ")}
                </span>
              )}
            </div>
            {schedule.nextRunAt && (
              <div>
                <span className="text-text-faint block mb-0.5">Next run</span>
                <span className="text-text-secondary" title={new Date(schedule.nextRunAt).toLocaleString()}>{timeAgo(schedule.nextRunAt)}</span>
              </div>
            )}
            {schedule.lastRunAt && (
              <div>
                <span className="text-text-faint block mb-0.5">Last run</span>
                <span className="text-text-secondary" title={new Date(schedule.lastRunAt).toLocaleString()}>{timeAgo(schedule.lastRunAt)}</span>
              </div>
            )}
            <div>
              <span className="text-text-faint block mb-0.5">Total runs</span>
              <span className="text-text-secondary">{schedule.runCount}</span>
            </div>
            <div>
              <span className="text-text-faint block mb-0.5">Session mode</span>
              <span className="text-text-secondary flex items-center gap-1">
                {schedule.sessionMode === "reuse-last" && <RefreshCw size={10} />}
                {schedule.sessionMode === "reuse-target" && <MessageSquare size={10} />}
                {formatSessionMode(schedule.sessionMode)}
              </span>
            </div>
            {schedule.sessionMode === "reuse-target" && (
              <div className="col-span-2">
                <span className="text-text-faint block mb-0.5">Target session</span>
                {selectedTargetSession ? (
                  selectedTargetSessionMissing ? (
                    <span className="text-text-muted truncate block max-w-full">
                      {selectedTargetSession.summary || selectedTargetSession.sessionId.slice(0, 8)}
                    </span>
                  ) : (
                    <button
                      onClick={() => onSelectSession?.(selectedTargetSession.sessionId)}
                      className="text-accent hover:text-accent-hover transition-colors truncate block max-w-full text-left flex items-center gap-1"
                    >
                      {selectedTargetSession.summary || selectedTargetSession.sessionId.slice(0, 8)}
                      <ExternalLink size={10} className="shrink-0" />
                    </button>
                  )
                ) : (
                  <span className="text-text-muted">Missing target session</span>
                )}
              </div>
            )}
            {schedule.maxRuns && (
              <div>
                <span className="text-text-faint block mb-0.5">Max runs</span>
                <span className="text-text-secondary">{schedule.runCount}/{schedule.maxRuns}</span>
              </div>
            )}
          </div>
        </div>

        {/* Prompt */}
        <div className="px-5 py-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Prompt</div>
          <div
            className={`text-xs text-text-secondary bg-bg-surface rounded-md px-3 py-2 border border-border font-mono whitespace-pre-wrap ${
              !promptExpanded && schedule.prompt.length > 200 ? "max-h-[80px] overflow-hidden relative" : ""
            }`}
          >
            {schedule.prompt}
            {!promptExpanded && schedule.prompt.length > 200 && (
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-bg-surface to-transparent" />
            )}
          </div>
          {schedule.prompt.length > 200 && (
            <button
              onClick={() => setPromptExpanded(!promptExpanded)}
              className="text-[10px] text-accent hover:text-accent-hover mt-1 flex items-center gap-0.5"
            >
              <ChevronDown size={10} className={promptExpanded ? "rotate-180" : ""} />
              {promptExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>

        {/* Run History */}
        <div className="px-5 py-3">
          <div className="text-[10px] uppercase tracking-wider text-text-faint mb-2">
            Run History {totalRuns > 0 && <span className="text-text-muted">({totalRuns})</span>}
          </div>
          {sessions.length === 0 ? (
            <EmptyState
              message="No runs yet"
              sub="Trigger or wait for the schedule to run"
            />
          ) : (
            <div className="space-y-1">
              {sessions.map((session) => (
                <SessionRunRow
                  key={session.runId}
                  session={session}
                  onSelect={session.missing ? undefined : () => onSelectSession?.(session.sessionId)}
                />
              ))}
              {totalRuns > sessions.length && (
                <div className="text-[10px] text-text-faint text-center py-2">
                  Showing {sessions.length} of {totalRuns} runs
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border flex items-center gap-2 shrink-0">
        <button
          onClick={() => onTrigger(schedule.id)}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5"
        >
          <Play size={12} /> Run Now
        </button>
        <button
          onClick={onSwitchToEdit}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-surface text-text-primary hover:bg-bg-hover border border-border transition-colors flex items-center gap-1.5"
        >
          <Pencil size={12} /> Edit
        </button>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowDeleteConfirm(false)} />
          <div className="relative bg-bg-primary border border-border rounded-xl p-5 max-w-sm mx-4 shadow-2xl">
            <h3 className="text-sm font-medium text-text-primary mb-2">Delete schedule?</h3>
            <p className="text-xs text-text-muted mb-4">
              "{schedule.name}" will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { onDelete(schedule.id); setShowDeleteConfirm(false); onClose(); }}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-error text-white hover:bg-error/90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Edit Mode ────────────────────────────────────────────────────

function EditMode({
  schedule,
  taskId,
  isCreating,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  taskId: string;
  isCreating: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [type, setType] = useState<"cron" | "once">(schedule?.type ?? "cron");
  const [cronExpr, setCronExpr] = useState(schedule?.cron ?? "0 8 * * 1-5");
  const [runAt, setRunAt] = useState(schedule?.runAt ? schedule.runAt.slice(0, 16) : "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "");
  const [sessionMode, setSessionMode] = useState<ScheduleSessionMode>(schedule?.sessionMode ?? "new");
  const [targetSessionId, setTargetSessionId] = useState(schedule?.targetSessionId ?? "");
  const [maxRuns, setMaxRuns] = useState<string>(schedule?.maxRuns?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { linkedSessions } = useTaskSessionOptions(taskId, targetSessionId || undefined);

  // Fetch server timezone as default for new schedules
  useEffect(() => {
    if (isCreating && !timezone) {
      fetchServerTimezone().then((tz) => setTimezone(tz)).catch(() => {});
    }
  }, [isCreating]);

  const currentPreset = CRON_PRESETS.find((p) => p.cron === cronExpr);
  const [selectedPreset, setSelectedPreset] = useState(currentPreset ? currentPreset.label : "Custom");

  // Reset form when schedule changes
  useEffect(() => {
    setName(schedule?.name ?? "");
    setPrompt(schedule?.prompt ?? "");
    setType(schedule?.type ?? "cron");
    setCronExpr(schedule?.cron ?? "0 8 * * 1-5");
    setRunAt(schedule?.runAt ? schedule.runAt.slice(0, 16) : "");
    setTimezone(schedule?.timezone ?? "");
    setSessionMode(schedule?.sessionMode ?? "new");
    setTargetSessionId(schedule?.targetSessionId ?? "");
    setMaxRuns(schedule?.maxRuns?.toString() ?? "");
  }, [schedule]);

  const handleSave = async () => {
    if (!name.trim() || !prompt.trim()) { setError("Name and prompt are required"); return; }
    if (type === "cron" && !cronExpr.trim()) { setError("Cron expression is required"); return; }
    if (type === "once" && !runAt) { setError("Run time is required"); return; }
    if (sessionMode === "reuse-target" && !targetSessionId) { setError("Target session is required"); return; }

    setSaving(true);
    setError(null);
    try {
      if (isCreating) {
        const input: ScheduleCreateInput = {
          taskId,
          name: name.trim(),
          prompt: prompt.trim(),
          type,
          ...(type === "cron" ? { cron: cronExpr.trim() } : { runAt: new Date(runAt).toISOString() }),
          ...(timezone ? { timezone } : {}),
          sessionMode,
          ...(sessionMode === "reuse-target" ? { targetSessionId } : {}),
          ...(maxRuns ? { maxRuns: parseInt(maxRuns, 10) } : {}),
        };
        await createSchedule(input);
      } else {
        await patchSchedule(schedule!.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          cron: type === "cron" ? cronExpr.trim() : undefined,
          runAt: type === "once" ? new Date(runAt).toISOString() : undefined,
          ...(timezone ? { timezone } : {}),
          sessionMode,
          ...(sessionMode === "reuse-target" ? { targetSessionId } : {}),
          maxRuns: maxRuns ? parseInt(maxRuns, 10) : undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
          <Clock size={14} className="text-accent" />
          {isCreating ? "New Schedule" : "Edit Schedule"}
        </h2>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text-secondary transition-colors" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-3 border-b border-border">
          <div className="grid grid-cols-2 gap-3 text-xs">
            {/* Name — full width */}
            <div className="col-span-2">
              <span className="text-text-faint block mb-1">Name</span>
              <input
                autoFocus
                className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                placeholder="e.g. Daily standup prep"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Type */}
            <div className="col-span-2">
              <span className="text-text-faint block mb-1">Type</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setType("cron")}
                  className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${type === "cron" ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-text-faint"}`}
                >
                  Recurring
                </button>
                <button
                  onClick={() => setType("once")}
                  className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${type === "once" ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-text-faint"}`}
                >
                  One-time
                </button>
              </div>
            </div>

            {/* Timing */}
            <div className="col-span-2">
              <span className="text-text-faint block mb-1">Schedule</span>
              {type === "cron" ? (
                <>
                  <select
                    className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent mb-2"
                    value={selectedPreset}
                    onChange={(e) => {
                      setSelectedPreset(e.target.value);
                      const preset = CRON_PRESETS.find((p) => p.label === e.target.value);
                      if (preset && preset.cron) setCronExpr(preset.cron);
                    }}
                  >
                    {CRON_PRESETS.map((p) => (
                      <option key={p.label} value={p.label}>{p.label}</option>
                    ))}
                  </select>
                  {(selectedPreset === "Custom" || !CRON_PRESETS.find((p) => p.label === selectedPreset)?.cron) && (
                    <input
                      className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent font-mono"
                      placeholder="0 8 * * 1-5"
                      value={cronExpr}
                      onChange={(e) => setCronExpr(e.target.value)}
                    />
                  )}
                  <div className="text-[10px] text-text-faint mt-1">Cron: {cronExpr || "—"}</div>
                </>
              ) : (
                <input
                  type="datetime-local"
                  className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                />
              )}
              {type === "cron" && (
                <div className="mt-2">
                  <span className="text-text-faint block mb-1">Timezone</span>
                  <input
                    className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                    placeholder="e.g. America/New_York"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Session mode */}
            <div className="col-span-2">
              <span className="text-text-faint block mb-1">Session mode</span>
              <div className="space-y-2">
                {SESSION_MODE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      sessionMode === option.value
                        ? "border-accent bg-accent/10"
                        : "border-border hover:border-text-faint"
                    }`}
                  >
                    <input
                      type="radio"
                      name="sessionMode"
                      checked={sessionMode === option.value}
                      onChange={() => setSessionMode(option.value)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-text-secondary">{option.label}</span>
                      <span className="block text-[10px] text-text-faint mt-0.5">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {sessionMode === "reuse-target" && (
              <div className="col-span-2">
                <span className="text-text-faint block mb-1">Target session</span>
                <select
                  className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                  value={targetSessionId}
                  onChange={(e) => setTargetSessionId(e.target.value)}
                >
                  <option value="">Select a linked session…</option>
                  {linkedSessions.map((session) => (
                    <option key={session.sessionId} value={session.sessionId}>
                      {getSessionOptionLabel(session)}
                    </option>
                  ))}
                  {targetSessionId && !linkedSessions.some((session) => session.sessionId === targetSessionId) && (
                    <option value={targetSessionId}>Missing session ({targetSessionId.slice(0, 8)})</option>
                  )}
                </select>
                {linkedSessions.length === 0 && (
                  <div className="text-[10px] text-text-faint mt-1">
                    No linked sessions are available on this task yet.
                  </div>
                )}
              </div>
            )}

            {/* Max runs */}
            <div>
              <span className="text-text-faint block mb-1">Max runs</span>
              <input
                type="number"
                min="1"
                className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                placeholder="∞"
                value={maxRuns}
                onChange={(e) => setMaxRuns(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Prompt — outside the grid, full width */}
        <div className="px-5 py-3">
          <div className="text-[10px] uppercase tracking-wider text-text-faint mb-1.5">Prompt</div>
          <textarea
            className="w-full text-xs bg-bg-surface border border-border rounded-md px-3 py-2 text-text-primary outline-none focus:border-accent resize-none font-mono"
            rows={5}
            placeholder="What should the agent do when this schedule fires?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mb-3 text-xs text-error bg-error/10 border border-error/20 rounded-lg px-3 py-2">{error}</div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover rounded-md transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-medium bg-accent text-white hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : isCreating ? "Create Schedule" : "Save Changes"}
        </button>
      </div>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function SessionRunRow({ session, onSelect }: { session: ScheduleRun; onSelect?: () => void }) {
  const statusDot = session.missing
    ? "bg-text-faint"
    : getSessionRunState(session) === "stalled"
      ? "bg-warning animate-pulse"
      : session.busy
        ? "bg-info animate-pulse"
        : session.archived
          ? "bg-text-faint"
          : "bg-success";

  return (
    <button
      onClick={onSelect}
      disabled={!onSelect}
      className={`w-full text-left px-3 py-2 rounded-md transition-colors flex items-center gap-2.5 ${
        onSelect ? "hover:bg-bg-hover" : "cursor-default"
      } ${session.archived || session.missing ? "opacity-60" : ""}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate flex items-center gap-1.5">
          <MessageSquare size={10} className="text-text-faint shrink-0" />
          {session.summary || (session.missing ? session.sessionId : "Untitled session")}
          {session.missing && <span className="text-[9px] text-text-faint bg-bg-surface px-1 py-0.5 rounded">unavailable</span>}
          {session.archived && <span className="text-[9px] text-text-faint bg-bg-surface px-1 py-0.5 rounded">archived</span>}
        </div>
        <div className="text-[10px] text-text-faint mt-0.5">
          {session.recordedAtKnown === false ? "Unknown run time" : timeAgo(session.recordedAt)}
          {session.diskSizeBytes != null && session.diskSizeBytes > 0 && <span> · {formatBytes(session.diskSizeBytes)}</span>}
        </div>
      </div>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
