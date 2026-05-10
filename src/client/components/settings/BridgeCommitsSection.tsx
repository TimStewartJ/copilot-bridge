import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, GitCommitHorizontal, Loader2, RotateCw } from "lucide-react";
import {
  fetchBridgeCommitMetadata,
  fetchLauncherLogTail,
  type BridgeCommitMetadata,
  type BridgeCommitSnapshot,
  type LauncherLogTail,
} from "../../api";
import {
  describeBridgeOverview,
  describeLocalVsRemote,
  describeRunningVsLocal,
  type BridgeStatusDescriptor,
  type BridgeStatusTone,
} from "../../lib/bridge-commit-status";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";
import { SettingsSection } from "./SettingsSection";

const LAUNCHER_LOG_LINE_COUNT = 8;

export function BridgeCommitsSection() {
  const [commits, setCommits] = useState<BridgeCommitMetadata | null>(null);
  const [launcherLog, setLauncherLog] = useState<LauncherLogTail | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(true);
  const [launcherLogLoading, setLauncherLogLoading] = useState(true);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [launcherLogError, setLauncherLogError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback((forceRefresh = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCommitsLoading(true);
    setLauncherLogLoading(true);
    setCommitError(null);
    setLauncherLogError(null);

    void fetchBridgeCommitMetadata(forceRefresh)
      .then((value) => {
        if (requestIdRef.current !== requestId) return;
        setCommits(value);
      })
      .catch((reason: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setCommitError(`Commit status failed: ${formatRequestError(reason)}`);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setCommitsLoading(false);
      });

    void fetchLauncherLogTail(LAUNCHER_LOG_LINE_COUNT)
      .then((value) => {
        if (requestIdRef.current !== requestId) return;
        setLauncherLog(value);
      })
      .catch((reason: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setLauncherLogError(`Launcher log failed: ${formatRequestError(reason)}`);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLauncherLogLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loading = commitsLoading || launcherLogLoading;
  const errors = [commitError, launcherLogError].filter(
    (message): message is string => message !== null,
  );
  const error = errors.length > 0 ? errors.join(" ") : null;

  return (
    <SettingsSection
      title="Bridge Status"
      description="Compare local, tracked upstream, and running bridge commits, plus the latest launcher lines from the bridge serving this UI."
      action={(
        <button
          onClick={() => refresh(true)}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors inline-flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="space-y-3">
        <CommitOverviewCard commits={commits} loading={commitsLoading} />
        <div className="grid gap-2 lg:grid-cols-3">
          <CommitCard
            title="Local"
            subtitle="Current worktree HEAD"
            snapshot={commits?.local ?? null}
            loading={commitsLoading}
          />
          <CommitCard
            title="Remote"
            subtitle="Tracked upstream branch"
            snapshot={commits?.remote ?? null}
            loading={commitsLoading}
          />
          <CommitCard
            title="Running"
            subtitle="Bridge process serving this UI"
            snapshot={commits?.running ?? null}
            loading={commitsLoading}
          />
        </div>
        <LauncherLogCard
          launcherLog={launcherLog}
          loading={launcherLogLoading}
        />

        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            Bridge status check failed: {error}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CommitOverviewCard({
  commits,
  loading,
}: {
  commits: BridgeCommitMetadata | null;
  loading: boolean;
}) {
  const overview = describeBridgeOverview(commits, loading);
  const localSummary = describeLocalVsRemote(commits?.comparisons.localVsRemote, loading);
  const runningSummary = describeRunningVsLocal(commits?.comparisons.runningVsLocal, loading);

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <GitBranch size={15} />
            Sync overview
          </div>
          <p className="mt-1 text-xs text-text-muted">{overview.detail}</p>
        </div>
        <StatusPill descriptor={overview} />
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <ComparisonSummaryCard label="Local vs remote" descriptor={localSummary} />
        <ComparisonSummaryCard label="Running vs local" descriptor={runningSummary} />
      </div>
    </div>
  );
}

function ComparisonSummaryCard({
  label,
  descriptor,
}: {
  label: string;
  descriptor: BridgeStatusDescriptor;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
          <p className="mt-1 text-xs text-text-muted">{descriptor.detail}</p>
        </div>
        <StatusPill descriptor={descriptor} compact />
      </div>
    </div>
  );
}

function StatusPill({
  descriptor,
  compact = false,
}: {
  descriptor: BridgeStatusDescriptor;
  compact?: boolean;
}) {
  return (
    <span className={`shrink-0 rounded-full font-medium ${compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"} ${statusToneClassName(descriptor.tone)}`}>
      {descriptor.label}
    </span>
  );
}

function statusToneClassName(tone: BridgeStatusTone): string {
  switch (tone) {
    case "success":
      return "bg-success/15 text-success";
    case "warning":
      return "bg-warning/15 text-warning";
    case "error":
      return "bg-error/10 text-error";
    case "info":
      return "bg-info-surface text-info";
    default:
      return "bg-bg-surface text-text-secondary";
  }
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

      {loading && !snapshot ? (
        <LoadingSkeletonRegion
          isLoading
          label={`Loading ${title.toLowerCase()} commit metadata`}
          className="space-y-2"
        >
          <Skeleton height={24} width="56%" />
          <SkeletonText lines={2} widths={["88%", "64%"]} />
        </LoadingSkeletonRegion>
      ) : snapshot?.status === "ok" ? (
        <div className="space-y-2">
          <code className="inline-flex max-w-full rounded bg-bg-primary px-2 py-1 text-[11px] text-text-secondary">
            {snapshot.ref}
          </code>
          <p className="text-sm leading-5 text-text-secondary break-words line-clamp-2">
            {snapshot.message}
          </p>
          <code className="block break-all text-[11px] text-text-faint">
            {snapshot.sha}
          </code>
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

      {loading && !launcherLog ? (
        <LoadingSkeletonRegion
          isLoading
          label="Loading launcher log tail"
          className="space-y-2"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="rounded-md border border-border bg-bg-primary px-3 py-2">
              <SkeletonText lines={1} widths={[index === 0 ? "92%" : index === 1 ? "76%" : "84%"]} />
            </div>
          ))}
        </LoadingSkeletonRegion>
      ) : launcherLog?.status === "ok" ? (
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
