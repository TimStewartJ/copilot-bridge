import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  cancelSessionModelMove,
  fetchSessionModelMove,
  fetchSessionModelUsage,
  startSessionModelMove,
  type ModelInfo,
} from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { queryClient } from "../../queryClient";
import {
  isSessionModelMoveFinished,
  type SessionModelMoveJob,
  type SessionModelMoveRequest,
  type SessionModelMoveResult,
  type SessionModelUsage,
} from "../../../shared/session-model-move.js";
import { DS, cx } from "../../design/tokens";
import { Button, Details, DisclosureRow, Notice, SettingList, SettingRow } from "../../design/primitives";

const POLL_INTERVAL_MS = 1_500;
/** A move can leave hundreds of chats behind when it stops early; the list shows the first of them. */
const MAX_LISTED_RESULTS = 50;

function countChats(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "chat" : "chats"}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The headline for a move that is over. */
export function describeMoveOutcome(job: SessionModelMoveJob, fromName: string, toName: string): string {
  if (job.total === 0) return `No chats are on ${fromName}`;
  const moved = `Moved ${job.counts.moved.toLocaleString()} of ${countChats(job.total)} from ${fromName} to ${toName}`;
  return job.status === "completed" ? moved : `Stopped early. ${moved}`;
}

/** Why the chats that did not move were left, as short phrases. */
export function describeMoveLeftovers(job: SessionModelMoveJob, toName: string): string[] {
  const { counts } = job;
  const notTried = job.total - job.processed;
  return [
    counts.busy > 0 && `${counts.busy.toLocaleString()} busy`,
    counts["needs-compaction"] > 0 && `${counts["needs-compaction"].toLocaleString()} too long for ${toName}`,
    counts.changed > 0 && `${counts.changed.toLocaleString()} switched by hand meanwhile`,
    counts.failed > 0 && `${counts.failed.toLocaleString()} failed`,
    notTried > 0 && `${notTried.toLocaleString()} not tried`,
  ].filter((part): part is string => typeof part === "string");
}

function describeResult(result: SessionModelMoveResult): string {
  switch (result.outcome) {
    case "busy":
      return "Busy";
    case "needs-compaction":
      return result.detail ? `Too long (${result.detail})` : "Too long for the new model";
    case "changed":
      return result.detail ?? "Switched by hand meanwhile";
    default:
      return result.detail ?? "Failed";
  }
}

/**
 * Moves every chat that is not archived from one model to another, for when a model is replaced.
 * It is used every few weeks at most, so it is one closed line under the model setting. The server
 * does the work one chat at a time; this shows the choice, the progress and the result.
 */
export function ModelMoveDisclosure() {
  const { data: models } = useModelsQuery();
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<SessionModelUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [fromModel, setFromModel] = useState("");
  const [toModel, setToModel] = useState("");
  const [job, setJob] = useState<SessionModelMoveJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const modelName = useCallback(
    (id: string) => models?.find((model) => model.id === id)?.name ?? id,
    [models],
  );

  const loadUsage = useCallback(async (refresh: boolean) => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const next = await fetchSessionModelUsage({ refresh });
      if (!mounted.current) return;
      setUsage(next);
      // A model with no chats left is no longer a choice.
      setFromModel((current) => (next.models.some((entry) => entry.model === current) ? current : ""));
    } catch (loadError) {
      if (mounted.current) setUsageError(errorText(loadError));
    } finally {
      if (mounted.current) setUsageLoading(false);
    }
  }, []);

  /** Takes the server's view of the move, and refreshes what depends on it once the move is over. */
  const applyJob = useCallback((next: SessionModelMoveJob, previous: SessionModelMoveJob | null) => {
    setJob(next);
    if (!isSessionModelMoveFinished(next.status)) return;
    if (previous && isSessionModelMoveFinished(previous.status) && previous.id === next.id) return;
    setStopping(false);
    // Chats open in this browser show their model from a cached read.
    void queryClient.invalidateQueries({ queryKey: ["session-model"] });
    void loadUsage(true);
  }, [loadUsage]);

  // A move started from another tab or a script is picked up while it runs.
  useEffect(() => {
    let cancelled = false;
    void fetchSessionModelMove()
      .then((state) => {
        if (!cancelled && state.job?.status === "running") {
          setJob(state.job);
          setOpen(true);
        }
      })
      .catch(() => {
        // The section still works without knowing about an earlier move.
      });
    return () => { cancelled = true; };
  }, []);

  const running = job?.status === "running";
  useEffect(() => {
    if (!running || !job) return;
    const timer = setInterval(() => {
      void fetchSessionModelMove()
        .then((state) => {
          if (!mounted.current) return;
          if (state.job) {
            applyJob(state.job, job);
            return;
          }
          // The server restarted and forgot the move; the chats it had not reached are still on the old model.
          setJob(null);
          setStopping(false);
          setError("The server restarted before the move finished. Chats already moved stay moved.");
          void loadUsage(true);
        })
        .catch(() => {
          // Keep polling: a missed read during a move is not worth an error.
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, job, applyJob, loadUsage]);

  const toggle = (next: boolean) => {
    setOpen(next);
    if (next && !job && !usage && !usageLoading) void loadUsage(false);
  };

  /** Puts a finished move away and closes the line. */
  const dismiss = () => {
    setOpen(false);
    setError(null);
    setJob(null);
  };

  const start = async (request: SessionModelMoveRequest) => {
    setStarting(true);
    setError(null);
    try {
      applyJob(await startSessionModelMove(request), null);
    } catch (startError) {
      if (mounted.current) setError(errorText(startError));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      const state = await cancelSessionModelMove();
      if (mounted.current && state.job) applyJob(state.job, job);
    } catch (stopError) {
      if (mounted.current) {
        setStopping(false);
        setError(errorText(stopError));
      }
    }
  };

  const availableModels: ModelInfo[] = (models ?? [])
    .filter((model) => !model.policy || model.policy.state !== "disabled")
    .sort((left, right) => left.name.localeCompare(right.name));
  const fromUsage = usage?.models.find((entry) => entry.model === fromModel);
  const canStart = Boolean(fromUsage && toModel && toModel !== fromModel) && !starting;

  const formRows = (
    <>
      <SettingRow
        label="From"
        htmlFor="model-move-from"
        hint={fromUsage && fromUsage.busyCount > 0
          ? `${countChats(fromUsage.busyCount)} busy now. Busy chats are skipped.`
          : undefined}
        control={usage ? (
          <select
            id="model-move-from"
            value={fromModel}
            onChange={(event) => {
              setFromModel(event.target.value);
              if (event.target.value === toModel) setToModel("");
            }}
            disabled={starting}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
          >
            <option value="">Choose a model</option>
            {usage.models.map((entry) => (
              <option key={entry.model} value={entry.model}>
                {modelName(entry.model)} · {countChats(entry.sessionCount)}
              </option>
            ))}
          </select>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
            {usageLoading && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {usageLoading ? "Counting chats…" : "Not counted"}
          </span>
        )}
      >
        {usageError && (
          <Notice tone="danger" title="Could not count the chats"
            action={<Button size="sm" onClick={() => void loadUsage(true)}>Retry</Button>}>
            {usageError}
          </Notice>
        )}
      </SettingRow>
      <SettingRow
        label="To"
        htmlFor="model-move-to"
        control={(
          <select
            id="model-move-to"
            value={toModel}
            onChange={(event) => setToModel(event.target.value)}
            disabled={starting}
            className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.field)}
          >
            <option value="">Choose a model</option>
            {availableModels.filter((model) => model.id !== fromModel).map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        )}
      />
      <div className="py-3 last:pb-0">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!canStart}
            onClick={() => void start({ fromModel, toModel })}
            icon={starting ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : undefined}
          >
            {fromUsage ? `Move ${countChats(fromUsage.sessionCount)}` : "Move chats"}
          </Button>
          {usage && (
            <Button size="sm" variant="ghost" onClick={() => void loadUsage(true)} disabled={usageLoading || starting}>
              {usageLoading ? "Counting…" : "Count again"}
            </Button>
          )}
        </div>
      </div>
    </>
  );

  const fromName = job ? modelName(job.fromModel) : "";
  const toName = job ? modelName(job.toModel) : "";
  const retryRequest: SessionModelMoveRequest | null = job ? {
    fromModel: job.fromModel,
    toModel: job.toModel,
    ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
    ...(job.contextTier ? { contextTier: job.contextTier } : {}),
  } : null;
  const leftovers = job ? describeMoveLeftovers(job, toName) : [];
  const leftBehind = job ? job.results.filter((result) => result.outcome !== "moved") : [];
  const retryable = job ? job.counts.busy + job.counts.failed + (job.total - job.processed) : 0;
  const needCompaction = job?.counts["needs-compaction"] ?? 0;

  return (
    <DisclosureRow
      inline
      label="Move existing chats to another model"
      meta={job && running ? `${job.processed.toLocaleString()} of ${job.total.toLocaleString()}` : undefined}
      live={running}
      expanded={open}
      onToggle={toggle}
      className="mt-1"
    >
      {!job && (
        <p className={cx(DS.field.help, "max-w-[72ch] pt-2 leading-relaxed")}>
          Switches every chat that is not archived, one at a time, most recent first. Each keeps its reasoning effort
          and context size where the new model has them. A chat that is busy, or too long for the new model, is left
          as it is and listed afterwards.
        </p>
      )}
      <SettingList className="pt-3">
        {job && running && (
          <SettingRow
            label={`Moving chats from ${fromName} to ${toName}`}
            hint={<span role="status">{job.processed.toLocaleString()} of {countChats(job.total)}</span>}
            control={(
              <Button size="sm" onClick={() => void stop()} disabled={stopping || job.cancelRequested}>
                {stopping || job.cancelRequested ? "Stopping…" : "Stop"}
              </Button>
            )}
          >
            <div className={DS.meter.track}>
              <div
                className={cx(DS.meter.fill, "transition-[width] duration-500 motion-reduce:transition-none")}
                style={{ width: `${Math.max(2, (job.processed / Math.max(1, job.total)) * 100)}%` }}
              />
            </div>
          </SettingRow>
        )}

        {job && !running && retryRequest && (
          <div className="py-3 first:pt-0 last:pb-0">
            <Notice
              tone={job.status === "completed" && leftovers.length === 0 ? "success" : "warning"}
              title={describeMoveOutcome(job, fromName, toName)}
            >
              {leftovers.length > 0 && <p>Left as they were: {leftovers.join(", ")}.</p>}
              {job.stopReason && <p className="break-words">{job.stopReason}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {needCompaction > 0 && (
                  <Button size="sm" disabled={starting} onClick={() => void start({ ...retryRequest, compact: true })}>
                    Compact and move {countChats(needCompaction)}
                  </Button>
                )}
                {retryable > 0 && (
                  <Button size="sm" disabled={starting}
                    onClick={() => void start({ ...retryRequest, ...(job.compact ? { compact: true } : {}) })}>
                    Try the rest again
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={starting}
                  onClick={() => { setJob(null); if (!usage && !usageLoading) void loadUsage(false); }}>
                  Move other chats
                </Button>
                <Button size="sm" variant="ghost" disabled={starting} onClick={dismiss}>Done</Button>
              </div>
            </Notice>
            {leftBehind.length > 0 && (
              <Details label="Chats that did not move" detail={leftBehind.length.toLocaleString()} className="mt-3">
                <ul className={cx(DS.surface.divided, "pt-1 text-xs")}>
                  {leftBehind.slice(0, MAX_LISTED_RESULTS).map((result) => (
                    <li key={result.sessionId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
                      <span className="min-w-0 truncate text-text-primary">{result.title ?? result.sessionId.slice(0, 8)}</span>
                      <span className="min-w-0 break-words text-text-secondary">{describeResult(result)}</span>
                    </li>
                  ))}
                </ul>
                {leftBehind.length > MAX_LISTED_RESULTS && (
                  <p className={cx(DS.field.help, "pt-1")}>
                    And {(leftBehind.length - MAX_LISTED_RESULTS).toLocaleString()} more.
                  </p>
                )}
              </Details>
            )}
          </div>
        )}

        {!job && formRows}
      </SettingList>

      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
    </DisclosureRow>
  );
}
