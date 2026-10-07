import { randomUUID } from "node:crypto";
import { BROWSER_HANDOFF_ANSWERS } from "../shared/browser-live.js";
import type { AppContext } from "./app-context.js";
import { ab, safeRecordBrowserSpan, type BrowserCommandOptions } from "./agent-browser.js";
import type { BrowserBrokerLease, BrowserBrokerOperationOptions } from "./browser-broker.js";
import {
  agentBrowserMissingFailure,
  browserStepFailure,
  captureFinalBrowserState,
  runBrowserAutomationCommands,
  withScreenshots,
} from "./browser-automation.js";
import { BrowserLiveUnavailableError } from "./browser-live.js";
import { CLEAR_PASSWORD_SCRIPT, SIGN_IN_PAGE_SCRIPT } from "./browser-login-watch.js";
import { loginHost } from "./browser-logins.js";
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
/**
 * A site that takes a moment to let someone in still shows its form meanwhile, so a form that is
 * still there is looked at again this often, this many times, before the login counts as refused.
 */
const SIGN_IN_LOOK_AGAIN_MS = 2_000;
const SIGN_IN_LOOKS = 5;
const base64 = (script: string): string => Buffer.from(script, "utf-8").toString("base64");
const SIGN_IN_PAGE_SCRIPT_BASE64 = base64(SIGN_IN_PAGE_SCRIPT);
const CLEAR_PASSWORD_SCRIPT_BASE64 = base64(CLEAR_PASSWORD_SCRIPT);
const HAND_OFF_SIGN_IN = "Ask the user to sign in with browser_session_handoff; they can save the login there for next time. "
  + "Do not call browser_sign_in again for this page.";

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
  const { broker: browserBroker, sessions: browserSessionStore, live: browserLive, logins } = getBrowserRuntime(ctx);

  /** The address of the page a session shows, and whether it shows a sign-in form. */
  const readSignInPage = async (commandOptions: BrowserCommandOptions): Promise<{ url: string; form: boolean } | undefined> => {
    const result = await ab(["eval", "-b", SIGN_IN_PAGE_SCRIPT_BASE64], undefined, commandOptions);
    if (!result.ok) return undefined;
    try {
      const [url, form] = JSON.parse(result.output) as [unknown, unknown];
      return typeof url === "string" ? { url, form: form === 1 } : undefined;
    } catch {
      return undefined;
    }
  };

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
    defineSessionBridgeTool("browser_sign_in", {
      description:
        "Sign in on the page a browser session shows, with the login the user saved for that site. Call it " +
        "when the page shows a sign-in form, before asking the user: it fills the form in and submits it, " +
        "and you never see the password. The result says what happened and what to do next.",
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
        const startedAt = Date.now();
        let outcome = "failed";
        try {
          return await onSessionBrowser("browser_sign_in", "Failed to sign in", args, invocation.sessionId, {}, async (record, commandOptions) => {
            const answer = (signIn: string, guidance: string, more: Record<string, unknown> = {}) => {
              outcome = signIn;
              return { browserSessionId: record.id, signIn, ...more, guidance };
            };
            const page = await readSignInPage(commandOptions);
            const login = page ? await logins.forPage(page.url) : undefined;
            if (!page || !login) return answer("no_saved_login", `The user has saved no login for this site. ${HAND_OFF_SIGN_IN}`);
            const host = loginHost(login);
            if (!page.form) {
              return answer("no_form", "This page shows no sign-in form with a username field and a password field. "
                + `A login is saved for ${host}: open the page that shows its form and call again, or hand off.`);
            }
            if (login.failedAt) {
              return answer("rejected", `${host} did not accept the saved login when it was last used. ${HAND_OFF_SIGN_IN}`);
            }
            // A password that is still in the page afterwards is not left there for anyone to read.
            const clearPassword = () => ab(["eval", "-b", CLEAR_PASSWORD_SCRIPT_BASE64], undefined, commandOptions);
            const filled = await logins.signIn(login, commandOptions);
            if (!filled.ok) {
              await clearPassword();
              return answer("failed", `The saved login could not be filled in. ${HAND_OFF_SIGN_IN}`, { detail: filled.output.slice(0, 300) });
            }

            let check = await checkPage(commandOptions, { settle: true });
            let after = await readSignInPage(commandOptions);
            for (let looks = 1; after?.form && !check.block && looks < SIGN_IN_LOOKS; looks++) {
              await new Promise((resolve) => setTimeout(resolve, SIGN_IN_LOOK_AGAIN_MS));
              check = await checkPage(commandOptions);
              after = await readSignInPage(commandOptions);
            }
            const state = { url: after?.url ?? check.signals?.url, title: check.signals?.title };
            if (after?.form && check.block) {
              // The site put a check in front of the sign-in. That says nothing about the login.
              await clearPassword();
              return answer("blocked", "The site asks for a check only a person can pass before it signs anyone in. "
                + "Hand off with browser_session_handoff.", { ...pageBlockFields(check, record.id), state });
            }
            if (after?.form) {
              // The form is still there, so the site turned the login down. The login is not
              // tried again until the user saves it anew.
              await clearPassword();
              await logins.markFailed(login.id);
              return answer("rejected", `${host} still shows its sign-in form, so it did not accept the saved login. ${HAND_OFF_SIGN_IN}`, { state });
            }
            return answer(
              "submitted",
              "The saved login was submitted and the sign-in form is gone. Carry on with the task. If the page "
                + "now asks for a code or another step only the user can do, hand off with browser_session_handoff.",
              { ...pageBlockFields(check, record.id), username: login.username, state },
            );
          });
        } finally {
          safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_sign_in", Date.now() - startedAt, {
            browserSessionId: args.browserSessionId,
            ownerSessionId: invocation.sessionId,
            outcome,
          });
        }
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
