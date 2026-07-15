import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Download,
  Gauge,
  Loader2,
  Power,
  RotateCcw,
  RotateCw,
  Terminal,
  XCircle,
} from "lucide-react";
import type { BridgeRuntimeStatus } from "../../bridge-management-api";
import {
  MANAGEMENT_JOB_STATUSES,
  MANAGEMENT_JOB_TYPES,
  type ManagementJobDetail,
  type ManagementJobFilters,
  type ManagementJobListResponse,
  type ManagementJobStatus,
  type ManagementJobSummary,
  type ManagementJobType,
} from "../../management-job-api";
import {
  useCancelManagementJobMutation,
  useEnqueueManagementJobMutation,
  useManagementJobQuery,
  useManagementJobsQuery,
  useRetryManagementJobMutation,
} from "../../hooks/queries/useManagementJobs";
import {
  useBridgeRuntimeStatusQuery,
  useRestartBridgeMutation,
} from "../../hooks/queries/useBridgeRuntimeStatus";
import { useRestartStatusQuery } from "../../hooks/queries/useRestartStatus";
import EmptyState from "../shared/EmptyState";
import { SettingsSection } from "./SettingsSection";

const JOB_TYPES = MANAGEMENT_JOB_TYPES;
const JOB_STATUSES = MANAGEMENT_JOB_STATUSES;
const ACTIVE_STATUSES = new Set<ManagementJobStatus>(["queued", "running"]);
const RETRYABLE_STATUSES = new Set<ManagementJobStatus>(["failed", "cancelled"]);
const CONFIRMATION_TYPES = new Set<ManagementJobType>(["self_update", "staging_deploy"]);
const EXCLUSIVE_JOB_TYPES = new Set<ManagementJobType>(["self_update", "staging_deploy"]);
const LIMITS = [25, 50, 100, 200];
const ACTIVE_JOB_FILTERS: ManagementJobFilters = { statuses: ["queued", "running"], limit: 200 };

type JobTypeFilter = "all" | ManagementJobType;
type JobStatusFilter = "all" | ManagementJobStatus;

export function ManagementJobsSection() {
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [limit, setLimit] = useState(50);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const filters = useMemo<ManagementJobFilters>(() => ({
    ...(typeFilter === "all" ? {} : { types: typeFilter }),
    ...(statusFilter === "all" ? {} : { statuses: statusFilter }),
    limit,
  }), [limit, statusFilter, typeFilter]);

  const activeJobsQuery = useManagementJobsQuery(ACTIVE_JOB_FILTERS);
  const jobsQuery = useManagementJobsQuery(filters);
  const detailQuery = useManagementJobQuery(selectedJobId ?? undefined);
  const runtimeQuery = useBridgeRuntimeStatusQuery();
  const restartStatusQuery = useRestartStatusQuery();
  const cancelMutation = useCancelManagementJobMutation();
  const enqueueMutation = useEnqueueManagementJobMutation();
  const retryMutation = useRetryManagementJobMutation();
  const restartMutation = useRestartBridgeMutation();

  const activeList = activeJobsQuery.data ?? null;
  const list = activeList ?? jobsQuery.data ?? null;
  const recentList = jobsQuery.data ?? null;
  const activeJobs = useMemo(
    () => activeList?.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)) ?? [],
    [activeList],
  );
  const recentJobs = useMemo(
    () => recentList?.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status)) ?? [],
    [recentList],
  );
  const jobs = useMemo(
    () => [...activeJobs, ...recentJobs],
    [activeJobs, recentJobs],
  );
  const selectedSummary = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedJob = detailQuery.data ?? selectedSummary;
  const activeExclusiveJob = activeJobs.find((job) => EXCLUSIVE_JOB_TYPES.has(job.type)) ?? null;
  const busy = activeJobsQuery.isFetching
    || jobsQuery.isFetching
    || detailQuery.isFetching
    || runtimeQuery.isLoading
    || restartStatusQuery.isLoading;
  const jobActionBusy = cancelMutation.isPending || retryMutation.isPending;
  const controlBusy = enqueueMutation.isPending || restartMutation.isPending;

  useEffect(() => {
    if (selectedJobId || jobs.length === 0) return;
    setSelectedJobId(jobs[0]?.id ?? null);
  }, [jobs, selectedJobId]);

  const refresh = useCallback(async () => {
    setActionError(null);
    await Promise.all([
      activeJobsQuery.refetch(),
      jobsQuery.refetch(),
      runtimeQuery.refetch(),
      restartStatusQuery.refetch(),
      selectedJobId ? detailQuery.refetch() : Promise.resolve(),
    ]);
  }, [activeJobsQuery, detailQuery, jobsQuery, restartStatusQuery, runtimeQuery, selectedJobId]);

  const handleCancel = useCallback(async (job: ManagementJobSummary) => {
    if (job.status !== "queued") return;
    const confirmed = !CONFIRMATION_TYPES.has(job.type)
      || window.confirm(`Cancel queued ${jobTypeLabel(job.type)} job ${shortJobId(job.id)}?`);
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      await cancelMutation.mutateAsync(job.id);
      setActionMessage(`Queued job ${shortJobId(job.id)} cancelled.`);
      setSelectedJobId(job.id);
      await activeJobsQuery.refetch();
      await jobsQuery.refetch();
    } catch (error) {
      setActionError(`Cancel failed: ${formatError(error)}`);
    }
  }, [activeJobsQuery, cancelMutation, jobsQuery]);

  const handleRetry = useCallback(async (job: ManagementJobSummary) => {
    if (!RETRYABLE_STATUSES.has(job.status)) return;
    const confirmed = !CONFIRMATION_TYPES.has(job.type)
      || window.confirm(`Retry ${jobTypeLabel(job.type)} job ${shortJobId(job.id)}?`);
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const retryResult = await retryMutation.mutateAsync(job.id);
      const nextJobId = retryResult.job.id;
      setSelectedJobId(nextJobId);
      setActionMessage(
        retryResult.reused
          ? `Using existing active job ${shortJobId(nextJobId)}.`
          : `Retry queued as ${shortJobId(nextJobId)}.`,
      );
      await activeJobsQuery.refetch();
      await jobsQuery.refetch();
    } catch (error) {
      setActionError(`Retry failed: ${formatError(error)}`);
    }
  }, [activeJobsQuery, jobsQuery, retryMutation]);

  const handleSelfUpdate = useCallback(async () => {
    const confirmed = window.confirm(
      "Queue a Bridge self-update job?\n\nThe launcher will pull the latest source, validate it, and restart the Bridge if the update succeeds.",
    );
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const result = await enqueueMutation.mutateAsync({ type: "self_update" });
      setSelectedJobId(result.job.id);
      setActionMessage(
        result.reused
          ? `Using existing self-update job ${shortJobId(result.job.id)}.`
          : `Self-update queued as ${shortJobId(result.job.id)}.`,
      );
      void activeJobsQuery.refetch();
      void jobsQuery.refetch();
      void runtimeQuery.refetch();
    } catch (error) {
      setActionError(`Self-update failed to queue: ${formatError(error)}`);
    }
  }, [activeJobsQuery, enqueueMutation, jobsQuery, runtimeQuery]);

  const handleRestart = useCallback(async () => {
    const confirmed = window.confirm(buildRestartConfirmation(runtimeQuery.data));
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const result = await restartMutation.mutateAsync();
      setActionMessage(
        result.waitingSessions > 0
          ? `Restart queued. Waiting for ${result.waitingSessions} active session${result.waitingSessions === 1 ? "" : "s"}.`
          : "Restart queued. The Bridge may reconnect momentarily.",
      );
      void runtimeQuery.refetch();
      void restartStatusQuery.refetch();
    } catch (error) {
      setActionError(`Restart failed: ${formatError(error)}`);
    }
  }, [restartMutation, restartStatusQuery, runtimeQuery]);

  const restartPending = restartStatusQuery.data?.pending === true;
  const selfUpdateDisabledReason = getSelfUpdateDisabledReason({
    runtime: runtimeQuery.data,
    runtimeError: runtimeQuery.error,
    restartPending,
    activeExclusiveJob,
    busy: controlBusy,
  });
  const restartDisabledReason = getRestartDisabledReason({
    runtime: runtimeQuery.data,
    runtimeError: runtimeQuery.error,
    restartPending,
    activeExclusiveJob,
    busy: controlBusy,
  });

  return (
    <SettingsSection
      title="Bridge Management"
      description="Review live Bridge activity, queue operational controls, and inspect launcher-supervised management jobs."
      action={(
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-wait disabled:text-text-faint"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="space-y-4">
        <CurrentActivityCard
          status={runtimeQuery.data ?? null}
          loading={runtimeQuery.isLoading && !runtimeQuery.data}
          error={runtimeQuery.error}
        />

        <CapacityCard
          status={runtimeQuery.data ?? null}
          loading={runtimeQuery.isLoading && !runtimeQuery.data}
          error={runtimeQuery.error}
        />

        <BridgeControlsCard
          selfUpdateDisabledReason={selfUpdateDisabledReason}
          restartDisabledReason={restartDisabledReason}
          queueingUpdate={enqueueMutation.isPending}
          restarting={restartMutation.isPending}
          onQueueSelfUpdate={() => void handleSelfUpdate()}
          onRestart={() => void handleRestart()}
        />

        {(activeJobsQuery.error || jobsQuery.error || actionError || actionMessage) && (
          <div className="space-y-2">
            {(activeJobsQuery.error || jobsQuery.error) && (
              <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                Failed to load management jobs: {formatError(activeJobsQuery.error ?? jobsQuery.error)}
              </div>
            )}
            {actionError && (
              <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
                {actionError}
              </div>
            )}
            {actionMessage && (
              <div className="rounded-md border border-success/25 bg-success/10 px-3 py-2 text-xs text-success">
                {actionMessage}
              </div>
            )}
          </div>
        )}

        <RunnerSummaryCard list={list} loading={(activeJobsQuery.isLoading || jobsQuery.isLoading) && !list} />

        <JobListCard
          title="Active jobs"
          description="Queued and running launcher jobs are listed first. Running cancellation is disabled until cooperative cancellation is supported by job implementations."
          jobs={activeJobs}
          emptyMessage="No active management jobs"
          emptySub="Queued or running self-update, staging preview, and staging deploy work will appear here."
          selectedJobId={selectedJobId}
          list={activeList}
          loading={activeJobsQuery.isLoading && !activeList}
          onSelectJob={setSelectedJobId}
          onCancel={handleCancel}
          onRetry={handleRetry}
          actionBusy={jobActionBusy}
        />

        <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-accent">
                <Activity size={15} />
                Recent jobs
              </div>
              <p className="mt-1 text-xs text-text-muted">
                History is sorted newest first. Filters apply to recent rows; runner summary counts remain unfiltered active-job totals.
              </p>
            </div>
            <FilterControls
              typeFilter={typeFilter}
              statusFilter={statusFilter}
              limit={limit}
              onTypeFilterChange={setTypeFilter}
              onStatusFilterChange={setStatusFilter}
              onLimitChange={setLimit}
            />
          </div>
          <JobTableOrEmpty
            jobs={recentJobs}
            emptyMessage="No recent matching jobs"
            emptySub="Adjust filters or run a management operation to populate recent history."
            selectedJobId={selectedJobId}
            list={recentList}
            loading={jobsQuery.isLoading && !recentList}
            onSelectJob={setSelectedJobId}
            onCancel={handleCancel}
            onRetry={handleRetry}
            actionBusy={jobActionBusy}
          />
        </div>

        <JobDetailPanel
          job={selectedJob}
          detail={detailQuery.data ?? null}
          loading={Boolean(selectedJobId) && detailQuery.isLoading && !detailQuery.data}
          error={detailQuery.error ?? null}
          staleAfterMs={list?.staleAfterMs}
          fetchedAt={list?.fetchedAt}
          onRefresh={() => void detailQuery.refetch()}
          onCancel={handleCancel}
          onRetry={handleRetry}
          actionBusy={jobActionBusy}
        />
      </div>
    </SettingsSection>
  );
}

function CurrentActivityCard({
  status,
  loading,
  error,
}: {
  status: BridgeRuntimeStatus | null;
  loading: boolean;
  error: unknown;
}) {
  const sessions = status?.sessions;
  const agents = status?.agents;
  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <Activity size={15} />
            Current activity
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Live in-memory activity for top-level sessions and background agents. Stale agent snapshots are excluded from current counts.
          </p>
        </div>
        <div className="text-[11px] text-text-faint">
          Updated {loading ? "checking…" : formatDateTime(status?.fetchedAt)}
        </div>
      </div>

      {error && !status ? (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          Runtime status unavailable: {formatError(error)}
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <SummaryMetric label="Active sessions" value={loading ? "…" : String(sessions?.active ?? 0)} tone={(sessions?.active ?? 0) > 0 ? "info" : "default"} />
            <SummaryMetric label="Stalled sessions" value={loading ? "…" : String(sessions?.stalled ?? 0)} tone={(sessions?.stalled ?? 0) > 0 ? "warning" : "success"} />
            <SummaryMetric label="Awaiting input" value={loading ? "…" : String(sessions?.waitingForUserInput ?? 0)} tone={(sessions?.waitingForUserInput ?? 0) > 0 ? "warning" : "default"} />
            <SummaryMetric label="Agents running" value={loading ? "…" : String(agents?.running ?? 0)} tone={(agents?.running ?? 0) > 0 ? "info" : "default"} />
            <SummaryMetric label="Agents idle" value={loading ? "…" : String(agents?.idle ?? 0)} />
            <SummaryMetric label="Agents failed" value={loading ? "…" : String(agents?.failed ?? 0)} tone={(agents?.failed ?? 0) > 0 ? "error" : "success"} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-faint">
            <span>PID {status?.pid ?? "unknown"}</span>
            <span>Uptime {status ? formatDurationMs(status.uptimeSeconds * 1_000) : "unknown"}</span>
            <span>{agents?.total ?? 0} tracked agents in {agents?.liveSessions ?? 0} live session snapshots</span>
            {(agents?.staleSessions ?? 0) > 0 && (
              <span>
                {agents?.staleSessions} stale snapshot{agents?.staleSessions === 1 ? "" : "s"} excluded
              </span>
            )}
            {(agents?.unknownSessions ?? 0) > 0 && (
              <span>
                {agents?.unknownSessions} snapshot{agents?.unknownSessions === 1 ? "" : "s"} unavailable
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CapacityCard({
  status,
  loading,
  error,
}: {
  status: BridgeRuntimeStatus | null;
  loading: boolean;
  error: unknown;
}) {
  const capacity = status?.capacity;
  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <Gauge size={15} />
            Copilot capacity
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Admission uses both a hard live-context limit and an MCP-weighted unit budget. Idle cached parents are evictable and do not count as used pressure.
          </p>
        </div>
        <div className="text-[11px] text-text-faint">
          Updated {loading ? "checking…" : formatDateTime(status?.fetchedAt)}
        </div>
      </div>

      {error && !status ? (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          Capacity status unavailable: {formatError(error)}
        </div>
      ) : !capacity ? (
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
          {loading ? "Loading capacity status…" : "Capacity statistics are unavailable from this server version."}
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryMetric
              label="Live contexts"
              value={`${formatCapacityValue(capacity.contexts.used)} / ${formatCapacityValue(capacity.contexts.limit)}`}
              tone={capacityTone(capacity.contexts.used, capacity.contexts.limit)}
            />
            <SummaryMetric
              label="Weighted units"
              value={`${formatCapacityValue(capacity.weightedUnits.used)} / ${formatCapacityValue(capacity.weightedUnits.limit)}`}
              tone={capacityTone(capacity.weightedUnits.used, capacity.weightedUnits.limit)}
            />
            <SummaryMetric
              label="Local MCP slots"
              value={formatCapacityValue(capacity.localMcpSlots.used)}
              tone={capacity.localMcpSlots.used > 0 ? "info" : "default"}
            />
            <SummaryMetric
              label="Waiting requests"
              value={String(capacity.waitingRequests)}
              tone={capacity.waitingRequests > 0 ? "warning" : "success"}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <CapacityBar
              label="Context pressure"
              used={capacity.contexts.used}
              retained={capacity.contexts.retained}
              limit={capacity.contexts.limit}
            />
            <CapacityBar
              label="Weighted pressure"
              used={capacity.weightedUnits.used}
              retained={capacity.weightedUnits.retained}
              limit={capacity.weightedUnits.limit}
            />
          </div>

          {capacity.cleanup.failed > 0 && (
            <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
              New work is blocked while {capacity.cleanup.failed} failed cleanup{capacity.cleanup.failed === 1 ? "" : "s"} remain. Bridge retries these automatically; restart if the count does not clear.
            </div>
          )}
          {capacity.cleanup.failed === 0 && capacity.waitingRequests > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {capacity.waitingRequests} request{capacity.waitingRequests === 1 ? " is" : "s are"} waiting for live capacity or cleanup headroom.
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-faint">
            <span>
              Parent cache {capacity.cache.readyParents}/{capacity.cache.limit}, {capacity.cache.protectedParents} protected
            </span>
            <span>
              Cleanup {capacity.cleanup.pending} pending, {capacity.cleanup.failed} failed, limit {capacity.cleanup.limit}
            </span>
            <span>Local MCP weight +{formatCapacityValue(capacity.localMcpWeight)} per context</span>
            <span>Capacity wait {formatCapacityValue(capacity.waitTimeoutSeconds)}s</span>
          </div>
        </>
      )}
    </div>
  );
}

function CapacityBar({
  label,
  used,
  retained,
  limit,
}: {
  label: string;
  used: number;
  retained: number;
  limit: number;
}) {
  const percentage = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return (
    <div className="rounded-md border border-border bg-bg-primary p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="text-text-muted">
          {formatCapacityValue(used)} used, {formatCapacityValue(retained)} retained
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-surface">
        <div
          className={`h-full rounded-full transition-[width] ${capacityBarClassName(used, limit)}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function BridgeControlsCard({
  selfUpdateDisabledReason,
  restartDisabledReason,
  queueingUpdate,
  restarting,
  onQueueSelfUpdate,
  onRestart,
}: {
  selfUpdateDisabledReason: string | null;
  restartDisabledReason: string | null;
  queueingUpdate: boolean;
  restarting: boolean;
  onQueueSelfUpdate: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-accent">
          <Power size={15} />
          Bridge controls
        </div>
        <p className="mt-1 text-xs text-text-muted">
          These operations are launcher-supervised. Restart waits for active sessions; self-update records durable progress below.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-bg-primary p-3">
          <div className="text-sm font-medium text-text-secondary">Self-update</div>
          <p className="mt-1 text-xs text-text-muted">
            Pull the latest source, validate it, and restart with automatic rollback if activation fails.
          </p>
          <button
            type="button"
            onClick={onQueueSelfUpdate}
            disabled={Boolean(selfUpdateDisabledReason)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {queueingUpdate ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {queueingUpdate ? "Queueing…" : "Queue self-update"}
          </button>
          <p className="mt-2 text-[11px] text-text-faint">
            {selfUpdateDisabledReason ?? "Available for source-managed Bridge installations."}
          </p>
        </div>

        <div className="rounded-md border border-border bg-bg-primary p-3">
          <div className="text-sm font-medium text-text-secondary">Operational restart</div>
          <p className="mt-1 text-xs text-text-muted">
            Reload configuration and dependencies without pulling or deploying code changes.
          </p>
          <button
            type="button"
            onClick={onRestart}
            disabled={Boolean(restartDisabledReason)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {restarting ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
            {restarting ? "Queueing…" : "Restart Bridge"}
          </button>
          <p className="mt-2 text-[11px] text-text-faint">
            {restartDisabledReason ?? "The launcher will wait for current sessions before cutover."}
          </p>
        </div>
      </div>
    </div>
  );
}

function RunnerSummaryCard({
  list,
  loading,
}: {
  list: ManagementJobListResponse | null;
  loading: boolean;
}) {
  const jobs = list?.jobs ?? [];
  const activeCount = list?.activeCount ?? jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  const runningCount = list?.runningCount ?? jobs.filter((job) => job.status === "running").length;
  const queuedCount = list?.queuedCount ?? jobs.filter((job) => job.status === "queued").length;
  const staleCount = list?.staleCount ?? jobs.filter((job) => job.stale).length;

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <Activity size={15} />
            Runner summary
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Runner health is inferred from queued/running jobs and their heartbeats; there is no dedicated idle-runner heartbeat yet.
          </p>
        </div>
        <div className="text-[11px] text-text-faint">
          Updated {loading ? "checking…" : formatDateTime(list?.fetchedAt)}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <SummaryMetric label="Active" value={loading ? "…" : String(activeCount)} />
        <SummaryMetric label="Running" value={loading ? "…" : String(runningCount)} tone={runningCount > 0 ? "info" : "default"} />
        <SummaryMetric label="Queued" value={loading ? "…" : String(queuedCount)} tone={queuedCount > 0 ? "warning" : "default"} />
        <SummaryMetric label="Stale" value={loading ? "…" : String(staleCount)} tone={staleCount > 0 ? "error" : "success"} />
        <SummaryMetric
          label="Stale after"
          value={list?.staleAfterMs ? formatDurationMs(list.staleAfterMs) : "unknown"}
        />
      </div>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "error" | "info";
}) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${metricToneClassName(tone)}`}>{value}</div>
    </div>
  );
}

function JobListCard({
  title,
  description,
  jobs,
  emptyMessage,
  emptySub,
  selectedJobId,
  list,
  loading,
  onSelectJob,
  onCancel,
  onRetry,
  actionBusy,
}: {
  title: string;
  description: string;
  jobs: ManagementJobSummary[];
  emptyMessage: string;
  emptySub: string;
  selectedJobId: string | null;
  list: ManagementJobListResponse | null;
  loading: boolean;
  onSelectJob: (jobId: string) => void;
  onCancel: (job: ManagementJobSummary) => void;
  onRetry: (job: ManagementJobSummary) => void;
  actionBusy: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <Terminal size={15} />
            {title}
          </div>
          <p className="mt-1 text-xs text-text-muted">{description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
          {jobs.length} shown
        </span>
      </div>
      <JobTableOrEmpty
        jobs={jobs}
        emptyMessage={emptyMessage}
        emptySub={emptySub}
        selectedJobId={selectedJobId}
        list={list}
        loading={loading}
        onSelectJob={onSelectJob}
        onCancel={onCancel}
        onRetry={onRetry}
        actionBusy={actionBusy}
      />
    </div>
  );
}

function FilterControls({
  typeFilter,
  statusFilter,
  limit,
  onTypeFilterChange,
  onStatusFilterChange,
  onLimitChange,
}: {
  typeFilter: JobTypeFilter;
  statusFilter: JobStatusFilter;
  limit: number;
  onTypeFilterChange: (value: JobTypeFilter) => void;
  onStatusFilterChange: (value: JobStatusFilter) => void;
  onLimitChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs text-text-muted">
      <label className="flex items-center gap-1.5">
        Type
        <select
          aria-label="Management job type filter"
          value={typeFilter}
          onChange={(event) => onTypeFilterChange(event.target.value as JobTypeFilter)}
          className="rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
        >
          <option value="all">all</option>
          {JOB_TYPES.map((type) => (
            <option key={type} value={type}>{jobTypeLabel(type)}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Status
        <select
          aria-label="Management job status filter"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as JobStatusFilter)}
          className="rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
        >
          <option value="all">all</option>
          {JOB_STATUSES.map((status) => (
            <option key={status} value={status}>{statusLabel(status)}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Limit
        <select
          aria-label="Management job limit filter"
          value={limit}
          onChange={(event) => onLimitChange(Number(event.target.value))}
          className="rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
        >
          {LIMITS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function JobTableOrEmpty({
  jobs,
  emptyMessage,
  emptySub,
  selectedJobId,
  list,
  loading,
  onSelectJob,
  onCancel,
  onRetry,
  actionBusy,
}: {
  jobs: ManagementJobSummary[];
  emptyMessage: string;
  emptySub: string;
  selectedJobId: string | null;
  list: ManagementJobListResponse | null;
  loading: boolean;
  onSelectJob: (jobId: string) => void;
  onCancel: (job: ManagementJobSummary) => void;
  onRetry: (job: ManagementJobSummary) => void;
  actionBusy: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border bg-bg-primary p-4 text-sm text-text-muted">
        Loading management jobs…
      </div>
    );
  }

  if (jobs.length === 0) {
    return <EmptyState message={emptyMessage} sub={emptySub} />;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-bg-primary">
      <table className="min-w-max w-full text-xs">
        <thead className="bg-bg-secondary text-text-muted">
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left font-medium">Job</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Created / started</th>
            <th className="px-3 py-2 text-left font-medium">Elapsed</th>
            <th className="px-3 py-2 text-left font-medium">Runner</th>
            <th className="px-3 py-2 text-left font-medium">Heartbeat</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              selected={job.id === selectedJobId}
              staleAfterMs={list?.staleAfterMs}
              fetchedAt={list?.fetchedAt}
              onSelect={() => onSelectJob(job.id)}
              onCancel={() => onCancel(job)}
              onRetry={() => onRetry(job)}
              actionBusy={actionBusy}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({
  job,
  selected,
  staleAfterMs,
  fetchedAt,
  onSelect,
  onCancel,
  onRetry,
  actionBusy,
}: {
  job: ManagementJobSummary;
  selected: boolean;
  staleAfterMs?: number;
  fetchedAt?: string;
  onSelect: () => void;
  onCancel: () => void;
  onRetry: () => void;
  actionBusy: boolean;
}) {
  const heartbeatAge = heartbeatAgeMs(job, fetchedAt);
  const elapsedStart = job.startedAt ?? job.createdAt;
  const elapsedEnd = job.completedAt;
  const isRetryable = RETRYABLE_STATUSES.has(job.status);
  const rowClassName = selected
    ? "border-b border-border bg-accent-surface/50"
    : job.stale
      ? "border-b border-warning/30 bg-warning/5 hover:bg-warning/10"
      : "border-b border-border hover:bg-bg-hover";

  return (
    <tr className={rowClassName} onClick={onSelect}>
      <td className="px-3 py-2 align-top">
        <button type="button" className="text-left" onClick={onSelect}>
          <div className="font-medium text-text-secondary">{jobTypeLabel(job.type)}</div>
          <code className="text-[11px] text-text-faint">{shortJobId(job.id)}</code>
        </button>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col gap-1">
          <StatusPill status={job.status} stale={job.stale} />
          {job.cancelRequestedAt && (
            <span className="text-[11px] text-warning">cancel requested</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-text-muted">
        <div>{formatDateTime(job.createdAt)}</div>
        <div className="text-[11px] text-text-faint">started {formatDateTime(job.startedAt)}</div>
      </td>
      <td className="px-3 py-2 align-top text-text-muted">{formatElapsed(elapsedStart, elapsedEnd)}</td>
      <td className="px-3 py-2 align-top text-text-muted">{job.runnerPid ?? "—"}</td>
      <td className="px-3 py-2 align-top text-text-muted">
        <div>{heartbeatAge === undefined ? "—" : `${formatDurationMs(heartbeatAge)} ago`}</div>
        {job.stale && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
            <AlertTriangle size={11} />
            Stale{staleAfterMs ? ` > ${formatDurationMs(staleAfterMs)}` : ""}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top text-right">
        <div className="flex justify-end gap-1.5">
          {job.status === "queued" && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCancel();
              }}
              disabled={actionBusy}
              className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionBusy ? <Loader2 size={10} className="animate-spin" /> : <XCircle size={10} />}
              Cancel
            </button>
          )}
          {job.status === "running" && (
            <button
              type="button"
              disabled
              title="Running job cancellation is not enabled until cooperative cancellation is implemented."
              className="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-border bg-bg-surface px-2 py-1 text-[11px] text-text-faint"
            >
              Cancel unavailable
            </button>
          )}
          {isRetryable && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
              disabled={actionBusy}
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionBusy ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
              Retry
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function JobDetailPanel({
  job,
  detail,
  loading,
  error,
  staleAfterMs,
  fetchedAt,
  onRefresh,
  onCancel,
  onRetry,
  actionBusy,
}: {
  job: ManagementJobSummary | ManagementJobDetail | null;
  detail: ManagementJobDetail | null;
  loading: boolean;
  error: unknown;
  staleAfterMs?: number;
  fetchedAt?: string;
  onRefresh: () => void;
  onCancel: (job: ManagementJobSummary) => void;
  onRetry: (job: ManagementJobSummary) => void;
  actionBusy: boolean;
}) {
  if (!job) {
    return (
      <div className="rounded-md border border-border bg-bg-elevated p-4">
        <EmptyState
          message="Select a management job"
          sub="Choose a row above to inspect job metadata, sanitized logs, and action state."
        />
      </div>
    );
  }

  const heartbeatAge = heartbeatAgeMs(job, fetchedAt);
  const canCancel = job.status === "queued";
  const canRetry = RETRYABLE_STATUSES.has(job.status);

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-accent">
            <Terminal size={15} />
            Job detail
            <StatusPill status={job.status} stale={job.stale} />
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-text-faint">{job.id}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-primary px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
            Refresh detail
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={() => onCancel(job)}
              disabled={actionBusy}
              className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <XCircle size={11} />
              Cancel queued
            </button>
          )}
          {job.status === "running" && (
            <button
              type="button"
              disabled
              title="Running job cancellation is not enabled until cooperative cancellation is implemented."
              className="inline-flex cursor-not-allowed items-center gap-1 rounded-md border border-border bg-bg-surface px-2.5 py-1 text-xs text-text-faint"
            >
              Cancel unavailable
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => onRetry(job)}
              disabled={actionBusy}
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw size={11} />
              Retry
            </button>
          )}
        </div>
      </div>

      {job.stale && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          This running job appears stale{staleAfterMs ? ` because its heartbeat is older than ${formatDurationMs(staleAfterMs)}` : ""}.
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          Detail refresh failed: {formatError(error)}
        </div>
      ) : null}

      <div className="grid gap-2 text-xs md:grid-cols-2 xl:grid-cols-4">
        <DetailStat label="Type" value={jobTypeLabel(job.type)} />
        <DetailStat label="Created" value={formatDateTime(job.createdAt)} />
        <DetailStat label="Started" value={formatDateTime(job.startedAt)} />
        <DetailStat label="Completed" value={formatDateTime(job.completedAt)} />
        <DetailStat label="Elapsed" value={formatElapsed(job.startedAt ?? job.createdAt, job.completedAt)} />
        <DetailStat label="Heartbeat age" value={heartbeatAge === undefined ? "—" : `${formatDurationMs(heartbeatAge)} ago`} />
        <DetailStat label="Runner PID" value={job.runnerPid === undefined ? "—" : String(job.runnerPid)} />
        <DetailStat label="Updated" value={formatDateTime(job.updatedAt)} />
      </div>

      {detail ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <JsonDetails label="Input JSON" value={detail.input} />
          <JsonDetails label="Result JSON" value={detail.result} empty="No result recorded yet." />
        </div>
      ) : (
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
          {loading ? "Loading detail payload…" : "Detail payload is not loaded yet."}
        </div>
      )}

      {job.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-3">
          <div className="text-xs font-medium text-error">Error</div>
          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px] text-error">{job.error}</pre>
        </div>
      )}

      <div className="rounded-md border border-border bg-bg-primary p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-text-secondary">Sanitized recent log tail</div>
          {loading && <Loader2 size={12} className="animate-spin text-text-muted" />}
        </div>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-secondary p-3 text-[11px] text-text-muted">
          {detail?.logTail?.trim() ? detail.logTail : "No log lines available."}
        </pre>
      </div>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 break-words text-xs text-text-secondary">{value}</div>
    </div>
  );
}

function JsonDetails({
  label,
  value,
  empty = "No value recorded.",
}: {
  label: string;
  value: unknown;
  empty?: string;
}) {
  const hasValue = value !== undefined && value !== null;
  return (
    <details className="rounded-md border border-border bg-bg-primary p-3">
      <summary className="cursor-pointer text-xs font-medium text-text-secondary">
        {label}
      </summary>
      {hasValue ? (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-secondary p-3 text-[11px] text-text-muted">
          {formatJson(value)}
        </pre>
      ) : (
        <p className="mt-2 text-xs text-text-muted">{empty}</p>
      )}
    </details>
  );
}

function StatusPill({ status, stale }: { status: ManagementJobStatus; stale?: boolean }) {
  return (
    <span className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusToneClassName(status, stale)}`}>
      {stale ? "stale" : statusLabel(status)}
    </span>
  );
}

function statusToneClassName(status: ManagementJobStatus, stale?: boolean): string {
  if (stale) return "bg-warning/15 text-warning";
  switch (status) {
    case "queued":
      return "bg-warning/15 text-warning";
    case "running":
      return "bg-info-surface text-info";
    case "succeeded":
      return "bg-success/15 text-success";
    case "failed":
      return "bg-error/10 text-error";
    case "cancelled":
      return "bg-bg-surface text-text-muted";
    default:
      return "bg-bg-surface text-text-muted";
  }
}

function metricToneClassName(tone: "default" | "success" | "warning" | "error" | "info"): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "error":
      return "text-error";
    case "info":
      return "text-info";
    default:
      return "text-text-primary";
  }
}

function capacityTone(
  used: number,
  limit: number,
): "default" | "success" | "warning" | "error" | "info" {
  if (limit <= 0) return "default";
  const ratio = used / limit;
  if (ratio >= 1) return "error";
  if (ratio >= 0.8) return "warning";
  if (ratio > 0) return "info";
  return "success";
}

function capacityBarClassName(used: number, limit: number): string {
  const tone = capacityTone(used, limit);
  if (tone === "error") return "bg-error";
  if (tone === "warning") return "bg-warning";
  if (tone === "success") return "bg-success";
  return "bg-info";
}

function formatCapacityValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function getSelfUpdateDisabledReason({
  runtime,
  runtimeError,
  restartPending,
  activeExclusiveJob,
  busy,
}: {
  runtime: BridgeRuntimeStatus | undefined;
  runtimeError: unknown;
  restartPending: boolean;
  activeExclusiveJob: ManagementJobSummary | null;
  busy: boolean;
}): string | null {
  if (busy) return "A management request is being submitted.";
  if (!runtime) return runtimeError ? "Runtime availability could not be checked." : "Checking availability…";
  if (runtime.isStaging) return "Unavailable from staging previews.";
  if (!runtime.sourceManagementAvailable) return "Requires a source-managed Bridge checkout.";
  if (restartPending) return "A restart is already pending.";
  if (activeExclusiveJob) {
    return `${jobTypeLabel(activeExclusiveJob.type)} is already ${activeExclusiveJob.status}.`;
  }
  return null;
}

function getRestartDisabledReason({
  runtime,
  runtimeError,
  restartPending,
  activeExclusiveJob,
  busy,
}: {
  runtime: BridgeRuntimeStatus | undefined;
  runtimeError: unknown;
  restartPending: boolean;
  activeExclusiveJob: ManagementJobSummary | null;
  busy: boolean;
}): string | null {
  if (busy) return "A management request is being submitted.";
  if (!runtime) return runtimeError ? "Runtime availability could not be checked." : "Checking availability…";
  if (runtime.isStaging) return "Unavailable from staging previews.";
  if (restartPending) return "A restart is already pending.";
  if (activeExclusiveJob) {
    return `Wait for the active ${jobTypeLabel(activeExclusiveJob.type).toLowerCase()} job to finish.`;
  }
  return null;
}

function buildRestartConfirmation(runtime: BridgeRuntimeStatus | undefined): string {
  if (!runtime) {
    return "Restart Bridge now?\n\nThe launcher will wait for active sessions before cutover.";
  }

  const { active, stalled, waitingForUserInput } = runtime.sessions;
  const activity = [
    `${active} active session${active === 1 ? "" : "s"}`,
    ...(stalled > 0 ? [`${stalled} stalled`] : []),
    ...(waitingForUserInput > 0 ? [`${waitingForUserInput} awaiting input`] : []),
  ].join(", ");
  const timing = active > 0
    ? "The launcher will wait for active sessions before cutover."
    : "The restart may begin immediately.";
  return `Restart Bridge now?\n\nCurrent activity: ${activity}.\n${timing}`;
}

function jobTypeLabel(type: ManagementJobType): string {
  switch (type) {
    case "self_update":
      return "Self update";
    case "staging_preview":
      return "Staging preview";
    case "staging_deploy":
      return "Staging deploy";
    default:
      return type;
  }
}

function statusLabel(status: ManagementJobStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

function shortJobId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatElapsed(start: string | undefined, end?: string): string {
  if (!start) return "—";
  const startTime = Date.parse(start);
  if (!Number.isFinite(startTime)) return "—";
  const endTime = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(endTime)) return "—";
  return formatDurationMs(Math.max(0, endTime - startTime));
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function heartbeatAgeMs(job: ManagementJobSummary, fetchedAt: string | undefined): number | undefined {
  if (typeof job.heartbeatAgeMs === "number" && Number.isFinite(job.heartbeatAgeMs)) {
    return Math.max(0, job.heartbeatAgeMs);
  }
  if (!job.heartbeatAt) return undefined;
  const heartbeatTime = Date.parse(job.heartbeatAt);
  const referenceTime = fetchedAt ? Date.parse(fetchedAt) : Date.now();
  if (!Number.isFinite(heartbeatTime) || !Number.isFinite(referenceTime)) return undefined;
  return Math.max(0, referenceTime - heartbeatTime);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(redactSensitive(value), null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!isPlainObject(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactSensitive(item);
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|api[-_]?key|private[-_]?key/i.test(key);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
