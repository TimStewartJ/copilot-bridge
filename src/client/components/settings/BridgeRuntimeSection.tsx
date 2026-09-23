import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Power, Trash2 } from "lucide-react";
import type { BridgeRuntimeStatus } from "../../bridge-management-api";
import type { AgentBackendLifecycleState, AgentBackendStatus } from "../../../shared/agent-backend-status.js";
import type { ManagementJobFilters, ManagementJobStatus, ManagementJobSummary, ManagementJobType } from "../../management-job-api";
import {
  useEnqueueManagementJobMutation,
  useManagementJobsQuery,
} from "../../hooks/queries/useManagementJobs";
import {
  useBridgeRuntimeStatusQuery,
  useEvictIdleCacheMutation,
  useRestartBridgeMutation,
} from "../../hooks/queries/useBridgeRuntimeStatus";
import { useRestartStatusQuery } from "../../hooks/queries/useRestartStatus";
import { Badge, Details, Notice, SettingList, SettingRow, StatRow, StatusIcon } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { SettingsSection } from "./SettingsSection";
import {
  formatCapacityValue,
  formatDateTime,
  formatDurationMs,
  formatError,
  jobTypeLabel,
  plural,
  shortJobId,
} from "./management-format";

const ACTIVE_STATUSES = new Set<ManagementJobStatus>(["queued", "running"]);
const EXCLUSIVE_JOB_TYPES = new Set<ManagementJobType>(["self_update", "staging_deploy"]);
const ACTIVE_JOB_FILTERS: ManagementJobFilters = { statuses: ["queued", "running"], limit: 200 };

type RuntimeStatusWithAgentBackend = BridgeRuntimeStatus & { agentBackend?: AgentBackendStatus };

/** A backend that is up is ordinary and carries no colour; only trouble does. */
const BACKEND_TONE: Record<AgentBackendLifecycleState, "neutral" | "warning" | "danger"> = {
  ready: "neutral",
  starting: "warning",
  reconnecting: "warning",
  disconnected: "danger",
  stopped: "neutral",
};

/**
 * What the Bridge is doing and the controls that act on the whole Bridge: restart, self-update and
 * the idle session cache. The live figures behind the one-line summaries open on request.
 */
export function BridgeRuntimeSection({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const runtimeQuery = useBridgeRuntimeStatusQuery();
  const restartStatusQuery = useRestartStatusQuery();
  const activeJobsQuery = useManagementJobsQuery(ACTIVE_JOB_FILTERS);
  const enqueueMutation = useEnqueueManagementJobMutation();
  const restartMutation = useRestartBridgeMutation();
  const evictIdleCacheMutation = useEvictIdleCacheMutation();

  const runtimeStatus = runtimeQuery.data as RuntimeStatusWithAgentBackend | undefined;
  const activeJobs = activeJobsQuery.data?.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)) ?? [];
  const activeExclusiveJob = activeJobs.find((job) => EXCLUSIVE_JOB_TYPES.has(job.type)) ?? null;
  const controlBusy = enqueueMutation.isPending || restartMutation.isPending || evictIdleCacheMutation.isPending;

  const refetchRef = useRef<() => void>(() => undefined);
  refetchRef.current = () => {
    void runtimeQuery.refetch();
    void restartStatusQuery.refetch();
    void activeJobsQuery.refetch();
  };
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refetchRef.current();
  }, [refreshSignal]);

  const handleSelfUpdate = useCallback(async () => {
    const confirmed = window.confirm(
      "Queue a Bridge self-update job?\n\nThe launcher will pull the latest source, validate it, and restart the Bridge if the update succeeds.",
    );
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const result = await enqueueMutation.mutateAsync({ type: "self_update" });
      setActionMessage(
        result.reused
          ? `Using existing self-update job ${shortJobId(result.job.id)}.`
          : `Self-update queued as ${shortJobId(result.job.id)}.`,
      );
      void activeJobsQuery.refetch();
      void runtimeQuery.refetch();
    } catch (error) {
      setActionError(`Self-update failed to queue: ${formatError(error)}`);
    }
  }, [activeJobsQuery, enqueueMutation, runtimeQuery]);

  const handleRestart = useCallback(async (now: boolean) => {
    if (now && !window.confirm(buildRestartNowConfirmation(runtimeStatus))) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const result = await restartMutation.mutateAsync(now ? { force: true, resume: true } : undefined);
      setActionMessage(
        now
          ? `Restarting now. ${result.resumingRuns ?? 0} running session${result.resumingRuns === 1 ? "" : "s"} will resume afterwards.`
          : "Restart requested. It happens once the Bridge is idle and blocks nothing until then.",
      );
      void runtimeQuery.refetch();
      void restartStatusQuery.refetch();
    } catch (error) {
      setActionError(`Restart failed: ${formatError(error)}`);
    }
  }, [restartMutation, restartStatusQuery, runtimeQuery, runtimeStatus]);

  const cacheCapacity = runtimeStatus?.capacity.cache;
  const idleCachedSessions = cacheCapacity
    ? Math.max(0, cacheCapacity.readyParents - cacheCapacity.protectedParents)
    : 0;

  const handleEvictIdleCache = useCallback(async () => {
    const confirmed = window.confirm(
      `Evict ${idleCachedSessions} idle cached session${idleCachedSessions === 1 ? "" : "s"}?\n\n`
      + "Active sessions and sessions with running agents are protected. Evicted sessions will resume from disk when used again.",
    );
    if (!confirmed) return;

    setActionError(null);
    setActionMessage(null);
    try {
      const result = await evictIdleCacheMutation.mutateAsync();
      const protectedSummary = result.protectedSessions > 0
        ? ` ${result.protectedSessions} protected session${result.protectedSessions === 1 ? " was" : "s were"} kept warm.`
        : "";
      setActionMessage(
        result.evictedSessions > 0
          ? `Evicted ${result.evictedSessions} idle cached session${result.evictedSessions === 1 ? "" : "s"}.${protectedSummary}`
          : `No idle cached sessions were evicted.${protectedSummary}`,
      );
      await runtimeQuery.refetch();
    } catch (error) {
      setActionError(`Idle cache eviction failed: ${formatError(error)}`);
    }
  }, [evictIdleCacheMutation, idleCachedSessions, runtimeQuery]);

  const selfUpdateDisabledReason = getSelfUpdateDisabledReason({
    runtime: runtimeStatus,
    runtimeError: runtimeQuery.error,
    activeExclusiveJob,
    busy: controlBusy,
  });
  const restartDisabledReason = getRestartDisabledReason({
    runtime: runtimeStatus,
    runtimeError: runtimeQuery.error,
    busy: controlBusy,
  });
  const evictIdleCacheDisabledReason = controlBusy
    ? "Another management control is in progress."
    : !runtimeStatus
      ? "Runtime cache status is unavailable."
      : idleCachedSessions === 0
        ? "No idle cached sessions to evict."
        : null;
  const restartPending = restartStatusQuery.data?.pending === true;
  const loading = runtimeQuery.isLoading && !runtimeQuery.data;

  return (
    <>
      <SettingsSection title="Status">
        {runtimeQuery.error && !runtimeStatus ? (
          <Notice tone="danger" title="Runtime status unavailable">{formatError(runtimeQuery.error)}</Notice>
        ) : (
          <SettingList>
            <ActivityRow status={runtimeStatus ?? null} loading={loading} />
            <BackendRow backend={runtimeStatus?.agentBackend ?? null} loading={loading} />
            <CapacityRow status={runtimeStatus ?? null} loading={loading} />
          </SettingList>
        )}
        {runtimeStatus && <RuntimeDetails status={runtimeStatus} />}
      </SettingsSection>

      <SettingsSection title="Controls">
        <SettingList>
          <SettingRow
            label="Restart Bridge"
            hint={restartDisabledReason ?? (restartPending
              ? "A restart is pending. It happens once every session and job is idle, and blocks nothing until then."
              : "Restart when idle waits for every session and job, and blocks nothing. Restart now stops running sessions and resumes them afterwards.")}
            control={(
              <>
                <button
                  type="button"
                  onClick={() => void handleRestart(false)}
                  disabled={Boolean(restartDisabledReason)}
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "gap-1.5")}
                >
                  {restartMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                  {restartMutation.isPending ? "Requesting…" : "Restart when idle"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRestart(true)}
                  disabled={Boolean(restartDisabledReason)}
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.danger, "gap-1.5")}
                >
                  {restartMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
                  {restartMutation.isPending ? "Requesting…" : "Restart now"}
                </button>
              </>
            )}
          />
          <SettingRow
            label="Self-update"
            hint={selfUpdateDisabledReason ?? "Pull the latest source, validate it and restart, rolling back if activation fails."}
            control={(
              <button
                type="button"
                onClick={() => void handleSelfUpdate()}
                disabled={Boolean(selfUpdateDisabledReason)}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "gap-1.5")}
              >
                {enqueueMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {enqueueMutation.isPending ? "Queueing…" : "Queue self-update"}
              </button>
            )}
          />
          <SettingRow
            label="Idle session cache"
            hint={evictIdleCacheDisabledReason ?? `${plural(idleCachedSessions, "idle cached session")} can be evicted now.`}
            control={(
              <button
                type="button"
                onClick={() => void handleEvictIdleCache()}
                disabled={Boolean(evictIdleCacheDisabledReason)}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1.5")}
              >
                {evictIdleCacheMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {evictIdleCacheMutation.isPending ? "Evicting…" : "Evict idle cache"}
              </button>
            )}
          />
        </SettingList>
        {actionError && <Notice tone="danger" className="mt-3">{actionError}</Notice>}
        {actionMessage && <p role="status" className={cx(DS.field.help, "mt-3")}>{actionMessage}</p>}
      </SettingsSection>
    </>
  );
}

function ActivityRow({ status, loading }: { status: RuntimeStatusWithAgentBackend | null; loading: boolean }) {
  const sessions = status?.sessions;
  const agents = status?.agents;
  const problems = [
    (sessions?.stalled ?? 0) > 0 && plural(sessions!.stalled, "stalled session"),
    (agents?.failed ?? 0) > 0 && plural(agents!.failed, "failed agent"),
  ].filter(Boolean) as string[];
  const summary = loading || !status
    ? "Checking…"
    : [
      plural(sessions?.active ?? 0, "active session"),
      `${sessions?.waitingForUserInput ?? 0} waiting for input`,
      plural(agents?.running ?? 0, "agent") + " running",
    ].join(" · ");
  return (
    <SettingRow
      label="Activity"
      hint={summary}
      control={problems.length > 0 ? (
        <Badge tone="warning"><StatusIcon kind="warning" decorative />{problems.join(" · ")}</Badge>
      ) : undefined}
    />
  );
}

function BackendRow({ backend, loading }: { backend: AgentBackendStatus | null; loading: boolean }) {
  if (!backend) {
    return (
      <SettingRow
        label="Agent backend"
        hint={loading ? "Checking…" : "Agent backend status is unavailable from this server version."}
      />
    );
  }
  return (
    <SettingRow
      label="Agent backend"
      hint={`Connection ${backend.connection ?? "unknown"} · started ${formatDateTime(backend.createdAt)}`}
      control={<Badge tone={BACKEND_TONE[backend.state]}>{backend.state}</Badge>}
    >
      {backend.lastRecoveryError && (
        <p className="text-xs text-error">Last recovery error: {backend.lastRecoveryError}</p>
      )}
    </SettingRow>
  );
}

function CapacityRow({ status, loading }: { status: RuntimeStatusWithAgentBackend | null; loading: boolean }) {
  const capacity = status?.capacity;
  if (!capacity) {
    return (
      <SettingRow
        label="Capacity"
        hint={loading ? "Checking…" : "Capacity statistics are unavailable from this server version."}
      />
    );
  }
  return (
    <SettingRow
      label="Capacity"
      hint={`${formatCapacityValue(capacity.contexts.used)} of ${formatCapacityValue(capacity.contexts.limit)} live contexts · ${formatCapacityValue(capacity.weightedUnits.used)} of ${formatCapacityValue(capacity.weightedUnits.limit)} weighted units`}
    >
      {capacity.cleanup.failed > 0 && (
        <Notice tone="danger" icon={<AlertTriangle size={14} />}>
          New work is blocked while {capacity.cleanup.failed} failed cleanup{capacity.cleanup.failed === 1 ? "" : "s"} remain. Bridge retries these automatically; restart if the count does not clear.
        </Notice>
      )}
      {capacity.cleanup.failed === 0 && capacity.waitingRequests > 0 && (
        <Notice tone="warning" icon={<AlertTriangle size={14} />}>
          {capacity.waitingRequests} request{capacity.waitingRequests === 1 ? " is" : "s are"} waiting for live capacity or cleanup headroom.
        </Notice>
      )}
    </SettingRow>
  );
}

function RuntimeDetails({ status }: { status: RuntimeStatusWithAgentBackend }) {
  const { sessions, agents, capacity } = status;
  const backend = status.agentBackend;
  return (
    <Details label="Activity and capacity details" detail={`Updated ${formatDateTime(status.fetchedAt)}`} className="mt-3">
      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <StatRow stats={[
            { label: "Active sessions", value: sessions.active },
            { label: "Stalled sessions", value: sessions.stalled },
            { label: "Awaiting input", value: sessions.waitingForUserInput },
            { label: "Agents running", value: agents.running },
            { label: "Agents idle", value: agents.idle },
            { label: "Agents failed", value: agents.failed },
          ]} />
          <p className={DS.text.meta}>
            PID {status.pid ?? "unknown"} · Uptime {formatDurationMs(status.uptimeSeconds * 1_000)} · {agents.total} tracked agents in {agents.liveSessions} live session snapshots
            {agents.staleSessions > 0 && ` · ${agents.staleSessions} stale snapshot${agents.staleSessions === 1 ? "" : "s"} excluded`}
            {agents.unknownSessions > 0 && ` · ${agents.unknownSessions} snapshot${agents.unknownSessions === 1 ? "" : "s"} unavailable`}
          </p>
        </div>

        {backend && (
          <div className="space-y-1 text-xs text-text-secondary">
            <p className={DS.text.sectionLabel}>Agent backend</p>
            <p>Connection {backend.connection ?? "unknown"} · PID {backend.pid ?? "unknown"} · Backend started {formatDateTime(backend.createdAt)}</p>
            {backend.lastDisconnect && (
              <p>
                Last disconnect {formatDateTime(backend.lastDisconnect.at)}: {backend.lastDisconnect.reason}
                {backend.lastDisconnect.detail ? ` - ${backend.lastDisconnect.detail}` : ""}
              </p>
            )}
            <p className={DS.text.meta}>
              Disconnects {backend.disconnectCount} · Recoveries {backend.recoveryCount} · Interrupted {backend.lastInterruptedSessionCount} · Auto-resumed {backend.lastAutoResumedSessionCount}
            </p>
          </div>
        )}

        {capacity && (
          <div className="space-y-2">
            <StatRow stats={[
              { label: "Live contexts", value: `${formatCapacityValue(capacity.contexts.used)} / ${formatCapacityValue(capacity.contexts.limit)}` },
              { label: "Weighted units", value: `${formatCapacityValue(capacity.weightedUnits.used)} / ${formatCapacityValue(capacity.weightedUnits.limit)}` },
              { label: "Local MCP slots", value: formatCapacityValue(capacity.localMcpSlots.used) },
              { label: "Waiting requests", value: capacity.waitingRequests },
            ]} />
            <div className="grid gap-3 @[34rem]/settings-content:grid-cols-2">
              <CapacityBar label="Context pressure" used={capacity.contexts.used} retained={capacity.contexts.retained} limit={capacity.contexts.limit} />
              <CapacityBar label="Weighted pressure" used={capacity.weightedUnits.used} retained={capacity.weightedUnits.retained} limit={capacity.weightedUnits.limit} />
            </div>
            <p className={DS.text.meta}>
              Parent cache {capacity.cache.readyParents}/{capacity.cache.limit}, {capacity.cache.protectedParents} protected · Cleanup {capacity.cleanup.pending} pending, {capacity.cleanup.failed} failed, limit {capacity.cleanup.limit} · Local MCP weight +{formatCapacityValue(capacity.localMcpWeight)} per context · Capacity wait {formatCapacityValue(capacity.waitTimeoutSeconds)}s
            </p>
            <p className={DS.field.help}>
              Admission uses a hard live-context limit and an MCP-weighted unit budget. Idle cached parents can be evicted and do not count as used.
            </p>
          </div>
        )}
      </div>
    </Details>
  );
}

function CapacityBar({ label, used, retained, limit }: { label: string; used: number; retained: number; limit: number }) {
  const percentage = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className="tabular-nums text-text-secondary">
          {formatCapacityValue(used)} used, {formatCapacityValue(retained)} retained
        </span>
      </div>
      <div className={cx(DS.meter.track, "mt-1.5")}>
        <div className={cx(DS.meter.fill, "transition-[width]")} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function getSelfUpdateDisabledReason({
  runtime,
  runtimeError,
  activeExclusiveJob,
  busy,
}: {
  runtime: RuntimeStatusWithAgentBackend | undefined;
  runtimeError: unknown;
  activeExclusiveJob: ManagementJobSummary | null;
  busy: boolean;
}): string | null {
  if (busy) return "A management request is being submitted.";
  if (!runtime) return runtimeError ? "Runtime availability could not be checked." : "Checking availability…";
  if (runtime.isStaging) return "Unavailable from staging previews.";
  if (!runtime.sourceManagementAvailable) return "Requires a source-managed Bridge checkout.";
  if (activeExclusiveJob) {
    return `${jobTypeLabel(activeExclusiveJob.type)} is already ${activeExclusiveJob.status}.`;
  }
  return null;
}

function getRestartDisabledReason({
  runtime,
  runtimeError,
  busy,
}: {
  runtime: RuntimeStatusWithAgentBackend | undefined;
  runtimeError: unknown;
  busy: boolean;
}): string | null {
  if (busy) return "A management request is being submitted.";
  if (!runtime) return runtimeError ? "Runtime availability could not be checked." : "Checking availability…";
  if (runtime.isStaging) return "Unavailable from staging previews.";
  return null;
}

function buildRestartNowConfirmation(runtime: RuntimeStatusWithAgentBackend | undefined): string {
  const active = runtime?.sessions.active ?? 0;
  return `Restart Bridge now?\n\n${active} running session${active === 1 ? "" : "s"} will stop and pick up where ${active === 1 ? "it" : "they"} left off once the Bridge is back.`;
}
