// browser_exec — structured freeform browser automation that runs through the
// bridge-owned browser session wrappers instead of raw bash.

import { randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import { ab, safeRecordBrowserSpan } from "./agent-browser.js";
import type { BrowserBrokerLease, BrowserContext } from "./browser-broker.js";
import { getBrowserRuntime } from "./browser-runtime.js";
import {
  agentBrowserMissingFailure,
  BROWSER_CAPTURE_PARAMETER,
  BROWSER_COMMANDS_PARAMETER,
  browserStepFailure,
  captureFinalBrowserState,
  normalizeBrowserAutomationCapture,
  normalizeBrowserAutomationCommands,
  runBrowserAutomationCommands,
  withScreenshots,
  type BrowserAutomationCaptureInput,
  type BrowserAutomationCommand,
} from "./browser-automation.js";
import { checkPage, pageBlockFields } from "./browser-page-check.js";
import { chatStepFiles } from "./browser-step-files.js";
import { err, ok, toolFailure, type Result } from "./tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/server.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";

interface BrowserExecNormalizedInput {
  context: BrowserContext;
  reason?: string;
  allowedOrigins?: string[];
  commands: BrowserAutomationCommand[];
  capture?: BrowserAutomationCaptureInput;
}

export function normalizeBrowserExecInput(args: any): Result<BrowserExecNormalizedInput> {
  const context = args.context;
  if (context !== undefined && context !== "public" && context !== "authenticated") {
    return err("context must be one of: public, authenticated");
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

  const resolvedContext: BrowserContext = context ?? "public";
  if (resolvedContext === "authenticated" && !reason) {
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
    ...(reason ? { reason } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
    commands: commands.value,
    capture: capture.value,
  });
}

export function createBrowserExecTools(ctx: AppContext): BridgeToolDefinition[] {
  const browserBroker = getBrowserRuntime(ctx).broker;
  return [
    defineBridgeTool("browser_exec", {
      description:
        "Execute structured browser automation through a Bridge-managed browser security context. " +
        "The public context is not signed in to anything and keeps its cookies between uses; its browser " +
        "is closed when the call returns. Use authenticated only when the task " +
        "explicitly requires the dedicated signed-in Bridge profile. " +
        "When the page is a site's human check or refusal, the result says so in `blocked` with what to do next. " +
        "Use this for hardened freeform browsing when browser_fetch is too narrow but you still " +
        "want Bridge-owned profile handling, serialization, readiness checks, and recovery. " +
        "Element refs (for example, @e12) are valid only within the same browser_exec call as the snapshot that produced them, " +
        "so include the snapshot and the steps that use its refs in one commands array. " +
        "If a snapshot ref must be reused across calls, use the browser_session_* tools. " +
        "A step can be nearly any agent-browser command, including screenshot (you get the picture), drag, upload and download.",
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
          commands: BROWSER_COMMANDS_PARAMETER,
          capture: BROWSER_CAPTURE_PARAMETER,
        },
        required: ["commands"],
      },
      handler: async (args: any, invocation) => {
        const normalized = normalizeBrowserExecInput(args);
        if (!normalized.ok) return toolFailure(normalized.error);
        const normalizedInput = normalized.value;

        const browserOpId = randomUUID();
        const toolStart = Date.now();
        const context = normalizedInput.context;
        const stepNames = normalizedInput.commands.map((command) => command.command).join(",");
        let success = false;
        let browserSession: string | undefined;

        const missing = await agentBrowserMissingFailure();
        if (missing) return missing;

        const runFlow = async (lease: BrowserBrokerLease) => {
          browserSession = lease.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_exec",
            browserOpId,
            browserTarget: lease.browserTarget,
            metadata: {
              browserContext: context,
              publicSlot: lease.publicSlot,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
          };

          const execution = await runBrowserAutomationCommands(
            normalizedInput.commands,
            commandOptions,
            chatStepFiles(ctx, invocation.sessionId),
          );
          if (!execution.ok) {
            // A step often fails because the site put a check where the page was expected.
            return withScreenshots(browserStepFailure(
              execution.error,
              { context },
              pageBlockFields(await checkPage(commandOptions)),
              [`Browser context: ${context}`],
            ), execution.error.images);
          }
          const finalState = await captureFinalBrowserState(normalizedInput.capture, commandOptions);
          const pageBlock = pageBlockFields(await checkPage(commandOptions));
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
          return withScreenshots({
            ...pageBlock,
            context,
            steps: execution.value.steps,
            finalState,
          }, execution.value.images);
        };

        try {
          return await browserBroker.withEphemeralContext(context, {
            browserOpId,
            toolName: "browser_exec",
            metadata: {
              browserOpId,
              browserContext: context,
              authenticatedReason: normalizedInput.reason,
              allowedOrigins: normalizedInput.allowedOrigins,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
          }, runFlow);
        } catch (err: any) {
          const detail = `Browser exec failed: ${String(err).slice(0, 400)}`;
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
            authenticatedReason: normalizedInput.reason,
            stepCount: normalizedInput.commands.length,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec.failed", duration, {
              browserOpId,
              browserSession,
              browserContext: context,
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
