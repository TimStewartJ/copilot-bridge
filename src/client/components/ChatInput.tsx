import { useState, useRef, useCallback, useEffect } from "react";
import { Square, Paperclip, FileText, X, Loader2, Mic, SendHorizontal } from "lucide-react";
import type { BlobAttachment, Attachment } from "../api";
import { uploadFile } from "../api";
import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import { useVoiceInput } from "../hooks/useVoiceInput";
import {
  canAutoSendVoiceTranscript,
  resolveVoiceSubmitMode,
  resolveVoiceSubmitModeAfterRecording,
  type VoiceSubmitMode,
} from "../lib/voice-submit-mode";
import { isDraftComposerKey } from "../lib/composer-key";
import {
  shouldClearAcceptedFlashHandoff,
  shouldFlashAcceptedHandoff,
  shouldFlashAcceptedStatus,
  shouldKeepAcceptedFlash,
  updateAcceptedFlashHandoff,
} from "../lib/voice-accepted-flash";
import { deriveVoiceUiState } from "../lib/voice-ui-state";
import type { Draft } from "../useDrafts";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

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
  onSend: (text: string, attachments?: Attachment[]) => void;
  onAbort?: () => void;
  composerKey: string;
  sessionId?: string | null;
  isDraft?: boolean;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: Attachment[]) => void;
  voiceJob?: VoiceBackgroundJob | null;
  onSubmitVoiceCapture: (capture: { composerKey: string; audio: Blob; submitMode: VoiceSubmitMode }) => Promise<void>;
  onReviewVoiceJob?: (composerKey: string) => void;
  onClearVoiceJobError?: (composerKey: string) => void;
  onRetryVoiceJobUpload?: (composerKey: string) => void;
  /** When true, input is visible but send is disabled (e.g., session warming up) */
  disabled?: boolean;
  disabledHint?: string;
}

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
  disabled,
  disabledHint,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHeightRef = useRef(0);
  const inputRef = useRef(input);
  const attachmentsRef = useRef<Attachment[]>(attachments);
  const uploadingRef = useRef(uploading);
  const sendBlockedRef = useRef(Boolean(disabled || onAbort));
  const restoredForRef = useRef<string | null>(null);
  const recordingStartModeRef = useRef<VoiceSubmitMode | null>(null);
  const pendingCaptureSubmitModeRef = useRef<VoiceSubmitMode | null>(null);
  const acceptedFlashJobIdRef = useRef<string | null>(null);
  const acceptedFlashTimerRef = useRef<number | null>(null);
  const previousComposerKeyRef = useRef<string | null>(composerKey);
  const pendingAcceptedHandoffRef = useRef<{ originComposerKey: string; targetComposerKey: string } | null>(null);
  const previousVoiceJobRef = useRef<VoiceBackgroundJob | null>(null);
  const [recordingStartMode, setRecordingStartMode] = useState<VoiceSubmitMode | null>(null);
  const [showAcceptedConfirmation, setShowAcceptedConfirmation] = useState(false);

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
  }, [disabled, onAbort]);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 200);
    lastHeightRef.current = next;
    el.style.height = `${next}px`;
  }, []);

  const updateDraft = useCallback((value: string, nextAttachments = attachmentsRef.current) => {
    onDraftChange?.(value, nextAttachments);
  }, [onDraftChange]);

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

  const activeVoiceJob = voiceJob && (
    voiceJob.status === "uploading"
    || voiceJob.status === "accepted"
    || voiceJob.status === "transcribing"
    || voiceJob.status === "sending"
  )
    ? voiceJob
    : null;
  const voiceJobError = voiceJob?.status === "error" ? voiceJob.error ?? null : null;
  const canRetryVoiceJobUpload =
    voiceJob?.status === "error"
    && voiceJob.retryable === true
    && !!onRetryVoiceJobUpload;

  const voice = useVoiceInput({
    contextKey: composerKey,
    onAudioCaptured: async ({ audio, contextKey }) => {
      const submitMode = contextKey === composerKey
        ? (pendingCaptureSubmitModeRef.current ?? "insert")
        : "insert";
      pendingCaptureSubmitModeRef.current = null;
      await onSubmitVoiceCapture({ composerKey: contextKey, audio, submitMode });
    },
  });

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
    }
  }, [activeVoiceJob, updateRecordingStartMode, voice.phase]);

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
    if (composerKey && window.matchMedia("(pointer: fine)").matches) {
      textareaRef.current?.focus();
    }
  }, [composerKey]);

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
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      void addFiles(files);
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
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

  const handleSend = useCallback(() => {
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

    onClearVoiceJobError?.(composerKey);
    onSend(text || "(attachment)", cleanAttachments.length > 0 ? cleanAttachments : undefined);
    clearComposer();

    if (textareaRef.current && !window.matchMedia("(pointer: fine)").matches) {
      textareaRef.current.blur();
    }
  }, [clearComposer, composerKey, disabled, manualSendBlockedByVoiceJob, onClearVoiceJobError, onSend, uploading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

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
  });
  const voiceMessageClassName = voiceUi.tone === "error"
    ? "text-error"
    : voiceUi.tone === "success"
      ? "text-success"
    : voiceUi.tone === "accent"
      ? "text-accent"
      : "text-text-faint";

  return (
    <div className="p-3 md:p-4 border-t border-border bg-bg-secondary">
      {uploading > 0 && (
        <div className="flex items-center gap-1 text-xs text-text-faint mb-1">
          <Loader2 size={12} className="animate-spin" />
          Uploading…
        </div>
      )}

      {voiceUi.message && (
        <div
          className={`mb-2 flex flex-wrap items-center gap-x-1 text-xs ${voiceMessageClassName}`}
        >
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {voiceUi.message}
          </span>
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
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att, i) => (
            <div key={i} className="relative group">
              {att.type === "blob" && att.mimeType.startsWith("image/") ? (
                <img
                  src={`data:${att.mimeType};base64,${att.data}`}
                  alt={att.displayName ?? "attachment"}
                  className="h-16 w-16 object-cover rounded-md border border-border"
                />
              ) : att.type === "uploaded" && att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.displayName ?? "attachment"}
                  className="h-16 w-16 object-cover rounded-md border border-border"
                />
              ) : (
                <div className="h-16 px-3 flex items-center gap-2 rounded-md border border-border bg-bg-elevated text-text-secondary text-xs max-w-[180px]">
                  <FileText size={16} className="flex-shrink-0 text-text-faint" />
                  <span className="truncate">{att.displayName ?? "file"}</span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(i)}
                className="absolute -top-1.5 -right-1.5 bg-bg-primary border border-border rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary hover:text-error"
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 md:gap-3">
        <div
          className="flex-1 flex items-center gap-1 bg-bg-primary border border-border rounded-md focus-within:border-accent"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            className="h-12 px-3 text-text-faint hover:text-text-secondary transition-colors flex flex-shrink-0 items-center justify-center"
            title="Attach file"
            type="button"
          >
            <Paperclip size={18} />
          </button>
          {voiceUi.showButton && (
            <button
              onClick={() => {
                if (voice.phase === "recording") {
                  pendingCaptureSubmitModeRef.current = resolveVoiceSubmitModeAfterRecording(recordingStartModeRef.current, {
                    text: inputRef.current,
                    attachmentCount: attachmentsRef.current.length,
                    sendBlocked: sendBlockedRef.current,
                    uploadingCount: uploadingRef.current,
                  });
                  void voice.stopRecording();
                } else {
                  onClearVoiceJobError?.(composerKey);
                  updateRecordingStartMode(resolveVoiceSubmitMode({
                    text: inputRef.current,
                    attachmentCount: attachmentsRef.current.length,
                    sendBlocked: sendBlockedRef.current,
                    uploadingCount: uploadingRef.current,
                  }));
                  pendingCaptureSubmitModeRef.current = null;
                  void voice.startRecording();
                }
              }}
              disabled={voiceUi.buttonDisabled}
              className={`h-12 px-3 transition-colors flex flex-shrink-0 items-center justify-center ${
                voice.phase === "recording"
                  ? "text-error hover:text-error-hover"
                  : "text-text-faint hover:text-text-secondary disabled:text-text-faint/60"
              }`}
              title={voiceUi.buttonTitle}
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
            onPaste={handlePaste}
            placeholder="Type a message, use the mic, or attach a file..."
            rows={1}
            className="flex-1 py-3 pr-3 bg-transparent text-text-primary text-base md:text-sm leading-6 resize-none focus:outline-none min-h-[48px] max-h-[200px] placeholder:text-text-faint"
          />
        </div>
        {onAbort ? (
          <button
            onClick={onAbort}
            className="p-3 bg-error hover:bg-error-hover text-white rounded-md self-center transition-colors flex items-center justify-center"
            title="Stop generating"
            type="button"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="h-10 w-10 rounded-md text-text-secondary hover:bg-bg-elevated hover:text-text-primary disabled:text-text-faint disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-faint self-center transition-colors flex items-center justify-center"
            title={disabled ? (disabledHint ?? "Warming up…") : "Send message"}
            aria-label={disabled ? (disabledHint ?? "Warming up…") : "Send message"}
            type="button"
          >
            <SendHorizontal size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
