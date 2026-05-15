import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import type { AppContext } from "./app-context.js";
import { getBrowserLaunchConfig, safeRecordBrowserSpan, withBridgeBrowserSession, isAgentBrowserInstalled } from "./agent-browser.js";
import { captureFinalBrowserState, normalizeBrowserAutomationCapture, normalizeBrowserAutomationCommands, runBrowserAutomationCommands, type BrowserAutomationRunFailure, type BrowserAutomationStepResult } from "./browser-automation.js";
import { getOrCreateBrowserSessionStore, type BrowserSessionMode } from "./browser-session-store.js";
import { joinFailureSections, toolFailure, toolFailureWithContext } from "./tool-results.js";

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

function browserSessionExecFailure(
  failure: BrowserAutomationRunFailure,
  context: { browserSessionId: string; mode: BrowserSessionMode },
) {
  const stepOutput = truncateBrowserFailureText(failure.failedStep.output);
  const detail = joinFailureSections(
    failure.error,
    stepOutput && stepOutput !== failure.error ? stepOutput : undefined,
  ) ?? failure.error;
  return toolFailureWithContext(failure.error, {
    browserSessionId: context.browserSessionId,
    mode: context.mode,
    failedStep: failure.failedStep,
    steps: failure.steps,
  }, {
    detail,
    sessionLog: joinFailureSections(
      `Browser session: ${context.browserSessionId}`,
      `Mode: ${context.mode}`,
      `Failed step: ${failure.failedStep.index + 1} ${failure.failedStep.command}`,
      formatBrowserStepTimeline(failure.steps),
    ),
  });
}

export function createBrowserSessionTools(ctx: AppContext) {
  const browserSessionStore = getOrCreateBrowserSessionStore(ctx, {
    copilotHome: ctx.copilotHome,
    telemetryStore: ctx.telemetryStore,
    getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
  });

  return [
    defineTool("browser_session_start", {
      description:
        "Create an explicit browser session handle for multi-turn continuity. Use mode='persistent' " +
        "to reuse the shared primary browser state across turns, or mode='isolated' for a disposable " +
        "browser session that stays alive until closed.",
      parameters: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["persistent", "isolated"],
            description: "Browser session mode",
          },
          purpose: {
            type: "string",
            description: "Optional short note about what this browser session is for",
          },
        },
        required: ["mode"],
      },
      handler: async (args: any, invocation) => {
        const mode = args.mode as BrowserSessionMode;
        if (mode !== "persistent" && mode !== "isolated") {
          return toolFailure("Browser session mode must be persistent or isolated.");
        }
        const browserOpId = randomUUID();
        const check = await isAgentBrowserInstalled();
        if (!check) {
          return toolFailure("agent-browser is not installed.", {
            detail: AGENT_BROWSER_INSTALL_GUIDANCE,
            sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
          });
        }
        let record;
        try {
          record = await browserSessionStore.createSession(invocation.sessionId, mode, args.purpose);
        } catch (err: any) {
          return toolFailure("Failed to start browser session.", {
            detail: `Failed to start browser session: ${String(err).slice(0, 200)}`,
          });
        }
        safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_session_start", 0, {
          browserOpId,
          browserSessionId: record.id,
          browserSessionMode: record.mode,
          ownerSessionId: invocation.sessionId,
          browserSession: record.browserTarget.sessionName,
        });
        return {
          browserSessionId: record.id,
          mode: record.mode,
          sharedPrimary: record.mode === "persistent",
          createdAt: new Date(record.createdAt).toISOString(),
        };
      },
    }),
    defineTool("browser_session_exec", {
      description:
        "Execute structured browser automation steps against an explicit browser session handle. " +
        "Use this when a browser workflow must persist across multiple turns.",
      parameters: {
        type: "object" as const,
        properties: {
          browserSessionId: {
            type: "string",
            description: "The browser session handle returned by browser_session_start",
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
                },
                args: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "String arguments for the command. Element-targeting commands (click, fill, type, select, check) use refs from snapshot output — " +
                    "pass the ref with @ prefix (e.g. @e42 for an element shown as [ref=e42] in the snapshot).",
                },
                timeoutMs: { type: "number" },
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
        required: ["browserSessionId", "commands"],
      },
      handler: async (args: any, invocation) => {
        const commands = normalizeBrowserAutomationCommands(args.commands);
        if (!commands.ok) return toolFailure(commands.error);
        const capture = normalizeBrowserAutomationCapture(args.capture);
        if (!capture.ok) return toolFailure(capture.error);
        const normalizedCommands = commands.value;
        const captureInput = capture.value;
        const browserOpId = randomUUID();
        let result;
        try {
          result = await browserSessionStore.useSession(args.browserSessionId, invocation.sessionId, async (record) => {
            return withBridgeBrowserSession(record.browserTarget, async () => {
              const commandOptions = {
                telemetryStore: ctx.telemetryStore,
                toolName: "browser_session_exec",
                browserOpId,
                browserTarget: record.browserTarget,
                metadata: {
                  browserSessionId: record.id,
                  browserSessionMode: record.mode,
                  ownerSessionId: record.ownerSessionId,
                  cloneId: record.cloneId,
                  stepCount: normalizedCommands.length,
                },
              };
              const execution = await runBrowserAutomationCommands(normalizedCommands, commandOptions);
              if (!execution.ok) {
                return browserSessionExecFailure(execution.error, {
                  browserSessionId: record.id,
                  mode: record.mode,
                });
              }
              const finalState = await captureFinalBrowserState(captureInput, commandOptions);
              return {
                browserSessionId: record.id,
                mode: record.mode,
                steps: execution.value.steps,
                finalState,
              };
            });
          });
        } catch (err: any) {
          return toolFailure("Browser session exec failed.", {
            detail: `Browser session exec failed: ${String(err).slice(0, 200)}`,
          });
        }
        if (!result.ok) return toolFailure(result.error);
        return result.value;
      },
    }),
    defineTool("browser_session_get_state", {
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
        const captureInput = capture.value;
        const browserOpId = randomUUID();
        let result;
        try {
          result = await browserSessionStore.useSession(args.browserSessionId, invocation.sessionId, async (record) => {
            return withBridgeBrowserSession(record.browserTarget, async () => {
              const commandOptions = {
                telemetryStore: ctx.telemetryStore,
                toolName: "browser_session_get_state",
                browserOpId,
                browserTarget: record.browserTarget,
                metadata: {
                  browserSessionId: record.id,
                  browserSessionMode: record.mode,
                  ownerSessionId: record.ownerSessionId,
                  cloneId: record.cloneId,
                },
              };
              return {
                browserSessionId: record.id,
                mode: record.mode,
                state: await captureFinalBrowserState(captureInput, commandOptions),
              };
            });
          });
        } catch (err: any) {
          return toolFailure("Failed to inspect browser session.", {
            detail: `Failed to inspect browser session: ${String(err).slice(0, 200)}`,
          });
        }
        if (!result.ok) return toolFailure(result.error);
        return result.value;
      },
    }),
    defineTool("browser_session_close", {
      description: "Close an explicit browser session handle and release any associated isolated browser resources.",
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
