import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AudioLines, Check, Cpu, Download, Loader2, Mic, RotateCw } from "lucide-react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../../api";
import { describeRecordingLimit } from "../../lib/voice-ui-state";
import { fetchVoiceStatus, startVoiceInstall, type VoiceEngineCapability, type VoiceInstallStatus, type VoiceStatus } from "../../voice/voice-api";
import { formatBytes } from "../../voice/voice-view-model";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Button, Details, Notice, SettingList, SettingRow } from "../../design/primitives";

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
    return { text: `Installing ${Math.round((install.progress?.overallFraction ?? 0) * 100)}%`, className: "text-accent" };
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
      return "Not running. It starts when you use the chat mic or Helm's hands-free mode, loads only the models that feature needs, and exits after 10 idle minutes.";
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
      description="Runs on this computer. Audio never leaves it; only text reaches your model."
      action={(
        <Button size="sm" variant="ghost" onClick={() => void refresh()}
          icon={loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}>
          Refresh
        </Button>
      )}
    >
      <SettingList>
        <SettingRow
          label="Parakeet v3 · Smart Turn · Kokoro"
          hint="Speech detection, end of turn, recognition and voices, on the CPU."
          control={<span className={cx("text-xs font-medium", badge.text === "Setup failed" ? "text-error" : "text-text-secondary")}>{badge.text}</span>}
        >
          {installStatus && !installStatus.supported && (
            <p className={DS.field.help}>
              The speech engine isn&apos;t available for this host ({installStatus.target}). It supports Windows x64, Linux x64 and Arm64, and Apple Silicon Macs.
            </p>
          )}
          {progress && (
            <div>
              <div className="flex justify-between gap-3 text-xs text-text-secondary">
                <span className="truncate">{PHASE_LABELS[progress.phase]} {progress.label}</span>
                <span className="tabular-nums">{Math.round(progress.overallFraction * 100)}%</span>
              </div>
              <div className={cx(DS.meter.track, "mt-1.5")}>
                <div className={cx(DS.meter.fill, "transition-[width] duration-500")} style={{ width: `${Math.max(2, progress.overallFraction * 100)}%` }} />
              </div>
            </div>
          )}
          {installStatus?.supported && !installStatus.installed && !installStatus.installing && (
            <Button size="sm" variant="primary" onClick={() => void install()} disabled={startingInstall}
              icon={startingInstall ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}>
              {installStatus.error ? "Retry setup" : "Download and set up"} ({formatBytes(installStatus.remainingBytes || installStatus.totalBytes)})
            </Button>
          )}
          {installStatus?.error && !installStatus.installing && (
            <p className="mt-2 break-words text-xs text-error">Setup failed: {installStatus.error}</p>
          )}
        </SettingRow>

        {voiceStatus && (
          <>
            <SettingRow
              label={<span className="inline-flex items-center gap-1.5"><Mic size={13} className="text-text-secondary" />Chat mic</span>}
              hint={micStatus?.available
                ? `Ready. Recordings up to ${describeRecordingLimit(micStatus.maxDurationSeconds)} are transcribed on this computer.`
                : micStatus?.reason ?? "Unavailable."}
            />
            <SettingRow
              label={<span className="inline-flex items-center gap-1.5"><AudioLines size={13} className="text-text-secondary" />Hands-free (Helm)</span>}
              hint={installStatus?.installed ? "Ready for hands-free conversations." : "Available once the speech engine is installed."}
              control={installStatus?.installed ? (
                <Link to="/helm" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)}>Open Helm</Link>
              ) : undefined}
            />
            <SettingRow
              label={<span className="inline-flex items-center gap-1.5"><Cpu size={13} className="text-text-secondary" />Engine</span>}
              hint={describeEngineState(voiceStatus.engine)}
            />
          </>
        )}

        {assets.length > 0 && (
          <div className="py-3 last:pb-0">
            <Details label="Components" detail={`${assets.filter((asset) => asset.installed).length} of ${assets.length} installed`}>
              <ul className={cx(DS.surface.divided, "pt-1 text-xs")}>
                {assets.map((asset) => (
                  <li key={asset.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate text-text-secondary">{asset.label}</span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums text-text-secondary">
                      {formatBytes(asset.sizeBytes)}
                      {asset.installed
                        ? <Check size={12} className="text-text-secondary" aria-label="Installed" />
                        : <span className="text-text-faint">not installed</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Details>
          </div>
        )}
      </SettingList>

      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
    </SettingsSection>
  );
}
