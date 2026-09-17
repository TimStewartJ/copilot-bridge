import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AudioLines, Check, Cpu, Download, Loader2, Mic, RotateCw } from "lucide-react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../../api";
import { fetchVoiceStatus, startVoiceInstall, type VoiceEngineCapability, type VoiceInstallStatus, type VoiceStatus } from "../../voice/voice-api";
import { formatBytes } from "../../voice/voice-view-model";
import { SettingsSection } from "./SettingsSection";

const CAPABILITY_NAMES: Record<VoiceEngineCapability, string> = {
  asr: "speech recognition",
  turn: "turn detection",
  tts: "voice",
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function describeInstallBadge(install: VoiceInstallStatus): { text: string; className: string } {
  if (!install.supported) return { text: "Unsupported", className: "bg-bg-surface text-text-secondary" };
  if (install.installing) {
    return { text: `Installing ${Math.round((install.progress?.overallFraction ?? 0) * 100)}%`, className: "bg-accent-surface text-accent" };
  }
  if (install.installed) return { text: "Installed", className: "bg-success/15 text-success" };
  if (install.error) return { text: "Setup failed", className: "bg-error/10 text-error" };
  return { text: "Not installed", className: "bg-bg-surface text-text-secondary" };
}

export function describeEngineState(engine: VoiceStatus["engine"]): string {
  switch (engine.state) {
    case "starting":
      return `${engine.detail ?? "Starting"}…`;
    case "ready": {
      const loaded = (engine.loaded ?? []).map((capability) => CAPABILITY_NAMES[capability]);
      return loaded.length > 0 ? `Running with ${joinNames(loaded)} loaded.` : "Running.";
    }
    case "failed":
      return `Stopped unexpectedly${engine.detail ? ` (${engine.detail})` : ""}. It restarts the next time it's needed.`;
    default:
      return "Not running. It starts when you use the chat mic or Voice mode, loads only the models that feature needs, and exits after 10 idle minutes.";
  }
}

const PHASE_LABELS = { downloading: "Downloading", verifying: "Verifying", extracting: "Unpacking" } as const;

export function SpeechEngineSection() {
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [micStatus, setMicStatus] = useState<TranscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingInstall, setStartingInstall] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextVoice, nextMic] = await Promise.all([fetchVoiceStatus(), fetchTranscriptionStatus()]);
      setVoiceStatus(nextVoice);
      setMicStatus(nextMic);
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

  const installing = !!voiceStatus?.install.installing;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(timer);
  }, [installing, refresh]);

  const install = useCallback(async () => {
    setStartingInstall(true);
    setError(null);
    try {
      await startVoiceInstall();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingInstall(false);
      await refresh();
    }
  }, [refresh]);

  const installStatus = voiceStatus?.install;
  const badge = installStatus ? describeInstallBadge(installStatus) : { text: loading ? "Checking…" : "Unknown", className: "bg-bg-surface text-text-muted" };
  const progress = installStatus?.installing ? installStatus.progress : undefined;
  const assets = installStatus?.assets ?? [];

  return (
    <SettingsSection
      title="Speech engine"
      description="Local speech recognition and voices for the chat mic and Voice mode. Audio never leaves the computer hosting Bridge; only text reaches your Copilot model."
      action={(
        <button
          type="button"
          onClick={() => void refresh()}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <AudioLines size={15} />
              Parakeet v3 · Smart Turn · Kokoro
            </div>
            <p className="mt-1 text-xs text-text-muted">
              One install powers both features: speech detection, end-of-turn detection, speech recognition and voices, all running on the CPU.
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}>
            {badge.text}
          </span>
        </div>

        {installStatus && !installStatus.supported && (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
            The speech engine isn&apos;t available for this host ({installStatus.target}). It supports Windows x64, Linux x64 and Arm64, and Apple Silicon Macs.
          </div>
        )}

        {progress && (
          <div>
            <div className="flex justify-between gap-3 text-xs text-text-muted">
              <span className="truncate">{PHASE_LABELS[progress.phase]} {progress.label}</span>
              <span className="tabular-nums">{Math.round(progress.overallFraction * 100)}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-surface">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, progress.overallFraction * 100)}%` }} />
            </div>
          </div>
        )}

        {installStatus?.supported && !installStatus.installed && !installStatus.installing && (
          <button
            type="button"
            onClick={() => void install()}
            disabled={startingInstall}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60"
          >
            {startingInstall ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {installStatus.error ? "Retry setup" : "Download and set up"} ({formatBytes(installStatus.remainingBytes || installStatus.totalBytes)})
          </button>
        )}

        {installStatus?.error && !installStatus.installing && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            Setup failed: {installStatus.error}
          </div>
        )}

        {voiceStatus && (
          <div className="grid gap-2 text-xs md:grid-cols-2">
            <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
              <div className="flex items-center gap-1.5 font-medium text-text-secondary"><Mic size={12} /> Chat mic</div>
              <p className="mt-1 text-text-muted">
                {micStatus?.available
                  ? `Ready. Recordings up to ${micStatus.maxDurationSeconds} seconds are transcribed on this computer.`
                  : micStatus?.reason ?? "Unavailable."}
              </p>
            </div>
            <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
              <div className="flex items-center gap-1.5 font-medium text-text-secondary"><AudioLines size={12} /> Voice mode</div>
              <p className="mt-1 text-text-muted">
                {installStatus?.installed ? "Ready for hands-free conversations." : "Available once the speech engine is installed."}
              </p>
              {installStatus?.installed && (
                <Link to="/voice" className="mt-1.5 inline-flex items-center gap-1 text-accent hover:underline">
                  Open voice mode
                </Link>
              )}
            </div>
            <div className="rounded-md border border-border bg-bg-primary px-3 py-2 md:col-span-2">
              <div className="flex items-center gap-1.5 font-medium text-text-secondary"><Cpu size={12} /> Engine</div>
              <p className="mt-1 text-text-muted">{describeEngineState(voiceStatus.engine)}</p>
            </div>
          </div>
        )}

        {assets.length > 0 && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-faint">Components</div>
            <ul className="mt-1.5 divide-y divide-border rounded-md border border-border bg-bg-primary text-xs">
              {assets.map((asset) => (
                <li key={asset.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 truncate text-text-secondary">{asset.label}</span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-text-muted">
                    {formatBytes(asset.sizeBytes)}
                    {asset.installed
                      ? <Check size={12} className="text-success" aria-label="Installed" />
                      : <span className="text-text-faint">not installed</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
