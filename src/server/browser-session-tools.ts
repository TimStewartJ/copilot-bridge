import { randomUUID } from "node:crypto";
import { BROWSER_HANDOFF_ANSWERS } from "../shared/browser-live.js";
import type { AppContext } from "./app-context.js";
import { safeRecordBrowserSpan, type BrowserCommandOptions } from "./agent-browser.js";
import type { BrowserBrokerLease, BrowserBrokerOperationOptions } from "./browser-broker.js";
import {
  agentBrowserMissingFailure,
  browserStepFailure,
  captureFinalBrowserState,
  runBrowserAutomationCommands,
  withScreenshots,
} from "./browser-automation.js";
import { BrowserLiveUnavailableError } from "./browser-live.js";
import { checkPage, pageBlockFields } from "./browser-page-check.js";
import {
  BROWSER_CAPTURE_PARAMETER,
  BROWSER_COMMANDS_PARAMETER,
  normalizeBrowserAutomationCapture,
  normalizeBrowserAutomationCommands,
} from "./browser-steps.js";
import { chatStepFiles } from "./browser-step-files.js";
import { getBrowserRuntime } from "./browser-runtime.js";
import { sessionLease, type BrowserSessionRecord } from "./browser-session-store.js";
import { defineSessionBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";
import { toolFailure } from "./tool-results.js";

const MAX_HANDOFF_REASON_LENGTH = 500;

export interface RegisterBrowserSessionToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

interface SessionOperation {
  lease: BrowserBrokerLease;
  /** For the broker, which runs the operation on the session's browser. */
  operation: BrowserBrokerOperationOptions;
  /** For the agent-browser commands of the operation. */
  commandOptions: BrowserCommandOptions;
}

export function createBrowserSessionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  const { broker: browserBroker, sessions: browserSessionStore, live: browserLive } = getBrowserRuntime(ctx);

  const sessionOperation = (
    toolName: string,
    browserOpId: string,
    record: BrowserSessionRecord,
    extraMetadata: Record<string, unknown> = {},
  ): SessionOperation => {
    const metadata = {
      browserSessionId: record.id,
      browserContext: record.context,
      ownerSessionId: record.ownerSessionId,
      publicSlot: record.publicSlot,
      ...extraMetadata,
    };
    return {
      lease: sessionLease(record),
      operation: { toolName, browserOpId, metadata },
      commandOptions: {
        telemetryStore: ctx.telemetryStore,
        toolName,
        browserOpId,
        browserTarget: record.browserTarget,
        metadata,
      },
    };
  };

  /** Runs a tool's commands on a browser session of the calling chat, one tool call at a time. */
  const onSessionBrowser = async (
    toolName: string,
    failureSummary: string,
    args: { browserSessionId: string },
    chatSessionId: string,
    extraMetadata: Record<string, unknown>,
    fn: (record: BrowserSessionRecord, commandOptions: BrowserCommandOptions) => Promise<unknown>,
  ): Promise<unknown> => {
    const browserOpId = randomUUID();
    try {
      const result = await browserSessionStore.useSession(args.browserSessionId, chatSessionId, (record) => {
        const { lease, operation, commandOptions } = sessionOperation(toolName, browserOpId, record, extraMetadata);
        return browserBroker.withTarget(lease, operation, () => fn(record, commandOptions));
      });
      return result.ok ? result.value : toolFailure(result.error);
    } catch (error) {
      return toolFailure(`${failureSummary}.`, { detail: `${failureSummary}: ${String(error).slice(0, 400)}` });
    }
  };

  return [
    defineSessionBridgeTool("browser_session_start", {
      description:
        "Create an explicit browser session handle for multi-turn continuity. Its browser stays open " +
        "between calls, so the user can be handed the same page with browser_session_handoff. Public " +
        "sessions are not signed in to anything and keep their cookies between uses. Authenticated " +
        "sessions reuse the dedicated signed-in Bridge profile and are serialized.",
      parameters: {
        type: "object" as const,
        properties: {
          context: {
            type: "string",
            enum: ["public", "authenticated"],
            description: "Browser security context",
          },
          purpose: {
            type: "string",
            description: "Short note about what this browser session is for. Required for authenticated.",
          },
        },
        required: ["context"],
      },
      handler: async (args: any, invocation) => {
        const context = args.context;
        if (context !== "public" && context !== "authenticated") {
          return toolFailure("Browser session context must be public or authenticated.");
        }
        const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
        if (context === "authenticated" && !purpose) {
          return toolFailure("purpose is required for an authenticated browser session.");
        }
        const missing = await agentBrowserMissingFailure();
        if (missing) return missing;
        let record;
        try {
          record = await browserSessionStore.createSession(invocation.sessionId, context, purpose || undefined);
        } catch (err: any) {
          return toolFailure("Failed to start browser session.", {
            detail: `Failed to start browser session: ${String(err).slice(0, 400)}`,
          });
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_session_start", 0, {
          browserOpId: randomUUID(),
          browserSessionId: record.id,
          browserContext: record.context,
          ownerSessionId: invocation.sessionId,
          browserSession: record.browserTarget.sessionName,
        });
        return {
          browserSessionId: record.id,
          context: record.context,
          sharedAuthenticated: record.context === "authenticated",
          createdAt: new Date(record.createdAt).toISOString(),
        };
      },
    }),
    defineSessionBridgeTool("browser_session_exec", {
      description:
        "Execute structured browser automation steps against an explicit browser session handle. " +
        "Use this when a browser workflow must persist across multiple turns. " +
        "A step can be nearly any agent-browser command, including screenshot (you get the picture), drag, upload and download.",
      parameters: {
        type: "object" as const,
        properties: {
          browserSessionId: {
            type: "string",
            description: "The browser session handle returned by browser_session_start",
          },
          commands: BROWSER_COMMANDS_PARAMETER,
          capture: BROWSER_CAPTURE_PARAMETER,
        },
        required: ["browserSessionId", "commands"],
      },
      handler: async (args: any, invocation) => {
        const commands = normalizeBrowserAutomationCommands(args.commands);
        if (!commands.ok) return toolFailure(commands.error);
        const capture = normalizeBrowserAutomationCapture(args.capture);
        if (!capture.ok) return toolFailure(capture.error);
        return onSessionBrowser(
          "browser_session_exec",
          "Browser session exec failed",
          args,
          invocation.sessionId,
          { stepCount: commands.value.length },
          async (record, commandOptions) => {
            const session = { browserSessionId: record.id, context: record.context };
            const execution = await runBrowserAutomationCommands(
              commands.value,
              commandOptions,
              chatStepFiles(ctx, invocation.sessionId),
            );
            if (!execution.ok) {
              return withScreenshots(browserStepFailure(
                execution.error,
                session,
                pageBlockFields(await checkPage(commandOptions), record.id),
                [`Browser session: ${record.id}`, `Browser context: ${record.context}`],
              ), execution.error.images);
            }
            const finalState = await captureFinalBrowserState(capture.value, commandOptions);
            return withScreenshots({
              ...pageBlockFields(await checkPage(commandOptions), record.id),
              ...session,
              steps: execution.value.steps,
              finalState,
            }, execution.value.images);
          },
        );
      },
    }),
    defineSessionBridgeTool("browser_session_get_state", {
      description:
        "Inspect the current state of an explicit browser session handle. By default returns URL and title; " +
        "optionally capture a fresh accessibility snapshot too.",
      parameters: {
        type: "object" as const,
        properties: {
          browserSessionId: {
            type: "string",
            description: "The browser session handle returned by browser_session_start",
          },
          url: { type: "boolean", description: "Include current URL (default true)" },
          title: { type: "boolean", description: "Include current title (default true)" },
          snapshot: { type: "boolean", description: "Include a fresh accessibility snapshot" },
          selector: { type: "string", description: "Optional selector to scope snapshot capture" },
        },
        required: ["browserSessionId"],
      },
      handler: async (args: any, invocation) => {
        const capture = normalizeBrowserAutomationCapture({
          url: args.url ?? true,
          title: args.title ?? true,
          snapshot: args.snapshot ?? false,
          selector: args.selector,
        });
        if (!capture.ok) return toolFailure(capture.error);
        return onSessionBrowser(
          "browser_session_get_state",
          "Failed to inspect browser session",
          args,
          invocation.sessionId,
          {},
          async (record, commandOptions) => {
            const state = await captureFinalBrowserState(capture.value, commandOptions);
            return {
              ...pageBlockFields(await checkPage(commandOptions), record.id),
              browserSessionId: record.id,
              context: record.context,
              state,
            };
          },
        );
      },
    }),
    defineSessionBridgeTool("browser_session_handoff", {
      description:
        "Ask the user to do something in a browser session that only a person can do: pass a human " +
        "check or CAPTCHA, sign in, approve a prompt. The user gets a request with a live view of this " +
        "browser, acts in it, and hands it back; what they type there is not shown to you. The call " +
        "returns when they answer, with the page as they left it. Navigate to the page that needs them " +
        "first. When the answer says nobody was there to do it, carry on without that step and say what " +
        "is waiting for the user.",
      parameters: {
        type: "object" as const,
        properties: {
          browserSessionId: {
            type: "string",
            description: "The browser session handle returned by browser_session_start",
          },
          reason: {
            type: "string",
            description:
              "What the user has to do and on which site, in one or two plain sentences they can act on " +
              "without the rest of the conversation.",
          },
        },
        required: ["browserSessionId", "reason"],
      },
      handler: async (args: any, invocation) => {
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (!reason) return toolFailure("reason is required: say what the user has to do in the browser.");
        if (reason.length > MAX_HANDOFF_REASON_LENGTH) {
          return toolFailure(`reason must be at most ${MAX_HANDOFF_REASON_LENGTH} characters.`);
        }
        const unattended = {
          browserSessionId: args.browserSessionId,
          handoff: "unattended",
          guidance: "Nobody acted in the browser. The session is still open. Carry on without this step and say what is waiting for the user; do not ask again in this turn.",
        };
        const browserOpId = randomUUID();
        const startedAt = Date.now();
        let outcome = "failed";
        try {
          const result = await browserSessionStore.useSession(args.browserSessionId, invocation.sessionId, async (record) => {
            const { lease, operation, commandOptions } = sessionOperation("browser_session_handoff", browserOpId, record);
            // A background worker has no user to ask.
            if (!ctx.sessionManager.canRequestElicitation(invocation.sessionId)) {
              outcome = "unattended";
              return unattended;
            }
            // The browser has to be running before anyone is asked to look at it.
            await browserBroker.withTarget(lease, operation, () => browserLive.resolveStreamPort(record.browserTarget));

            // The browser is the user's until they answer: nothing else may navigate it under them.
            const releaseBrowser = browserBroker.holdTarget(lease, reason.slice(0, 120));
            const handoff = browserSessionStore.beginHandoff(invocation.sessionId, record.id, reason);
            let response;
            try {
              response = await ctx.sessionManager.requestElicitation(invocation.sessionId, {
                message: `The browser needs you: ${reason}`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    [handoff.fieldName]: {
                      type: "string",
                      title: "Open the browser, do this, then answer",
                      enum: [BROWSER_HANDOFF_ANSWERS.done, BROWSER_HANDOFF_ANSWERS.notDone],
                      enumNames: ["Done, continue", "I couldn't do it"],
                    },
                  },
                  required: [handoff.fieldName],
                },
              });
            } finally {
              handoff.end();
              releaseBrowser();
            }

            const answer = response.action === "accept" ? response.content?.[handoff.fieldName] : undefined;
            if (response.action !== "accept") {
              outcome = response.action === "decline" ? "declined" : "cancelled";
              return {
                browserSessionId: record.id,
                handoff: outcome,
                guidance: "The user did not do it. The browser session is still open. Carry on without this step and say what is waiting for them.",
              };
            }
            if (answer !== BROWSER_HANDOFF_ANSWERS.done && answer !== BROWSER_HANDOFF_ANSWERS.notDone) {
              // Bridge answers in the user's place when they are away or the chat runs unattended.
              outcome = "unattended";
              return { ...unattended, ...(typeof answer === "string" && answer ? { reply: answer } : {}) };
            }
            outcome = answer === BROWSER_HANDOFF_ANSWERS.done ? "completed" : "not_completed";
            // The answer can come after the Bridge closed the browser, as it does when it shuts down.
            if (!browserSessionStore.getSession(record.id)) {
              return { browserSessionId: record.id, handoff: outcome, guidance: "The browser session has ended since; start a new one to continue." };
            }
            return browserBroker.withTarget(lease, operation, async () => {
              const state = await captureFinalBrowserState({ url: true, title: true, snapshot: true }, commandOptions);
              return {
                ...pageBlockFields(await checkPage(commandOptions), record.id),
                browserSessionId: record.id,
                handoff: outcome,
                ...(outcome === "not_completed"
                  ? { guidance: "The user could not do it. Carry on without this step, or ask them what went wrong." }
                  : {}),
                state,
              };
            });
          });
          return result.ok ? result.value : toolFailure(result.error);
        } catch (err: any) {
          if (err instanceof BrowserLiveUnavailableError) return toolFailure(err.message);
          return toolFailure("Browser handoff failed.", {
            detail: `Browser handoff failed: ${String(err).slice(0, 400)}`,
          });
        } finally {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_session_handoff", Date.now() - startedAt, {
            browserOpId,
            browserSessionId: args.browserSessionId,
            ownerSessionId: invocation.sessionId,
            outcome,
          });
        }
      },
    }),
    defineSessionBridgeTool("browser_session_close", {
      description: "Close an explicit browser session handle and release any associated public browser resources.",
      parameters: {
        type: "object" as const,
        properties: {
          browserSessionId: {
            type: "string",
            description: "The browser session handle returned by browser_session_start",
          },
        },
        required: ["browserSessionId"],
      },
      handler: async (args: any, invocation) => {
        const result = await browserSessionStore.closeSession(args.browserSessionId, invocation.sessionId);
        if (!result.ok) return toolFailure(result.error);
        return { success: true, browserSessionId: args.browserSessionId };
      },
    }),
  ];
}

export function registerBrowserSessionTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterBrowserSessionToolsOptions = {},
): void {
  const definitions = createBrowserSessionToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
