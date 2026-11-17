import { toolFailure } from "../tool-results.js";
import { validateToolArguments } from "./validate-args.js";
import { isRecord } from "../../shared/is-record.js";
import type { BridgeToolDefinition, BridgeToolHandlerResult } from "./server.js";

export interface BridgeToolInvocation {
  /** Session that issued the call; `undefined`, never an empty string, when there is none. */
  sessionId: string | undefined;
  /** SDK sub-agent instance; a delegated call shares its parent chat's sessionId. */
  agentId?: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Invocation handed to session-scoped tools, where the session id is guaranteed. */
export interface SessionBridgeToolInvocation extends BridgeToolInvocation {
  sessionId: string;
}

/** A handler's arguments, checked against `parameters` first: the type must match that schema. */
export type BridgeToolArgs = object;

export interface DefineBridgeToolOptions<Args extends BridgeToolArgs = Record<string, unknown>> {
  description?: string;
  parameters?: BridgeToolDefinition["inputSchema"];
  scope?: BridgeToolDefinition["scope"];
  handler: (
    args: Args,
    invocation: BridgeToolInvocation,
  ) => BridgeToolHandlerResult | Promise<BridgeToolHandlerResult>;
}

export interface DefineSessionBridgeToolOptions<Args extends BridgeToolArgs = Record<string, unknown>> {
  description?: string;
  parameters?: BridgeToolDefinition["inputSchema"];
  handler: (
    args: Args,
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
  extra: unknown,
): BridgeToolInvocation {
  const fields = isRecord(extra) ? extra : {};
  const { requestId, agentId, signal } = fields;
  return {
    sessionId: normalizeInvocationSessionId(fields.sessionId),
    agentId: typeof agentId === "string" ? agentId : undefined,
    toolCallId: requestId === undefined || requestId === null ? "" : String(requestId),
    toolName: name,
    arguments: args,
    signal: signal instanceof AbortSignal ? signal : undefined,
  };
}

/** Session-scoped tools act on the caller's session, so a missing id is a hard error. */
function requiresInvokingSession(scope: BridgeToolDefinition["scope"]): boolean {
  return scope === "session";
}

const ADAPTED_HANDLER = Symbol.for("bridge.tool.adaptedHandler");

/** Only defineBridgeTool handlers (validation plus session guard) may be registered. */
export function isAdaptedToolHandler(handler: unknown): boolean {
  return typeof handler === "function"
    && (handler as unknown as Record<symbol, unknown>)[ADAPTED_HANDLER] === true;
}

export function defineBridgeTool<Args extends BridgeToolArgs = Record<string, unknown>>(
  name: string,
  options: DefineBridgeToolOptions<Args>,
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

    // validateToolArguments has checked args against the schema that Args describes.
    return options.handler(args as Args, invocation);
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

/** A session-scoped tool: calls without a session id are rejected, so handlers get one. */
export function defineSessionBridgeTool<Args extends BridgeToolArgs = Record<string, unknown>>(
  name: string,
  options: DefineSessionBridgeToolOptions<Args>,
): BridgeToolDefinition {
  return defineBridgeTool<Args>(name, {
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
