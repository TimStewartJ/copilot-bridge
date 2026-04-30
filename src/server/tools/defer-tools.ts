import { defineTool } from "@github/copilot-sdk";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";

const DEFER_MAX_PROMPT_BYTES = 32 * 1024; // 32 KB
const DEFER_MAX_HORIZON_DAYS = 30;
const DEFER_MAX_HORIZON_SECONDS = DEFER_MAX_HORIZON_DAYS * 24 * 60 * 60;

export function createDeferTools(ctx: AppContext) {
  return [
  defineTool("defer_session", {
    description: "Send a new user-turn prompt to this same session later. Use for polling, reminders, retries, and follow-up checks when this session should continue after a delay.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send to this session at the scheduled time." },
        delaySeconds: { type: "number", description: "Seconds from now to send the prompt. Provide exactly one of delaySeconds or runAt." },
        runAt: { type: "string", description: "ISO timestamp at which to send the prompt. Provide exactly one of delaySeconds or runAt." },
      },
      required: ["prompt"],
    },
    handler: async (args: any, invocation: any) => {
      const sessionId: string | undefined = invocation?.sessionId;
      if (!sessionId) return toolFailure("No active session — defer_session requires an invocation session.");

      if (!ctx.deferredPromptStore) return toolFailure("Deferred prompt store is unavailable.");

      const prompt: unknown = args.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) return toolFailure("prompt must be a non-empty string.");
      if (prompt.length > DEFER_MAX_PROMPT_BYTES) return toolFailure(`prompt is too long (max ${DEFER_MAX_PROMPT_BYTES} characters).`);

      const hasDelay = args.delaySeconds !== undefined;
      const hasRunAt = args.runAt !== undefined;
      if (hasDelay && hasRunAt) return toolFailure("Provide exactly one of delaySeconds or runAt, not both.");
      if (!hasDelay && !hasRunAt) return toolFailure("Provide exactly one of delaySeconds or runAt.");

      let runAtIso: string;
      if (hasDelay) {
        const delay = Number(args.delaySeconds);
        if (!Number.isFinite(delay) || delay <= 0) return toolFailure("delaySeconds must be a positive finite number.");
        if (delay > DEFER_MAX_HORIZON_SECONDS) return toolFailure(`delaySeconds exceeds maximum horizon of ${DEFER_MAX_HORIZON_SECONDS} seconds (${DEFER_MAX_HORIZON_DAYS} days).`);
        runAtIso = new Date(Date.now() + delay * 1000).toISOString();
      } else {
        const raw = String(args.runAt);
        const parsed = new Date(raw);
        if (!Number.isFinite(parsed.getTime())) return toolFailure(`runAt is not a valid date: ${raw}`);
        if (parsed.getTime() <= Date.now()) return toolFailure("runAt must be in the future.");
        const secondsUntil = (parsed.getTime() - Date.now()) / 1000;
        if (secondsUntil > DEFER_MAX_HORIZON_SECONDS) return toolFailure(`runAt exceeds maximum horizon of ${DEFER_MAX_HORIZON_DAYS} days from now.`);
        runAtIso = parsed.toISOString();
      }

      const deferred = ctx.deferredPromptStore.create(sessionId, prompt, runAtIso);
      ctx.deferredPromptRunner?.poke();

      return {
        success: true,
        deferredPromptId: deferred.id,
        sessionId: deferred.sessionId,
        runAt: deferred.runAt,
        message: `Deferred prompt scheduled for ${deferred.runAt}.`,
      };
    },
  }),

  defineTool("defer_cancel", {
    description: "Cancel a pending deferred prompt in this session by its ID. Prompts already being delivered cannot be cancelled.",
    parameters: {
      type: "object",
      properties: {
        deferredPromptId: { type: "string", description: "The ID returned by defer_session." },
      },
      required: ["deferredPromptId"],
    },
    handler: async (args: any, invocation: any) => {
      const sessionId: string | undefined = invocation?.sessionId;
      if (!sessionId) return toolFailure("No active session — defer_cancel requires an invocation session.");
      if (!ctx.deferredPromptStore) return toolFailure("Deferred prompt store is unavailable.");

      const id = String(args.deferredPromptId);
      const existing = ctx.deferredPromptStore.get(id);
      if (!existing) return toolFailure(`Deferred prompt ${id} not found.`);
      if (existing.sessionId !== sessionId) return toolFailure(`Deferred prompt ${id} does not belong to this session.`);
      if (existing.status !== "pending") {
        return toolFailure(`Deferred prompt ${id} is ${existing.status} and cannot be cancelled.`);
      }

      const cancelled = ctx.deferredPromptStore.cancelById(id);
      if (!cancelled) return toolFailure(`Failed to cancel deferred prompt ${id}.`);
      return { success: true, message: `Deferred prompt ${id} cancelled.` };
    },
  }),

  defineTool("defer_list", {
    description: "List pending and running deferred prompts for this session.",
    parameters: { type: "object", properties: {} },
    handler: async (_args: any, invocation: any) => {
      const sessionId: string | undefined = invocation?.sessionId;
      if (!sessionId) return toolFailure("No active session — defer_list requires an invocation session.");
      if (!ctx.deferredPromptStore) return toolFailure("Deferred prompt store is unavailable.");

      const all = ctx.deferredPromptStore.listForSession(sessionId);
      const active = all.filter((d) => d.status === "pending" || d.status === "running");
      return {
        deferrals: active.map((d) => ({
          id: d.id,
          sessionId: d.sessionId,
          runAt: d.runAt,
          status: d.status,
          attempts: d.attempts,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          prompt: d.prompt,
        })),
      };
    },
  }),
  ];
}
