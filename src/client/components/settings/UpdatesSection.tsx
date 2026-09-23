import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import {
  fetchUpdateInstallStatus,
  fetchUpdateStatus,
  installUpdate,
  type UpdateChannel,
  type UpdateCheckResponse,
  type UpdateCheckStatus,
  type UpdateInstallPhase,
  type UpdateInstallStatus,
} from "../../update-api";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, Details, SettingList, SettingRow } from "../../design/primitives";

const STATUS_LABELS: Record<UpdateCheckStatus, string> = {
  disabled: "Disabled",
  not_configured: "Not configured",
  error: "Check failed",
  up_to_date: "Up to date",
  update_available: "Update available",
};

const INSTALL_PHASE_COPY: Record<UpdateInstallPhase, { label: string; description: string }> = {
  started: {
    label: "Preparing update",
    description: "The verified updater is launching.",
  },
  downloading: {
    label: "Downloading package",
    description: "Bridge is downloading the signed release package.",
  },
  verifying: {
    label: "Verifying download",
    description: "Bridge is checking the package SHA256 from the signed manifest.",
  },
  staging: {
    label: "Extracting package",
    description: "Windows extraction is the quietest step and can take a while for many small files.",
  },
  staged: {
    label: "Restart queued",
    description: "The update candidate is staged and waiting for the launcher to activate it safely.",
  },
  succeeded: {
    label: "Update complete",
    description: "Bridge activated the staged release package.",
  },
  failed: {
    label: "Update failed",
    description: "Bridge kept the previous active release and did not activate the staged candidate.",
  },
};

const TERMINAL_INSTALL_PHASES = new Set<string>(["succeeded", "failed"]);
const FAILED_INSTALL_PHASES = new Set<string>(["failed"]);

export function UpdatesSection({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [status, setStatus] = useState<UpdateCheckResponse | null>(null);
  const [installStatus, setInstallStatus] = useState<UpdateInstallStatus | null>(null);
  const [installLogTail, setInstallLogTail] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installStatusRef = useRef<UpdateInstallStatus | null>(null);
  const refreshedCompletedInstallRef = useRef<string | null>(null);
  const selectedChannel = channel ?? status?.channel ?? "stable";

  const refresh = useCallback((selectedChannel?: UpdateChannel) => {
    setLoading(true);
    setError(null);
    void fetchUpdateStatus(selectedChannel)
      .then((value) => {
        setStatus(value);
        setChannel(value.channel);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshInstallStatus = useCallback((quiet = false) => {
    void fetchUpdateInstallStatus()
      .then((value) => {
        setInstallStatus(value.status);
        setInstallLogTail(value.logTail ?? []);
      })
      .catch((reason: unknown) => {
        if (quiet || isInstallActive(installStatusRef.current)) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshRef = useRef<() => void>(() => undefined);
  refreshRef.current = () => {
    refresh(selectedChannel);
    refreshInstallStatus(true);
  };
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refreshRef.current();
  }, [refreshSignal]);

  useEffect(() => {
    refreshInstallStatus(true);
  }, [refreshInstallStatus]);

  useEffect(() => {
    installStatusRef.current = installStatus;
  }, [installStatus]);

  useEffect(() => {
    if (!isInstallActive(installStatus)) return undefined;
    const timer = window.setInterval(() => refreshInstallStatus(true), 2000);
    return () => window.clearInterval(timer);
  }, [installStatus?.id, installStatus?.phase, refreshInstallStatus]);

  useEffect(() => {
    if (!installStatus || isInstallActive(installStatus)) return;
    if (refreshedCompletedInstallRef.current === installStatus.id) return;
    refreshedCompletedInstallRef.current = installStatus.id;
    refresh(selectedChannel);
  }, [installStatus, refresh, selectedChannel]);

  const handleInstall = useCallback(() => {
    if (!status?.update) return;
    const confirmed = window.confirm(`Install Copilot Bridge ${status.update.version} and restart now?`);
    if (!confirmed) return;
    setInstalling(true);
    setError(null);
    setInstallLogTail([]);
    void installUpdate(selectedChannel)
      .then((value) => {
        setInstallStatus(value.install);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setInstalling(false));
  }, [selectedChannel, status?.update]);

  const activeInstall = isInstallActive(installStatus);
  const installCopy = installStatus ? INSTALL_PHASE_COPY[installStatus.phase] : null;
  const installFailed = installStatus ? FAILED_INSTALL_PHASES.has(installStatus.phase) : false;
  const channelSelectionDisabled = activeInstall || status?.status === "disabled" || status?.status === "not_configured";
  const statusBadge = loading
    ? <span className={DS.field.help}>Checking…</span>
    : status?.status === "update_available"
      ? <span className={DS.text.attention}>{STATUS_LABELS.update_available}</span>
      : status?.status === "error" || error
        ? <Badge tone="danger">{STATUS_LABELS.error}</Badge>
        : <span className="text-xs text-text-secondary">{status ? STATUS_LABELS[status.status] : "Unknown"}</span>;

  return (
    <SettingsSection id="settings-system-updates" title="Release updates">
      <SettingList>
        <SettingRow
          label={`Version ${status?.current.version ?? "…"}${status ? ` · ${status.current.channel} · ${status.current.platform}` : ""}`}
          hint={(
            <>
              {error ?? status?.error ?? describeStatus(status)}
              {status?.checkedAt && <span className="text-text-faint"> · checked {formatDate(status.checkedAt)}</span>}
            </>
          )}
          control={(
            <>
              {statusBadge}
              {!channelSelectionDisabled && (
                <select
                  aria-label="Update channel"
                  value={selectedChannel}
                  onChange={(event) => {
                    const next = event.target.value as UpdateChannel;
                    setChannel(next);
                    refresh(next);
                  }}
                  className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.compactField)}
                >
                  <option value="stable">stable</option>
                  <option value="preview">preview</option>
                </select>
              )}
            </>
          )}
        >
          {status?.update && (
            <div className="space-y-2">
              <p className="text-[13px] text-text-primary">
                {status.update.version} is available
                <span className={DS.field.help}> · published {formatDate(status.update.publishedAt)} from {status.update.sourceCommit.slice(0, 12)}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={handleInstall} disabled={installing || activeInstall}
                  icon={installing || activeInstall ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}>
                  {activeInstall ? "Install in progress" : "Install and restart"}
                </Button>
                {status.update.releaseNotesUrl && (
                  <a href={status.update.releaseNotesUrl} target="_blank" rel="noreferrer"
                    className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1")}>
                    Release notes <ExternalLink size={11} />
                  </a>
                )}
                <a href={status.update.package.url} target="_blank" rel="noreferrer"
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1")}>
                  Download package <ExternalLink size={11} />
                </a>
              </div>
            </div>
          )}

          {installStatus && (
            <div className={cx(DS.surface.inset, "mt-2 px-3 py-2 text-xs")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className={cx("flex items-center gap-2 font-medium", installStatus.phase === "succeeded" ? "text-text-primary" : installFailed ? "text-error" : "text-text-primary")}>
                  {activeInstall && <Loader2 size={13} className="animate-spin" />}
                  {installCopy?.label ?? installStatus.phase}
                </div>
                <div className={DS.text.meta}>
                  {installStatus.fromVersion} to {installStatus.toVersion}
                </div>
              </div>
              <p className="mt-1 text-text-secondary">
                {installStatus.error ?? installStatus.message ?? installCopy?.description}
              </p>
              <p className={cx(DS.text.meta, "mt-1")}>
                Phase {installStatus.phase} · Elapsed {formatElapsed(installStatus.startedAt, installStatus.completedAt)} · Updated {formatDate(installStatus.updatedAt)}
              </p>
              {installStatus.logPath && (
                <p className={cx(DS.text.meta, "mt-1 break-all")}>Log: {installStatus.logPath}</p>
              )}
              {installLogTail.length > 0 && (
                <Details label="Recent update log" className="mt-1">
                  <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">
                    {installLogTail.join("\n")}
                  </pre>
                </Details>
              )}
            </div>
          )}
        </SettingRow>
      </SettingList>
    </SettingsSection>
  );
}

function describeStatus(status: UpdateCheckResponse | null): string {
  if (!status) return "Update status has not been checked yet.";
  if (status.status === "disabled") return "Update checks are available only in packaged release mode.";
  if (status.status === "not_configured") return "Signed release updates aren't configured here. A source checkout updates with Self-update.";
  if (status.status === "up_to_date") return `No newer ${status.channel} update was found.`;
  if (status.status === "update_available") return "A newer signed update manifest is available.";
  return "The update check failed.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function isInstallActive(status: UpdateInstallStatus | null | undefined): boolean {
  return Boolean(status && !TERMINAL_INSTALL_PHASES.has(status.phase));
}

function formatElapsed(startValue: string, endValue?: string): string {
  const startedAt = new Date(startValue).getTime();
  const endedAt = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return "unknown";
  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
