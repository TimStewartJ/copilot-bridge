// browser_exec — structured freeform browser automation that runs through the
// bridge-owned browser session wrappers instead of raw bash.

import { randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import { ab, getBrowserLaunchConfig, isAgentBrowserInstalled, safeRecordBrowserSpan } from "./agent-browser.js";
import {
  getOrCreateBrowserBroker,
  type BrowserBrokerLease,
  type BrowserContext,
} from "./browser-broker.js";
import { captureFinalBrowserState, formatBrowserStepTimeline, normalizeBrowserAutomationCapture, normalizeBrowserAutomationCommands, runBrowserAutomationCommands, truncateBrowserFailureText, type BrowserAutomationCaptureInput, type BrowserAutomationCommand, type BrowserAutomationRunFailure } from "./browser-automation.js";
import { err, joinFailureSections, ok, toolFailure, toolFailureWithContext, type Result } from "./tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/server.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";

type BrowserExecLane = "auto" | "primary" | "clone";

interface BrowserExecNormalizedInput {
  context: BrowserContext;
  legacyLane?: BrowserExecLane;
  reason?: string;
  allowedOrigins?: string[];
  commands: BrowserAutomationCommand[];
  capture?: BrowserAutomationCaptureInput;
}

const AGENT_BROWSER_INSTALL_GUIDANCE =
  "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install";

function browserExecStepFailure(
  failure: BrowserAutomationRunFailure,
  context: BrowserContext,
) {
  const stepOutput = truncateBrowserFailureText(failure.failedStep.output);
  const detail = joinFailureSections(
    failure.error,
    stepOutput && stepOutput !== failure.error ? stepOutput : undefined,
  ) ?? failure.error;
  return toolFailureWithContext(failure.error, {
    context,
    failedStep: failure.failedStep,
    steps: failure.steps,
  }, {
    detail,
    sessionLog: joinFailureSections(
      `Browser context: ${context}`,
      `Failed step: ${failure.failedStep.index + 1} ${failure.failedStep.command}`,
      formatBrowserStepTimeline(failure.steps),
    ),
  });
}

export function normalizeBrowserExecInput(args: any): Result<BrowserExecNormalizedInput> {
  const context = args.context;
  if (context !== undefined && context !== "public" && context !== "authenticated") {
    return err("context must be one of: public, authenticated");
  }
  const lane = args.lane as BrowserExecLane | undefined;
  if (lane !== undefined && lane !== "auto" && lane !== "primary" && lane !== "clone") {
    return err("lane must be one of: auto, primary, clone");
  }
  if (context !== undefined && lane !== undefined) {
    return err("provide context or legacy lane, not both");
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : undefined;
  if (args.reason !== undefined && !reason) {
    return err("reason must be a non-empty string");
  }
  let allowedOrigins: string[] | undefined;
  if (args.allowedOrigins !== undefined) {
    if (!Array.isArray(args.allowedOrigins) || args.allowedOrigins.some((value: unknown) => typeof value !== "string")) {
      return err("allowedOrigins must be an array of HTTP(S) origins");
    }
    try {
      allowedOrigins = args.allowedOrigins.map((value: string) => {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
        return parsed.origin;
      });
    } catch {
      return err("allowedOrigins must contain valid HTTP(S) origins");
    }
  }

  const commands = normalizeBrowserAutomationCommands(args.commands);
  if (!commands.ok) return err(commands.error);
  const capture = normalizeBrowserAutomationCapture(args.capture);
  if (!capture.ok) return err(capture.error);

  const resolvedContext = context ?? (lane === "primary" ? "authenticated" : "public");
  if (resolvedContext === "authenticated" && !reason && lane !== "primary") {
    return err("reason is required for authenticated browser access");
  }

  for (const command of commands.value) {
    if (resolvedContext !== "authenticated" || !allowedOrigins?.length || command.command !== "open") continue;
    const origin = new URL(command.args[0]).origin;
    if (!allowedOrigins.includes(origin)) {
      return err(`authenticated browser URL origin is not allowed: ${origin}`);
    }
  }

  return ok({
    context: resolvedContext,
    ...(lane ? { legacyLane: lane } : {}),
    ...(reason ? { reason } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
    commands: commands.value,
    capture: capture.value,
  });
}

export function resolveBrowserExecContext(
  lane: BrowserExecLane,
  _commands: BrowserExecNormalizedInput["commands"],
): BrowserContext {
  return lane === "primary" ? "authenticated" : "public";
}

export function createBrowserExecTools(ctx: AppContext): BridgeToolDefinition[] {
  const browserBroker = getOrCreateBrowserBroker(ctx, {
    copilotHome: ctx.copilotHome,
    telemetryStore: ctx.telemetryStore,
    getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
  });
  return [
    defineBridgeTool("browser_exec", {
      description:
        "Execute structured browser automation through a Bridge-managed browser security context. " +
        "The public context is disposable and unauthenticated. Use authenticated only when the task " +
        "explicitly requires the dedicated signed-in Bridge profile. " +
        "Use this for hardened freeform browsing when browser_fetch is too narrow but you still " +
        "want Bridge-owned profile handling, serialization, readiness checks, and recovery. " +
        "Element refs (for example, @e12) are valid only within the same browser_exec call as the snapshot that produced them, " +
        "so include the snapshot and any ref-targeting click, fill, type, select, or check step in one commands array. " +
        "If a snapshot ref must be reused across calls, use the browser_session_* tools. " +
        "For unsupported low-level agent-browser features, use the browser skill.",
      parameters: {
        type: "object" as const,
        properties: {
          context: {
            type: "string",
            enum: ["public", "authenticated"],
            description:
              "Browser security context. Defaults to public. Authenticated uses the dedicated signed-in Bridge profile and is serialized.",
          },
          reason: {
            type: "string",
            description: "Required justification when context is authenticated.",
          },
          allowedOrigins: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional HTTP(S) origin allowlist for authenticated navigation, such as https://msazure.visualstudio.com.",
          },
          lane: {
            type: "string",
            enum: ["auto", "primary", "clone"],
            description:
              "Deprecated compatibility input. primary maps to authenticated; auto and clone map to public. Use context instead.",
          },
          commands: {
            type: "array",
            description: "Structured browser steps to run in order.",
            items: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  enum: ["open", "wait", "snapshot", "click", "fill", "type", "select", "check", "press", "scroll", "get"],
                  description: "The agent-browser command name",
                },
                args: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "String arguments for the command. Element-targeting commands (click, fill, type, select, check) use refs from snapshot output — " +
                    "pass the ref with @ prefix (e.g. @e42 for an element shown as [ref=e42] in the snapshot). CSS selectors are not supported for element targeting. " +
                    "The get command reads page or element info: use args ['url'] for the current URL, ['title'] for the page title, or ['text', '@e42'] for an element's text by ref.",
                },
                timeoutMs: {
                  type: "number",
                  description: "Optional per-command timeout in milliseconds",
                },
              },
              required: ["command"],
            },
          },
          capture: {
            type: "object",
            description: "Optional final page state to capture after the command list completes.",
            properties: {
              url: { type: "boolean" },
              title: { type: "boolean" },
              snapshot: { type: "boolean" },
              selector: { type: "string" },
            },
          },
        },
        required: ["commands"],
      },
      handler: async (args: any) => {
        const normalized = normalizeBrowserExecInput(args);
        if (!normalized.ok) return toolFailure(normalized.error);
        const normalizedInput = normalized.value;

        const browserOpId = randomUUID();
        const toolStart = Date.now();
        const context = normalizedInput.context;
        const stepNames = normalizedInput.commands.map((command) => command.command).join(",");
        let success = false;
        let browserSession: string | undefined;

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_exec",
            browserContext: context,
            legacyLane: normalizedInput.legacyLane,
            authenticatedReason: normalizedInput.reason,
            allowedOrigins: normalizedInput.allowedOrigins,
          });
          return toolFailure("agent-browser is not installed.", {
            detail: AGENT_BROWSER_INSTALL_GUIDANCE,
            sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
          });
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "browser_exec",
          browserContext: context,
          legacyLane: normalizedInput.legacyLane,
        });

        const runFlow = async (lease: BrowserBrokerLease) => {
          browserSession = lease.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_exec",
            browserOpId,
            browserTarget: lease.browserTarget,
            metadata: {
              browserContext: context,
              legacyLane: normalizedInput.legacyLane,
              publicTargetId: lease.publicTargetId,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
          };

          const execution = await runBrowserAutomationCommands(normalizedInput.commands, commandOptions);
          if (!execution.ok) {
            return browserExecStepFailure(execution.error, context);
          }
          const finalState = await captureFinalBrowserState(normalizedInput.capture, commandOptions);
          if (context === "authenticated" && normalizedInput.allowedOrigins?.length) {
            const currentUrl = await ab(["get", "url"], undefined, commandOptions);
            if (!currentUrl.ok) {
              throw new Error(`Failed to verify authenticated browser origin: ${currentUrl.output.slice(0, 200)}`);
            }
            const currentOrigin = new URL(currentUrl.output.trim()).origin;
            if (!normalizedInput.allowedOrigins.includes(currentOrigin)) {
              throw new Error(`Authenticated browser left the allowed origins: ${currentOrigin}`);
            }
          }
          success = true;
          return {
            context,
            ...(normalizedInput.legacyLane ? { deprecatedLane: normalizedInput.legacyLane } : {}),
            steps: execution.value.steps,
            finalState,
          };
        };

        try {
          return await browserBroker.withEphemeralContext(context, {
            browserOpId,
            toolName: "browser_exec",
            metadata: {
              browserOpId,
              browserContext: context,
              legacyLane: normalizedInput.legacyLane,
              authenticatedReason: normalizedInput.reason,
              allowedOrigins: normalizedInput.allowedOrigins,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
          }, runFlow);
        } catch (err: any) {
          const detail = `Browser exec failed: ${String(err).slice(0, 200)}`;
          return toolFailure("Browser exec failed.", {
            detail,
            sessionLog: detail,
          });
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec", duration, {
            browserOpId,
            browserSession,
            success,
            browserContext: context,
            legacyLane: normalizedInput.legacyLane,
            authenticatedReason: normalizedInput.reason,
            stepCount: normalizedInput.commands.length,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec.failed", duration, {
              browserOpId,
              browserSession,
              browserContext: context,
              legacyLane: normalizedInput.legacyLane,
              authenticatedReason: normalizedInput.reason,
              stepCount: normalizedInput.commands.length,
            });
          }
        }
      },
    }),
  ];
}

export function registerBrowserExecTools(server: BridgeToolsMcpServer, ctx: AppContext): void {
  registerBridgeToolDefinitions(server, createBrowserExecTools(ctx));
}
