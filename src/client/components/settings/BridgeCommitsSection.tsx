import { useCallback, useEffect, useRef, useState } from "react";
import { GitCommitHorizontal, Loader2, RotateCw } from "lucide-react";
import {
  fetchBridgeCommitMetadata,
  fetchLauncherLogTail,
  type BridgeCommitMetadata,
  type BridgeCommitSnapshot,
  type LauncherLogTail,
} from "../../api";
import { SettingsSection } from "./SettingsSection";

const LAUNCHER_LOG_LINE_COUNT = 8;

export function BridgeCommitsSection() {
  const [commits, setCommits] = useState<BridgeCommitMetadata | null>(null);
  const [launcherLog, setLauncherLog] = useState<LauncherLogTail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (forceRefresh = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const [commitResult, launcherLogResult] = await Promise.allSettled([
        fetchBridgeCommitMetadata(forceRefresh),
        fetchLauncherLogTail(LAUNCHER_LOG_LINE_COUNT),
      ]);
      if (requestIdRef.current !== requestId) return;
      const nextErrors: string[] = [];

      if (commitResult.status === "fulfilled") {
        setCommits(commitResult.value);
      } else {
        nextErrors.push(`Commit status failed: ${formatRequestError(commitResult.reason)}`);
      }

      if (launcherLogResult.status === "fulfilled") {
        setLauncherLog(launcherLogResult.value);
      } else {
        nextErrors.push(`Launcher log failed: ${formatRequestError(launcherLogResult.reason)}`);
      }

      setError(nextErrors.length > 0 ? nextErrors.join(" ") : null);
    } finally {
      if (requestIdRef.current !== requestId) return;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsSection
      title="Bridge Status"
      description="Read-only git metadata plus the latest launcher lines from the bridge that is currently serving this UI."
      action={(
        <button
          onClick={() => void refresh(true)}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="space-y-2">
        <CommitCard
          title="Latest local commit"
          subtitle="Current worktree HEAD"
          snapshot={commits?.local ?? null}
          loading={loading}
        />
        <CommitCard
          title="Latest remote commit"
          subtitle="Freshly fetched from the tracked upstream branch"
          snapshot={commits?.remote ?? null}
          loading={loading}
        />
        <CommitCard
          title="Running bridge commit"
          subtitle="Captured when this server instance started"
          snapshot={commits?.running ?? null}
          loading={loading}
        />
        <LauncherLogCard
          launcherLog={launcherLog}
          loading={loading}
        />

        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            Commit metadata check failed: {error}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CommitCard({
  title,
  subtitle,
  snapshot,
  loading,
}: {
  title: string;
  subtitle: string;
  snapshot: BridgeCommitSnapshot | null;
  loading: boolean;
}) {
  const badgeText = loading && !snapshot
    ? "Checking…"
    : snapshot?.status === "ok"
      ? snapshot.shortSha
      : "Unavailable";

  const badgeClassName = loading && !snapshot
    ? "bg-bg-surface text-text-muted"
    : snapshot?.status === "ok"
      ? "bg-bg-primary text-text-secondary"
      : "bg-error/10 text-error";

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <GitCommitHorizontal size={15} />
            {title}
          </div>
          <p className="mt-1 text-xs text-text-muted">{subtitle}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClassName}`}>
          {badgeText}
        </span>
      </div>

      {snapshot?.status === "ok" ? (
        <div className="grid gap-2 text-xs text-text-muted">
          <div>
            <span className="text-text-faint">ref:</span>{" "}
            <code className="text-text-secondary">{snapshot.ref}</code>
          </div>
          <div>
            <span className="text-text-faint">sha:</span>{" "}
            <code className="text-text-secondary break-all">{snapshot.sha}</code>
          </div>
          <div>
            <span className="text-text-faint">message:</span>{" "}
            <span className="text-text-secondary break-words">{snapshot.message}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {snapshot?.error ?? "Commit metadata is unavailable."}
        </div>
      )}
    </div>
  );
}

function LauncherLogCard({
  launcherLog,
  loading,
}: {
  launcherLog: LauncherLogTail | null;
  loading: boolean;
}) {
  const lineCount = launcherLog?.status === "ok" ? launcherLog.lines.length : 0;
  const badgeText = loading && !launcherLog
    ? "Checking…"
    : launcherLog?.status === "ok"
      ? `${lineCount} ${lineCount === 1 ? "line" : "lines"}`
      : "Unavailable";

  const badgeClassName = loading && !launcherLog
    ? "bg-bg-surface text-text-muted"
    : launcherLog?.status === "ok"
      ? "bg-bg-primary text-text-secondary"
      : "bg-error/10 text-error";

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <GitCommitHorizontal size={15} />
            Launcher log tail
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Latest {LAUNCHER_LOG_LINE_COUNT} lines from the running launcher process.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClassName}`}>
          {badgeText}
        </span>
      </div>

      {launcherLog?.status === "ok" ? (
        launcherLog.lines.length > 0 ? (
          <pre className="overflow-x-auto rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary whitespace-pre-wrap break-words">
            {launcherLog.lines.join("\n")}
          </pre>
        ) : (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
            The launcher log file exists, but no lines have been written yet.
          </div>
        )
      ) : (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {launcherLog?.error ?? "Launcher log is unavailable."}
        </div>
      )}
    </div>
  );
}
