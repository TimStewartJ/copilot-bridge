import type { AppContext } from "../app-context.js";
import {
  CUA_FOREGROUND_GRANT_MINUTES,
  CUA_FOREGROUND_REQUEST_TOOL,
  cuaForegroundGrants,
  type CuaForegroundGrants,
} from "../cua-driver.js";
import { defineSessionBridgeTool, registerBridgeToolDefinitions } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { readSecondsSinceLastInput } from "../platform.js";
import { resolveComputerUseAwayMinutes } from "../settings-store.js";
import { toolFailure } from "../tool-results.js";

const MAX_REASON_LENGTH = 300;
const ANSWER_FIELD = "foreground";
export const FOREGROUND_ANSWERS = { allow: "allow", deny: "deny" } as const;

export interface ComputerUseToolOptions {
  grants?: CuaForegroundGrants;
  now?: () => number;
  readIdleSeconds?: () => Promise<number | undefined>;
}

export function createComputerUseToolDefinitions(ctx: AppContext, options: ComputerUseToolOptions = {}): BridgeToolDefinition[] {
  const grants = options.grants ?? cuaForegroundGrants;
  const now = options.now ?? Date.now;
  const readIdleSeconds = options.readIdleSeconds ?? (() => readSecondsSinceLastInput());
  const userIsAway = async (): Promise<boolean> => {
    try {
      const idle = await readIdleSeconds();
      return idle !== undefined && idle >= resolveComputerUseAwayMinutes(ctx.settingsStore?.getSettings()) * 60;
    } catch {
      return false;
    }
  };
  const granted = (expiresAt: number) => ({
    granted: true,
    expiresAt: new Date(expiresAt).toISOString(),
    guidance: "Foreground Cua calls are allowed in this chat until then, even while the user is at the PC. "
      + "Still prefer background delivery where it works.",
  });

  return [
    defineSessionBridgeTool(CUA_FOREGROUND_REQUEST_TOOL, {
      description:
        "Ask the user to let this chat use the foreground of their PC while they are at it: bring windows to the front, "
        + "foreground delivery, desktop-scope input and moving the pointer. The user gets an Allow button; once they allow, "
        + `foreground Cua calls in this chat are not refused for ${CUA_FOREGROUND_GRANT_MINUTES} minutes. `
        + "Call it when a step needs the foreground and the user is at the PC, including right away when the user says in chat "
        + "that you may take over. Background work never needs it, and when the user is away it returns at once without asking.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "What you will do in the foreground and in which app, in one plain sentence the user can decide on.",
          },
        },
        required: ["reason"],
      },
      handler: async (args: any, invocation) => {
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (!reason) return toolFailure("reason is required: say what you will do in the foreground.");
        if (reason.length > MAX_REASON_LENGTH) return toolFailure(`reason must be at most ${MAX_REASON_LENGTH} characters.`);

        const current = grants.activeUntil(invocation.sessionId, now());
        if (current !== undefined) return granted(current);
        // While the user is away the guard already allows the foreground: nobody to ask.
        if (await userIsAway()) {
          return {
            granted: false,
            userAway: true,
            guidance: "The user is away, so foreground calls are allowed now without asking. "
              + "If they come back, foreground calls are refused again; call this tool then.",
          };
        }
        // A background worker has no user to ask.
        if (!ctx.sessionManager.canRequestElicitation(invocation.sessionId)) {
          return {
            granted: false,
            guidance: "Nobody can answer in this chat. Use background delivery, or wait until the user is away.",
          };
        }
        const response = await ctx.sessionManager.requestElicitation(invocation.sessionId, {
          message: `This chat wants to use your screen: ${reason}`,
          requestedSchema: {
            type: "object",
            properties: {
              [ANSWER_FIELD]: {
                type: "string",
                title: "Let it take the foreground?",
                description: `For ${CUA_FOREGROUND_GRANT_MINUTES} minutes it can bring windows to the front and send real input, so keystrokes and clicks you make meanwhile may land in its window.`,
                enum: [FOREGROUND_ANSWERS.allow, FOREGROUND_ANSWERS.deny],
                enumNames: [`Allow for ${CUA_FOREGROUND_GRANT_MINUTES} minutes`, "Not now"],
              },
            },
            required: [ANSWER_FIELD],
          },
        });
        // Only the user's own Allow counts; the Bridge's automatic answers are free text.
        if (response.action === "accept" && response.content?.[ANSWER_FIELD] === FOREGROUND_ANSWERS.allow) {
          return granted(grants.grant(invocation.sessionId, now()));
        }
        return {
          granted: false,
          guidance: "The user did not allow it. Use background delivery, or wait until the user is away. Do not ask again in this turn.",
        };
      },
    }),
  ];
}

export function registerComputerUseTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  const definitions = createComputerUseToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
