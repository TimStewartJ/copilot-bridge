import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchModels,
  fetchSessionModelState,
  getSessionActivityTime,
  getSessionRunState,
  patchSessionModel,
  type BatchAction,
  type ModelInfo,
  type ReasoningEffort,
  type Session,
  type SessionModelState,
  type Task,
} from "../api";
import { timeAgo } from "../time";
import { ChevronDown, ChevronRight, Archive, ArchiveRestore, ClipboardList, Copy, Check, CheckCheck, Link, Unlink, Loader2, Trash2, Clock, EyeOff, Pencil, CopyPlus, Square, SquareCheckBig, RotateCw, Bot } from "lucide-react";
import TaskPickerDialog from "./TaskPickerDialog";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import useLongPressMenu from "../hooks/useLongPressMenu";
import { LoadingSkeletonRegion, SkeletonRow } from "./shared/Skeleton";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
  { value: "xhigh", label: "Extra High" },
];

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatReasoningEffortLabel(effort?: string): string | undefined {
  if (!effort) return undefined;
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? effort;
}

export function formatSessionModelLabel(
  state?: SessionModelState,
  models?: readonly ModelInfo[] | null,
): string {
  if (!state) return "Loading...";
  if (!state.model) return "Unknown";
  const modelLabel = models?.find((model) => model.id === state.model)?.name ?? state.model;
  const effortLabel = formatReasoningEffortLabel(state.reasoningEffort);
  return effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel;
}

export function formatDeferSummaryLabel(deferSummary?: Session["deferSummary"]): string | null {
  const count = deferSummary?.count ?? 0;
  if (count <= 0) return null;

  const nextRun = deferSummary?.nextRunAt ? timeAgo(deferSummary.nextRunAt) : null;
  if (count === 1) {
    return nextRun ? `Deferred ${nextRun}` : "Deferred";
  }

  return nextRun ? `${count} defers · next ${nextRun}` : `${count} defers`;
}

function getSessionModelSourceLabel(source?: SessionModelState["source"]): string {
  switch (source) {
    case "live": return "Live session";
    case "events": return "Saved in session history";
    case "unknown": return "No saved model state";
    default: return "Checking session model";
  }
}

function getAvailableModels(models: readonly ModelInfo[] | null): ModelInfo[] {
  return [...(models ?? [])]
    .filter((model) => !model.policy || model.policy.state !== "disabled")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value);
}

function getPreferredReasoningEffort(model?: ModelInfo): ReasoningEffort | undefined {
  const supported = model?.supportedReasoningEfforts;
  if (!supported || supported.length === 0) return undefined;
  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supported[0];
}

export function canKeepCurrentReasoningEffortForModel({
  supportedReasoningEfforts,
  currentReasoningEffort,
  currentEffortLookupReady,
}: {
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  currentReasoningEffort?: string;
  currentEffortLookupReady: boolean;
}): boolean {
  if (!supportedReasoningEfforts) return true;
  if (!currentEffortLookupReady) return false;
  if (supportedReasoningEfforts.length === 0) {
    return !currentReasoningEffort;
  }
  if (!currentReasoningEffort) return true;
  return isReasoningEffort(currentReasoningEffort)
    && supportedReasoningEfforts.includes(currentReasoningEffort);
}

interface SessionModelLookup {
  data?: SessionModelState;
  loading: boolean;
  error?: string;
}

const styles = {
  global: {
    wrapper: "flex-1 overflow-y-auto overflow-x-hidden min-w-0 p-2 space-y-1",
    newButton:
      "w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors",
    itemPadding: "py-2.5",
    titleClass: "font-medium truncate",
    metaClass: "text-xs text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1.5",
    listGap: "space-y-1",
  },
  compact: {
    wrapper: "min-w-0 overflow-x-hidden",
    newButton:
      "w-full mb-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-xs hover:bg-accent/20 transition-colors",
    itemPadding: "py-2",
    titleClass: "font-medium truncate text-xs",
    metaClass: "text-[10px] text-text-muted mt-0.5",
    dotSize: "w-1.5 h-1.5 mr-1",
    listGap: "space-y-0.5",
  },
} as const;

// ── Bulk action bar for multi-select mode ────────────────────────
function BulkActionBar({
  activeSessions,
  selectedIds,
  onToggleSelect,
  onBulkAction,
  isUnread,
}: {
  activeSessions: Session[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onBulkAction: (action: BatchAction, ids: string[]) => void;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
}) {
  const count = selectedIds.size;
  const allSelected = activeSessions.length > 0 && activeSessions.every((s) => selectedIds.has(s.sessionId));
  const unreadSelected = activeSessions.filter(
    (s) => selectedIds.has(s.sessionId) && isUnread?.(s.sessionId, getSessionActivityTime(s)),
  );

  const handleToggleAll = () => {
    if (allSelected) {
      for (const s of activeSessions) onToggleSelect(s.sessionId);
    } else {
      for (const s of activeSessions) {
        if (!selectedIds.has(s.sessionId)) onToggleSelect(s.sessionId);
      }
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs">
      <button
        onClick={handleToggleAll}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
        title={allSelected ? "Deselect all" : "Select all"}
      >
        {allSelected ? <SquareCheckBig size={13} className="text-accent" /> : <Square size={13} />}
        <span>{allSelected ? "All" : "All"}</span>
      </button>
      {count > 0 && (
        <>
          <span className="text-text-faint">·</span>
          <span className="text-text-muted">{count} selected</span>
          <span className="text-text-faint">·</span>
          {unreadSelected.length > 0 && (
            <button
              onClick={() => onBulkAction("markRead", [...selectedIds])}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
              title={`Mark ${count} as read`}
            >
              <Check size={13} />
              Read
            </button>
          )}
          <button
            onClick={() => onBulkAction("archive", [...selectedIds])}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-text-secondary"
            title={`Archive ${count} sessions`}
          >
            <Archive size={13} />
            Archive
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete ${count} session${count === 1 ? "" : "s"}? This cannot be undone.`)) {
                onBulkAction("delete", [...selectedIds]);
              }
            }}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-error"
            title={`Delete ${count} sessions`}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </>
      )}
    </div>
  );
}

interface SessionListProps {
  variant: "global" | "compact";
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  newButtonLabel?: string;
  showEmptyState?: boolean;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  // Task linking (global variant)
  tasks?: Task[];
  onLinkToTask?: (sessionId: string, taskId: string) => void;
  // Task unlinking (compact/task-context variant)
  taskContext?: Task;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  // Session deletion
  onDeleteSession?: (sessionId: string) => void;
  // Session duplication
  onDuplicateSession?: (sessionId: string) => void;
  // Session reload
  onReloadSession?: (sessionId: string) => void;
  // Mark unread
  onMarkUnread?: (sessionId: string) => void;
  onMarkAllRead?: () => void;
  // Draft indicator
  hasDraft?: (sessionId: string) => boolean;
  exitingIds?: Set<string>;
  className?: string;
  // Bulk actions
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  // Lazy-load archived sessions
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  // Hide the new-session button (e.g. when the parent already provides one)
  showNewButton?: boolean;
}

export default function SessionList({
  variant,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  newButtonLabel = variant === "global" ? "+ New Session" : "+ New Chat",
  showEmptyState = variant === "compact",
  isUnread,
  onArchiveSession,
  archivingIds,
  tasks,
  onLinkToTask,
  taskContext,
  onUnlinkFromTask,
  onDeleteSession,
  onDuplicateSession,
  onReloadSession,
  onMarkUnread,
  onMarkAllRead,
  hasDraft,
  exitingIds,
  className,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
  archivedLoading = false,
  showNewButton = true,
}: SessionListProps) {
  const s = styles[variant];
  const [showArchived, setShowArchived] = useState(false);
  const { bind: bindLongPress, menu: ctxMenu, closeMenu: rawCloseMenu, isTarget } = useLongPressMenu<string>();
  const [copied, setCopied] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [sessionModelLookups, setSessionModelLookups] = useState<Record<string, SessionModelLookup>>({});
  const [modelOptions, setModelOptions] = useState<ModelInfo[] | null>(null);
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const [modelDialogSessionId, setModelDialogSessionId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [reasoningDraft, setReasoningDraft] = useState<"" | ReasoningEffort>("");
  const [modelSwitchSaving, setModelSwitchSaving] = useState(false);
  const [modelSwitchError, setModelSwitchError] = useState<string | null>(null);
  const sessionModelLookupVersionRef = useRef<Record<string, number>>({});

  const closeMenu = useCallback(() => { rawCloseMenu(); setCopied(false); }, [rawCloseMenu]);

  const ctxSession = ctxMenu ? sessions.find((ss) => ss.sessionId === ctxMenu.id) : null;

  // Find which task (if any) the context-menu'd session is linked to
  const ctxLinkedTask = ctxMenu && tasks
    ? tasks.find((t) => t.sessionIds.includes(ctxMenu.id))
    : null;
  const canSelectFromMenu = !!onBulkAction && !!ctxSession && !ctxSession.archived;
  const canReloadFromMenu = !!onReloadSession && !!ctxSession;
  const canDuplicateFromMenu = !!onDuplicateSession && !!ctxSession;
  const canArchiveFromMenu = !!onArchiveSession && !!ctxSession;
  const canMarkUnreadFromMenu = !!ctxSession
    && !!onMarkUnread
    && !isUnread?.(ctxSession.sessionId, getSessionActivityTime(ctxSession));
  const canLinkToTaskFromMenu = !!ctxSession && !taskContext && !!onLinkToTask && !!tasks;
  const canUnlinkFromTaskFromMenu = !!ctxSession && !!taskContext && !!onUnlinkFromTask;
  const canDeleteFromMenu = !!onDeleteSession && !!ctxSession;
  const hasEditSection =
    canDuplicateFromMenu
    || canArchiveFromMenu
    || canMarkUnreadFromMenu
    || canLinkToTaskFromMenu
    || canUnlinkFromTaskFromMenu;

  const activeSessions = sessions.filter((sess) => !sess.archived && !archivingIds?.has(sess.sessionId));
  const archivedSessions = sessions.filter((sess) => sess.archived);
  const ctxModelLookup = ctxSession ? sessionModelLookups[ctxSession.sessionId] : undefined;
  const modelDialogSession = modelDialogSessionId
    ? sessions.find((session) => session.sessionId === modelDialogSessionId)
    : null;
  const modelDialogLookup = modelDialogSessionId ? sessionModelLookups[modelDialogSessionId] : undefined;
  const availableModels = getAvailableModels(modelOptions);
  const selectedDialogModel = modelOptions?.find((model) => model.id === modelDraft);
  const supportedReasoningEfforts = selectedDialogModel?.supportedReasoningEfforts;
  const currentReasoningEffort = modelDialogLookup?.data?.reasoningEffort;
  const currentEffortLookupReady = !!modelDialogLookup
    && !modelDialogLookup.loading
    && !modelDialogLookup.error
    && !!modelDialogLookup.data;
  const preferredReasoningEffort = getPreferredReasoningEffort(selectedDialogModel);
  const reasoningOptions = supportedReasoningEfforts
    ? REASONING_EFFORT_OPTIONS.filter((option) => supportedReasoningEfforts.includes(option.value))
    : REASONING_EFFORT_OPTIONS;
  const canKeepCurrentReasoningEffort = canKeepCurrentReasoningEffortForModel({
    supportedReasoningEfforts,
    currentReasoningEffort,
    currentEffortLookupReady,
  });
  const reasoningDraftCanBeSubmitted =
    !!reasoningDraft
    && (!supportedReasoningEfforts || supportedReasoningEfforts.includes(reasoningDraft));
  const showDraftModelOption = !!modelDraft && !availableModels.some((model) => model.id === modelDraft);
  const canSaveModelSwitch =
    !!modelDialogSessionId
    && !!modelDraft.trim()
    && !modelSwitchSaving
    && !modelOptionsLoading
    && !modelDialogSession?.busy
    && (canKeepCurrentReasoningEffort || reasoningDraftCanBeSubmitted || !supportedReasoningEfforts);
  const unreadCount = activeSessions.filter(
    (session) => !session.archived && isUnread?.(session.sessionId, getSessionActivityTime(session)),
  ).length;
  const showQuickChatHeader = !!onMarkAllRead;

  useEffect(() => {
    const validSessions = selectMode ? activeSessions : sessions;
    const validIds = new Set(validSessions.map((session) => session.sessionId));
    if (anchorRef.current && !validIds.has(anchorRef.current)) {
      anchorRef.current = null;
    }
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [activeSessions, selectMode, sessions]);

  useEffect(() => {
    if (!ctxSession) return;
    const sessionId = ctxSession.sessionId;
    const requestVersion = (sessionModelLookupVersionRef.current[sessionId] ?? 0) + 1;
    sessionModelLookupVersionRef.current[sessionId] = requestVersion;
    setSessionModelLookups((prev) => ({
      ...prev,
      [sessionId]: { data: prev[sessionId]?.data, loading: true },
    }));

    void fetchSessionModelState(sessionId)
      .then((data) => {
        if (sessionModelLookupVersionRef.current[sessionId] !== requestVersion) return;
        setSessionModelLookups((prev) => ({
          ...prev,
          [sessionId]: { data, loading: false },
        }));
      })
      .catch((error: unknown) => {
        if (sessionModelLookupVersionRef.current[sessionId] !== requestVersion) return;
        setSessionModelLookups((prev) => ({
          ...prev,
          [sessionId]: {
            data: prev[sessionId]?.data,
            loading: false,
            error: getErrorMessage(error),
          },
        }));
      });
  }, [ctxSession?.sessionId]);

  const loadModelOptions = useCallback(async () => {
    setModelOptionsLoading(true);
    setModelOptionsError(null);
    try {
      const models = await fetchModels();
      setModelOptions(models);
    } catch (error) {
      setModelOptionsError(getErrorMessage(error));
    } finally {
      setModelOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!modelDialogSessionId || modelOptions || modelOptionsLoading || modelOptionsError) return;
    void loadModelOptions();
  }, [loadModelOptions, modelDialogSessionId, modelOptions, modelOptionsError, modelOptionsLoading]);

  useEffect(() => {
    if (!supportedReasoningEfforts) {
      return;
    }
    if (reasoningDraft && !supportedReasoningEfforts.includes(reasoningDraft)) {
      setReasoningDraft(preferredReasoningEffort ?? "");
      return;
    }
    if (!reasoningDraft && !canKeepCurrentReasoningEffort) {
      setReasoningDraft(preferredReasoningEffort ?? "");
    }
  }, [
    canKeepCurrentReasoningEffort,
    currentReasoningEffort,
    preferredReasoningEffort,
    reasoningDraft,
    supportedReasoningEfforts,
  ]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  const openModelDialog = useCallback((sessionId: string) => {
    const currentState = sessionModelLookups[sessionId]?.data;
    setModelDialogSessionId(sessionId);
    setModelDraft(currentState?.model ?? "");
    setReasoningDraft("");
    setModelSwitchError(null);
    setModelOptionsError(null);
    closeMenu();
  }, [closeMenu, sessionModelLookups]);

  const closeModelDialog = useCallback(() => {
    if (modelSwitchSaving) return;
    setModelDialogSessionId(null);
    setModelSwitchError(null);
  }, [modelSwitchSaving]);

  const handleSaveModelSwitch = useCallback(async () => {
    if (!modelDialogSessionId) return;
    const model = modelDraft.trim();
    if (!model) return;

    setModelSwitchSaving(true);
    setModelSwitchError(null);
    try {
      const submittedReasoningEffort = reasoningDraftCanBeSubmitted
        ? reasoningDraft
        : !canKeepCurrentReasoningEffort
          ? preferredReasoningEffort
        : undefined;
      const result = await patchSessionModel(
        modelDialogSessionId,
        model,
        submittedReasoningEffort,
      );
      const nextReasoningEffort = result.reasoningEffort
        ?? (submittedReasoningEffort || modelDialogLookup?.data?.reasoningEffort);
      const nextState: SessionModelState = {
        model: result.modelId ?? result.model,
        ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {}),
        source: "live",
      };
      sessionModelLookupVersionRef.current[modelDialogSessionId] =
        (sessionModelLookupVersionRef.current[modelDialogSessionId] ?? 0) + 1;
      setSessionModelLookups((prev) => ({
        ...prev,
        [modelDialogSessionId]: { data: nextState, loading: false },
      }));
      setModelDialogSessionId(null);
    } catch (error) {
      setModelSwitchError(getErrorMessage(error));
    } finally {
      setModelSwitchSaving(false);
    }
  }, [
    modelDialogLookup?.data?.reasoningEffort,
    modelDialogSessionId,
    modelDraft,
    reasoningDraft,
    reasoningDraftCanBeSubmitted,
    canKeepCurrentReasoningEffort,
    preferredReasoningEffort,
    supportedReasoningEfforts,
  ]);

  const handleBulkAction = useCallback((action: BatchAction, ids: string[]) => {
    onBulkAction?.(action, ids);
    exitSelectMode();
  }, [onBulkAction, exitSelectMode]);

  const renderItem = (session: Session) => {
    const id = session.sessionId;
    const isActive = id === activeSessionId;
    const unread = !isActive && isUnread?.(id, getSessionActivityTime(session));
    const isArch = session.archived;
    const isArchiving = archivingIds?.has(id);
    const isExiting = exitingIds?.has(id);
    const isSelected = selectedIds?.has(id);
    const needsUserInput = session.needsUserInput || (session.pendingUserInputCount ?? 0) > 0;
    const deferLabel = formatDeferSummaryLabel(session.deferSummary);
    const dotColor = isArchiving
      ? ""
      : needsUserInput
        ? "bg-warning animate-pulse"
        : getSessionRunState(session) === "stalled"
        ? "bg-warning animate-pulse"
        : session.busy
          ? "bg-info animate-pulse"
          : unread
            ? "bg-success"
            : isArch
              ? "bg-text-faint"
              : "bg-text-faint";
    const { onClick: guardedClick, ...longPressBindings } = bindLongPress(id, () => onSelectSession(id));

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      const canBulkSelect = !!onBulkAction && !session.archived;
      const isToggleKey = canBulkSelect && (e.metaKey || e.ctrlKey);
      const isRangeKey = canBulkSelect && e.shiftKey;

      if (isRangeKey) {
        e.preventDefault();
        setSelectMode(true);
        const anchorIndex = anchorRef.current
          ? activeSessions.findIndex((activeSession) => activeSession.sessionId === anchorRef.current)
          : -1;
        const currentIndex = activeSessions.findIndex((activeSession) => activeSession.sessionId === id);
        if (anchorIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(anchorIndex, currentIndex);
          const end = Math.max(anchorIndex, currentIndex);
          const rangeIds = activeSessions.slice(start, end + 1).map((activeSession) => activeSession.sessionId);
          setSelectedIds((prev) => {
            if (isToggleKey) {
              const next = new Set(prev);
              for (const rangeId of rangeIds) next.add(rangeId);
              return next;
            }
            return new Set(rangeIds);
          });
          return;
        }
        setSelectedIds((prev) => {
          if (isToggleKey) {
            const next = new Set(prev);
            next.add(id);
            return next;
          }
          return new Set([id]);
        });
        anchorRef.current = id;
        return;
      }

      if (isToggleKey) {
        e.preventDefault();
        setSelectMode(true);
        toggleSelect(id);
        anchorRef.current = id;
        return;
      }

      if (selectMode && onBulkAction) {
        toggleSelect(id);
        anchorRef.current = id;
        return;
      }

      guardedClick();
      if (!session.archived) anchorRef.current = id;
    };

    return (
      <div key={id} className={`group relative min-w-0${isExiting ? " animate-session-exit" : ""}`}>
        <button
          {...(selectMode ? {} : longPressBindings)}
          onClick={handleClick}
          title={session.summary || id}
          className={`w-full min-w-0 overflow-hidden text-left px-3 ${s.itemPadding} rounded-md text-sm select-none no-callout transition-all duration-150 ${
            selectMode && isSelected
              ? "bg-accent/10 ring-1 ring-accent/30"
              : ctxMenu?.id === id
                ? "bg-bg-hover ring-1 ring-border"
                : isActive
                  ? "bg-bg-hover"
                  : "hover:bg-bg-hover"
          } ${isTarget(id) ? "scale-[0.97] bg-bg-hover" : ""} ${isArch || isArchiving ? "opacity-50" : ""}`}
        >
          <div className={`${unread ? s.titleClass.replace("font-medium", "font-semibold") : s.titleClass} flex items-center min-w-0`}>
            {selectMode ? (
              isSelected
                ? <SquareCheckBig size={14} className="text-accent shrink-0 mr-1.5" />
                : <Square size={14} className="text-text-muted shrink-0 mr-1.5" />
            ) : isArchiving ? (
              <Loader2 size={10} className={`${s.dotSize} animate-spin text-text-muted shrink-0`} />
            ) : (
              <span
                className={`inline-block ${s.dotSize} ${dotColor} rounded-full shrink-0`}
              />
            )}
            {session.triggeredBy === "schedule" && session.scheduleEnabled && (
              <Clock size={10} className="text-accent shrink-0 mr-0.5" title={`Scheduled: ${session.scheduleName ?? ""}`} />
            )}
            <span className="truncate">
              {session.summary || id.slice(0, 8)}
            </span>
          </div>
          <div className={`${s.metaClass} truncate`}>
            {isArchiving ? "Archiving…" : needsUserInput ? "Needs answer" : timeAgo(getSessionActivityTime(session))}
            {deferLabel && (
              <>
                {" · "}
                <span
                  className="inline-flex items-center gap-0.5 rounded-full border border-accent/15 bg-accent/5 px-1.5 py-0.5 align-middle text-[10px] font-medium text-accent"
                  title={deferLabel}
                >
                  <Clock size={9} className="shrink-0" aria-hidden="true" />
                  <span>{deferLabel}</span>
                </span>
              </>
            )}
            {session.context?.branch && ` · ${session.context.branch}`}
            {session.eventLogSizeBytes
              ? ` · ${formatSize(session.eventLogSizeBytes)}`
              : ""}
            {session.workspace?.overridesTaskWorkspace && (
              <>
                {" · "}
                <span className="text-warning">Overrides task workspace</span>
              </>
            )}
            {session.hasPlan && " · "}
            {session.hasPlan && <ClipboardList size={10} className="inline" />}
            {hasDraft?.(id) && " · "}
            {hasDraft?.(id) && <Pencil size={10} className="inline text-warning" title="Has draft" />}
          </div>
        </button>
      </div>
    );
  };

  return (
    <div className={className ?? s.wrapper}>
      {selectMode ? (
        <div className="flex items-center gap-1 mb-1">
          <button
            onClick={exitSelectMode}
            className="text-xs px-2 py-0.5 rounded text-accent bg-accent/10 transition-colors"
          >
            Done
          </button>
        </div>
      ) : showQuickChatHeader ? (
        <div className="flex items-center gap-1 mb-1">
          {showNewButton && (
            <button
              onClick={onNewSession}
              className="flex-1 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors"
            >
              {newButtonLabel}
            </button>
          )}
          {unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              className="p-2 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover transition-colors"
              title="Mark all as read"
            >
              <CheckCheck size={14} />
            </button>
          )}
        </div>
      ) : showNewButton ? (
        <button onClick={onNewSession} className={s.newButton}>
          {newButtonLabel}
        </button>
      ) : null}
      {selectMode && onBulkAction && (
        <BulkActionBar
          activeSessions={activeSessions}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onBulkAction={handleBulkAction}
          isUnread={isUnread}
        />
      )}
      {showEmptyState && activeSessions.length === 0 && archivedSessions.length === 0 && archivedLoaded !== false && !archivedLoading ? (
        <div className="text-xs text-text-faint px-3 py-1">No sessions yet</div>
      ) : (
        <>
          <div className={s.listGap}>
            {activeSessions.map(renderItem)}
          </div>
          {!selectMode && (archivedSessions.length > 0 || archivedLoading || (onRequestArchived && !archivedLoaded)) && (
            <>
              <button
                onClick={() => {
                  const next = !showArchived;
                  setShowArchived(next);
                  if (next && onRequestArchived && !archivedLoaded) onRequestArchived();
                }}
                className="w-full px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2 flex items-center gap-1"
              >
                {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />} Archived{archivedLoaded !== false && !archivedLoading ? ` (${archivedSessions.length})` : ""}
              </button>
              {showArchived && (
                <div className={s.listGap}>
                  {archivedSessions.length === 0 && (archivedLoading || !archivedLoaded) ? (
                    <LoadingSkeletonRegion
                      isLoading
                      label="Loading archived sessions"
                      className="px-1 py-1"
                    >
                      <div className="space-y-0.5">
                        {Array.from({ length: 3 }, (_, index) => (
                          <SkeletonRow
                            key={index}
                            leading={false}
                            className={`px-2 ${s.itemPadding}`}
                          />
                        ))}
                      </div>
                    </LoadingSkeletonRegion>
                  ) : (
                    archivedSessions.map(renderItem)
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu position={ctxMenu} onClose={closeMenu}>
          {canSelectFromMenu && (
            <CtxItem
              icon={<SquareCheckBig size={14} />}
              label="Select"
              onClick={() => {
                setSelectMode(true);
                setSelectedIds(new Set([ctxMenu.id]));
                anchorRef.current = ctxMenu.id;
                closeMenu();
              }}
            />
          )}
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(ctxMenu.id);
              setCopied(true);
              setTimeout(closeMenu, 600);
            }}
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy Session ID"}
          </button>
          {canReloadFromMenu && (
            <CtxItem
              icon={<RotateCw size={14} />}
              label="Reload MCPs"
              disabled={ctxSession.busy}
              onClick={() => {
                onReloadSession(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {ctxSession && (
            <>
              <CtxDivider />
              <div className="px-3 py-2 flex items-start gap-2 text-xs">
                <Bot size={14} className="shrink-0 text-text-muted mt-0.5" />
                <div className="min-w-0">
                  <div className="text-text-faint">Session model</div>
                  <div
                    className={`truncate ${ctxModelLookup?.error ? "text-error" : "text-text-secondary"}`}
                    title={ctxModelLookup?.error ?? undefined}
                  >
                    {ctxModelLookup?.error
                      ? "Unable to load model"
                      : formatSessionModelLabel(ctxModelLookup?.data, modelOptions)}
                  </div>
                  <div className="text-[10px] text-text-faint">
                    {ctxModelLookup?.loading && ctxModelLookup.data
                      ? "Refreshing..."
                      : getSessionModelSourceLabel(ctxModelLookup?.data?.source)}
                  </div>
                </div>
              </div>
              <CtxItem
                icon={<Bot size={14} />}
                label="Change Model..."
                disabled={ctxSession.busy}
                title={ctxSession.busy ? "This session is busy" : "Change only this session's model"}
                onClick={() => {
                  openModelDialog(ctxSession.sessionId);
                }}
              />
            </>
          )}
          {(hasEditSection || canDeleteFromMenu) && <CtxDivider />}
          {canDuplicateFromMenu && (
            <CtxItem
              icon={<CopyPlus size={14} />}
              label="Duplicate"
              disabled={ctxSession.busy}
              onClick={() => {
                onDuplicateSession(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {canArchiveFromMenu && (
            <CtxItem
              icon={ctxSession.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={ctxSession.archived ? "Unarchive" : "Archive"}
              onClick={() => {
                onArchiveSession(ctxSession.sessionId, !ctxSession.archived);
                closeMenu();
              }}
            />
          )}
          {canMarkUnreadFromMenu && (
            <CtxItem
              icon={<EyeOff size={14} />}
              label="Mark Unread"
              onClick={() => {
                onMarkUnread(ctxSession.sessionId);
                closeMenu();
              }}
            />
          )}
          {/* Unlinked sessions: Link or move to task */}
          {canLinkToTaskFromMenu && (
            <>
              {ctxLinkedTask && (
                <div className="px-3 py-1.5 text-text-faint flex items-center gap-2 text-xs">
                  <ClipboardList size={14} />
                  <span className="truncate">On: {ctxLinkedTask.title}</span>
                </div>
              )}
              <CtxItem
                icon={<Link size={14} />}
                label={ctxLinkedTask ? "Move to Task…" : "Link to Task…"}
                onClick={() => {
                  const sid = ctxSession.sessionId;
                  closeMenu();
                  setShowTaskPicker(sid);
                }}
              />
            </>
          )}
          {/* Task-linked sessions: unlink from current task */}
          {canUnlinkFromTaskFromMenu && (
            <CtxItem
              icon={<Unlink size={14} />}
              label="Unlink from Task"
              className="text-warning"
              onClick={() => {
                onUnlinkFromTask(ctxSession.sessionId, taskContext.id);
                closeMenu();
              }}
            />
          )}
          {/* Delete session */}
          {hasEditSection && canDeleteFromMenu && <CtxDivider />}
          {canDeleteFromMenu && (
            <>
              <CtxItem
                icon={<Trash2 size={14} />}
                label="Delete"
                className="text-error"
                disabled={ctxSession.busy}
                onClick={() => {
                  onDeleteSession(ctxSession.sessionId);
                  closeMenu();
                }}
              />
            </>
          )}
        </ContextMenu>
      )}

      {modelDialogSessionId && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Change session model"
          onClick={closeModelDialog}
        >
          <div
            className="w-full max-w-md bg-bg-secondary border border-border rounded-lg shadow-xl p-4 space-y-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <div className="text-sm font-semibold text-text-primary">Change Session Model</div>
              <div className="text-xs text-text-muted mt-1">
                Changes apply only to this session.
                {modelDialogSession?.summary ? ` ${modelDialogSession.summary}` : ""}
              </div>
            </div>

            <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs">
              <div className="text-text-faint">Current model</div>
              <div className="mt-0.5 text-text-secondary truncate">
                {modelDialogLookup?.error
                  ? "Unable to load current model"
                  : formatSessionModelLabel(modelDialogLookup?.data, modelOptions)}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-text-secondary" htmlFor="session-model-select">
                Model
              </label>
              {modelOptionsError ? (
                <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                  <div>Failed to load models: {modelOptionsError}</div>
                  <button
                    type="button"
                    className="mt-2 text-xs text-error underline"
                    onClick={() => {
                      void loadModelOptions();
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <select
                  id="session-model-select"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  disabled={modelOptionsLoading}
                  className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none disabled:opacity-50"
                >
                  <option value="" disabled>
                    {modelOptionsLoading ? "Loading models..." : "Select a model"}
                  </option>
                  {showDraftModelOption && (
                    <option value={modelDraft}>{modelDraft}</option>
                  )}
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}{model.billing && model.billing.multiplier !== 1 ? ` (${model.billing.multiplier}x)` : ""}
                    </option>
                  ))}
                </select>
              )}
              {modelDraft && (
                <div className="text-[11px] text-text-faint truncate">
                  Model ID: <code className="text-text-muted">{modelDraft}</code>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-text-secondary" htmlFor="session-reasoning-select">
                Reasoning effort
              </label>
              <select
                id="session-reasoning-select"
                value={reasoningDraft}
                onChange={(event) => {
                  const next = event.target.value;
                  setReasoningDraft(next && isReasoningEffort(next) ? next : "");
                }}
                className="w-full px-3 py-2 text-xs bg-bg-surface border border-border rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none"
              >
                <option value="" disabled={!canKeepCurrentReasoningEffort}>
                  {canKeepCurrentReasoningEffort ? "Keep current" : "Select a supported effort"}
                </option>
                {reasoningOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-text-faint">
                Current: {formatReasoningEffortLabel(modelDialogLookup?.data?.reasoningEffort) ?? "unknown"}
                {!canKeepCurrentReasoningEffort && " (not supported by selected model)"}
              </div>
            </div>

            {modelSwitchError && (
              <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                {modelSwitchError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                onClick={closeModelDialog}
                disabled={modelSwitchSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1.5"
                onClick={() => {
                  void handleSaveModelSwitch();
                }}
                disabled={!canSaveModelSwitch}
                title={modelDialogSession?.busy ? "This session is busy" : undefined}
              >
                {modelSwitchSaving && <Loader2 size={12} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task picker dialog (global variant) */}
      {showTaskPicker && tasks && onLinkToTask && (
        <TaskPickerDialog
          tasks={tasks}
          onSelect={(taskId) => {
            onLinkToTask(showTaskPicker, taskId);
            setShowTaskPicker(null);
          }}
          onClose={() => setShowTaskPicker(null)}
        />
      )}
    </div>
  );
}
