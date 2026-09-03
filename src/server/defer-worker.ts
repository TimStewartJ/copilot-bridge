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
export type DeferWorkerAction = "continue" | "finish" | "return" | "expired";

export interface DeferWorkerInput {
  deferId: string;
  kind: DeferWorkerKind;
  parentSessionId: string;
  prompt: string;
  runCount?: number;
  intervalSeconds?: number;
  expiresAt?: string;
}

export interface DeferWorkerResult {
  action: DeferWorkerAction;
  message?: string;
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
        '- "finish": stop the recurring check silently.',
        '- "return": stop the recurring check and send the enclosed concise result to the parent session.',
      ]
    : [
        '- "finish": complete the one-shot defer silently.',
        '- "return": complete the one-shot defer and send the enclosed concise result to the parent session.',
      ];
  return [
    "You are a temporary deferred-work agent. Complete exactly one check using the user prompt and available tools.",
    "You do not have the parent conversation history. Do not wait, sleep, poll repeatedly, create or cancel defers, create subagents, ask the user a question, or call task_complete.",
    "Finish with exactly one result tag and no text outside it:",
    ...actions,
    "",
    'Examples: <defer-result action="continue"></defer-result>',
    '<defer-result action="finish"></defer-result>',
    '<defer-result action="return">Concise result for the parent</defer-result>',
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
  if (input.intervalSeconds !== undefined) metadata.push(`intervalSeconds: ${input.intervalSeconds}`);
  metadata.push("</defer-worker>", "", input.prompt);
  return metadata.join("\n");
}

export function parseDeferWorkerResult(
  rawOutput: unknown,
  kind: DeferWorkerKind,
): DeferWorkerResult {
  const text = typeof rawOutput === "string" ? rawOutput.trim() : "";
  const match = text.match(
    /<defer-result\s+action=(?:"|')(continue|finish|return)(?:"|')\s*>([\s\S]*?)<\/defer-result>/i,
  );
  if (match) {
    const action = match[1]!.toLowerCase() as DeferWorkerAction;
    const message = match[2]!.trim();
    if (kind === "once" && action === "continue") {
      throw new Error("One-shot defer worker cannot continue.");
    }
    return action === "return"
      ? { action, message: (message || "Deferred work completed.").slice(0, 16 * 1024) }
      : { action };
  }

  if (kind === "interval") return { action: "continue" };
  return {
    action: "return",
    message: (text || "Deferred work completed.").slice(0, 16 * 1024),
  };
}

export function formatReturnedDeferPrompt(input: DeferWorkerInput, message: string): string {
  return [
    "<deferred-work-result>",
    `deferId: ${input.deferId}`,
    `kind: ${input.kind}`,
    "</deferred-work-result>",
    "",
    "A temporary deferred-work session returned this result. Continue from it without repeating the completed check:",
    "",
    message,
  ].join("\n");
}

export function isReturnedDeferPrompt(prompt: string): boolean {
  return prompt.startsWith("<deferred-work-result>");
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
      const response = await session.sendAndWait(
        { prompt: buildDeferWorkerPrompt(input), attachments: [] },
        DEFER_WORKER_TIMEOUT_MS,
      ) as { data?: { content?: unknown } } | undefined;
      const result = parseDeferWorkerResult(response?.data?.content, input.kind);
      this.deps.recordSpan?.("defer.worker", Date.now() - startedAt, input.parentSessionId, {
        action: result.action,
        kind: input.kind,
        model,
        reasoningEffort,
        contextTier: configuredContextTier,
      });
      return result;
    } catch (error) {
      this.deps.recordSpan?.("defer.worker", Date.now() - startedAt, input.parentSessionId, {
        action: "error",
        kind: input.kind,
        model,
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
