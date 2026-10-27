// Helm: Bridge's orchestration manager. One conversation you can type to like any chat or
// talk to hands-free, inside the normal app layout. The chat view, composer, drafts, chat mic,
// model switcher and hands-free dock are the same ones every chat uses; Helm adds the header and
// the conversation lifecycle (new, resume, keep, delete).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AudioLines,
  History,
  Loader2,
  MessageSquarePlus,
  Pin,
  PinOff,
  RotateCcw,
  Settings2,
  ShipWheel,
  Trash2,
  X,
} from "lucide-react";
import type { Attachment } from "../api";
import { sendChatMessage } from "../api";
import ChatView from "../components/ChatView";
import SessionModelSummary from "../components/SessionModelSummary";
import { sendMaterializedFirstPrompt } from "../first-send-session-cleanup";
import { useModelsQuery } from "../hooks/queries/useModels";
import { useSessionModelQuery } from "../hooks/queries/useSessionModel";
import type { UseBackgroundVoiceJobsResult, VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import type { VoiceCaptureSubmission } from "../lib/voice-submit-mode";
import { timeAgo } from "../time";
import type { Draft } from "../useDrafts";
import { useHandsFree } from "../voice/HandsFreeProvider";
import { useChatHandsFree } from "../voice/useChatHandsFree";
import { DEFAULT_SEND_MODE, type SendMode } from "../../shared/send-mode.js";
import {
  createHelmConversation,
  deleteHelmConversation,
  describeDuration,
  describeHelmExpiry,
  helmStateQueryKey,
  resumeHelmConversation,
  setHelmConversationKept,
  startFreshHelm,
  useHelmStateQuery,
  type HelmConversation,
  type HelmState,
} from "./helm-api";
import { DS, cx } from "../design/tokens";

export const HELM_DRAFT_COMPOSER_KEY = "draft:helm";

const SUGGESTIONS = [
  "What needs me right now?",
  "What's running, and how is it going?",
  "Summarize my unread replies",
  "Tidy up: archive finished sessions I've already read",
];

export interface HelmViewProps {
  onMessageSent: () => void;
  getDraft: (composerKey: string) => Draft | null;
  setDraft: (composerKey: string, text: string, attachments?: Attachment[]) => void;
  clearDraft: (composerKey: string) => void;
  getVoiceJob: (composerKey: string) => VoiceBackgroundJob | null;
  startBackgroundVoiceJob: UseBackgroundVoiceJobsResult["startBackgroundVoiceJob"];
  retryVoiceJobUpload: (composerKey: string) => void;
  reviewVoiceJob: (composerKey: string) => void;
  clearVoiceJobError: (composerKey: string) => void;
  discardVoiceRecording: (composerKey: string) => void;
  sessionReloadSignals: Record<string, number>;
  sessionBusySignals: Record<string, number>;
  sessionHistorySignals: Record<string, number>;
}

function conversationLabel(conversation: Pick<HelmConversation, "title">): string {
  return conversation.title?.trim() || "Untitled conversation";
}

function describeConversation(conversation: HelmConversation): string {
  return [
    `${conversation.turnCount} turn${conversation.turnCount === 1 ? "" : "s"}`,
    timeAgo(conversation.lastActiveAt),
    describeHelmExpiry(conversation),
  ].filter(Boolean).join(" · ");
}

const HEADER_BUTTON = cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "min-w-9 gap-1.5 disabled:opacity-50");

function HistoryPanel({
  state,
  busyId,
  onResume,
  onKeep,
  onDelete,
  onClose,
}: {
  state: HelmState;
  busyId: string | null;
  onResume(conversation: HelmConversation): void;
  onKeep(conversation: HelmConversation, kept: boolean): void;
  onDelete(conversation: HelmConversation): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[65]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Helm conversations"
        onClick={(event) => event.stopPropagation()}
        className={cx(DS.surface.floating, "absolute inset-x-2 top-14 mx-auto flex max-h-[70dvh] max-w-md flex-col overflow-hidden md:inset-x-auto md:right-4")}
        style={{ marginTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <div className="text-xs font-semibold text-text-primary">Recent conversations</div>
          <button type="button" onClick={onClose} aria-label="Close history" className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}>
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {state.recent.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-text-muted">No earlier conversations yet.</div>
          ) : state.recent.map((conversation) => (
            <div key={conversation.sessionId} className="group flex items-center gap-1 rounded-lg hover:bg-bg-hover">
              <button
                type="button"
                onClick={() => onResume(conversation)}
                disabled={busyId !== null}
                className={cx(DS.row.stacked, "flex-1 disabled:opacity-60")}
              >
                <span className="flex items-center gap-1.5">
                  {conversation.kept && <Pin size={11} aria-hidden="true" className="shrink-0 text-accent" />}
                  <span className="truncate text-sm text-text-primary">{conversationLabel(conversation)}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-text-faint">{describeConversation(conversation)}</span>
              </button>
              {busyId === conversation.sessionId ? (
                <Loader2 size={14} className="mx-2 shrink-0 animate-spin text-text-muted" />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onKeep(conversation, !conversation.kept)}
                    aria-label={conversation.kept ? `Stop keeping ${conversationLabel(conversation)}` : `Keep ${conversationLabel(conversation)}`}
                    title={conversation.kept ? "Let it expire normally" : "Keep (never expires)"}
                    className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "text-text-faint")}
                  >
                    {conversation.kept ? <PinOff size={13} /> : <Pin size={13} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(conversation)}
                    aria-label={`Delete ${conversationLabel(conversation)}`}
                    title="Delete now"
                    className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "mr-1 text-text-faint hover:bg-error/10 hover:text-error")}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] leading-relaxed text-text-faint">
          Helm opens fresh after {describeDuration(state.policy.freshAfterMs)} idle. Conversations stay resumable for {describeDuration(state.policy.retainMs)}, then expire unless kept.
        </div>
      </div>
    </div>
  );
}

function HelmWelcome({
  resumable,
  resuming,
  handsFreeBusy,
  disabled,
  onResume,
  onSuggestion,
  onHandsFree,
}: {
  resumable: HelmConversation | null;
  resuming: boolean;
  handsFreeBusy: boolean;
  disabled: boolean;
  onResume(conversation: HelmConversation): void;
  onSuggestion(prompt: string): void;
  onHandsFree(): void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2 text-text-primary">
          <ShipWheel size={22} aria-hidden="true" className="text-accent" />
          <h1 className="text-xl font-semibold tracking-tight">Helm</h1>
          <Link to="/helm/memory" className={cx(DS.text.meta, DS.focus, "ml-auto rounded hover:text-text-primary")}>What Helm knows</Link>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Steer Bridge from one place. Ask what needs you, hear what finished, hand work to sessions, and keep tasks tidy. Type like any chat, or go hands-free and just talk. It's the same conversation either way.
        </p>
        {resumable && (
          <button
            type="button"
            onClick={() => onResume(resumable)}
            disabled={resuming}
            className={cx(DS.row.base, DS.row.interactive, DS.choice.selected, DS.row.selected, "mt-5 w-full gap-3 border text-left disabled:opacity-60", DS.row.touch)}
          >
            {resuming ? <Loader2 size={16} className="shrink-0 animate-spin text-accent" /> : <RotateCcw size={16} aria-hidden="true" className="shrink-0 text-accent" />}
            <span className="min-w-0 flex-1">
              <span className={cx(DS.text.sectionLabel, "block font-medium text-accent")}>Pick up where you left off</span>
              <span className="mt-0.5 block truncate text-sm font-medium text-text-primary">{conversationLabel(resumable)}</span>
              <span className="block truncate text-[11px] text-text-muted">{describeConversation(resumable)}</span>
            </span>
          </button>
        )}
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onSuggestion(prompt)}
              disabled={disabled}
              className={cx(DS.row.stacked, DS.surface.inset, "disabled:opacity-50")}
            >
              {prompt}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onHandsFree}
          disabled={disabled || handsFreeBusy}
          className={cx(DS.button.base, DS.button.size.md, DS.button.variant.secondary, "mt-5 gap-2 disabled:opacity-60")}
        >
          {handsFreeBusy ? <Loader2 size={15} className="animate-spin" /> : <AudioLines size={15} aria-hidden="true" />}
          Go hands-free
        </button>
      </div>
    </div>
  );
}

export default function HelmView({
  onMessageSent,
  getDraft,
  setDraft,
  clearDraft,
  getVoiceJob,
  startBackgroundVoiceJob,
  retryVoiceJobUpload,
  reviewVoiceJob,
  clearVoiceJobError,
  discardVoiceRecording,
  sessionReloadSignals,
  sessionBusySignals,
  sessionHistorySignals,
}: HelmViewProps) {
  const queryClient = useQueryClient();
  const helmQuery = useHelmStateQuery();
  const handsFree = useHandsFree();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const creatingRef = useRef<Promise<HelmConversation> | null>(null);

  const state = helmQuery.data;
  const current = state?.current ?? null;
  const sessionId = current?.sessionId ?? null;
  const composerKey = sessionId ?? HELM_DRAFT_COMPOSER_KEY;

  const modelsQuery = useModelsQuery({ enabled: Boolean(sessionId) });
  const sessionModelQuery = useSessionModelQuery(sessionId);

  const setHelmState = useCallback((update: (previous: HelmState) => HelmState) => {
    queryClient.setQueryData<HelmState>(helmStateQueryKey, (previous) => (previous ? update(previous) : previous));
  }, [queryClient]);

  const refreshHelm = useCallback(() => queryClient.invalidateQueries({ queryKey: helmStateQueryKey }), [queryClient]);

  const adoptConversation = useCallback((conversation: HelmConversation) => {
    setHelmState((previous) => ({
      ...previous,
      current: conversation,
      resumable: null,
      recent: [
        ...(previous.current && previous.current.sessionId !== conversation.sessionId && previous.current.turnCount > 0 ? [previous.current] : []),
        ...previous.recent.filter((entry) => entry.sessionId !== conversation.sessionId),
      ],
    }));
  }, [setHelmState]);

  /** The current conversation, created on demand. Concurrent callers share one creation. */
  const ensureConversation = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    // The server picks Helm's model (Settings › Models), with its tier's effort and context.
    creatingRef.current ??= createHelmConversation().finally(() => {
      creatingRef.current = null;
    });
    const conversation = await creatingRef.current;
    adoptConversation(conversation);
    return conversation.sessionId;
  }, [adoptConversation, sessionId]);

  const reportError = (error: unknown) => setActionError(error instanceof Error ? error.message : String(error));

  const chatHandsFree = useChatHandsFree(sessionId, { ensureSessionId: ensureConversation, onChange: () => void refreshHelm() });
  const handsFreeHere = chatHandsFree.here;
  const startHandsFree = chatHandsFree.start;
  const endHandsFree = chatHandsFree.stop;

  /** Hands-free speaks for one conversation; moving to another takes it along. */
  const switchConversation = useCallback(async (move: () => Promise<string | null>) => {
    setActionError(null);
    setSwitching(true);
    const wasHandsFree = handsFree.active;
    try {
      if (wasHandsFree) await handsFree.stop();
      const nextSessionId = await move();
      if (wasHandsFree) await handsFree.start(nextSessionId ?? (async () => (await createAndAdopt()).sessionId));
    } catch (error) {
      reportError(error);
    } finally {
      setSwitching(false);
      void refreshHelm();
    }
    async function createAndAdopt() {
      const conversation = await createHelmConversation();
      adoptConversation(conversation);
      return conversation;
    }
  }, [adoptConversation, handsFree, refreshHelm]);

  const handleNewConversation = useCallback(() => switchConversation(async () => {
    queryClient.setQueryData<HelmState>(helmStateQueryKey, await startFreshHelm());
    return null;
  }), [queryClient, switchConversation]);

  const handleResume = useCallback((conversation: HelmConversation) => {
    setHistoryOpen(false);
    setPendingId(conversation.sessionId);
    void switchConversation(async () => {
      adoptConversation(await resumeHelmConversation(conversation.sessionId));
      return conversation.sessionId;
    }).finally(() => setPendingId(null));
  }, [adoptConversation, switchConversation]);

  const handleKeep = useCallback(async (conversation: HelmConversation, kept: boolean) => {
    setActionError(null);
    try {
      const updated = await setHelmConversationKept(conversation.sessionId, kept);
      setHelmState((previous) => ({
        ...previous,
        current: previous.current?.sessionId === updated.sessionId ? updated : previous.current,
        recent: previous.recent.map((entry) => (entry.sessionId === updated.sessionId ? updated : entry)),
      }));
    } catch (error) {
      reportError(error);
    }
  }, [setHelmState]);

  const handleDelete = useCallback(async (conversation: HelmConversation) => {
    if (!window.confirm(`Delete "${conversationLabel(conversation)}"? This can't be undone.`)) return;
    setActionError(null);
    setPendingId(conversation.sessionId);
    try {
      await deleteHelmConversation(conversation.sessionId);
      clearDraft(conversation.sessionId);
      await refreshHelm();
    } catch (error) {
      reportError(error);
    } finally {
      setPendingId(null);
    }
  }, [clearDraft, refreshHelm]);

  // ── Chat wiring (the same contract SessionRoute fulfils for ordinary sessions) ──

  const draft = getDraft(composerKey);
  const handleDraftChange = useCallback((text: string, attachments?: Attachment[]) => {
    setDraft(composerKey, text, attachments);
  }, [composerKey, setDraft]);
  const handleDraftClear = useCallback(() => clearDraft(composerKey), [clearDraft, composerKey]);

  const handleMessageSent = useCallback(() => {
    onMessageSent();
    void refreshHelm();
  }, [onMessageSent, refreshHelm]);

  const onCreateAndSend = useCallback(async (
    prompt: string,
    attachments?: Attachment[],
    mode?: SendMode,
    clientMessageId?: string,
  ): Promise<void> => {
    const newSessionId = await ensureConversation();
    await sendMaterializedFirstPrompt({ sessionId: newSessionId, prompt, attachments, mode, clientMessageId });
    clearDraft(HELM_DRAFT_COMPOSER_KEY);
  }, [clearDraft, ensureConversation]);

  const handleSuggestion = useCallback(async (prompt: string) => {
    setActionError(null);
    try {
      const target = await ensureConversation();
      await sendChatMessage(target, prompt, undefined, undefined, { waitForDelivery: true });
      handleMessageSent();
    } catch (error) {
      reportError(error);
    }
  }, [ensureConversation, handleMessageSent]);

  /** A recording made before any conversation exists still belongs to Helm, not to a new quick chat. */
  const handleSubmitVoiceCapture = useCallback(async (capture: VoiceCaptureSubmission) => {
    const target = await ensureConversation();
    return startBackgroundVoiceJob({ ...capture, composerKey: target });
  }, [ensureConversation, startBackgroundVoiceJob]);

  const showResumable = !current || current.turnCount === 0;
  const emptyState = useMemo(() => (
    <HelmWelcome
      resumable={showResumable ? state?.resumable ?? state?.recent.find((entry) => entry.turnCount > 0) ?? null : null}
      resuming={pendingId !== null || switching}
      handsFreeBusy={handsFree.phase === "connecting"}
      disabled={switching}
      onResume={handleResume}
      onSuggestion={(prompt) => void handleSuggestion(prompt)}
      onHandsFree={() => void startHandsFree()}
    />
  ), [handleResume, handleSuggestion, handsFree.phase, pendingId, showResumable, startHandsFree, state?.recent, state?.resumable, switching]);

  const subtitle = current
    ? current.turnCount > 0 ? `${conversationLabel(current)} · ${describeConversation(current)}` : "New conversation"
    : helmQuery.isLoading ? "Loading…" : "New conversation";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-helm-view={handsFreeHere ? "hands-free" : "chat"}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3 py-1.5 sm:px-4">
        <ShipWheel size={18} aria-hidden="true" className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight text-text-primary">Helm</div>
          <div className="truncate text-[11px] leading-tight text-text-muted">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={() => void (handsFreeHere ? endHandsFree() : startHandsFree())}
          disabled={switching || handsFree.phase === "connecting"}
          aria-pressed={handsFreeHere}
          aria-label={handsFreeHere ? "Hands-free on" : "Hands-free"}
          className={cx(HEADER_BUTTON, handsFreeHere && DS.row.selected)}
        >
          {handsFree.phase === "connecting" ? <Loader2 size={14} className="animate-spin" /> : <AudioLines size={14} aria-hidden="true" />}
          <span>{handsFreeHere ? "Hands-free on" : "Hands-free"}</span>
        </button>
        <button
          type="button"
          onClick={() => void handleNewConversation()}
          disabled={switching || !current || current.turnCount === 0}
          title="Start a new conversation. This one stays in history."
          aria-label="New conversation"
          className={HEADER_BUTTON}
        >
          {switching ? <Loader2 size={15} className="animate-spin" /> : <MessageSquarePlus size={15} />}
          <span className="hidden lg:inline">New</span>
        </button>
        <button type="button" onClick={() => setHistoryOpen(true)} aria-label="Recent conversations" title="Recent conversations" className={HEADER_BUTTON}>
          <History size={15} />
          {state && state.recent.length > 0 && <span className="tabular-nums text-text-faint">{state.recent.length}</span>}
        </button>
        {current && current.turnCount > 0 && (
          <button
            type="button"
            onClick={() => void handleKeep(current, !current.kept)}
            aria-pressed={current.kept}
            aria-label={current.kept ? "Stop keeping this conversation" : "Keep this conversation"}
            title={current.kept ? "Kept: never expires. Click to let it expire normally." : "Keep this conversation so it never expires"}
            className={cx(HEADER_BUTTON, current.kept ? cx(DS.button.base, DS.button.size.sm, DS.segmented.option, DS.segmented.selected) : "")}
          >
            <Pin size={15} />
          </button>
        )}
        <Link to="/settings?group=helm" aria-label="Helm settings" title="Helm settings" className={HEADER_BUTTON}>
          <Settings2 size={15} />
        </Link>
      </header>
      {(actionError || helmQuery.error || (handsFree.error && !handsFreeHere)) && (
        <div role="alert" className={cx(DS.notice.surface, "flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs text-error")}>
          <span className="min-w-0 flex-1 break-words">
            {actionError ?? (helmQuery.error instanceof Error ? helmQuery.error.message : null) ?? handsFree.error}
          </span>
          {(actionError || (!helmQuery.error && handsFree.error)) && (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                handsFree.clearError();
              }}
              aria-label="Dismiss"
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "hover:bg-error/10")}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <ChatView
        // No `key`: the view has to survive the draft → conversation handoff so a first message
        // that is still being delivered is not dropped by a remount.
        composerKey={composerKey}
        sessionId={sessionId}
        sessionModelSummary={sessionId ? (
          <SessionModelSummary
            state={sessionModelQuery.data}
            models={modelsQuery.data}
            loading={sessionModelQuery.isLoading || sessionModelQuery.isFetching}
            error={sessionModelQuery.error instanceof Error ? sessionModelQuery.error.message : undefined}
            onRetry={() => {
              void sessionModelQuery.refetch();
            }}
          />
        ) : undefined}
        onMessageSent={handleMessageSent}
        draft={draft}
        onDraftChange={handleDraftChange}
        onDraftClear={handleDraftClear}
        onCreateAndSend={sessionId ? undefined : onCreateAndSend}
        emptyState={emptyState}
        defaultSendMode={DEFAULT_SEND_MODE}
        voiceJob={getVoiceJob(composerKey)}
        onSubmitVoiceCapture={handleSubmitVoiceCapture}
        onReviewVoiceJob={reviewVoiceJob}
        onClearVoiceJobError={clearVoiceJobError}
        onDiscardVoiceRecording={discardVoiceRecording}
        onRetryVoiceJobUpload={retryVoiceJobUpload}
        reloadToken={sessionId ? sessionReloadSignals[sessionId] ?? 0 : 0}
        busySignal={sessionId ? sessionBusySignals[sessionId] ?? 0 : 0}
        historySignal={sessionId ? sessionHistorySignals[sessionId] ?? 0 : 0}
        newWorkDisabled={switching || helmQuery.isLoading}
        newWorkDisabledHint={switching ? "Switching conversations…" : undefined}
        composerAccessory={chatHandsFree.accessory}
        hideVoiceInput={handsFree.active}
        composerPlaceholder={handsFreeHere ? "Type to Helm. Replies are read back…" : "Ask Helm…"}
      />
      {historyOpen && state && (
        <HistoryPanel
          state={state}
          busyId={pendingId}
          onResume={handleResume}
          onKeep={(conversation, kept) => void handleKeep(conversation, kept)}
          onDelete={(conversation) => void handleDelete(conversation)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
