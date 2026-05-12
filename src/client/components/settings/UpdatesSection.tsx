import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, RotateCw, ShieldCheck } from "lucide-react";
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
  stopping: {
    label: "Stopping Bridge",
    description: "The updater is stopping the current Bridge process before replacing app files.",
  },
  installing: {
    label: "Copying app files",
    description: "Bridge is backing up the old app and copying the new app into place.",
  },
  starting: {
    label: "Starting Bridge",
    description: "The updated app is starting and waiting for the health check.",
  },
  succeeded: {
    label: "Update complete",
    description: "Bridge restarted with the updated package.",
  },
  failed: {
    label: "Update failed",
    description: "Bridge kept user data and attempted to restore the previous app.",
  },
  rollback_failed: {
    label: "Rollback needs attention",
    description: "The update failed and the automatic rollback did not finish cleanly.",
  },
};

const TERMINAL_INSTALL_PHASES = new Set<UpdateInstallPhase>(["succeeded", "failed", "rollback_failed"]);

export function UpdatesSection() {
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
  const installTone = !installStatus
    ? "border-border bg-bg-primary text-text-muted"
    : installStatus.phase === "succeeded"
      ? "border-success/30 bg-success/10 text-success"
      : installStatus.phase === "failed" || installStatus.phase === "rollback_failed"
        ? "border-error/30 bg-error/10 text-error"
        : "border-accent/30 bg-accent/10 text-accent";

  const statusTone = status?.status === "update_available"
    ? "text-accent"
    : status?.status === "error"
      ? "text-error"
      : status?.status === "not_configured" || status?.status === "disabled"
        ? "text-warning"
        : "text-success";
  const channelSelectionDisabled = activeInstall || status?.status === "disabled";

  return (
    <SettingsSection
      title="Updates"
      description="Check signed stable or preview release manifests, then install a verified update with a restart."
      action={(
        <button
          type="button"
          onClick={() => refresh(selectedChannel)}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <ShieldCheck size={15} />
              Signed update manifests
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Current: {status?.current.version ?? "unknown"} on {status?.current.channel ?? "unknown"} for {status?.current.platform ?? "unknown"}
            </p>
          </div>

          <label className={`flex items-center gap-2 text-xs ${channelSelectionDisabled ? "cursor-not-allowed text-text-faint" : "text-text-muted"}`}>
            Channel
            <select
              value={selectedChannel}
              disabled={channelSelectionDisabled}
              onChange={(event) => {
                const next = event.target.value as UpdateChannel;
                setChannel(next);
                refresh(next);
              }}
              className="rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="stable">stable</option>
              <option value="preview">preview</option>
            </select>
          </label>
        </div>

        <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className={`text-sm font-medium ${statusTone}`}>
              {loading ? "Checking..." : status ? STATUS_LABELS[status.status] : "Unknown"}
            </div>
            {status?.checkedAt && (
              <div className="text-[11px] text-text-faint">
                Checked {formatDate(status.checkedAt)}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">
            {error ?? status?.error ?? describeStatus(status)}
          </p>
        </div>

        {status?.update && (
          <div className="rounded-md border border-accent/30 bg-accent/10 p-3">
            <div className="text-sm font-medium text-accent">
              {status.update.version} is available
            </div>
            <div className="mt-1 text-xs text-text-muted">
              Published {formatDate(status.update.publishedAt)} from {status.update.sourceCommit.slice(0, 12)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleInstall}
                disabled={installing || activeInstall}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:opacity-90 disabled:opacity-60"
              >
                {installing || activeInstall ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                {activeInstall ? "Install in progress" : "Install and restart"}
              </button>
              {status.update.releaseNotesUrl && (
                <a
                  href={status.update.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  Release notes
                  <ExternalLink size={11} />
                </a>
              )}
              <a
                href={status.update.package.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
              >
                Download package
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        )}

        {installStatus && (
          <div className={`rounded-md border px-3 py-3 text-xs ${installTone}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                {activeInstall && <Loader2 size={13} className="animate-spin" />}
                {installCopy?.label ?? installStatus.phase}
              </div>
              <div className="text-[11px] text-text-faint">
                {installStatus.fromVersion} to {installStatus.toVersion}
              </div>
            </div>
            <p className="mt-1 text-text-muted">
              {installStatus.error ?? installStatus.message ?? installCopy?.description}
            </p>
            <div className="mt-2 grid gap-1 text-[11px] text-text-faint sm:grid-cols-3">
              <div>Phase: {installStatus.phase}</div>
              <div>Elapsed: {formatElapsed(installStatus.startedAt, installStatus.completedAt)}</div>
              <div>Updated: {formatDate(installStatus.updatedAt)}</div>
            </div>
            {installStatus.logPath && (
              <div className="mt-2 break-all text-[11px] text-text-faint">Log: {installStatus.logPath}</div>
            )}
            {installLogTail.length > 0 && (
              <details className="mt-2 rounded-md border border-border/70 bg-bg-elevated/70 px-2 py-1 text-text-muted">
                <summary className="cursor-pointer text-[11px] font-medium text-text-secondary">
                  Recent update log
                </summary>
                <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-muted">
                  {installLogTail.join("\n")}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function describeStatus(status: UpdateCheckResponse | null): string {
  if (!status) return "Update status has not been checked yet.";
  if (status.status === "disabled") return "Update checks are available only in packaged release mode.";
  if (status.status === "not_configured") return "Configure a trusted update manifest public key and manifest URL to enable checks.";
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
