import type { BridgeToolDefinition, BridgeToolHandlerExtra, BridgeToolHandlerResult } from "./server.js";

export interface BridgeToolInvocation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface DefineBridgeToolOptions {
  description?: string;
  parameters?: BridgeToolDefinition["inputSchema"];
  scope?: BridgeToolDefinition["scope"];
  handler: (
    args: any,
    invocation: BridgeToolInvocation,
  ) => BridgeToolHandlerResult | Promise<BridgeToolHandlerResult>;
}

function bridgeInvocationFromMcp(
  name: string,
  args: Record<string, unknown>,
  extra: BridgeToolHandlerExtra,
): BridgeToolInvocation {
  return {
    sessionId: extra.sessionId ?? "",
    toolCallId: String(extra.requestId),
    toolName: name,
    arguments: args,
  };
}

export function defineBridgeTool(
  name: string,
  options: DefineBridgeToolOptions,
): BridgeToolDefinition {
  return {
    name,
    description: options.description,
    inputSchema: options.parameters ?? { type: "object", properties: {} },
    scope: options.scope,
    handler: (args, extra) => options.handler(args, bridgeInvocationFromMcp(name, args, extra)),
  };
}

export function registerBridgeToolDefinitions(
  server: { registerTool(definition: BridgeToolDefinition): void },
  definitions: readonly BridgeToolDefinition[],
): void {
  for (const definition of definitions) {
    server.registerTool(definition);
  }
}
