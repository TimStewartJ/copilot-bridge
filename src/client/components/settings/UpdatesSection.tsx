import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, RotateCw, ShieldCheck } from "lucide-react";
import {
  fetchUpdateInstallStatus,
  fetchUpdateStatus,
  installUpdate,
  type UpdateChannel,
  type UpdateCheckResponse,
  type UpdateCheckStatus,
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

export function UpdatesSection() {
  const [channel, setChannel] = useState<UpdateChannel>("stable");
  const [status, setStatus] = useState<UpdateCheckResponse | null>(null);
  const [installStatus, setInstallStatus] = useState<UpdateInstallStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((selectedChannel = channel) => {
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
  }, [channel]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    void fetchUpdateInstallStatus()
      .then((value) => setInstallStatus(value.status))
      .catch(() => {});
  }, []);

  const handleInstall = useCallback(() => {
    if (!status?.update) return;
    const confirmed = window.confirm(`Install Copilot Bridge ${status.update.version} and restart now?`);
    if (!confirmed) return;
    setInstalling(true);
    setError(null);
    void installUpdate(channel)
      .then((value) => {
        setInstallStatus(value.install);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setInstalling(false));
  }, [channel, status?.update]);

  const statusTone = status?.status === "update_available"
    ? "text-accent"
    : status?.status === "error"
      ? "text-error"
      : status?.status === "not_configured" || status?.status === "disabled"
        ? "text-warning"
        : "text-success";

  return (
    <SettingsSection
      title="Updates"
      description="Check signed stable or preview release manifests, then install a verified update with a restart."
      action={(
        <button
          type="button"
          onClick={() => refresh(channel)}
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

          <label className="flex items-center gap-2 text-xs text-text-muted">
            Channel
            <select
              value={channel}
              onChange={(event) => {
                const next = event.target.value as UpdateChannel;
                setChannel(next);
                refresh(next);
              }}
              className="rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
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
                disabled={installing}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:opacity-90 disabled:opacity-60"
              >
                {installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                Install and restart
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
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
            <div className="font-medium text-text-secondary">
              Last install: {installStatus.phase} - {installStatus.fromVersion} to {installStatus.toVersion}
            </div>
            <div className="mt-1">
              Updated {formatDate(installStatus.updatedAt)}
              {installStatus.error ? ` - ${installStatus.error}` : ""}
            </div>
            {installStatus.logPath && (
              <div className="mt-1 text-text-faint">Log: {installStatus.logPath}</div>
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
