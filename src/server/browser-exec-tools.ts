// browser_exec — structured freeform browser automation that runs through the
// bridge-owned browser session wrappers instead of raw bash.

import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import type { BrowserLane } from "./agent-browser.js";
import { ab, getBridgeBrowserTarget, isAgentBrowserInstalled, safeRecordBrowserSpan, withCloneBrowserLane, withPrimaryBrowserLane } from "./agent-browser.js";
import { captureFinalBrowserState, normalizeBrowserAutomationCapture, normalizeBrowserAutomationCommands, runBrowserAutomationCommands, type BrowserAutomationCaptureInput, type BrowserAutomationCommand, type BrowserAutomationCommandName } from "./browser-automation.js";

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

function isToolErrorResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export function normalizeBrowserExecInput(args: any): BrowserExecNormalizedInput | { error: string } {
  const lane = args.lane ?? "auto";
  if (lane !== "auto" && lane !== "primary" && lane !== "clone") {
    return { error: "lane must be one of: auto, primary, clone" };
  }

  const commands = normalizeBrowserAutomationCommands(args.commands);
  if ("error" in commands) return commands;
  const capture = normalizeBrowserAutomationCapture(args.capture);
  if (capture && "error" in capture) return capture;

  return {
    lane,
    commands,
    capture,
  };
}

export function resolveBrowserExecLane(
  lane: BrowserExecLane,
  commands: BrowserExecNormalizedInput["commands"],
): BrowserExecResolvedLane {
  if (lane === "primary" || lane === "clone") return lane;
  if (commands.some((command) => MUTATING_COMMANDS.has(command.command))) return "primary";
  return commands[0]?.command === "open" ? "clone" : "primary";
}

export function createBrowserExecTools(ctx: AppContext) {
  return [
    defineTool("browser_exec", {
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
              "Lane selection. auto uses clone for read-only flows that establish their own page with open, and primary for stateful interactions or flows that rely on existing browser state.",
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
                  description: "String arguments for the command",
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
        if (isToolErrorResult(normalized)) return normalized;

        const browserOpId = randomUUID();
        const primaryTarget = getBridgeBrowserTarget(ctx.copilotHome);
        const toolStart = Date.now();
        const requestedLane = normalized.lane;
        const resolvedLane = resolveBrowserExecLane(normalized.lane, normalized.commands);
        const stepNames = normalized.commands.map((command) => command.command).join(",");
        let success = false;
        let laneType: BrowserExecResolvedLane = resolvedLane;
        let browserSession = primaryTarget.sessionName;
        let attemptedClone = false;
        let fallbackToPrimary = false;

        const check = await isAgentBrowserInstalled();
        if (!check) {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.command.which.failed", 0, {
            browserOpId,
            toolName: "browser_exec",
            browserSession: primaryTarget.sessionName,
            requestedLane,
            resolvedLane,
          });
          return {
            error:
              "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
          };
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
              stepCount: normalized.commands.length,
              stepNames,
            },
          };

          const execution = await runBrowserAutomationCommands(normalized.commands, commandOptions);
          if ("error" in execution) {
            return {
              error: execution.error,
              lane: lane.laneType,
              failedStep: execution.failedStep,
              steps: execution.steps,
            };
          }
          const finalState = await captureFinalBrowserState(normalized.capture, commandOptions);
          success = true;
          return {
            lane: lane.laneType,
            steps: execution.steps,
            finalState,
          };
        };

        try {
          if (resolvedLane === "clone") {
            attemptedClone = true;
            try {
              return await withCloneBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
                browserOpId,
                toolName: "browser_exec",
                requestedLane,
                resolvedLane,
                stepCount: normalized.commands.length,
                stepNames,
              }, runFlow);
            } catch (err) {
              if (requestedLane !== "auto") throw err;
              fallbackToPrimary = true;
              safeRecordBrowserSpan(ctx.telemetryStore, "browser.clone.fallback_to_primary", 0, {
                browserOpId,
                toolName: "browser_exec",
                requestedLane,
                resolvedLane,
                reason: "exception",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          return await withPrimaryBrowserLane(ctx.copilotHome, ctx.telemetryStore, {
            browserOpId,
            toolName: "browser_exec",
            requestedLane,
            resolvedLane,
            stepCount: normalized.commands.length,
            stepNames,
          }, runFlow);
        } catch (err: any) {
          return { error: `Browser exec failed: ${String(err).slice(0, 200)}` };
        } finally {
          const duration = Date.now() - toolStart;
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec", duration, {
            browserOpId,
            browserSession,
            success,
            requestedLane,
            resolvedLane,
            browserLane: laneType,
            stepCount: normalized.commands.length,
            attemptedClone,
            fallbackToPrimary,
          });
          if (!success) {
            safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_exec.failed", duration, {
              browserOpId,
              browserSession,
              requestedLane,
              resolvedLane,
              browserLane: laneType,
              stepCount: normalized.commands.length,
              attemptedClone,
              fallbackToPrimary,
            });
          }
        }
      },
    }),
  ];
}
