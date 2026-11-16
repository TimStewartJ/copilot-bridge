import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Pause, Pencil, Play, RotateCcw } from "lucide-react";
import {
  createTrigger,
  fetchServerTimezone,
  getSessionRunState,
  updateTrigger,
  type ModelInfo,
  type TriggerChat,
  type TriggerView,
} from "../api";
import Dialog from "../design/Dialog";
import {
  Badge,
  Button,
  EmptyHint,
  Field,
  FieldList,
  FormRow,
  MetaLine,
  Notice,
  Section,
  SegmentedControl,
  Select,
  StatusIcon,
  Switch,
  TextArea,
  TextInput,
} from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { useModelRolesQuery, useModelsQuery } from "../hooks/queries/useModels";
import { usePlaybooksQuery } from "../hooks/queries/usePlaybooks";
import { useTasksQuery } from "../hooks/queries/useTasks";
import { useTriggerChatsQuery, type TriggerAction } from "../hooks/queries/useTriggers";
import type { TriggerSheetMode } from "../hooks/useTriggerDetail";
import { haptic } from "../lib/haptics";
import { playbookIdLabel } from "../lib/playbooks";
import { getSessionPath } from "../lib/session-path";
import {
  buildTriggerCreate,
  buildTriggerUpdate,
  MAX_NEW_TASK_RUNS,
  toDatetimeLocalValue,
  triggerFormState,
  type TaskTriggerThen,
  type TriggerFormState,
  type TriggerTimingMode,
} from "../lib/trigger-form";
import {
  formatTriggerWhen,
  isTriggerLive,
  TRIGGER_CHECK_OUTCOME_LABEL,
  TRIGGER_THEN_LABEL,
  triggerLabel,
  triggerStatusKind,
  triggerStatusLabel,
} from "../lib/trigger-presentation";
import { timeAgo } from "../time";
import { MODEL_PRESET_SLOTS, isModelPresetSlot, type ModelPresetSlot } from "../../shared/model-presets.js";
import { MODEL_TIER_INFO, type ModelRolesView } from "../../shared/model-roles.js";
import PlaybookSelect from "./shared/PlaybookSelect";

const CRON_PRESETS = [
  { label: "Every weekday at 8 AM", cron: "0 8 * * 1-5" },
  { label: "Every day at 8 AM", cron: "0 8 * * *" },
  { label: "Every day at 6 PM", cron: "0 18 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every Monday at 9 AM", cron: "0 9 * * 1" },
  { label: "Every Friday at 5 PM", cron: "0 17 * * 5" },
];
const CUSTOM_CRON = "custom";
const SAME_AS_NEW_CHATS = "Same as new chats";

type ModelTiers = ModelRolesView["tiers"];

export interface TriggerTierSummary {
  /** The tier's model now; unset when the tier can't be used and runs follow New chats. */
  model?: string;
  label: string;
}

/** What a tier runs on now. `models` is the available list; empty while it loads. */
export function describeTriggerTier(slot: ModelPresetSlot, tiers: ModelTiers | undefined, models: readonly ModelInfo[]): TriggerTierSummary {
  const tierLabel = `${MODEL_TIER_INFO[slot].label} tier`;
  const preset = tiers?.[slot];
  if (!preset?.model) return { label: `${tierLabel} (no model yet)` };
  const known = models.find((model) => model.id === preset.model);
  if (models.length > 0 && !known) return { label: `${tierLabel} (${preset.model} unavailable)` };
  return { model: preset.model, label: `${tierLabel} · ${known?.name ?? preset.model}` };
}

function useAvailableModels(): ModelInfo[] {
  const { data } = useModelsQuery();
  return (data ?? [])
    .filter((model) => !model.policy || model.policy.state !== "disabled")
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface TriggerDetailSheetProps {
  /** The trigger shown or edited; null while creating. */
  trigger: TriggerView | null;
  taskId: string;
  mode: TriggerSheetMode;
  onClose: () => void;
  onSwitchToEdit: () => void;
  onSwitchToView: () => void;
  onAction: (action: TriggerAction, id: string) => Promise<void>;
  /** A trigger was created or changed. */
  onSaved: (trigger: TriggerView) => void;
  onSelectSession?: (sessionId: string) => void;
}

export default function TriggerDetailSheet({
  trigger,
  taskId,
  mode,
  onClose,
  onSwitchToEdit,
  onSwitchToView,
  onAction,
  onSaved,
  onSelectSession,
}: TriggerDetailSheetProps) {
  const models = useAvailableModels();
  const tiers = useModelRolesQuery().data?.tiers;
  if (mode === "view") {
    if (!trigger) {
      return (
        <Dialog title="Trigger" pending={false} onClose={onClose}>
          <EmptyHint>Loading…</EmptyHint>
        </Dialog>
      );
    }
    return (
      <ViewMode
        trigger={trigger}
        models={models}
        tiers={tiers}
        onClose={onClose}
        onSwitchToEdit={onSwitchToEdit}
        onAction={onAction}
        onSelectSession={onSelectSession}
      />
    );
  }
  return (
    <EditMode
      trigger={mode === "edit" ? trigger : null}
      taskId={taskId}
      models={models}
      tiers={tiers}
      // Leaving an edit returns to the trigger; leaving a new one closes the sheet.
      onClose={mode === "edit" ? onSwitchToView : onClose}
      onSaved={onSaved}
    />
  );
}

// ── View ─────────────────────────────────────────────────────────

function ViewMode({
  trigger,
  models,
  tiers,
  onClose,
  onSwitchToEdit,
  onAction,
  onSelectSession,
}: {
  trigger: TriggerView;
  models: ModelInfo[];
  tiers: ModelTiers | undefined;
  onClose: () => void;
  onSwitchToEdit: () => void;
  onAction: (action: TriggerAction, id: string) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tier = trigger.modelTier ? describeTriggerTier(trigger.modelTier, tiers, models) : undefined;
  const playbooksQuery = usePlaybooksQuery({ enabled: Boolean(trigger.playbook) });
  const playbookLabel = playbookIdLabel(trigger.playbook, playbooksQuery.data);
  const live = isTriggerLive(trigger.status);

  async function act(action: TriggerAction) {
    setPending(true);
    setError("");
    try {
      await onAction(action, trigger.id);
      if (action === "delete") {
        haptic("success");
        onClose();
      }
    } catch (cause) {
      haptic("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog title={triggerLabel(trigger)} pending={pending} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            <StatusIcon kind={triggerStatusKind(trigger.status)} decorative />
            {triggerStatusLabel(trigger.status)}
          </Badge>
          <MetaLine items={[
            trigger.runNow ? "Runs now" : trigger.nextRunAt && (
              <span title={new Date(trigger.nextRunAt).toLocaleString()}>Next {timeAgo(trigger.nextRunAt)}</span>
            ),
            trigger.lastRunAt && (
              <span title={new Date(trigger.lastRunAt).toLocaleString()}>Last {timeAgo(trigger.lastRunAt)}</span>
            ),
          ]} />
        </div>

        <p className={cx(DS.text.content, "whitespace-pre-wrap break-words")}>{trigger.prompt}</p>

        <FieldList>
          <Field label="Does">{TRIGGER_THEN_LABEL[trigger.then]}</Field>
          {trigger.then === "new_task" && <Field label="Task title">{trigger.title}</Field>}
          <Field label="When">{formatTriggerWhen(trigger.when, trigger.whenLabel)}</Field>
          {trigger.check && (
            <Field label="Check">
              <code className={cx(DS.text.literal, "break-all")} title={trigger.check.cwd}>{trigger.check.command.join(" ")}</code>
              <MetaLine items={[
                trigger.check.fireOn === "exit_code" ? "Fires on exit code" : "Fires when output changes",
                trigger.check.cwd,
                trigger.lastCheck && (
                  <span title={new Date(trigger.lastCheck.at).toLocaleString()}>
                    {TRIGGER_CHECK_OUTCOME_LABEL[trigger.lastCheck.outcome]} {timeAgo(trigger.lastCheck.at)}
                    {trigger.lastCheck.exitCode !== undefined ? ` · exit ${trigger.lastCheck.exitCode}` : ""}
                    {trigger.lastCheck.actionPending ? " · action pending" : ""}
                  </span>
                ),
              ]} />
            </Field>
          )}
          <Field label="AI model">
            <span title={tier?.model}>{tier ? tier.model ? tier.label : `${tier.label}, runs as new chats` : SAME_AS_NEW_CHATS}</span>
          </Field>
          <Field label="Playbook" empty="None">{playbookLabel}</Field>
          {trigger.then === "new_chat" && <Field label="Keep chats" empty="All">{trigger.keepChats}</Field>}
          <Field label="Runs">
            {trigger.runCount}{trigger.maxRuns !== undefined ? ` of ${trigger.maxRuns}` : ""}
            {trigger.check ? ` · ${trigger.fireCount} fired` : ""}
          </Field>
          {trigger.expiresAt && (
            <Field label="Ends"><span title={trigger.expiresAt}>{new Date(trigger.expiresAt).toLocaleString()}</span></Field>
          )}
        </FieldList>

        {trigger.lastError && (
          <Notice tone={live ? "warning" : "danger"} icon={<AlertTriangle size={12} />}>{trigger.lastError}</Notice>
        )}
        {error && <Notice tone="danger" title="The trigger was not changed">{error}</Notice>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {trigger.canRun && (
              <Button variant="primary" disabled={pending} icon={<Play size={12} />} onClick={() => void act("run")}>Run now</Button>
            )}
            <Button disabled={pending} icon={<Pencil size={12} />} onClick={onSwitchToEdit}>Edit</Button>
            {trigger.canPause && (
              <Button disabled={pending} icon={<Pause size={12} />} onClick={() => void act("pause")}>Pause</Button>
            )}
            {trigger.canResume && (
              <Button disabled={pending} icon={<Play size={12} />} onClick={() => void act("resume")}>Resume</Button>
            )}
            {trigger.canReactivate && !trigger.canResume && (
              <Button disabled={pending} icon={<RotateCcw size={12} />} onClick={() => void act("reactivate")}>Restart</Button>
            )}
          </div>
          <Button
            variant={confirmDelete ? "danger" : "ghost"}
            disabled={pending}
            onClick={() => confirmDelete ? void act("delete") : setConfirmDelete(true)}
          >
            {confirmDelete ? "Delete trigger and its history" : "Delete"}
          </Button>
        </div>

        <TriggerChats trigger={trigger} onSelectSession={onSelectSession} />
      </div>
    </Dialog>
  );
}

function TriggerChats({ trigger, onSelectSession }: { trigger: TriggerView; onSelectSession?: (sessionId: string) => void }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useTriggerChatsQuery(trigger.id);
  const tasks = useTasksQuery().data;
  const navigate = useNavigate();
  const seen = new Set<number>();
  const chats = (data?.pages ?? [])
    .flatMap((page) => page.sessions)
    .filter((chat) => {
      if (seen.has(chat.runId)) return false;
      seen.add(chat.runId);
      return true;
    });
  const total = data?.pages[0]?.total ?? 0;
  const taskTitles = new Map((tasks ?? []).map((task) => [task.id, task.title]));

  return (
    <Section label={trigger.then === "new_task" ? "Tasks it created" : "Chats it started"} count={total > 0 ? total : undefined}>
      {chats.length === 0 ? (
        <EmptyHint>None yet.</EmptyHint>
      ) : (
        <div className="space-y-0.5">
          {chats.map((chat) => {
            const createdTaskTitle = chat.createdTaskId ? taskTitles.get(chat.createdTaskId) : undefined;
            const open = chat.missing
              ? undefined
              : createdTaskTitle && chat.createdTaskId
                ? () => navigate(getSessionPath({ sessionId: chat.sessionId, taskId: chat.createdTaskId }))
                : onSelectSession && (() => onSelectSession(chat.sessionId));
            return <TriggerChatRow key={chat.runId} chat={chat} taskTitle={createdTaskTitle} onOpen={open} />;
          })}
          {hasNextPage && (
            <div className="flex items-center gap-3 pt-2">
              <Button size="sm" disabled={isFetchingNextPage} onClick={() => { void fetchNextPage(); }}>
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
              <span className={DS.text.meta}>{chats.length} of {total}</span>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function TriggerChatRow({ chat, taskTitle, onOpen }: { chat: TriggerChat; taskTitle?: string; onOpen?: () => void }) {
  const runState = getSessionRunState(chat);
  const status = chat.missing
    ? { kind: "closed" as const, label: "Unavailable" }
    : runState === "stalled"
      ? { kind: "warning" as const, label: "Stalled" }
      : runState === "busy"
        ? { kind: "working" as const, label: "Working" }
        : chat.archived
          ? { kind: "closed" as const, label: "Archived" }
          : { kind: "done" as const, label: "Finished" };
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={cx(DS.row.base, DS.row.touch, "gap-2.5 py-2", onOpen ? DS.row.interactive : DS.row.inert)}
    >
      <StatusIcon kind={status.kind} label={status.label} />
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate", chat.archived || chat.missing ? "text-text-secondary" : "text-text-primary")}>
          {chat.summary || (chat.missing ? chat.sessionId : "Untitled chat")}
        </span>
        <MetaLine items={[
          chat.recordedAtKnown === false ? "Unknown run time" : timeAgo(chat.recordedAt),
          taskTitle,
          chat.missing && "Unavailable",
          chat.archived && "Archived",
        ]} />
      </span>
    </button>
  );
}

// ── Create and edit ──────────────────────────────────────────────

const TIMING_OPTIONS = [
  { value: "once" as const, label: "Once" },
  { value: "every" as const, label: "Every" },
  { value: "cron" as const, label: "Cron" },
];

const THEN_OPTIONS = [
  { value: "new_chat" as const, label: TRIGGER_THEN_LABEL.new_chat },
  { value: "new_task" as const, label: TRIGGER_THEN_LABEL.new_task },
];

function EditMode({
  trigger,
  taskId,
  models,
  tiers,
  onClose,
  onSaved,
}: {
  trigger: TriggerView | null;
  taskId: string;
  models: ModelInfo[];
  tiers: ModelTiers | undefined;
  onClose: () => void;
  onSaved: (trigger: TriggerView) => void;
}) {
  const id = useId();
  const creating = !trigger;
  const serverTimezone = useQuery({
    queryKey: ["server-timezone"],
    queryFn: fetchServerTimezone,
    staleTime: Infinity,
    enabled: creating,
  }).data;
  const [form, setForm] = useState<TriggerFormState>(() => triggerFormState(trigger, { timezone: "" }));
  const [cronPreset, setCronPreset] = useState(() => CRON_PRESETS.find((preset) => preset.cron === form.cron)?.cron ?? CUSTOM_CRON);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const playbooksQuery = usePlaybooksQuery();

  useEffect(() => {
    if (creating && serverTimezone) setForm((current) => current.timezone ? current : { ...current, timezone: serverTimezone });
  }, [creating, serverTimezone]);

  const set = <K extends keyof TriggerFormState>(key: K, value: TriggerFormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function persist(write: () => Promise<TriggerView>) {
    setPending(true);
    setError("");
    try {
      const saved = await write();
      haptic("success");
      onSaved(saved);
    } catch (cause) {
      haptic("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function save() {
    if (!trigger) {
      const built = buildTriggerCreate(form, taskId);
      if (built.ok) void persist(() => createTrigger(built.input));
      else setError(built.error);
      return;
    }
    const built = buildTriggerUpdate(form, trigger);
    if (!built.ok) setError(built.error);
    else if (Object.keys(built.input).length === 0) onClose();
    else void persist(() => updateTrigger(trigger.id, built.input));
  }

  const then: TaskTriggerThen = form.then;
  return (
    <Dialog title={creating ? "New trigger" : "Edit trigger"} pending={pending} onClose={onClose}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <FormRow label="Name" htmlFor={`${id}-name`}>
          <TextInput id={`${id}-name`} value={form.name} disabled={pending} maxLength={200} placeholder="Optional"
            onChange={(event) => set("name", event.target.value)} />
        </FormRow>
        <FormRow label="Prompt" htmlFor={`${id}-prompt`}>
          <TextArea id={`${id}-prompt`} rows={6} value={form.prompt} disabled={pending} className="min-h-32 resize-y"
            onChange={(event) => set("prompt", event.target.value)} />
        </FormRow>
        <FormRow label="Does">
          {creating ? (
            <SegmentedControl ariaLabel="What it does" options={THEN_OPTIONS} value={then} disabled={pending}
              onChange={(value) => set("then", value)} />
          ) : (
            <p className={cx(DS.text.rowLabel, "pt-2")}>{TRIGGER_THEN_LABEL[then]}</p>
          )}
        </FormRow>
        {then === "new_task" && (
          <FormRow label="Task title" htmlFor={`${id}-title`}>
            <TextInput id={`${id}-title`} value={form.title} disabled={pending} maxLength={200}
              onChange={(event) => set("title", event.target.value)} />
          </FormRow>
        )}
        <FormRow label="When">
          <div className="space-y-2">
            <SegmentedControl<TriggerTimingMode> ariaLabel="Timing" options={TIMING_OPTIONS} value={form.timing} disabled={pending}
              onChange={(value) => set("timing", value)} />
            {form.timing === "once" && (
              <TextInput type="datetime-local" aria-label="Run at" value={form.runAt} disabled={pending}
                min={toDatetimeLocalValue(new Date())} onChange={(event) => set("runAt", event.target.value)} />
            )}
            {form.timing === "every" && (
              <div className="flex gap-2">
                <TextInput type="number" aria-label="Interval" min={1} value={form.everyCount} disabled={pending} className="w-24"
                  onChange={(event) => set("everyCount", event.target.value)} />
                <Select aria-label="Interval unit" value={form.everyUnit} disabled={pending} className="w-32"
                  onChange={(event) => set("everyUnit", event.target.value === "minutes" ? "minutes" : "hours")}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </Select>
              </div>
            )}
            {form.timing === "cron" && (
              <>
                <Select aria-label="Cron preset" value={cronPreset} disabled={pending}
                  onChange={(event) => {
                    setCronPreset(event.target.value);
                    if (event.target.value !== CUSTOM_CRON) set("cron", event.target.value);
                  }}>
                  {CRON_PRESETS.map((preset) => <option key={preset.cron} value={preset.cron}>{preset.label}</option>)}
                  <option value={CUSTOM_CRON}>Custom</option>
                </Select>
                {cronPreset === CUSTOM_CRON && (
                  <TextInput aria-label="Cron expression" value={form.cron} disabled={pending} className="font-mono" placeholder="0 8 * * 1-5"
                    onChange={(event) => set("cron", event.target.value)} />
                )}
                <TextInput aria-label="Time zone" value={form.timezone} disabled={pending} placeholder={serverTimezone ?? "Server time zone"}
                  onChange={(event) => set("timezone", event.target.value)} />
              </>
            )}
          </div>
        </FormRow>
        {form.timing !== "once" && (
          <FormRow label="Check" htmlFor={`${id}-check`}>
            <div className="space-y-2">
              <Switch id={`${id}-check`} checked={form.checkEnabled} disabled={pending}
                onChange={(event) => set("checkEnabled", event.target.checked)} />
              {form.checkEnabled && (
                <>
                  <TextArea aria-label="Check command" rows={3} value={form.checkCommand} disabled={pending} className="font-mono"
                    placeholder={"gh\npr\nchecks\n123"} onChange={(event) => set("checkCommand", event.target.value)} />
                  <p className={DS.field.help}>One argument per line.</p>
                  <TextInput aria-label="Working directory" value={form.checkCwd} disabled={pending} className="font-mono" placeholder="Working directory"
                    onChange={(event) => set("checkCwd", event.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <Select aria-label="Fires on" value={form.checkFireOn} disabled={pending} className="min-w-0 flex-1"
                      onChange={(event) => set("checkFireOn", event.target.value === "exit_code" ? "exit_code" : "change")}>
                      <option value="change">Output changes</option>
                      <option value="exit_code">Exit code (10 fires, 11 fires and stops)</option>
                    </Select>
                    <TextInput type="number" aria-label="Timeout seconds" title="Timeout in seconds" min={1} value={form.checkTimeoutSeconds}
                      disabled={pending} className="w-24" onChange={(event) => set("checkTimeoutSeconds", event.target.value)} />
                  </div>
                </>
              )}
            </div>
          </FormRow>
        )}
        <FormRow label="AI model" htmlFor={`${id}-model`}>
          <Select id={`${id}-model`} value={form.modelTier} disabled={pending}
            onChange={(event) => set("modelTier", isModelPresetSlot(event.target.value) ? event.target.value : "")}>
            <option value="">{SAME_AS_NEW_CHATS}</option>
            {MODEL_PRESET_SLOTS.map((slot) => (
              <option key={slot} value={slot}>{describeTriggerTier(slot, tiers, models).label}</option>
            ))}
          </Select>
        </FormRow>
        <FormRow label="Playbook" htmlFor={`${id}-playbook`}>
          <PlaybookSelect id={`${id}-playbook`} playbooks={playbooksQuery.data ?? []} value={form.playbook} disabled={pending}
            onValueChange={(value) => set("playbook", value)} emptyLabel="None" />
        </FormRow>
        {then === "new_chat" && (
          <FormRow label="Keep chats" htmlFor={`${id}-keep`}>
            <TextInput id={`${id}-keep`} type="number" min={0} value={form.keepChats} disabled={pending} placeholder="All"
              title="Older chats it started are archived" className="w-32" onChange={(event) => set("keepChats", event.target.value)} />
          </FormRow>
        )}
        <FormRow label="Max runs" htmlFor={`${id}-max`}>
          <TextInput id={`${id}-max`} type="number" min={1} max={then === "new_task" ? MAX_NEW_TASK_RUNS : undefined} value={form.maxRuns}
            disabled={pending} placeholder="No limit" className="w-32" onChange={(event) => set("maxRuns", event.target.value)} />
        </FormRow>
        <FormRow label="Ends" htmlFor={`${id}-ends`}>
          <TextInput id={`${id}-ends`} type="datetime-local" value={form.expiresAt} disabled={pending}
            onChange={(event) => set("expiresAt", event.target.value)} />
        </FormRow>
        {error && <Notice tone="danger" title="The trigger was not saved">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : creating ? "Create trigger" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
