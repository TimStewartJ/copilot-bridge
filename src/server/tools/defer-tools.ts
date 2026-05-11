import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "../app-context.js";
import { parseDeferId } from "../defer-ids.js";
import { emitSessionDeferSummary } from "../defer-summary.js";
import { toolFailure } from "../tool-results.js";

const DEFER_MAX_PROMPT_BYTES = 32 * 1024; // 32 KB
const DEFER_MAX_HORIZON_DAYS = 30;
const DEFER_MAX_HORIZON_SECONDS = DEFER_MAX_HORIZON_DAYS * 24 * 60 * 60;
const DEFER_MIN_INTERVAL_SECONDS = 5 * 60;
const DEFER_MAX_INTERVAL_SECONDS = DEFER_MAX_HORIZON_SECONDS;
const DEFER_DEFAULT_EXPIRY_DAYS = 7;
const DEFER_DEFAULT_EXPIRY_SECONDS = DEFER_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60;
const DEFER_MAX_RUNS = 10_000;

function validatePrompt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "prompt must be a non-empty string.";
  if (value.length > DEFER_MAX_PROMPT_BYTES) return `prompt is too long (max ${DEFER_MAX_PROMPT_BYTES} characters).`;
  return undefined;
}

function parseFutureIso(raw: unknown, fieldName: string): { iso: string } | { error: string } {
  const value = String(raw);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return { error: `${fieldName} is not a valid date: ${value}` };
  if (parsed.getTime() <= Date.now()) return { error: `${fieldName} must be in the future.` };
  const secondsUntil = (parsed.getTime() - Date.now()) / 1000;
  if (secondsUntil > DEFER_MAX_HORIZON_SECONDS) {
    return { error: `${fieldName} exceeds maximum horizon of ${DEFER_MAX_HORIZON_DAYS} days from now.` };
  }
  return { iso: parsed.toISOString() };
}

function formatOneShot(d: any) {
  return {
    deferId: d.deferId,
    kind: "once",
    sessionId: d.sessionId,
    prompt: d.prompt,
    nextRunAt: d.runAt,
    runAt: d.runAt,
    status: d.status,
    attempts: d.attempts,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.lastError ? { lastError: d.lastError } : {}),
  };
}

function formatLoop(loop: any) {
  return {
    deferId: loop.deferId,
    kind: "interval",
    sessionId: loop.sessionId,
    ...(loop.name ? { name: loop.name } : {}),
    prompt: loop.prompt,
    intervalSeconds: loop.intervalSeconds,
    nextRunAt: loop.nextRunAt,
    status: loop.status,
    runCount: loop.runCount,
    attempts: loop.attempts,
    ...(loop.maxRuns !== undefined ? { maxRuns: loop.maxRuns } : {}),
    ...(loop.expiresAt ? { expiresAt: loop.expiresAt } : {}),
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
    ...(loop.lastError ? { lastError: loop.lastError } : {}),
  };
}

export function createDeferTools(ctx: AppContext) {
  return [
    defineTool("defer_create", {
      description: "Create a same-session defer. Use delaySeconds or runAt for a one-shot follow-up in this session. Use intervalSeconds for same-session polling/recurrence with an explicit stop condition such as maxRuns or expiresAt; do not chain one-shot defers for polling. Use schedule_create for durable task-level automation that starts fresh task-linked sessions.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt to send to this same session." },
          delaySeconds: { type: "number", description: "One-shot same-session follow-up: seconds from now. Provide exactly one timing mode." },
          runAt: { type: "string", description: "One-shot same-session follow-up: ISO timestamp. Provide exactly one timing mode." },
          intervalSeconds: { type: "number", description: "Same-session polling/recurrence interval in seconds. Use instead of chained one-shots; cannot be combined with delaySeconds or runAt." },
          name: { type: "string", description: "Optional recurring defer name. Valid only with intervalSeconds." },
          maxRuns: { type: "number", description: "Optional recurring stop condition. Valid only with intervalSeconds." },
          expiresAt: { type: "string", description: "Optional recurring expiry ISO timestamp. Valid only with intervalSeconds." },
        },
        required: ["prompt"],
      },
      handler: async (args: any, invocation: any) => {
        const sessionId: string | undefined = invocation?.sessionId;
        if (!sessionId) return toolFailure("No active session — defer_create requires an invocation session.");
        if (args.deferredPromptId !== undefined || args.loopId !== undefined) {
          return toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId.");
        }

        const promptError = validatePrompt(args.prompt);
        if (promptError) return toolFailure(promptError);
        const prompt = args.prompt as string;

        const hasDelay = args.delaySeconds !== undefined;
        const hasRunAt = args.runAt !== undefined;
        const hasInterval = args.intervalSeconds !== undefined;
        const oneShotTimingCount = Number(hasDelay) + Number(hasRunAt);

        if (!hasInterval && hasDelay && hasRunAt) {
          return toolFailure("delaySeconds and runAt are mutually exclusive.");
        }
        if (hasInterval && oneShotTimingCount > 0) {
          return toolFailure("intervalSeconds cannot be combined with delaySeconds or runAt.");
        }
        if (!hasInterval && oneShotTimingCount !== 1) {
          return toolFailure("Provide exactly one timing mode: delaySeconds, runAt, or intervalSeconds.");
        }

        if (!hasInterval) {
          if (args.maxRuns !== undefined || args.expiresAt !== undefined || args.name !== undefined) {
            return toolFailure("name, maxRuns, and expiresAt are valid only for recurring interval defers.");
          }
          if (!ctx.deferredPromptStore) return toolFailure("Deferred prompt store is unavailable.");

          let runAtIso: string;
          if (hasDelay) {
            const delay = Number(args.delaySeconds);
            if (!Number.isFinite(delay) || delay <= 0) return toolFailure("delaySeconds must be a positive finite number.");
            if (delay > DEFER_MAX_HORIZON_SECONDS) {
              return toolFailure(`delaySeconds exceeds maximum horizon of ${DEFER_MAX_HORIZON_SECONDS} seconds (${DEFER_MAX_HORIZON_DAYS} days).`);
            }
            runAtIso = new Date(Date.now() + delay * 1000).toISOString();
          } else {
            const parsed = parseFutureIso(args.runAt, "runAt");
            if ("error" in parsed) return toolFailure(parsed.error);
            runAtIso = parsed.iso;
          }

          const deferred = ctx.deferredPromptStore.create(sessionId, prompt, runAtIso);
          emitSessionDeferSummary(ctx.globalBus, sessionId, ctx);
          ctx.deferredPromptRunner?.poke();
          return {
            success: true,
            deferId: deferred.deferId,
            kind: "once",
            sessionId: deferred.sessionId,
            nextRunAt: deferred.runAt,
            runAt: deferred.runAt,
            message: `One-shot defer scheduled for ${deferred.runAt}.`,
          };
        }

        if (!ctx.deferLoopStore) return toolFailure("Recurring defer store is unavailable.");
        const intervalSeconds = Number(args.intervalSeconds);
        if (!Number.isInteger(intervalSeconds)) return toolFailure("intervalSeconds must be an integer number of seconds.");
        if (intervalSeconds < DEFER_MIN_INTERVAL_SECONDS) {
          return toolFailure(`intervalSeconds must be at least ${DEFER_MIN_INTERVAL_SECONDS} seconds.`);
        }
        if (intervalSeconds > DEFER_MAX_INTERVAL_SECONDS) {
          return toolFailure(`intervalSeconds exceeds maximum of ${DEFER_MAX_INTERVAL_SECONDS} seconds (${DEFER_MAX_HORIZON_DAYS} days).`);
        }

        let maxRuns: number | undefined;
        if (args.maxRuns !== undefined) {
          maxRuns = Number(args.maxRuns);
          if (!Number.isInteger(maxRuns) || maxRuns <= 0 || maxRuns > DEFER_MAX_RUNS) {
            return toolFailure(`maxRuns must be an integer between 1 and ${DEFER_MAX_RUNS}.`);
          }
        }

        let expiresAt: string | undefined;
        if (args.expiresAt !== undefined) {
          const parsed = parseFutureIso(args.expiresAt, "expiresAt");
          if ("error" in parsed) return toolFailure(parsed.error);
          expiresAt = parsed.iso;
        } else if (maxRuns === undefined) {
          if (intervalSeconds >= DEFER_DEFAULT_EXPIRY_SECONDS) {
            return toolFailure(
              `intervalSeconds must be less than the default recurring expiry of ${DEFER_DEFAULT_EXPIRY_SECONDS} seconds unless maxRuns or expiresAt is provided.`,
            );
          }
          expiresAt = new Date(Date.now() + DEFER_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
        }

        const name = args.name === undefined ? undefined : String(args.name).trim();
        if (args.name !== undefined && !name) return toolFailure("name must be non-empty when provided.");

        const nextRunAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
        if (expiresAt && Date.parse(expiresAt) <= Date.parse(nextRunAt)) {
          return toolFailure("expiresAt must be after the first recurring defer run.");
        }
        const loop = ctx.deferLoopStore.create({
          sessionId,
          ...(name ? { name } : {}),
          prompt,
          intervalSeconds,
          nextRunAt,
          ...(maxRuns !== undefined ? { maxRuns } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        });
        emitSessionDeferSummary(ctx.globalBus, sessionId, ctx);
        ctx.deferLoopRunner?.poke();
        return {
          success: true,
          deferId: loop.deferId,
          kind: "interval",
          sessionId: loop.sessionId,
          nextRunAt: loop.nextRunAt,
          intervalSeconds: loop.intervalSeconds,
          ...(loop.maxRuns !== undefined ? { maxRuns: loop.maxRuns } : {}),
          ...(loop.expiresAt ? { expiresAt: loop.expiresAt } : {}),
          message: `Recurring defer scheduled every ${loop.intervalSeconds} seconds.`,
        };
      },
    }),

    defineTool("defer_cancel", {
      description: "Cancel a pending or running same-session defer by public deferId. Works for one-shot and recurring interval defers. Use the deferId from defer_create, defer_list, or recurring prompt metadata.",
      parameters: {
        type: "object",
        properties: {
          deferId: { type: "string", description: "Public defer ID, e.g. once_<uuid> or interval_<uuid>." },
        },
        required: ["deferId"],
      },
      handler: async (args: any, invocation: any) => {
        const sessionId: string | undefined = invocation?.sessionId;
        if (!sessionId) return toolFailure("No active session — defer_cancel requires an invocation session.");
        if (args.deferredPromptId !== undefined || args.loopId !== undefined) {
          return toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId.");
        }
        const deferId = typeof args.deferId === "string" ? args.deferId : "";
        const parsed = parseDeferId(deferId);
        if (!parsed) return toolFailure("deferId must start with once_ or interval_.");

        if (parsed.kind === "once") {
          if (!ctx.deferredPromptStore) return toolFailure("Deferred prompt store is unavailable.");
          const existing = ctx.deferredPromptStore.get(parsed.id);
          if (!existing) return toolFailure(`Defer ${deferId} not found.`);
          if (existing.sessionId !== sessionId) return toolFailure(`Defer ${deferId} does not belong to this session.`);
          if (existing.status !== "pending" && existing.status !== "running") {
            return toolFailure(`Defer ${deferId} is ${existing.status} and cannot be cancelled.`);
          }
          const cancelled = ctx.deferredPromptStore.cancelById(parsed.id);
          if (!cancelled) return toolFailure(`Failed to cancel defer ${deferId}.`);
          emitSessionDeferSummary(ctx.globalBus, sessionId, ctx);
          return { success: true, deferId, kind: "once", message: `Defer ${deferId} cancelled.` };
        }

        if (!ctx.deferLoopStore) return toolFailure("Recurring defer store is unavailable.");
        const loop = ctx.deferLoopStore.get(parsed.id);
        if (!loop) return toolFailure(`Defer ${deferId} not found.`);
        if (loop.sessionId !== sessionId) return toolFailure(`Defer ${deferId} does not belong to this session.`);
        if (loop.status !== "active" && loop.status !== "running") {
          return toolFailure(`Defer ${deferId} is ${loop.status} and cannot be cancelled.`);
        }
        const cancelled = ctx.deferLoopStore.cancelById(parsed.id);
        if (!cancelled) return toolFailure(`Failed to cancel defer ${deferId}.`);
        ctx.sessionManager.markSessionAttention(sessionId);
        emitSessionDeferSummary(ctx.globalBus, sessionId, ctx);
        ctx.deferLoopRunner?.poke();
        return { success: true, deferId, kind: "interval", message: `Defer ${deferId} cancelled.` };
      },
    }),

    defineTool("defer_list", {
      description: "List active same-session defers for this session. Includes one-shot and recurring interval defers using public deferId values.",
      parameters: { type: "object", properties: {} },
      handler: async (args: any, invocation: any) => {
        const sessionId: string | undefined = invocation?.sessionId;
        if (!sessionId) return toolFailure("No active session — defer_list requires an invocation session.");
        if (args?.deferredPromptId !== undefined || args?.loopId !== undefined) {
          return toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId.");
        }
        const oneShots = ctx.deferredPromptStore
          ? ctx.deferredPromptStore
            .listForSession(sessionId)
            .filter((d) => d.status === "pending" || d.status === "running")
            .map(formatOneShot)
          : [];
        const loops = ctx.deferLoopStore
          ? ctx.deferLoopStore
            .listForSession(sessionId)
            .filter((d) => d.status === "active" || d.status === "running")
            .map(formatLoop)
          : [];
        return {
          deferrals: [...oneShots, ...loops].sort((a, b) =>
            Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt)
          ),
        };
      },
    }),
  ];
}
