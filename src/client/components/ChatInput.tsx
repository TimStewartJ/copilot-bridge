import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ArrowUp, Check, Square, Paperclip, Loader2, Mic, MoreHorizontal, X } from "lucide-react";
import type { BlobAttachment, Attachment, SlashCommandInfo } from "../api";
import { uploadFile } from "../api";
import {
  isActiveVoiceBackgroundJob,
  type ActiveVoiceBackgroundJob,
  type VoiceBackgroundJob,
} from "../hooks/useBackgroundVoiceJobs";
import { useVoiceInput } from "../hooks/useVoiceInput";
import useLongPressMenu from "../hooks/useLongPressMenu";
import {
  canAutoSendVoiceTranscript,
  resolveVoiceSubmitMode,
  resolveVoiceSubmitModeAfterRecording,
  type SubmitVoiceCapture,
  type VoiceSubmitMode,
} from "../lib/voice-submit-mode";
import { isDraftComposerKey } from "../lib/composer-key";
import { hasFinePointer, usesSoftKeyboard } from "../lib/pointer";
import { classifyComposerKey } from "../lib/composer-enter";
import {
  shouldClearAcceptedFlashHandoff,
  shouldFlashAcceptedHandoff,
  shouldFlashAcceptedStatus,
  shouldKeepAcceptedFlash,
  updateAcceptedFlashHandoff,
} from "../lib/voice-accepted-flash";
import { deriveVoiceUiState } from "../lib/voice-ui-state";
import type { Draft } from "../useDrafts";
import { DEFAULT_SEND_MODE, type SendMode } from "../../shared/send-mode.js";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "./ContextMenu";
import { ComposerAttachmentTray } from "./ChatAttachments";
import { VoiceRecordingWave } from "./VoiceRecordingWave";
import { DS, cx } from "../design/tokens";
import { AutopilotIcon } from "../design/primitives";
import { haptic } from "../lib/haptics";
import { useIsMobile } from "../useIsMobile";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
const COMPOSER_RAIL_CLASS = "mx-auto w-full max-w-4xl px-3 pb-3 pt-1 sm:px-4 md:px-6 md:pb-4 lg:px-8";

interface SlashDraftState {
  query: string;
  hasArgumentStart: boolean;
}

function parseSlashDraft(value: string): SlashDraftState | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const match = value.match(/^\/([^\s/]*)([\s\S]*)$/);
  if (!match) return null;
  return {
    query: match[1] ?? "",
    hasArgumentStart: (match[2] ?? "").length > 0,
  };
}

function slashCommandTokens(command: SlashCommandInfo): string[] {
  return [command.name, ...(command.aliases ?? [])].map((token) => token.toLowerCase());
}

function matchesSlashQuery(command: SlashCommandInfo, query: string): boolean {
  const normalized = query.toLowerCase();
  if (!normalized) return true;
  return slashCommandTokens(command).some((token) => token.startsWith(normalized));
}

function isExactSlashCommand(command: SlashCommandInfo, query: string): boolean {
  const normalized = query.toLowerCase();
  return slashCommandTokens(command).some((token) => token === normalized);
}

/** Read a File as base64 (fallback for draft mode without sessionId) */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      resolve(result.split(",", 2)[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function revokePreviewUrls(items: Attachment[]): void {
  for (const item of items) {
    if (item.type === "uploaded" && item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[], mode?: SendMode) => void;
  onAbort?: () => void;
  composerKey: string;
  sessionId?: string | null;
  isDraft?: boolean;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: Attachment[]) => void;
  voiceJob?: VoiceBackgroundJob | null;
  onSubmitVoiceCapture: SubmitVoiceCapture;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  onRetryVoiceJobUpload?: (composerKey: string) => void;
  onDiscardVoiceRecording?: (composerKey: string) => void;
  /** When true, input is visible but send is disabled (e.g., session warming up) */
  disabled?: boolean;
  disabledHint?: string;
  slashCommands?: SlashCommandInfo[];
  slashCommandsSupported?: boolean;
  defaultSendMode?: SendMode;
  /** Hides the record button while something else owns the microphone (hands-free voice). */
  hideVoiceInput?: boolean;
  /** A tool shown beside the record button (the chat's hands-free switch). */
  extraTool?: ComposerTool;
  placeholder?: string;
  /** Incremented to request focus (desktop only, so touch devices do not raise the keyboard). */
  focusRequest?: number;
}

/** A composer tool: a round button beside the record button, or a row in the phone's tools menu. */
export interface ComposerTool {
  label: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

const COMPOSER_TOOL_BUTTON_CLASS = "flex h-12 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors";

export default function ChatInput({
  onSend,
  onAbort,
  composerKey,
  sessionId,
  isDraft,
  draft,
  onDraftChange,
  voiceJob,
  onSubmitVoiceCapture,
  onReviewVoiceJob,
  onClearVoiceJobError,
  onRetryVoiceJobUpload,
  onDiscardVoiceRecording,
  disabled,
  disabledHint,
  slashCommands = [],
  slashCommandsSupported = false,
  defaultSendMode = DEFAULT_SEND_MODE,
  hideVoiceInput = false,
  extraTool,
  placeholder = "Type a message...",
  focusRequest = 0,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHeightRef = useRef(0);
  /** The text box is hidden behind the recording line; measuring it then would collapse it to nothing. */
  const textareaHiddenRef = useRef(false);
  const recordingRowRef = useRef<HTMLDivElement>(null);
  const finishRecordingRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef(input);
  const attachmentsRef = useRef<Attachment[]>(attachments);
  const uploadingRef = useRef(uploading);
  const sendBlockedRef = useRef(Boolean(disabled || onAbort));
  const agentBusyRef = useRef(Boolean(onAbort));
  /** The send mode an auto-sent transcript uses, so dictating with Autopilot on starts an Autopilot run. */
  const nextSendModeRef = useRef<SendMode>(defaultSendMode);
  const pendingCaptureSendModeRef = useRef<{ mode: SendMode; choice: number } | null>(null);
  /** Counts send-mode choices, so a recording finishing late never undoes a newer one. */
  const sendModeChoiceRef = useRef(0);
  const restoredForRef = useRef<string | null>(null);
  const recordingStartModeRef = useRef<VoiceSubmitMode | null>(null);
  const pendingCaptureSubmitModeRef = useRef<VoiceSubmitMode | null>(null);
  const acceptedFlashJobIdRef = useRef<string | null>(null);
  const acceptedFlashTimerRef = useRef<number | null>(null);
  const previousComposerKeyRef = useRef<string | null>(composerKey);
  const pendingAcceptedHandoffRef = useRef<{ originComposerKey: string; targetComposerKey: string } | null>(null);
  const previousVoiceJobRef = useRef<ActiveVoiceBackgroundJob | null>(null);
  const [recordingStartMode, setRecordingStartMode] = useState<VoiceSubmitMode | null>(null);
  const [showAcceptedConfirmation, setShowAcceptedConfirmation] = useState(false);
  const [recordingCancelled, setRecordingCancelled] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const {
    bind: bindSendModeMenu,
    menu: sendModeMenu,
    closeMenu: closeSendModeMenu,
    isTarget: isSendModeMenuTarget,
  } = useLongPressMenu<"send-mode">();
  const isMobile = useIsMobile();
  const [toolsMenu, setToolsMenu] = useState<ContextMenuPosition | null>(null);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    uploadingRef.current = uploading;
  }, [uploading]);

  useEffect(() => {
    sendBlockedRef.current = Boolean(disabled || onAbort);
    agentBusyRef.current = Boolean(onAbort);
  }, [disabled, onAbort]);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el || textareaHiddenRef.current) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 200);
    lastHeightRef.current = next;
    el.style.height = `${next}px`;
  }, []);

  const updateDraft = useCallback((value: string, nextAttachments = attachmentsRef.current) => {
    onDraftChange?.(value, nextAttachments);
  }, [onDraftChange]);

  const applyComposerText = useCallback((value: string) => {
    inputRef.current = value;
    setInput(value);
    updateDraft(value);
    queueMicrotask(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange?.(value.length, value.length);
      adjustTextareaHeight();
    });
  }, [adjustTextareaHeight, updateDraft]);

  const clearComposer = useCallback(() => {
    revokePreviewUrls(attachmentsRef.current);
    inputRef.current = "";
    attachmentsRef.current = [];
    setInput("");
    setAttachments([]);
    lastHeightRef.current = 0;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, []);

  const updateRecordingStartMode = useCallback((next: VoiceSubmitMode | null) => {
    recordingStartModeRef.current = next;
    setRecordingStartMode(next);
  }, []);

  const clearAcceptedFlash = useCallback(() => {
    acceptedFlashJobIdRef.current = null;
    if (acceptedFlashTimerRef.current !== null) {
      window.clearTimeout(acceptedFlashTimerRef.current);
      acceptedFlashTimerRef.current = null;
    }
    setShowAcceptedConfirmation(false);
  }, []);

  const startAcceptedFlash = useCallback((jobId: string) => {
    acceptedFlashJobIdRef.current = jobId;
    setShowAcceptedConfirmation(true);
    if (acceptedFlashTimerRef.current !== null) {
      window.clearTimeout(acceptedFlashTimerRef.current);
    }
    acceptedFlashTimerRef.current = window.setTimeout(() => {
      acceptedFlashTimerRef.current = null;
      setShowAcceptedConfirmation(false);
    }, 2_000);
  }, []);

  const activeVoiceJob = isActiveVoiceBackgroundJob(voiceJob) ? voiceJob : null;
  const voiceJobError = voiceJob?.status === "error" ? voiceJob.error ?? null : null;
  const hasPendingVoiceRecording = voiceJob?.status === "error" && voiceJob.retryable === true;
  const canRetryVoiceJobUpload = hasPendingVoiceRecording && !!onRetryVoiceJobUpload;
  const canDiscardVoiceRecording = hasPendingVoiceRecording && !!onDiscardVoiceRecording;

  const stopVoiceRecordingRef = useRef<() => void>(() => {});
  const voice = useVoiceInput({
    contextKey: composerKey,
    onAudioCaptured: async ({ audio, contextKey }) => {
      const submitMode = contextKey === composerKey
        ? (pendingCaptureSubmitModeRef.current ?? "insert")
        : "insert";
      const capturedSendMode = submitMode === "autosend" ? pendingCaptureSendModeRef.current : null;
      const sendMode = capturedSendMode?.mode;
      pendingCaptureSubmitModeRef.current = null;
      pendingCaptureSendModeRef.current = null;
      const delivered = await onSubmitVoiceCapture({
        composerKey: contextKey,
        audio,
        submitMode,
        ...(sendMode ? { sendMode } : {}),
      });
      // Like a typed send, an auto-sent recording uses up this message's mode choice.
      if (
        delivered === "autosend"
        && capturedSendMode
        && capturedSendMode.mode !== defaultSendMode
        && capturedSendMode.choice === sendModeChoiceRef.current
      ) {
        chooseSendMode(defaultSendMode);
      }
    },
    onMaxDurationReached: () => stopVoiceRecordingRef.current(),
  });
  const canCancelRecording = voice.phase === "starting" || voice.phase === "recording";
  const cancelVoiceRecording = useCallback(() => {
    if (!canCancelRecording || !voice.cancelRecording()) return;
    pendingCaptureSubmitModeRef.current = null;
    pendingCaptureSendModeRef.current = null;
    updateRecordingStartMode(null);
    setRecordingCancelled(true);
  }, [canCancelRecording, updateRecordingStartMode, voice.cancelRecording]);
  const handleRecordingEscape = useCallback((event: React.KeyboardEvent) => {
    if (
      event.key !== "Escape"
      || !canCancelRecording
      || composingRef.current
      || event.nativeEvent?.isComposing
      || event.keyCode === 229
    ) return;
    event.preventDefault();
    event.stopPropagation();
    cancelVoiceRecording();
  }, [canCancelRecording, cancelVoiceRecording]);

  useEffect(() => {
    setRecordingCancelled(false);
  }, [composerKey]);
  // Pressing stop and running into the length limit end a recording the same way.
  stopVoiceRecordingRef.current = () => {
    pendingCaptureSubmitModeRef.current = resolveVoiceSubmitModeAfterRecording(recordingStartModeRef.current, {
      text: inputRef.current,
      attachmentCount: attachmentsRef.current.length,
      sendBlocked: sendBlockedRef.current,
      uploadingCount: uploadingRef.current,
    });
    pendingCaptureSendModeRef.current = { mode: nextSendModeRef.current, choice: sendModeChoiceRef.current };
    void voice.stopRecording();
  };

  useEffect(() => {
    return () => {
      clearAcceptedFlash();
      revokePreviewUrls(attachmentsRef.current);
    };
  }, [clearAcceptedFlash]);

  useEffect(() => {
    if (voice.phase === "idle" && !activeVoiceJob) {
      updateRecordingStartMode(null);
      pendingCaptureSubmitModeRef.current = null;
      pendingCaptureSendModeRef.current = null;
    }
  }, [activeVoiceJob, updateRecordingStartMode, voice.phase]);

  // The microphone starting and stopping is felt, so you know it is listening without looking.
  const recording = voice.phase === "recording";
  const wasRecordingRef = useRef(recording);
  useEffect(() => {
    if (recording === wasRecordingRef.current) return;
    wasRecordingRef.current = recording;
    haptic(recording ? "light" : "selection");
  }, [recording]);

  // While the microphone is open, the box shows only the recording line, Cancel and Finish.
  // Finishing hands straight back to the composer, which shows the upload and transcription.
  const recordingView = voice.phase === "starting" || voice.phase === "recording";
  textareaHiddenRef.current = recordingView;
  const wasRecordingViewRef = useRef(recordingView);
  useEffect(() => {
    if (recordingView === wasRecordingViewRef.current) return;
    wasRecordingViewRef.current = recordingView;
    if (recordingView) {
      setToolsMenu(null);
      closeSendModeMenu();
      return;
    }
    adjustTextareaHeight();
    if (focusWasDropped() && hasFinePointer()) textareaRef.current?.focus();
  }, [adjustTextareaHeight, closeSendModeMenu, recordingView]);
  // The button that started the recording is gone, so keyboard focus moves into the recording row:
  // onto the row while the microphone starts, then onto Finish.
  useEffect(() => {
    if (!recordingView) return;
    const row = recordingRowRef.current;
    const dropped = focusWasDropped();
    if (!dropped && !row?.contains(document.activeElement)) return;
    if (voice.phase === "recording") finishRecordingRef.current?.focus({ preventScroll: true });
    else if (dropped) row?.focus({ preventScroll: true });
  }, [recordingView, voice.phase]);

  // A voice error that appears is felt too; one that was already there when you open a chat is not.
  const voiceFailed = Boolean(voiceJobError || voice.error);
  const voiceFailedRef = useRef({ composerKey, failed: voiceFailed });
  useEffect(() => {
    const previous = voiceFailedRef.current;
    voiceFailedRef.current = { composerKey, failed: voiceFailed };
    if (voiceFailed && !previous.failed && previous.composerKey === composerKey) haptic("error");
  }, [composerKey, voiceFailed]);

  useEffect(() => {
    const pendingAcceptedHandoff = updateAcceptedFlashHandoff(
      previousComposerKeyRef.current,
      composerKey,
      pendingAcceptedHandoffRef.current,
    );
    pendingAcceptedHandoffRef.current = pendingAcceptedHandoff;

    if (!shouldKeepAcceptedFlash(acceptedFlashJobIdRef.current, activeVoiceJob)) {
      clearAcceptedFlash();
    }

    const shouldFlashAccepted =
      shouldFlashAcceptedStatus(previousVoiceJobRef.current, activeVoiceJob)
      || shouldFlashAcceptedHandoff(
        pendingAcceptedHandoff?.originComposerKey ?? null,
        composerKey,
        activeVoiceJob,
      );

    if (
      shouldFlashAccepted
      && activeVoiceJob?.serverJobId
      && acceptedFlashJobIdRef.current !== activeVoiceJob.serverJobId
    ) {
      startAcceptedFlash(activeVoiceJob.serverJobId);
    }

    if (shouldClearAcceptedFlashHandoff(pendingAcceptedHandoff, composerKey, activeVoiceJob)) {
      pendingAcceptedHandoffRef.current = null;
    }

    previousComposerKeyRef.current = composerKey;
    previousVoiceJobRef.current = activeVoiceJob;
  }, [activeVoiceJob, clearAcceptedFlash, composerKey, startAcceptedFlash]);

  // Restore draft when the active composer target changes.
  useEffect(() => {
    if (restoredForRef.current === composerKey) return;
    restoredForRef.current = composerKey;
    composingRef.current = false;

    if (draft) {
      revokePreviewUrls(attachmentsRef.current);
      inputRef.current = draft.text;
      attachmentsRef.current = draft.attachments ?? [];
      setInput(draft.text);
      setAttachments(draft.attachments ?? []);
      requestAnimationFrame(() => adjustTextareaHeight());
    } else {
      clearComposer();
    }
  }, [composerKey, draft, adjustTextareaHeight, clearComposer]);

  useEffect(() => {
    if (restoredForRef.current !== composerKey) return;
    const nextText = draft?.text ?? "";
    if (nextText === inputRef.current) return;
    inputRef.current = nextText;
    setInput(nextText);
    requestAnimationFrame(() => adjustTextareaHeight());
  }, [adjustTextareaHeight, composerKey, draft?.text]);

  // Auto-focus on session change (desktop only — avoids keyboard popup on mobile)
  useEffect(() => {
    if (composerKey && hasFinePointer()) {
      textareaRef.current?.focus();
    }
  }, [composerKey]);

  const handledFocusRequestRef = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRequestRef.current) return;
    handledFocusRequestRef.current = focusRequest;
    if (!hasFinePointer()) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange?.(end, end);
  }, [focusRequest]);

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        console.warn(`Skipping ${file.name}: exceeds 10 MB limit`);
        continue;
      }

      if (sessionId) {
        setUploading((count) => count + 1);
        try {
          const uploaded = await uploadFile(sessionId, file);
          if (file.type.startsWith("image/")) {
            uploaded.previewUrl = URL.createObjectURL(file);
          }
          setAttachments((prev) => {
            const next = [...prev, uploaded];
            attachmentsRef.current = next;
            updateDraft(inputRef.current, next);
            return next;
          });
        } catch (err) {
          console.error(`Failed to upload ${file.name}:`, err);
        } finally {
          setUploading((count) => count - 1);
        }
      } else {
        const data = await readFileAsBase64(file);
        const blob: BlobAttachment = {
          type: "blob",
          data,
          mimeType: file.type || "application/octet-stream",
          displayName: file.name,
        };
        setAttachments((prev) => {
          const next = [...prev, blob];
          attachmentsRef.current = next;
          updateDraft(inputRef.current, next);
          return next;
        });
      }
    }
  }, [sessionId, updateDraft]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed?.type === "uploaded" && removed.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      const next = prev.filter((_, i) => i !== index);
      attachmentsRef.current = next;
      updateDraft(inputRef.current, next);
      return next;
    });
  }, [updateDraft]);

  const insertSlashCommand = useCallback((command: SlashCommandInfo) => {
    const current = inputRef.current;
    const draft = parseSlashDraft(current);
    if (!draft) return;
    const tokenEnd = 1 + draft.query.length;
    const rest = current.slice(tokenEnd);
    applyComposerText(`/${command.name}${rest || " "}`);
  }, [applyComposerText]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pastedFiles: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      const file = item.getAsFile();
      if (file) pastedFiles.push(file);
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void addFiles(pastedFiles);
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      void addFiles(files);
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    if (dragDepthRef.current === 0) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    inputRef.current = value;
    setInput(value);
    updateDraft(value);
    const el = e.target;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 200);
    lastHeightRef.current = next;
    el.style.height = `${next}px`;
  }, [updateDraft]);

  const manualSendBlockedByVoiceJob = !!activeVoiceJob?.serverOwned && isDraftComposerKey(composerKey);
  const slashDraft = useMemo(() => parseSlashDraft(input), [input]);
  const exactSlashCommand = useMemo(() => {
    if (!slashDraft || !slashCommandsSupported) return undefined;
    return slashCommands.find((command) => isExactSlashCommand(command, slashDraft.query));
  }, [slashCommands, slashCommandsSupported, slashDraft]);
  const slashSuggestions = useMemo(() => {
    if (!slashDraft || !slashCommandsSupported) return [];
    if (slashDraft.hasArgumentStart && exactSlashCommand) return [];
    return slashCommands
      .filter((command) => matchesSlashQuery(command, slashDraft.query))
      .slice(0, 8);
  }, [exactSlashCommand, slashCommands, slashCommandsSupported, slashDraft]);
  const agentBusy = Boolean(onAbort);

  useEffect(() => {
    setSelectedSlashCommandIndex(0);
  }, [slashDraft?.query, slashSuggestions.length]);

  /**
   * The mode the next send uses. A new chat takes it from its launch panel; an open chat starts
   * each message interactive and the Autopilot toggle switches just that message.
   */
  const [chosenSendMode, setChosenSendMode] = useState<SendMode>(defaultSendMode);
  const chooseSendMode = useCallback((mode: SendMode) => {
    sendModeChoiceRef.current += 1;
    setChosenSendMode(mode);
  }, []);
  useEffect(() => {
    chooseSendMode(defaultSendMode);
  }, [chooseSendMode, composerKey, defaultSendMode]);
  const nextSendMode: SendMode = isDraft ? defaultSendMode : chosenSendMode;
  const autopilotNext = nextSendMode === "autopilot";
  nextSendModeRef.current = nextSendMode;

  const handleSend = useCallback((mode: SendMode = nextSendMode) => {
    if (disabled || uploading > 0 || manualSendBlockedByVoiceJob) return;

    const text = inputRef.current.trim();
    const currentAttachments = attachmentsRef.current;
    if (!text && currentAttachments.length === 0) return;

    for (const att of currentAttachments) {
      if (att.type === "uploaded" && att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
      }
    }

    const cleanAttachments: Attachment[] = currentAttachments.map((att) =>
      att.type === "uploaded"
        ? { type: att.type, displayName: att.displayName, mimeType: att.mimeType, size: att.size }
        : att,
    );

    const cleanAttachmentsOrUndefined = cleanAttachments.length > 0 ? cleanAttachments : undefined;
    const selectedMode = onAbort ? undefined : mode;

    onClearVoiceJobError?.(composerKey);
    setRecordingCancelled(false);
    haptic("light");
    if (selectedMode) {
      onSend(text || "(attachment)", cleanAttachmentsOrUndefined, selectedMode);
    } else {
      onSend(text || "(attachment)", cleanAttachmentsOrUndefined);
    }
    clearComposer();
    if (selectedMode) chooseSendMode(defaultSendMode);

    if (textareaRef.current && usesSoftKeyboard()) {
      textareaRef.current.blur();
    }
  }, [chooseSendMode, clearComposer, composerKey, defaultSendMode, disabled, manualSendBlockedByVoiceJob, nextSendMode, onAbort, onClearVoiceJobError, onSend, uploading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const intent = classifyComposerKey(e, {
      composing: composingRef.current,
      usesSoftKeyboard,
      hasFinePointer,
    });
    if (intent === "composing" || intent === "newline") return;
    if (intent === "send") {
      e.preventDefault();
      handleSend();
      return;
    }
    if (slashSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSlashCommandIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashCommandIndex((index) => (index + slashSuggestions.length - 1) % slashSuggestions.length);
        return;
      }
      if (e.key === "Tab" || intent === "submit") {
        e.preventDefault();
        insertSlashCommand(slashSuggestions[selectedSlashCommandIndex] ?? slashSuggestions[0]!);
        return;
      }
    }
    if (intent === "submit") {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, insertSlashCommand, selectedSlashCommandIndex, slashSuggestions]);

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && uploading === 0 && !disabled && !manualSendBlockedByVoiceJob;
  const canAutoSendNewVoiceTranscript = canAutoSendVoiceTranscript({
    text: input,
    attachmentCount: attachments.length,
    sendBlocked: Boolean(disabled || onAbort),
    uploadingCount: uploading,
  });
  const canAutoSendStoppedRecording =
    recordingStartMode === "autosend" && canAutoSendNewVoiceTranscript;
  const voiceUi = deriveVoiceUiState({
    browserSupported: voice.browserSupported,
    statusAvailable: voice.status?.available === true,
    statusError: voice.statusError,
    voiceError: voice.error,
    voiceJobError,
    showAcceptedConfirmation,
    recorderPhase: voice.phase,
    isCheckingStatus: voice.isCheckingStatus,
    activeVoiceJob: activeVoiceJob
      ? {
          status: activeVoiceJob.status,
          submitMode: activeVoiceJob.submitMode,
          serverOwned: activeVoiceJob.serverOwned,
        }
      : null,
    canAutoSendStoppedRecording,
    hasPendingRecording: hasPendingVoiceRecording,
    persistWarning: voiceJob?.persistWarning ?? null,
    recordingSeconds: voice.elapsedSeconds,
    maxRecordingSeconds: voice.status?.maxDurationSeconds,
    uploadPercent: voiceJob?.uploadPercent,
  });
  const showVoiceButton = voiceUi.showButton && !hideVoiceInput;
  // On a phone, typed text gets the room: the tools fold into one menu, unless a recording is under way.
  const collapseTools = isMobile && input.trim().length > 0 && (!showVoiceButton || voiceUi.buttonState === "mic");
  const toggleVoiceRecording = () => {
    if (voice.phase === "recording") {
      stopVoiceRecordingRef.current();
      return;
    }
    setRecordingCancelled(false);
    onClearVoiceJobError?.(composerKey);
    // A composer that is only loading or reconnecting may still send; stopping checks it again.
    updateRecordingStartMode(resolveVoiceSubmitMode({
      text: inputRef.current,
      attachmentCount: attachmentsRef.current.length,
      sendBlocked: agentBusyRef.current,
      uploadingCount: uploadingRef.current,
    }));
    pendingCaptureSubmitModeRef.current = null;
    void voice.startRecording();
  };
  useEffect(() => {
    if (!collapseTools) setToolsMenu(null);
  }, [collapseTools]);
  const voiceMessageClassName = voiceUi.tone === "error"
    ? "text-error"
    : voiceUi.tone === "success"
      ? "text-success"
      : voiceUi.tone === "accent"
        ? "text-accent"
        : "text-text-faint";
  const voiceMessage = voiceUi.message ?? (
    recordingCancelled && voice.phase === "idle" && !activeVoiceJob
      ? "Recording cancelled. Nothing sent."
      : null
  );
  const showAbortControl = Boolean(onAbort && !hasContent);
  const sendTitle = disabled
    ? (disabledHint ?? "Warming up…")
    : onAbort
      ? "Send steering note"
      : autopilotNext
        ? "Start Autopilot"
        : "Send message";
  const submitControlTitle = showAbortControl ? "Stop generating" : sendTitle;
  const modeMenuBindings = bindSendModeMenu(
    "send-mode",
    showAbortControl ? () => { haptic("medium"); onAbort?.(); } : () => handleSend(nextSendMode),
  );
  const handleMenuSend = useCallback((mode: SendMode) => {
    closeSendModeMenu();
    handleSend(mode);
  }, [closeSendModeMenu, handleSend]);
  const modeMenuEnabled = !showAbortControl;
  // Steering goes into the run already going, and a new chat picks its mode on the launch panel.
  const showAutopilotToggle = !isDraft && !onAbort;

  return (
    <div className="shrink-0" onKeyDown={handleRecordingEscape}>
      <div className={COMPOSER_RAIL_CLASS}>

        {voiceMessage && (
          <div
            className={cx(
              "mb-2 flex flex-wrap items-center gap-x-1 text-xs",
              voiceMessageClassName,
              recordingView && voiceUi.tone !== "error" && "sr-only",
            )}
          >
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {voiceMessage}
            </span>
            {voiceUi.detail && !recordingView && <span className="tabular-nums">{voiceUi.detail}</span>}
            {canRetryVoiceJobUpload && (
              <button
                type="button"
                onClick={() => onRetryVoiceJobUpload?.(composerKey)}
                aria-label="Try sending voice message again"
                className="rounded-sm font-medium underline underline-offset-2 transition-colors hover:text-error-hover focus:outline-none focus:ring-2 focus:ring-error/40"
              >
                Try again
              </button>
            )}
            {canDiscardVoiceRecording && (
              <button
                type="button"
                onClick={() => onDiscardVoiceRecording?.(composerKey)}
                aria-label="Discard the unsent voice recording"
                className="rounded-sm font-medium underline underline-offset-2 transition-colors hover:text-error-hover focus:outline-none focus:ring-2 focus:ring-error/40"
              >
                Discard
              </button>
            )}
          </div>
        )}

        {slashCommandsSupported && !recordingView && (slashSuggestions.length > 0 || exactSlashCommand) && (
          <div
            className={`mb-2 overflow-hidden p-1 ${DS.surface.floating}`}
            role="listbox"
            aria-label="Slash command suggestions"
          >
            {slashSuggestions.length > 0 ? (
              slashSuggestions.map((command, index) => {
                const commandDisabled = agentBusy && !command.allowDuringAgentExecution;
                return (
                  <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={index === selectedSlashCommandIndex}
                    disabled={commandDisabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertSlashCommand(command)}
                    title={commandDisabled ? "This command cannot run while the agent is busy." : undefined}
                    className={`block w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                      index === selectedSlashCommandIndex
                        ? "bg-bg-hover text-text-primary"
                        : "text-text-secondary hover:bg-bg-hover/60"
                    } ${commandDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium text-text-primary">/{command.name}</span>
                      {command.input?.hint && (
                        <span className="truncate text-xs text-text-faint">{command.input.hint}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">
                      {command.description}
                    </span>
                  </button>
                );
              })
            ) : exactSlashCommand ? (
              <div className="px-3 py-2 text-sm">
                <div className="font-medium text-text-primary">/{exactSlashCommand.name}</div>
                <div className="mt-0.5 text-xs text-text-muted">{exactSlashCommand.description}</div>
                {exactSlashCommand.input?.hint && (
                  <div className="mt-1 text-xs text-text-faint">
                    {exactSlashCommand.input.required ? "Required: " : "Hint: "}
                    {exactSlashCommand.input.hint}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {showAutopilotToggle && autopilotNext && (
          <div className="mb-2 flex min-w-0 items-center gap-1.5 px-1 text-xs text-text-secondary" data-autopilot-hint>
            <AutopilotIcon size={12} className="text-agent" />
            <span className="min-w-0">
              <span className="font-medium text-agent">Autopilot</span>
              {" keeps going until done. Questions still wait for you."}
            </span>
          </div>
        )}
        <div
          className={`relative flex flex-col ${DS.surface.composer} ${dragActive ? "ring-1 ring-text-secondary" : ""}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl bg-surface-overlay/95 text-sm font-medium text-text-primary">
              <Paperclip size={16} aria-hidden="true" />
              Drop files to attach
            </div>
          )}
          <ComposerAttachmentTray
            attachments={attachments}
            uploadingCount={uploading}
            onRemove={recordingView ? undefined : removeAttachment}
          />
          <div
            ref={recordingRowRef}
            role={recordingView ? "group" : undefined}
            aria-label={recordingView ? "Voice recording" : undefined}
            tabIndex={recordingView ? -1 : undefined}
            className={cx("flex gap-0.5 focus:outline-none", recordingView ? "items-center" : "items-end")}
          >
          {recordingView ? (
            <button
              type="button"
              onClick={cancelVoiceRecording}
              disabled={!canCancelRecording}
              className={cx("ml-1", COMPOSER_TOOL_BUTTON_CLASS, DS.focus, "text-text-muted hover:text-text-primary disabled:text-text-faint/60")}
              title="Discard this recording without sending (Esc)"
              aria-label="Cancel voice recording"
            >
              <X size={18} />
            </button>
          ) : collapseTools ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setToolsMenu((open) => (open ? null : { x: rect.left, y: rect.top - 4 }));
              }}
              className={cx(
                "ml-1",
                COMPOSER_TOOL_BUTTON_CLASS,
                extraTool?.active ? "text-accent hover:text-accent-hover" : "text-text-muted hover:text-text-primary",
              )}
              title="More tools"
              aria-label="More tools"
              aria-haspopup="menu"
              aria-expanded={Boolean(toolsMenu)}
            >
              <MoreHorizontal size={18} />
            </button>
          ) : (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className={cx("ml-1", COMPOSER_TOOL_BUTTON_CLASS, "text-text-muted hover:text-text-primary")}
                title="Attach file"
                aria-label="Attach file"
                type="button"
              >
                <Paperclip size={18} />
              </button>
              {extraTool && (
                <button
                  type="button"
                  onClick={extraTool.onSelect}
                  disabled={extraTool.disabled}
                  aria-pressed={extraTool.active}
                  title={extraTool.title}
                  aria-label={extraTool.label}
                  className={cx(
                    COMPOSER_TOOL_BUTTON_CLASS,
                    extraTool.active ? "text-accent hover:text-accent-hover" : "text-text-muted hover:text-text-primary disabled:text-text-faint/60",
                  )}
                >
                  {extraTool.icon}
                </button>
              )}
              {showVoiceButton && (
                <button
                  onClick={toggleVoiceRecording}
                  disabled={voiceUi.buttonDisabled}
                  className={cx(
                    COMPOSER_TOOL_BUTTON_CLASS,
                    voice.phase === "recording"
                      ? "text-error hover:text-error-hover"
                      : "text-text-muted hover:text-text-primary disabled:text-text-faint/60",
                  )}
                  title={voiceUi.buttonTitle}
                  aria-label={voiceUi.buttonTitle}
                  type="button"
                >
                  {voiceUi.buttonState === "spinner" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : voiceUi.buttonState === "stop" ? (
                    <Square size={16} fill="currentColor" />
                  ) : (
                    <Mic size={18} />
                  )}
                </button>
              )}
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onBlur={() => { composingRef.current = false; }}
            onPaste={handlePaste}
            enterKeyHint="enter"
            placeholder={placeholder}
            rows={1}
            className={cx(
              "min-h-[48px] max-h-[200px] flex-1 resize-none bg-transparent py-3 pl-1 pr-2 text-base leading-6 text-text-primary placeholder:text-text-faint focus:outline-none md:text-sm",
              recordingView && "hidden",
            )}
          />
          {recordingView && (
            <div className={cx("flex h-12 min-w-0 flex-1 items-center gap-2 pl-1 pr-2", DS.motion.reveal)}>
              <div className="h-8 min-w-0 flex-1">
                <VoiceRecordingWave getLevel={voice.getLevel} live={voice.phase === "recording"} />
              </div>
              {voiceUi.limitNotice && (
                <span className="shrink-0 text-xs font-medium text-accent" aria-hidden="true">{voiceUi.limitNotice}</span>
              )}
              {voiceUi.recordingClock && (
                <span className="shrink-0 text-xs tabular-nums text-text-muted" aria-hidden="true">{voiceUi.recordingClock}</span>
              )}
            </div>
          )}
          {recordingView ? (
            <div className="mr-1 flex-shrink-0 md:mr-2">
              <button
                ref={finishRecordingRef}
                type="button"
                onClick={() => stopVoiceRecordingRef.current()}
                disabled={voice.phase !== "recording"}
                className={cx(
                  "flex h-10 w-10 items-center justify-center rounded-full transition-colors md:h-8 md:w-8",
                  DS.focus,
                  voice.phase === "recording" ? DS.button.variant.primary : "cursor-not-allowed bg-bg-hover text-text-faint",
                )}
                title={voiceUi.buttonTitle}
                aria-label={voiceUi.buttonTitle}
              >
                {voice.phase !== "recording" ? (
                  <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
                ) : canAutoSendStoppedRecording ? (
                  <ArrowUp size={17} strokeWidth={2.25} />
                ) : (
                  <Check size={17} strokeWidth={2.5} />
                )}
              </button>
            </div>
          ) : (
          <>
          {showAutopilotToggle && (
            <button
              type="button"
              onClick={() => {
                haptic("selection");
                chooseSendMode(autopilotNext ? "interactive" : "autopilot");
              }}
              aria-pressed={autopilotNext}
              aria-label="Autopilot"
              title={autopilotNext
                ? "Autopilot is on for this message: Copilot keeps going until the task is done. Click to turn it off."
                : "Turn on Autopilot for this message: Copilot keeps going on its own until the task is done"}
              data-autopilot-toggle={autopilotNext ? "on" : "off"}
              className={cx(
                "mb-1 flex h-10 flex-shrink-0 items-center justify-center gap-1.5 rounded-full transition-colors md:mb-2 md:h-8",
                DS.focus,
                autopilotNext
                  ? "px-2.5 text-agent hover:bg-bg-hover/60"
                  : "w-10 text-text-muted hover:text-text-primary md:w-8",
              )}
            >
              <AutopilotIcon size={17} />
              {autopilotNext && <span className="hidden text-xs font-medium sm:inline">Autopilot</span>}
            </button>
          )}
          <div
            className={`mb-1 mr-1 flex-shrink-0 select-none touch-manipulation md:mb-2 md:mr-2 ${isSendModeMenuTarget("send-mode") ? "scale-[0.97]" : ""}`}
            style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
            onClick={modeMenuBindings.onClick}
            onContextMenu={modeMenuEnabled ? modeMenuBindings.onContextMenu : undefined}
            onTouchStart={modeMenuEnabled ? modeMenuBindings.onTouchStart : undefined}
            onTouchMove={modeMenuEnabled ? modeMenuBindings.onTouchMove : undefined}
            onTouchEnd={modeMenuEnabled ? modeMenuBindings.onTouchEnd : undefined}
            onTouchCancel={modeMenuEnabled ? modeMenuBindings.onTouchCancel : undefined}
          >
            <button
              aria-disabled={!showAbortControl && !canSend}
              aria-haspopup={modeMenuEnabled ? "menu" : undefined}
              aria-expanded={modeMenuEnabled ? Boolean(sendModeMenu) : undefined}
              tabIndex={!showAbortControl && !canSend ? -1 : undefined}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors md:h-8 md:w-8 ${DS.focus} ${
                showAbortControl || canSend
                  ? DS.button.variant.primary
                  : "cursor-not-allowed bg-bg-hover text-text-faint"
              }`}
              title={submitControlTitle}
              aria-label={submitControlTitle}
              type="button"
            >
              {showAbortControl ? (
                <Square size={11} fill="currentColor" />
              ) : (
                <ArrowUp size={17} strokeWidth={2.25} />
              )}
            </button>
          </div>
          </>
          )}
          </div>
        </div>
        {toolsMenu && collapseTools && !recordingView && (
          <ContextMenu position={toolsMenu} placement="above" onClose={() => setToolsMenu(null)}>
            <CtxItem
              icon={<Paperclip size={16} aria-hidden="true" />}
              label="Attach file"
              onClick={() => {
                setToolsMenu(null);
                fileInputRef.current?.click();
              }}
            />
            {extraTool && (
              <CtxItem
                icon={<span className={cx("flex size-4 items-center justify-center [&>svg]:size-4", extraTool.active && "text-accent")} aria-hidden="true">{extraTool.icon}</span>}
                label={extraTool.label}
                title={extraTool.title}
                disabled={extraTool.disabled}
                onClick={() => {
                  setToolsMenu(null);
                  extraTool.onSelect();
                }}
              />
            )}
            {showVoiceButton && (
              <CtxItem
                icon={<Mic size={16} aria-hidden="true" />}
                label="Voice message"
                title={voiceUi.buttonTitle}
                disabled={voiceUi.buttonDisabled}
                onClick={() => {
                  setToolsMenu(null);
                  toggleVoiceRecording();
                }}
              />
            )}
          </ContextMenu>
        )}
        {sendModeMenu && (
          <ContextMenu position={sendModeMenu} onClose={closeSendModeMenu}>
            <div className="px-3 py-2 text-xs text-text-muted">
              Send options
            </div>
            <CtxDivider />
            <CtxItem
              icon={<span className="h-[14px] w-[14px]" aria-hidden="true" />}
              label="Send with Autopilot"
              onClick={() => handleMenuSend("autopilot")}
              disabled={!canSend}
              title="Let Copilot continue until task complete, error, stop, or limit."
            />
          </ContextMenu>
        )}
      </div>
    </div>
  );
}

/** True when the focused control has been removed, leaving keyboard focus nowhere useful. */
function focusWasDropped(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}
