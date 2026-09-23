import { useCallback, useEffect, useRef, useState } from "react";
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
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Badge, Details, Notice, SettingList, SettingRow } from "../../design/primitives";

const LAUNCHER_LOG_LINE_COUNT = 8;

export function BridgeCommitsSection({ refreshSignal = 0, open = false }: { refreshSignal?: number; open?: boolean }) {
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

  const refreshRef = useRef<() => void>(() => undefined);
  refreshRef.current = () => refresh(true);
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refreshRef.current();
  }, [refreshSignal]);

  const errors = [commitError, launcherLogError].filter(
    (message): message is string => message !== null,
  );
  const overview = describeBridgeOverview(commits, commitsLoading);
  const running = commits?.running;
  const lineCount = launcherLog?.status === "ok" ? launcherLog.lines.length : 0;

  return (
    <SettingsSection id="settings-system-version" title="Source version">
      <SettingList>
        <SettingRow
          label={running?.status === "ok" ? `Running ${running.shortSha}` : commitsLoading ? "Checking…" : "Running commit unavailable"}
          hint={overview.detail}
          control={<StatusBadge descriptor={overview} />}
        />
      </SettingList>
      <div className="mt-3 space-y-1">
        <Details label="Local, remote and running commits" open={open || undefined}>
          <div className="pt-1">
            <ComparisonLine label="Local vs remote" descriptor={describeLocalVsRemote(commits?.comparisons.localVsRemote, commitsLoading)} />
            <ComparisonLine label="Running vs local" descriptor={describeRunningVsLocal(commits?.comparisons.runningVsLocal, commitsLoading)} />
            <div className={cx(DS.surface.divided, "mt-2")}>
              <CommitLine title="Local" subtitle="Current worktree HEAD" snapshot={commits?.local ?? null} loading={commitsLoading} />
              <CommitLine title="Remote" subtitle="Tracked upstream branch" snapshot={commits?.remote ?? null} loading={commitsLoading} />
              <CommitLine title="Running" subtitle="Bridge process serving this UI" snapshot={commits?.running ?? null} loading={commitsLoading} />
            </div>
          </div>
        </Details>
        <Details label="Launcher log" detail={launcherLog?.status === "ok" ? `Last ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : undefined}>
          <div className="pt-1">
            {launcherLogLoading && !launcherLog ? (
              <p role="status" className={DS.field.help}>Loading launcher log…</p>
            ) : launcherLog?.status === "ok" ? (
              launcherLog.lines.length > 0 ? (
                <pre className={cx(DS.surface.inset, "overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-text-secondary")}>
                  {launcherLog.lines.join("\n")}
                </pre>
              ) : (
                <p className={DS.field.help}>The launcher log file exists, but no lines have been written yet.</p>
              )
            ) : (
              <p className="text-xs text-error">{launcherLog?.error ?? "Launcher log is unavailable."}</p>
            )}
          </div>
        </Details>
      </div>
      {errors.length > 0 && <Notice tone="danger" className="mt-3">Bridge status check failed: {errors.join(" ")}</Notice>}
    </SettingsSection>
  );
}

function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Healthy and informational states stay neutral; only disagreement or failure takes a colour. */
const TONE_BADGE: Record<BridgeStatusTone, "neutral" | "warning" | "danger"> = {
  success: "neutral",
  info: "neutral",
  neutral: "neutral",
  warning: "warning",
  error: "danger",
};

function StatusBadge({ descriptor }: { descriptor: BridgeStatusDescriptor }) {
  return <Badge tone={TONE_BADGE[descriptor.tone]}>{descriptor.label}</Badge>;
}

function ComparisonLine({ label, descriptor }: { label: string; descriptor: BridgeStatusDescriptor }) {
  return (
    <p className="flex flex-wrap items-center gap-2 py-1 text-xs text-text-secondary">
      <span className="font-medium">{label}</span>
      <StatusBadge descriptor={descriptor} />
      <span>{descriptor.detail}</span>
    </p>
  );
}

function CommitLine({
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
  return (
    <div className="min-w-0 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className="font-medium text-text-primary">{title}</span>
        {snapshot?.status === "ok" && <code className={DS.text.literal}>{snapshot.shortSha}</code>}
        {snapshot?.status === "ok" && <code className={DS.text.literal}>{snapshot.ref}</code>}
        <span className={DS.field.help}>{subtitle}</span>
      </div>
      {loading && !snapshot ? (
        <p role="status" className={DS.field.help}>Checking…</p>
      ) : snapshot?.status === "ok" ? (
        <p className="truncate text-xs text-text-secondary" title={`${snapshot.message}\n${snapshot.sha}`}>{snapshot.message}</p>
      ) : (
        <p className="text-xs text-error">{snapshot?.error ?? "Commit metadata is unavailable."}</p>
      )}
    </div>
  );
}
