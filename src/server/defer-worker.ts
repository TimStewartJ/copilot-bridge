import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModelInfo, AgentSession } from "./agent-backend/index.js";
import { deleteCliSessionStoreRows } from "./cli-session-store.js";
import type { SessionConfigOptions } from "./session-config-builder.js";
import { selectCheapHelperModel } from "./session-name-generator.js";
import type { AppSettings } from "./settings-store.js";

export const DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX = "d3f3e000";
const DEFER_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DEFER_WORKER_REASONING_EFFORT = "low";
const DEFAULT_DEFER_WORKER_CONTEXT_TIER = "default";

export type DeferWorkerKind = "once" | "interval";
export type DeferWorkerAction = "continue" | "notify" | "finish" | "return" | "expired";

export interface DeferWorkerInput {
  deferId: string;
  kind: DeferWorkerKind;
  parentSessionId: string;
  prompt: string;
  runCount?: number;
  maxRuns?: number;
  remainingRunsAfterThis?: number;
  isFinalRun?: boolean;
  intervalSeconds?: number;
  expiresAt?: string;
}

export interface DeferWorkerResult {
  action: DeferWorkerAction;
  message?: string;
  deliveryId?: string;
}

export interface DeferWorkerExecutor {
  run(input: DeferWorkerInput): Promise<DeferWorkerResult>;
}

export interface DeferWorkerLease {
  run(input: DeferWorkerInput): Promise<DeferWorkerResult>;
  release(): void;
}

export interface DisposableDeferWorkerDeps {
  getSettings(): AppSettings;
  listModels(): Promise<AgentModelInfo[]>;
  buildSessionConfig(options: SessionConfigOptions): Record<string, unknown>;
  getParentWorkingDirectory(sessionId: string): string | undefined;
  beginLifecycle(): () => void;
  reserveCapacity(config: Record<string, unknown>): Promise<() => void>;
  createSession(config: Record<string, unknown>): Promise<AgentSession>;
  deleteSession(sessionId: string): Promise<unknown>;
  getCopilotHome(): string;
  recordSpan?(
    name: string,
    duration: number,
    sessionId?: string,
    metadata?: Record<string, unknown>,
  ): void;
  logger?: Pick<Console, "warn">;
}

export function createDisposableDeferWorkerSessionId(): string {
  const uuid = randomUUID();
  return `${DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX}${uuid.slice(DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX.length)}`;
}

export function isDisposableDeferWorkerSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_DEFER_WORKER_SESSION_ID_PREFIX}-`);
}

export function buildDeferWorkerSystemPrompt(kind: DeferWorkerKind): string {
  const actions = kind === "interval"
    ? [
        '- "continue": the recurring check should run again later and the parent should not be disturbed.',
        '- "notify": send the enclosed concise update to the parent and keep the recurring check active.',
        '- "finish": stop the recurring check silently.',
        '- "return": stop the recurring check and send the enclosed concise result to the parent session.',
      ]
    : [
        '- "finish": complete the one-shot defer silently.',
        '- "return": complete the one-shot defer and send the enclosed concise result to the parent session.',
      ];
  const examples = kind === "interval"
    ? [
        '<defer-result action="continue"></defer-result>',
        '<defer-result action="notify">Concise update for the parent</defer-result>',
        '<defer-result action="finish"></defer-result>',
        '<defer-result action="return">Concise result for the parent</defer-result>',
      ]
    : [
        '<defer-result action="finish"></defer-result>',
        '<defer-result action="return">Concise result for the parent</defer-result>',
      ];
  return [
    "You are a temporary deferred-work agent. Complete exactly one check using the user prompt and available tools.",
    "You do not have the parent conversation history. Do not wait, sleep, poll repeatedly, create or cancel defers, create subagents, ask the user a question, or call task_complete.",
    "Ignore prompt instructions to cancel the defer or complete the parent task. Express the outcome only through the result tag.",
    'When the metadata says "isFinalRun: true", do not choose continue or notify; choose finish or return.',
    "Finish with exactly one result tag and no text outside it:",
    ...actions,
    "",
    "Examples:",
    ...examples,
  ].join("\n");
}

export function buildDeferWorkerPrompt(input: DeferWorkerInput): string {
  const metadata = [
    "<defer-worker>",
    `deferId: ${input.deferId}`,
    `kind: ${input.kind}`,
    `parentSessionId: ${input.parentSessionId}`,
  ];
  if (input.runCount !== undefined) metadata.push(`runCount: ${input.runCount}`);
  if (input.maxRuns !== undefined) metadata.push(`maxRuns: ${input.maxRuns}`);
  if (input.remainingRunsAfterThis !== undefined) {
    metadata.push(`remainingRunsAfterThis: ${input.remainingRunsAfterThis}`);
  }
  if (input.isFinalRun !== undefined) metadata.push(`isFinalRun: ${input.isFinalRun}`);
  if (input.intervalSeconds !== undefined) metadata.push(`intervalSeconds: ${input.intervalSeconds}`);
  if (input.expiresAt !== undefined) metadata.push(`expiresAt: ${input.expiresAt}`);
  metadata.push("</defer-worker>", "", input.prompt);
  return metadata.join("\n");
}

export function parseDeferWorkerResult(
  rawOutput: unknown,
  kind: DeferWorkerKind,
): DeferWorkerResult {
  const text = typeof rawOutput === "string" ? rawOutput.trim() : "";
  const match = text.match(
    /^<defer-result\s+action=(?:"|')(continue|notify|finish|return)(?:"|')\s*>([\s\S]*?)<\/defer-result>$/i,
  );
  if (match) {
    const action = match[1]!.toLowerCase() as DeferWorkerAction;
    const message = match[2]!.trim();
    if (kind === "once" && (action === "continue" || action === "notify")) {
      throw new Error(`One-shot defer worker cannot ${action}.`);
    }
    return action === "return" || action === "notify"
      ? { action, message: (message || "Deferred work completed.").slice(0, 16 * 1024) }
      : { action };
  }

  throw new Error("Deferred worker response did not contain one valid result tag.");
}

function runDeferWorkerPrompt(
  session: AgentSession,
  input: DeferWorkerInput,
): Promise<{ result: DeferWorkerResult; completionSource: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resultCandidate: DeferWorkerResult | undefined;
    let resultTurnEnded = false;
    const openToolCallIds = new Set<string>();
    const openExternalRequestIds = new Set<string>();
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(
        `Timeout after ${DEFER_WORKER_TIMEOUT_MS}ms waiting for deferred worker result`,
      )));
    }, DEFER_WORKER_TIMEOUT_MS);

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      complete();
    };

    const invalidateResultCandidate = () => {
      resultCandidate = undefined;
      resultTurnEnded = false;
    };
    const resolveCompletedResult = (completionSource: string) => {
      if (
        !resultCandidate
        || !resultTurnEnded
        || openToolCallIds.size > 0
        || openExternalRequestIds.size > 0
      ) {
        return;
      }
      const result = resultCandidate;
      settle(() => resolve({ result, completionSource }));
    };

    unsubscribe = session.on((event) => {
      if (!event || typeof event !== "object") return;
      const candidate = event as { type?: unknown; data?: unknown };
      const data = candidate.data && typeof candidate.data === "object"
        ? candidate.data as {
            content?: unknown;
            message?: unknown;
            error?: unknown;
            parentToolCallId?: unknown;
            toolRequests?: unknown;
            toolCallId?: unknown;
            requestId?: unknown;
          }
        : undefined;

      if (candidate.type === "assistant.turn_start") {
        invalidateResultCandidate();
        return;
      }

      if (
        candidate.type === "assistant.message"
        && !data?.parentToolCallId
        && typeof data?.content === "string"
      ) {
        if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) {
         invalidateResultCandidate();
         return;
        }
        try {
         if (data.content.includes("<defer-result")) {
           resultCandidate = parseDeferWorkerResult(data.content, input.kind);
           resultTurnEnded = false;
         } else {
           invalidateResultCandidate();
         }
        } catch (error) {
         settle(() => reject(error));
        }
        return;
      }

      if (candidate.type === "tool.execution_start") {
        if (typeof data?.toolCallId === "string") openToolCallIds.add(data.toolCallId);
        invalidateResultCandidate();
        return;
      }
      if (candidate.type === "tool.execution_complete") {
        if (typeof data?.toolCallId === "string") openToolCallIds.delete(data.toolCallId);
        resolveCompletedResult("assistant.turn_end");
        return;
      }
      if (candidate.type === "external_tool.requested") {
        if (typeof data?.requestId === "string") openExternalRequestIds.add(data.requestId);
        invalidateResultCandidate();
        return;
      }
      if (candidate.type === "external_tool.completed") {
        if (typeof data?.requestId === "string") openExternalRequestIds.delete(data.requestId);
        resolveCompletedResult("assistant.turn_end");
        return;
      }
      if (candidate.type === "assistant.turn_end") {
        resultTurnEnded = true;
        resolveCompletedResult("assistant.turn_end");
        return;
      }

      if (candidate.type === "session.idle" || candidate.type === "session.task_complete") {
        if (!resultCandidate) {
         settle(() => reject(new Error(
           "Deferred worker ended without one valid result tag.",
         )));
         return;
        }
        resultTurnEnded = true;
        resolveCompletedResult(String(candidate.type));
        return;
      }

      if (
        candidate.type === "session.error"
        || candidate.type === "abort"
        || candidate.type === "session.shutdown"
      ) {
        const detail = typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : `Deferred worker ended with ${String(candidate.type)}`;
        settle(() => reject(new Error(detail)));
      }
    });

    void session.send({
      prompt: buildDeferWorkerPrompt(input),
      attachments: [],
    }).catch((error) => settle(() => reject(error)));
  });
}

export class DisposableDeferWorker implements DeferWorkerExecutor {
  private readonly maxConcurrentWorkers = 2;
  private activeWorkers = 0;

  constructor(private readonly deps: DisposableDeferWorkerDeps) {}

  async run(input: DeferWorkerInput): Promise<DeferWorkerResult> {
    const lease = this.tryAcquire();
    if (!lease) throw new Error("Deferred worker capacity is full.");
    try {
      return await lease.run(input);
    } finally {
      lease.release();
    }
  }

  tryAcquire(): DeferWorkerLease | undefined {
    if (this.activeWorkers >= this.maxConcurrentWorkers) return undefined;
    this.activeWorkers += 1;
    let completeLifecycle: (() => void) | undefined;
    try {
      completeLifecycle = this.deps.beginLifecycle();
    } catch (error) {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      throw error;
    }
    let released = false;
    return {
      run: (input) => this.runOne(input),
      release: () => {
        if (released) return;
        released = true;
        completeLifecycle?.();
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      },
    };
  }

  private async runOne(input: DeferWorkerInput): Promise<DeferWorkerResult> {
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
      return { action: "expired" };
    }
    const startedAt = Date.now();
    const settings = this.deps.getSettings();
    const workerSettings = settings.deferWorker;
    const models = await this.deps.listModels();
    const configuredModel = workerSettings?.model
      ? models.find((candidate) =>
          candidate.id === workerSettings.model
          && (!candidate.policy || candidate.policy.state === "enabled")
        )
      : undefined;
    const defaultModel = settings.model
      ? models.find((candidate) =>
          candidate.id === settings.model
          && (!candidate.policy || candidate.policy.state === "enabled")
        )
      : undefined;
    const model = configuredModel?.id
      ?? selectCheapHelperModel(models)
      ?? defaultModel?.id;
    const selectedModel = model
      ? models.find((candidate) => candidate.id === model)
      : undefined;
    const configuredEffort = workerSettings?.reasoningEffort
      ?? DEFAULT_DEFER_WORKER_REASONING_EFFORT;
    const configuredContextTier = workerSettings?.contextTier
      ?? DEFAULT_DEFER_WORKER_CONTEXT_TIER;
    const reasoningEffort = configuredEffort
      && (
        !selectedModel
        || selectedModel.supportedReasoningEfforts?.some((effort) => effort === configuredEffort) === true
      )
      ? configuredEffort
      : undefined;
    const sessionId = createDisposableDeferWorkerSessionId();
    let session: AgentSession | undefined;
    let releaseCapacityReservation: (() => void) | undefined;

    try {
      const workingDirectory = this.deps.getParentWorkingDirectory(input.parentSessionId);
      const baseConfig = this.deps.buildSessionConfig({
        sessionId,
        ...(model ? { modelOverride: model } : {}),
        ...(reasoningEffort ? { reasoningEffortOverride: reasoningEffort } : {}),
        contextTierOverride: configuredContextTier,
        modelMetadata: models,
      });
      if (!model) {
        delete baseConfig.model;
        delete baseConfig.reasoningEffort;
        delete baseConfig.contextTier;
        delete baseConfig.modelCapabilities;
      }
      const sessionConfig = {
        ...baseConfig,
        ...(workingDirectory ? { workingDirectory } : {}),
        sessionId,
        clientName: "Copilot Bridge Defer Worker",
        systemMessage: { mode: "replace", content: buildDeferWorkerSystemPrompt(input.kind) },
        enableConfigDiscovery: false,
        skillDirectories: [],
        instructionDirectories: [],
        infiniteSessions: { enabled: false },
        enableSessionTelemetry: false,
        enableSessionStore: false,
      };
      releaseCapacityReservation = await this.deps.reserveCapacity(sessionConfig);
      session = await this.deps.createSession(sessionConfig);
      const completed = await runDeferWorkerPrompt(session, input);
      const result = completed.result.action === "return" || completed.result.action === "notify"
        ? { ...completed.result, deliveryId: randomUUID() }
        : completed.result;
      this.deps.recordSpan?.("defer.worker", Date.now() - startedAt, input.parentSessionId, {
        action: result.action,
        kind: input.kind,
        deferId: input.deferId,
        runCount: input.runCount,
        model,
        reasoningEffort,
        contextTier: configuredContextTier,
        completionSource: completed.completionSource,
        ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
      });
      return result;
    } catch (error) {
      this.deps.recordSpan?.("defer.worker", Date.now() - startedAt, input.parentSessionId, {
        action: "error",
        kind: input.kind,
        deferId: input.deferId,
        runCount: input.runCount,
        model,
        reasoningEffort,
        contextTier: configuredContextTier,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      try {
        await session?.disconnect?.();
      } catch (error) {
        this.deps.logger?.warn(
          `[defer-worker] Disposable session disconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await this.deps.deleteSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found/i.test(message)) {
          this.deps.logger?.warn(`[defer-worker] Disposable session delete failed: ${message}`);
        }
      }
      try {
        await rm(join(this.deps.getCopilotHome(), "session-state", sessionId), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        this.deps.logger?.warn(
          `[defer-worker] Disposable session directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        deleteCliSessionStoreRows(this.deps.getCopilotHome(), sessionId);
      } catch (error) {
        this.deps.logger?.warn(
          `[defer-worker] Disposable session DB cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      releaseCapacityReservation?.();
    }
  }
}

export function createDisposableDeferWorker(
  deps: DisposableDeferWorkerDeps,
): DisposableDeferWorker {
  return new DisposableDeferWorker(deps);
}
