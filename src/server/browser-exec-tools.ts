// browser_exec — structured freeform browser automation that runs through the
// bridge-owned browser session wrappers instead of raw bash.

import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import type { BrowserCommand, BrowserLane } from "./agent-browser.js";
import { ab, getBridgeBrowserTarget, isAgentBrowserInstalled, safeRecordBrowserSpan, withCloneBrowserLane, withPrimaryBrowserLane } from "./agent-browser.js";

type BrowserExecLane = "auto" | "primary" | "clone";
type BrowserExecResolvedLane = "primary" | "clone";
type BrowserExecCommandName =
  | "open"
  | "wait"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "select"
  | "check"
  | "press"
  | "scroll"
  | "get";

interface BrowserExecCommandInput {
  command: BrowserExecCommandName;
  args?: string[];
  timeoutMs?: number;
}

interface BrowserExecCaptureInput {
  url?: boolean;
  title?: boolean;
  snapshot?: boolean;
  selector?: string;
}

interface BrowserExecNormalizedInput {
  lane: BrowserExecLane;
  commands: Array<{ command: BrowserExecCommandName; args: string[]; timeoutMs?: number }>;
  capture?: BrowserExecCaptureInput;
}

const MUTATING_COMMANDS = new Set<BrowserExecCommandName>([
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

function isRef(value: string): boolean {
  return /^@[\w:-]+$/.test(value);
}

function isPositiveTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateBrowserExecCommand(command: BrowserExecCommandInput, index: number): string | null {
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return `commands[${index}].args must be an array of strings`;
  }

  if (command.timeoutMs !== undefined && !isPositiveTimeout(command.timeoutMs)) {
    return `commands[${index}].timeoutMs must be a positive number`;
  }

  switch (command.command) {
    case "open":
      return args.length === 1 ? null : `commands[${index}] open requires exactly 1 URL argument`;
    case "wait":
      if (args.length === 1) return null;
      if (args.length === 2 && (args[0] === "--url" || args[0] === "--text")) return null;
      if (args.length === 2 && args[0] === "--load" && args[1] === "networkidle") return null;
      return `commands[${index}] wait supports one selector/duration argument or --load networkidle, --url <pattern>, --text <text>`;
    case "snapshot":
      if (args.length === 0) return null;
      if (args.length === 1 && args[0] === "-i") return null;
      if (args.length === 3 && args[0] === "-i" && args[1] === "-s") return null;
      return `commands[${index}] snapshot supports [], ['-i'], or ['-i', '-s', selector]`;
    case "click":
    case "check":
      return args.length === 1 && isRef(args[0])
        ? null
        : `commands[${index}] ${command.command} requires exactly 1 element ref argument`;
    case "fill":
    case "type":
    case "select":
      return args.length === 2 && isRef(args[0])
        ? null
        : `commands[${index}] ${command.command} requires an element ref and value`;
    case "press":
      return args.length === 1 ? null : `commands[${index}] press requires exactly 1 key argument`;
    case "scroll":
      return args.length === 2 ? null : `commands[${index}] scroll requires direction and amount`;
    case "get":
      if (args.length === 1 && (args[0] === "url" || args[0] === "title")) return null;
      if (args.length === 2 && args[0] === "text" && isRef(args[1])) return null;
      return `commands[${index}] get supports ['url'], ['title'], or ['text', ref]`;
    default:
      return `commands[${index}] uses unsupported command "${String(command.command)}"`;
  }
}

export function normalizeBrowserExecInput(args: any): BrowserExecNormalizedInput | { error: string } {
  const lane = args.lane ?? "auto";
  if (lane !== "auto" && lane !== "primary" && lane !== "clone") {
    return { error: "lane must be one of: auto, primary, clone" };
  }

  if (!Array.isArray(args.commands) || args.commands.length === 0) {
    return { error: "commands must be a non-empty array" };
  }

  const commands: BrowserExecNormalizedInput["commands"] = [];
  for (const [index, rawCommand] of args.commands.entries()) {
    if (!rawCommand || typeof rawCommand !== "object") {
      return { error: `commands[${index}] must be an object` };
    }
    if (typeof rawCommand.command !== "string") {
      return { error: `commands[${index}].command must be a string` };
    }
    const command = rawCommand as BrowserExecCommandInput;
    const validationError = validateBrowserExecCommand(command, index);
    if (validationError) return { error: validationError };
    commands.push({
      command: command.command,
      args: command.args ?? [],
      timeoutMs: command.timeoutMs,
    });
  }

  if (args.capture !== undefined) {
    if (!args.capture || typeof args.capture !== "object") {
      return { error: "capture must be an object" };
    }
    for (const key of ["url", "title", "snapshot"] as const) {
      if (args.capture[key] !== undefined && typeof args.capture[key] !== "boolean") {
        return { error: `capture.${key} must be a boolean` };
      }
    }
    if (args.capture.selector !== undefined && typeof args.capture.selector !== "string") {
      return { error: "capture.selector must be a string" };
    }
    if (args.capture.selector && args.capture.snapshot !== true) {
      return { error: "capture.selector requires capture.snapshot to be true" };
    }
  }

  return {
    lane,
    commands,
    capture: args.capture,
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

function toBrowserCommand(input: BrowserExecNormalizedInput["commands"][number]): BrowserCommand {
  return [input.command, ...input.args];
}

async function captureFinalState(
  capture: BrowserExecCaptureInput | undefined,
  commandOptions: Parameters<typeof ab>[2],
): Promise<Record<string, { ok: boolean; output: string; selector?: string }>> {
  const finalState: Record<string, { ok: boolean; output: string; selector?: string }> = {};
  if (!capture) return finalState;

  if (capture.url) {
    const result = await ab(["get", "url"], undefined, commandOptions);
    finalState.url = { ok: result.ok, output: result.output };
  }
  if (capture.title) {
    const result = await ab(["get", "title"], undefined, commandOptions);
    finalState.title = { ok: result.ok, output: result.output };
  }
  if (capture.snapshot) {
    const snapshotCommand: BrowserCommand = capture.selector
      ? ["snapshot", "-i", "-s", capture.selector]
      : ["snapshot", "-i"];
    const result = await ab(snapshotCommand, undefined, commandOptions);
    finalState.snapshot = { ok: result.ok, output: result.output, selector: capture.selector };
  }
  return finalState;
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

          const steps: Array<{
            index: number;
            command: BrowserExecCommandName;
            args: string[];
            timeoutMs?: number;
            ok: boolean;
            output: string;
          }> = [];

          for (const [index, command] of normalized.commands.entries()) {
            const result = await ab(toBrowserCommand(command), command.timeoutMs, commandOptions);
            const stepResult = {
              index,
              command: command.command,
              args: command.args,
              timeoutMs: command.timeoutMs,
              ok: result.ok,
              output: result.output,
            };
            steps.push(stepResult);
            if (!result.ok) {
              return {
                error: `Command ${index + 1} failed: ${command.command}`,
                lane: lane.laneType,
                failedStep: stepResult,
                steps,
              };
            }
          }

          const finalState = await captureFinalState(normalized.capture, commandOptions);
          success = true;
          return {
            lane: lane.laneType,
            steps,
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
