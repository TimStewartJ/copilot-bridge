import { useCallback, useEffect, useState } from "react";
import { Loader2, Mic, RotateCw } from "lucide-react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../../api";
import { SettingsSection } from "./SettingsSection";

const REQUIRED_ENV_VARS = [
  "BRIDGE_TRANSCRIPTION_PROVIDER=whisper.cpp",
  "BRIDGE_WHISPER_CPP_COMMAND=/path/to/whisper-cli",
  "BRIDGE_WHISPER_CPP_MODEL=/path/to/ggml-model.bin",
];

export function VoiceInputSection() {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await fetchTranscriptionStatus();
      setStatus(nextStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const badgeText = loading
    ? "Checking…"
    : status?.available
      ? "Available"
      : status
        ? "Unavailable"
        : "Unknown";

  const badgeClassName = loading
    ? "bg-bg-surface text-text-muted"
    : status?.available
      ? "bg-success/15 text-success"
      : "bg-bg-surface text-text-secondary";

  return (
    <SettingsSection
      title="Voice Input"
      description="Server-side transcription for the chat composer. Backend paths and GPU flags are configured via environment variables, not this UI."
      action={(
        <button
          onClick={() => void refresh()}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <Mic size={15} />
              Transcription backend
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Status is read from <code>/api/transcribe/status</code>. Changes to transcription config require a Bridge restart.
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClassName}`}>
            {badgeText}
          </span>
        </div>

        {status && (
          <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2">
            <div>
              <span className="text-text-faint">provider:</span>{" "}
              <code className="text-text-secondary">{status.provider}</code>
            </div>
            <div>
              <span className="text-text-faint">max duration:</span>{" "}
              <code className="text-text-secondary">{status.maxDurationSeconds}s</code>
            </div>
            <div className="md:col-span-2">
              <span className="text-text-faint">label:</span>{" "}
              <code className="text-text-secondary">{status.label}</code>
            </div>
            {status.reason && (
              <div className="md:col-span-2">
                <span className="text-text-faint">reason:</span>{" "}
                <span className="text-text-secondary">{status.reason}</span>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            Status check failed: {error}
          </div>
        )}

        <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
          Voice input is intentionally configured at the host level so command paths, model files, and GPU flags are not editable from the app. Set the environment variables below in <code>.env</code> or the process environment, then restart the Bridge.
        </div>

        <pre className="overflow-x-auto rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
          <code>{REQUIRED_ENV_VARS.join("\n")}</code>
        </pre>
      </div>
    </SettingsSection>
  );
}
