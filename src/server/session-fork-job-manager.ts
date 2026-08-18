import { randomUUID } from "node:crypto";
import {
  isSessionForkJobTerminal,
  type SessionForkJob,
  type StartSessionForkResponse,
} from "../shared/session-fork.js";

export interface StartSessionForkInput {
  sourceSessionId: string;
  toEventId?: string;
}

interface CreateSessionForkJobManagerOptions {
  runFork: (input: StartSessionForkInput) => Promise<string>;
  now?: () => number;
  createId?: () => string;
  schedule?: (run: () => void) => void;
  terminalRetentionMs?: number;
  maxTerminalJobs?: number;
}

interface StoredSessionForkJob extends SessionForkJob {
  dedupeKey: string;
  toEventId?: string;
}

const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_TERMINAL_JOBS = 100;

function createDedupeKey(input: StartSessionForkInput): string {
  return `${input.sourceSessionId}\n${input.toEventId ?? ""}`;
}

function toSnapshot(job: StoredSessionForkJob): SessionForkJob {
  const { dedupeKey: _dedupeKey, toEventId: _toEventId, ...snapshot } = job;
  return { ...snapshot };
}

export function createSessionForkJobManager({
  runFork,
  now = Date.now,
  createId = randomUUID,
  schedule = (run) => { queueMicrotask(run); },
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  maxTerminalJobs = DEFAULT_MAX_TERMINAL_JOBS,
}: CreateSessionForkJobManagerOptions) {
  const jobs = new Map<string, StoredSessionForkJob>();
  const activeJobIdsByKey = new Map<string, string>();

  function pruneTerminalJobs(): void {
    const cutoff = now() - terminalRetentionMs;
    const terminalJobs = [...jobs.values()]
      .filter((job) => isSessionForkJobTerminal(job.status))
      .sort((left, right) => Date.parse(left.completedAt ?? left.updatedAt) - Date.parse(right.completedAt ?? right.updatedAt));

    for (const job of terminalJobs) {
      if (Date.parse(job.completedAt ?? job.updatedAt) < cutoff) {
        jobs.delete(job.id);
      }
    }

    const retainedTerminalJobs = terminalJobs.filter((job) => jobs.has(job.id));
    const overflow = retainedTerminalJobs.length - maxTerminalJobs;
    for (let index = 0; index < overflow; index += 1) {
      jobs.delete(retainedTerminalJobs[index].id);
    }
  }

  async function processJob(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job || job.status !== "queued") return;

    const startedAt = new Date(now()).toISOString();
    job.status = "running";
    job.startedAt = startedAt;
    job.updatedAt = startedAt;

    try {
      job.sessionId = await runFork({
        sourceSessionId: job.sourceSessionId,
        ...(job.toEventId ? { toEventId: job.toEventId } : {}),
      });
      job.status = "succeeded";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      const completedAt = new Date(now()).toISOString();
      job.completedAt = completedAt;
      job.updatedAt = completedAt;
      if (activeJobIdsByKey.get(job.dedupeKey) === job.id) {
        activeJobIdsByKey.delete(job.dedupeKey);
      }
      pruneTerminalJobs();
    }
  }

  function start(input: StartSessionForkInput): StartSessionForkResponse {
    pruneTerminalJobs();
    const dedupeKey = createDedupeKey(input);
    const activeJobId = activeJobIdsByKey.get(dedupeKey);
    if (activeJobId) {
      const activeJob = jobs.get(activeJobId);
      if (activeJob && !isSessionForkJobTerminal(activeJob.status)) {
        return { job: toSnapshot(activeJob), reused: true };
      }
      activeJobIdsByKey.delete(dedupeKey);
    }

    const timestamp = new Date(now()).toISOString();
    const job: StoredSessionForkJob = {
      id: createId(),
      sourceSessionId: input.sourceSessionId,
      status: "queued",
      bounded: Boolean(input.toEventId),
      createdAt: timestamp,
      updatedAt: timestamp,
      dedupeKey,
      ...(input.toEventId ? { toEventId: input.toEventId } : {}),
    };
    jobs.set(job.id, job);
    activeJobIdsByKey.set(dedupeKey, job.id);

    try {
      schedule(() => {
        void processJob(job.id);
      });
    } catch (error) {
      jobs.delete(job.id);
      activeJobIdsByKey.delete(dedupeKey);
      throw error;
    }

    return { job: toSnapshot(job), reused: false };
  }

  function get(jobId: string): SessionForkJob | undefined {
    pruneTerminalJobs();
    const job = jobs.get(jobId);
    return job ? toSnapshot(job) : undefined;
  }

  return { start, get };
}

export type SessionForkJobManager = ReturnType<typeof createSessionForkJobManager>;
