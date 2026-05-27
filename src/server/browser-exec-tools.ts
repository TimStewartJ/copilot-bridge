// browser_exec — structured freeform browser automation that runs through the
// bridge-owned browser session wrappers instead of raw bash.

import { randomUUID } from "node:crypto";
import type { AppContext } from "./app-context.js";
import type { BrowserLane } from "./agent-browser.js";
import { browserLaneFallbackTelemetry, createBrowserLaneFallbackState, getBridgeBrowserTarget, getBrowserLaunchConfig, isAgentBrowserInstalled, safeRecordBrowserSpan, withBrowserLaneFallback } from "./agent-browser.js";
import { captureFinalBrowserState, normalizeBrowserAutomationCapture, normalizeBrowserAutomationCommands, runBrowserAutomationCommands, type BrowserAutomationCaptureInput, type BrowserAutomationCommand, type BrowserAutomationCommandName, type BrowserAutomationRunFailure, type BrowserAutomationStepResult } from "./browser-automation.js";
import { err, joinFailureSections, ok, toolFailure, toolFailureWithContext, type Result } from "./tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "./agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/server.js";
import type { BridgeToolsMcpServer } from "./agent-tools-mcp/server.js";

type BrowserExecLane = "auto" | "primary" | "clone";
type BrowserExecResolvedLane = "primary" | "clone";

interface BrowserExecNormalizedInput {
  lane: BrowserExecLane;
  commands: BrowserAutomationCommand[];
  capture?: BrowserAutomationCaptureInput;
}

const MUTATING_COMMANDS = new Set<BrowserAutomationCommandName>([
  "click",
  "fill",
  "type",
  "select",
  "check",
  "press",
]);

const AGENT_BROWSER_INSTALL_GUIDANCE =
  "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install";

function truncateBrowserFailureText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function formatBrowserStepTimeline(steps: BrowserAutomationStepResult[]): string | undefined {
  if (steps.length === 0) return undefined;
  return steps.map((step) => {
    const output = truncateBrowserFailureText(step.output);
    return `${step.index + 1}. ${step.command} ${step.ok ? "ok" : "failed"}${output ? ` — ${output}` : ""}`;
  }).join("\n");
}

function browserExecStepFailure(
  failure: BrowserAutomationRunFailure,
  lane: BrowserExecResolvedLane,
) {
  const stepOutput = truncateBrowserFailureText(failure.failedStep.output);
  const detail = joinFailureSections(
    failure.error,
    stepOutput && stepOutput !== failure.error ? stepOutput : undefined,
  ) ?? failure.error;
  return toolFailureWithContext(failure.error, {
    lane,
    failedStep: failure.failedStep,
    steps: failure.steps,
  }, {
    detail,
    sessionLog: joinFailureSections(
      `Lane: ${lane}`,
      `Failed step: ${failure.failedStep.index + 1} ${failure.failedStep.command}`,
      formatBrowserStepTimeline(failure.steps),
    ),
  });
}

export function normalizeBrowserExecInput(args: any): Result<BrowserExecNormalizedInput> {
  const lane = args.lane ?? "auto";
  if (lane !== "auto" && lane !== "primary" && lane !== "clone") {
    return err("lane must be one of: auto, primary, clone");
  }

  const commands = normalizeBrowserAutomationCommands(args.commands);
  if (!commands.ok) return err(commands.error);
  const capture = normalizeBrowserAutomationCapture(args.capture);
  if (!capture.ok) return err(capture.error);

  return ok({
    lane,
    commands: commands.value,
    capture: capture.value,
  });
}

export function resolveBrowserExecLane(
  lane: BrowserExecLane,
  commands: BrowserExecNormalizedInput["commands"],
): BrowserExecResolvedLane {
  if (lane === "primary" || lane === "clone") return lane;
  if (commands.some((command) => MUTATING_COMMANDS.has(command.command))) return "primary";
  return commands[0]?.command === "open" ? "clone" : "primary";
}

export function createBrowserExecTools(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineBridgeTool("browser_exec", {
      description:
        "Execute structured browser automation steps through the bridge-managed browser session. " +
        "Use this for hardened freeform browsing when browser_fetch is too narrow but you still " +
        "want bridge-owned session/profile handling, primary-lane serialization, clone support, " +
        "and Chrome recovery. For unsupported low-level agent-browser features, use the browser skill.",
      parameters: {
        type: "object" as const,
        properties: {
          lane: {
            type: "string",
            enum: ["auto", "primary", "clone"],
            description:
              "Lane selection. auto uses clone for read-only flows that establish their own page with open, and primary for stateful interactions or flows that rely on existing browser state. " +
              "Clone lanes are isolated — element refs and page state from one clone call are invalid in another. Use primary or browser_session_* for multi-step flows that need to reference elements across calls.",
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
                    "pass the ref with @ prefix (e.g. @e42 for an element shown as [ref=e42] in the snapshot). CSS selectors are not supported for element targeting.",
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
        const launchConfig = getBrowserLaunchConfig(ctx.settingsStore.getSettings());
        const primaryTarget = getBridgeBrowserTarget(ctx.copilotHome, launchConfig);
        const toolStart = Date.now();
        const requestedLane = normalizedInput.lane;
        const resolvedLane = resolveBrowserExecLane(normalizedInput.lane, normalizedInput.commands);
        const stepNames = normalizedInput.commands.map((command) => command.command).join(",");
        let success = false;
        let laneType: BrowserExecResolvedLane = resolvedLane;
        let browserSession = primaryTarget.sessionName;
        const laneFallback = createBrowserLaneFallbackState();

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_exec",
            browserSession: primaryTarget.sessionName,
            requestedLane,
            resolvedLane,
          });
          return toolFailure("agent-browser is not installed.", {
            detail: AGENT_BROWSER_INSTALL_GUIDANCE,
            sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
          });
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which", 0, {
          browserOpId,
          toolName: "browser_exec",
          browserSession: primaryTarget.sessionName,
          requestedLane,
          resolvedLane,
        });

        const runFlow = async (lane: BrowserLane) => {
          laneType = lane.laneType;
          browserSession = lane.browserTarget.sessionName;
          const commandOptions = {
            telemetryStore: ctx.telemetryStore,
            toolName: "browser_exec",
            browserOpId,
            browserTarget: lane.browserTarget,
            metadata: {
              requestedLane,
              resolvedLane,
              browserLane: lane.laneType,
              cloneId: lane.cloneId,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
          };

          const execution = await runBrowserAutomationCommands(normalizedInput.commands, commandOptions);
          if (!execution.ok) {
            return browserExecStepFailure(execution.error, lane.laneType);
          }
          const finalState = await captureFinalBrowserState(normalizedInput.capture, commandOptions);
          success = true;
          return {
            lane: lane.laneType,
            steps: execution.value.steps,
            finalState,
          };
        };

        try {
          return await withBrowserLaneFallback({
            copilotHome: ctx.copilotHome,
            telemetryStore: ctx.telemetryStore,
            metadata: {
              browserOpId,
              toolName: "browser_exec",
              requestedLane,
              resolvedLane,
              stepCount: normalizedInput.commands.length,
              stepNames,
            },
            launchConfig,
            tryClone: resolvedLane === "clone",
            fallbackToPrimaryOnCloneException: requestedLane === "auto",
            state: laneFallback,
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
            requestedLane,
            resolvedLane,
            browserLane: laneType,
            stepCount: normalizedInput.commands.length,
            ...browserLaneFallbackTelemetry(laneFallback),
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec.failed", duration, {
              browserOpId,
              browserSession,
              requestedLane,
              resolvedLane,
              browserLane: laneType,
              stepCount: normalizedInput.commands.length,
              ...browserLaneFallbackTelemetry(laneFallback),
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
