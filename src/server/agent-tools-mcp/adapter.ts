import { toolFailure } from "../tool-results.js";
import { validateToolArguments } from "./validate-args.js";
import type { BridgeToolDefinition, BridgeToolHandlerExtra, BridgeToolHandlerResult } from "./server.js";

export interface BridgeToolInvocation {
  /**
   * Session that issued the call. `undefined` when the tool was invoked without
   * one — never an empty string, so a handler cannot mistake "no session" for a
   * real session id.
   */
  sessionId: string | undefined;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Invocation handed to session-scoped tools, where the session id is guaranteed. */
export interface SessionBridgeToolInvocation extends BridgeToolInvocation {
  sessionId: string;
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

export interface DefineSessionBridgeToolOptions {
  description?: string;
  parameters?: BridgeToolDefinition["inputSchema"];
  handler: (
    args: any,
    invocation: SessionBridgeToolInvocation,
  ) => BridgeToolHandlerResult | Promise<BridgeToolHandlerResult>;
}

function normalizeInvocationSessionId(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function bridgeInvocationFromMcp(
  name: string,
  args: Record<string, unknown>,
  extra: BridgeToolHandlerExtra,
): BridgeToolInvocation {
  return {
    sessionId: normalizeInvocationSessionId(extra?.sessionId),
    toolCallId: extra?.requestId === undefined || extra?.requestId === null ? "" : String(extra.requestId),
    toolName: name,
    arguments: args,
  };
}

/** Session-scoped tools act on the caller's session, so a missing id is a hard error. */
function requiresInvokingSession(scope: BridgeToolDefinition["scope"]): boolean {
  return scope === "session";
}

const ADAPTED_HANDLER = Symbol.for("bridge.tool.adaptedHandler");

/**
 * True when the handler was produced by `defineBridgeTool`, and therefore runs
 * argument validation and the session guard. The registry rejects anything else
 * so a tool cannot be registered with those checks patched out.
 */
export function isAdaptedToolHandler(handler: unknown): boolean {
  return typeof handler === "function"
    && (handler as unknown as Record<symbol, unknown>)[ADAPTED_HANDLER] === true;
}

export function defineBridgeTool(
  name: string,
  options: DefineBridgeToolOptions,
): BridgeToolDefinition {
  const inputSchema = options.parameters ?? { type: "object", properties: {} };
  const handler: BridgeToolDefinition["handler"] = async (args, extra) => {
    const invocation = bridgeInvocationFromMcp(name, args, extra);

    const schemaError = validateToolArguments(inputSchema, args);
    if (schemaError) {
      return toolFailure(`Invalid arguments for ${name}: ${schemaError}`, {
        detail: "Correct the arguments to match the tool's declared schema, then call the tool again.",
      });
    }

    if (requiresInvokingSession(options.scope) && !invocation.sessionId) {
      return toolFailure(`${name} requires an invoking session.`, {
        detail: "This tool is session-scoped and was called without a session id.",
      });
    }

    return options.handler(args, invocation);
  };
  Object.defineProperty(handler, ADAPTED_HANDLER, { value: true });

  return {
    name,
    description: options.description,
    inputSchema,
    scope: options.scope,
    handler,
  };
}

/**
 * Define a session-scoped tool. The adapter rejects the call when no session id
 * is present, so the handler receives a guaranteed `sessionId` and does not
 * repeat that check.
 */
export function defineSessionBridgeTool(
  name: string,
  options: DefineSessionBridgeToolOptions,
): BridgeToolDefinition {
  return defineBridgeTool(name, {
    ...options,
    scope: "session",
    handler: (args, invocation) => options.handler(args, invocation as SessionBridgeToolInvocation),
  });
}

export function registerBridgeToolDefinitions(
  server: { registerTool(definition: BridgeToolDefinition): void },
  definitions: readonly BridgeToolDefinition[],
): void {
  for (const definition of definitions) {
    server.registerTool(definition);
  }
}
