import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, RotateCcw, RotateCw, XCircle } from "lucide-react";
import {
  MANAGEMENT_JOB_STATUSES,
  MANAGEMENT_JOB_TYPES,
  type ManagementJobDetail,
  type ManagementJobFilters,
  type ManagementJobStatus,
  type ManagementJobSummary,
  type ManagementJobType,
} from "../../management-job-api";
import {
  useCancelManagementJobMutation,
  useManagementJobQuery,
  useManagementJobsQuery,
  useRetryManagementJobMutation,
} from "../../hooks/queries/useManagementJobs";
import { timeAgo } from "../../time";
import { Badge, Button, Details, EmptyHint, Notice, StatusIcon } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { SettingsSection } from "./SettingsSection";
import {
  formatDateTime,
  formatDurationMs,
  formatElapsed,
  formatError,
  formatJson,
  heartbeatAgeMs,
  jobTypeLabel,
  plural,
  shortJobId,
  statusLabel,
} from "./management-format";

const JOB_TYPES = MANAGEMENT_JOB_TYPES;
const JOB_STATUSES = MANAGEMENT_JOB_STATUSES;
const ACTIVE_STATUSES = new Set<ManagementJobStatus>(["queued", "running"]);
const RETRYABLE_STATUSES = new Set<ManagementJobStatus>(["failed", "cancelled"]);
const CONFIRMATION_TYPES = new Set<ManagementJobType>(["self_update", "staging_deploy"]);
const LIMITS = [10, 25, 50, 100, 200];
const ACTIVE_JOB_FILTERS: ManagementJobFilters = { statuses: ["queued", "running"], limit: 200 };

type JobTypeFilter = "all" | ManagementJobType;
type JobStatusFilter = "all" | ManagementJobStatus;

/**
 * Launcher-supervised jobs: self-update, staging preview and deploy. Queued and running jobs are
 * always shown; history is one line per job and opens beneath the row that was chosen.
 */
export function ManagementJobsSection({ refreshSignal = 0, open = false }: { refreshSignal?: number; open?: boolean }) {
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [limit, setLimit] = useState(10);
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
  const cancelMutation = useCancelManagementJobMutation();
  const retryMutation = useRetryManagementJobMutation();

  const activeList = activeJobsQuery.data ?? null;
  const recentList = jobsQuery.data ?? null;
  const list = activeList ?? recentList;
  const activeJobs = useMemo(
    () => activeList?.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)) ?? [],
    [activeList],
  );
  const recentJobs = useMemo(
    () => recentList?.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status)) ?? [],
    [recentList],
  );
  const actionBusy = cancelMutation.isPending || retryMutation.isPending;

  const refetchRef = useRef<() => void>(() => undefined);
  refetchRef.current = () => {
    void activeJobsQuery.refetch();
    void jobsQuery.refetch();
    if (selectedJobId) void detailQuery.refetch();
  };
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refetchRef.current();
  }, [refreshSignal]);

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

  const staleCount = list?.staleCount ?? activeJobs.filter((job) => job.stale).length;
  const latest = recentJobs[0];
  const summary = [
    activeList || recentList ? `${activeJobs.length} active` : "Checking…",
    latest && `last: ${jobTypeLabel(latest.type).toLowerCase()} ${statusLabel(latest.status)} ${timeAgo(latest.completedAt ?? latest.updatedAt ?? latest.createdAt)}`,
  ].filter(Boolean).join(" · ");
  const rowProps = {
    selectedJobId,
    staleAfterMs: list?.staleAfterMs,
    fetchedAt: list?.fetchedAt,
    detail: detailQuery.data ?? null,
    detailLoading: Boolean(selectedJobId) && detailQuery.isLoading && !detailQuery.data,
    detailError: detailQuery.error ?? null,
    onRefreshDetail: () => void detailQuery.refetch(),
    onToggle: (jobId: string) => setSelectedJobId((current) => (current === jobId ? null : jobId)),
    onCancel: handleCancel,
    onRetry: handleRetry,
    actionBusy,
  };

  return (
    <SettingsSection id="settings-system-jobs" title="Management jobs" description={summary}>
      <div className="space-y-3">
        {(activeJobsQuery.error || jobsQuery.error) && (
          <Notice tone="danger">Failed to load management jobs: {formatError(activeJobsQuery.error ?? jobsQuery.error)}</Notice>
        )}
        {actionError && <Notice tone="danger">{actionError}</Notice>}
        {actionMessage && <p role="status" className={DS.field.help}>{actionMessage}</p>}
        {staleCount > 0 && (
          <Notice tone="warning" icon={<AlertTriangle size={14} />} title={`${plural(staleCount, "running job")} look stale`}>
            No heartbeat for over {list?.staleAfterMs ? formatDurationMs(list.staleAfterMs) : "the stale limit"}. Runner health is inferred from job heartbeats.
          </Notice>
        )}

        {activeJobsQuery.isLoading && !activeList ? (
          <p role="status" className={DS.field.help}>Loading management jobs…</p>
        ) : activeJobs.length > 0 && (
          <JobList jobs={activeJobs} {...rowProps} />
        )}

        <Details label="Recent jobs" detail={recentList ? `${recentJobs.length} shown` : undefined} open={open || undefined}>
          <div className="space-y-2 pt-2">
            <FilterControls
              typeFilter={typeFilter}
              statusFilter={statusFilter}
              limit={limit}
              onTypeFilterChange={setTypeFilter}
              onStatusFilterChange={setStatusFilter}
              onLimitChange={setLimit}
            />
            {jobsQuery.isLoading && !recentList ? (
              <p role="status" className={DS.field.help}>Loading management jobs…</p>
            ) : recentJobs.length === 0 ? (
              <EmptyHint>No recent matching jobs.</EmptyHint>
            ) : (
              <JobList jobs={recentJobs} {...rowProps} />
            )}
          </div>
        </Details>
      </div>
    </SettingsSection>
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
  const select = cx(DS.field.input, DS.field.inputSize.sm);
  return (
    <div className="grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-3">
      <select aria-label="Management job type filter" value={typeFilter}
        onChange={(event) => onTypeFilterChange(event.target.value as JobTypeFilter)} className={select}>
        <option value="all">All types</option>
        {JOB_TYPES.map((type) => <option key={type} value={type}>{jobTypeLabel(type)}</option>)}
      </select>
      <select aria-label="Management job status filter" value={statusFilter}
        onChange={(event) => onStatusFilterChange(event.target.value as JobStatusFilter)} className={select}>
        <option value="all">All statuses</option>
        {JOB_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
      </select>
      <select aria-label="Management job limit filter" value={limit}
        onChange={(event) => onLimitChange(Number(event.target.value))} className={select}>
        {LIMITS.map((value) => <option key={value} value={value}>Last {value}</option>)}
      </select>
    </div>
  );
}

interface JobRowProps {
  selectedJobId: string | null;
  staleAfterMs?: number;
  fetchedAt?: string;
  detail: ManagementJobDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  onRefreshDetail: () => void;
  onToggle: (jobId: string) => void;
  onCancel: (job: ManagementJobSummary) => void;
  onRetry: (job: ManagementJobSummary) => void;
  actionBusy: boolean;
}

function JobList({ jobs, ...rowProps }: JobRowProps & { jobs: ManagementJobSummary[] }) {
  return (
    <div className={DS.surface.divided}>
      {jobs.map((job) => <JobRow key={job.id} job={job} {...rowProps} />)}
    </div>
  );
}

function JobRow({
  job,
  selectedJobId,
  staleAfterMs,
  fetchedAt,
  detail,
  detailLoading,
  detailError,
  onRefreshDetail,
  onToggle,
  onCancel,
  onRetry,
  actionBusy,
}: JobRowProps & { job: ManagementJobSummary }) {
  const selected = job.id === selectedJobId;
  const isRetryable = RETRYABLE_STATUSES.has(job.status);
  const when = job.completedAt ?? job.startedAt ?? job.createdAt;

  return (
    <div className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onToggle(job.id)}
          aria-expanded={selected}
          className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "flex-1 gap-2.5", selected && DS.row.selected)}
        >
          <ChevronRight size={13} aria-hidden="true" className={cx(DS.row.chevron, selected && DS.row.chevronOpen)} />
          <span className="shrink-0 font-medium text-text-primary">{jobTypeLabel(job.type)}</span>
          <code className={cx(DS.text.literal, "hidden sm:inline")}>{shortJobId(job.id)}</code>
          <JobStatusBadge status={job.status} stale={job.stale} />
          {job.cancelRequestedAt && <span className="text-[11px] text-warning">cancel requested</span>}
          <span className={cx(DS.row.trailing, "hidden sm:flex")}>
            <span title={formatDateTime(when)}>{timeAgo(when)}</span>
            <span>{formatElapsed(job.startedAt ?? job.createdAt, job.completedAt)}</span>
          </span>
        </button>
        {job.status === "queued" && (
          <Button size="sm" variant="danger" disabled={actionBusy} onClick={() => onCancel(job)}
            icon={actionBusy ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}>
            Cancel
          </Button>
        )}
        {job.status === "running" && (
          <Button size="sm" variant="ghost" disabled aria-label="Cancel unavailable"
            title="Running job cancellation is not enabled until cooperative cancellation is implemented.">
            <span className="hidden sm:inline">Cancel unavailable</span>
            <span className="sm:hidden">Cancel</span>
          </Button>
        )}
        {isRetryable && (
          <Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => onRetry(job)}
            icon={actionBusy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}>
            Retry
          </Button>
        )}
      </div>
      {selected && (
        <div className={cx(DS.rail, DS.motion.reveal, "pb-2")}>
          <JobDetail
            job={detail && detail.id === job.id ? detail : job}
            detail={detail && detail.id === job.id ? detail : null}
            loading={detailLoading}
            error={detailError}
            staleAfterMs={staleAfterMs}
            fetchedAt={fetchedAt}
            onRefresh={onRefreshDetail}
          />
        </div>
      )}
    </div>
  );
}

function JobDetail({
  job,
  detail,
  loading,
  error,
  staleAfterMs,
  fetchedAt,
  onRefresh,
}: {
  job: ManagementJobSummary | ManagementJobDetail;
  detail: ManagementJobDetail | null;
  loading: boolean;
  error: unknown;
  staleAfterMs?: number;
  fetchedAt?: string;
  onRefresh: () => void;
}) {
  const heartbeatAge = heartbeatAgeMs(job, fetchedAt);
  return (
    <div className="space-y-3 pt-1">
      {job.stale && (
        <Notice tone="warning" icon={<AlertTriangle size={14} />}>
          This running job appears stale{staleAfterMs ? ` because its heartbeat is older than ${formatDurationMs(staleAfterMs)}` : ""}.
        </Notice>
      )}
      {error ? <Notice tone="danger">Detail refresh failed: {formatError(error)}</Notice> : null}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className={cx(DS.text.meta, "min-w-0")}>
          Created {formatDateTime(job.createdAt)} · Started {formatDateTime(job.startedAt)}
          {" · "}Elapsed {formatElapsed(job.startedAt ?? job.createdAt, job.completedAt)}
          {job.completedAt && ` · Completed ${formatDateTime(job.completedAt)}`}
          {" · "}Heartbeat {heartbeatAge === undefined ? "—" : `${formatDurationMs(heartbeatAge)} ago`}
          {" · "}Runner PID {job.runnerPid === undefined ? "—" : String(job.runnerPid)}
          <span className="block break-all font-mono">{job.id}</span>
        </p>
        <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading}
          icon={loading ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}>
          Refresh detail
        </Button>
      </div>

      {job.error && (
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px] text-error">{job.error}</pre>
      )}

      {detail ? (
        <div className="space-y-1">
          <JsonDetails label="Input JSON" value={detail.input} />
          <JsonDetails label="Result JSON" value={detail.result} empty="No result recorded yet." />
        </div>
      ) : (
        <p className={DS.field.help}>{loading ? "Loading detail payload…" : "Detail payload is not loaded yet."}</p>
      )}

      <div>
        <p className={DS.text.sectionLabel}>Sanitized recent log tail</p>
        <pre className={cx(DS.surface.inset, "mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] text-text-secondary")}>
          {detail?.logTail?.trim() ? detail.logTail : "No log lines available."}
        </pre>
      </div>
    </div>
  );
}

function JsonDetails({ label, value, empty = "No value recorded." }: { label: string; value: unknown; empty?: string }) {
  const hasValue = value !== undefined && value !== null;
  return (
    <Details label={label}>
      {hasValue ? (
        <pre className={cx(DS.surface.inset, "mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] text-text-secondary")}>
          {formatJson(value)}
        </pre>
      ) : (
        <p className={cx(DS.field.help, "pt-1")}>{empty}</p>
      )}
    </Details>
  );
}

function JobStatusBadge({ status, stale }: { status: ManagementJobStatus; stale?: boolean }) {
  if (stale) return <Badge tone="warning"><StatusIcon kind="warning" decorative />Stale</Badge>;
  switch (status) {
    case "failed":
      return <Badge tone="danger"><StatusIcon kind="danger" decorative />{statusLabel(status)}</Badge>;
    case "running":
      return <Badge tone="neutral"><StatusIcon kind="working" decorative />{statusLabel(status)}</Badge>;
    case "succeeded":
      return <Badge tone="neutral"><StatusIcon kind="done" decorative />{statusLabel(status)}</Badge>;
    default:
      return <Badge tone="neutral">{statusLabel(status)}</Badge>;
  }
}

