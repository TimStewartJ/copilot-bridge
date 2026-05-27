import { defineBridgeTool, registerBridgeToolDefinitions } from "../agent-tools-mcp/adapter.js";
import type { AppContext } from "../app-context.js";
import type { BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

const REPORT_INTENT_DESCRIPTION = [
  "Update the visible session intent.",
  "Use only with real tool work; omit if it would be alone.",
].join(" ");

const REPORT_INTENT_PARAMETERS = {
  type: "object" as const,
  properties: {
    intent: { type: "string", description: "Concise current phase." },
  },
  required: ["intent"],
  additionalProperties: false,
};

export function registerReportIntentTool(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
): void {
  registerBridgeToolDefinitions(server, createReportIntentToolDefinitions(ctx));
}

export function createReportIntentToolDefinitions(ctx: AppContext) {
  return [
    defineBridgeTool("report_intent", {
      description: REPORT_INTENT_DESCRIPTION,
      parameters: REPORT_INTENT_PARAMETERS,
      handler: async (args: any) => {
        const intent = typeof args.intent === "string" ? args.intent.trim() : "";
        if (!intent) {
          return { isError: true, content: [{ type: "text" as const, text: "Intent must not be blank" }] };
        }

        // Emit the intent update on all currently-active session buses so the
        // Bridge web UI reflects the change without relying on the SDK sessionLog path.
        for (const { id: sessionId } of ctx.sessionManager.getSessionActivity()) {
          ctx.eventBusRegistry.getBus(sessionId)?.emit({ type: "intent", intent });
          ctx.globalBus.emit({ type: "session:intent", sessionId, intent });
        }

        return { content: [{ type: "text" as const, text: "Intent logged" }] };
      },
    }),
  ];
}
