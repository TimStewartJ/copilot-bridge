import type { BrowserCommand, BrowserCommandResult } from "./agent-browser.js";
import { ab, isAgentBrowserInstalled } from "./agent-browser.js";
import type { PageBlockFields } from "./browser-page-check.js";
import { saveDownload, SCREENSHOT_OPTIONS, takeScreenshot, type BrowserStepFiles, type BrowserStepImage } from "./browser-step-files.js";
import { uploadFiles } from "./browser-upload.js";
import { err, isToolErrorResult, joinFailureSections, ok, toolFailure, toolFailureWithContext, type Result } from "./tool-results.js";

/** A step of a browser tool: one agent-browser command, or one the Bridge handles itself. */
export interface BrowserAutomationCommandInput {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface BrowserAutomationCaptureInput {
  url?: boolean;
  title?: boolean;
  snapshot?: boolean;
  selector?: string;
}

export interface BrowserAutomationCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface BrowserAutomationStepResult {
  index: number;
  command: string;
  args: string[];
  timeoutMs?: number;
  ok: boolean;
  output: string;
}

/**
 * The agent-browser commands a step may be. Left out are the ones that would take the browser
 * out of the Bridge's hands, which chooses, serialises and closes it (close, connect, session,
 * stream, state, auth, batch and their kind), and with them the names agent-browser accepts for
 * the same things (quit, exit, goto, navigate). A command of a later agent-browser is added here.
 */
const STEP_COMMANDS = new Set([
  "open", "read", "snapshot", "screenshot", "pdf", "eval", "wait", "get", "is", "find",
  "click", "dblclick", "hover", "focus", "fill", "type", "select", "check", "uncheck", "press",
  "keyboard", "mouse", "drag", "scroll", "scrollintoview", "upload", "download",
  "back", "forward", "reload", "pushstate", "tab", "frame", "dialog",
  "set", "cookies", "storage", "network", "console", "errors", "clipboard", "highlight",
  "diff", "vitals", "a11y", "record", "trace", "profiler",
]);

/**
 * The options a step may carry. agent-browser reads its own options (--session, --profile,
 * --cdp, --json and some forty more) wherever they stand in a command, also where a value was
 * meant, so any argument shaped like an option that is not listed here is refused.
 */
const STEP_OPTIONS: Record<string, readonly string[]> = {
  snapshot: ["-i", "-s"],
  wait: ["--url", "--text", "--load", "--fn"],
  screenshot: SCREENSHOT_OPTIONS,
  drag: ["--human"],
  mouse: ["--duration", "--steps", "--human", "--seed"],
  find: ["--name", "--exact"],
  console: ["--clear"],
  errors: ["--clear"],
  network: ["--abort", "--body", "--resource-type", "--clear", "--filter"],
  cookies: ["--url", "--domain", "--path", "--httpOnly", "--secure", "--sameSite", "--expires"],
};
const OPTION_SHAPED = /^--?[A-Za-z][\w-]*(=[\s\S]*)?$/;

/** The steps that are run again after the Bridge revived a browser that would not start. */
const RERUN_AFTER_RECOVERY = new Set(["open", "wait", "snapshot", "click", "fill", "type", "select", "check", "press", "scroll", "get"]);
/** Each screenshot is a picture in the conversation for as long as the chat lasts. */
const MAX_SCREENSHOTS_PER_CALL = 6;
/** All of a call's pictures arrive in one tool result, which a chat cannot compact its way out of. */
const MAX_SCREENSHOT_CHARS_PER_CALL = 8_000_000;
/** A page's markup or console can be megabytes; a step's result is for reading. */
const MAX_STEP_OUTPUT_CHARS = 100_000;

export function truncateBrowserFailureText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

export function formatBrowserStepTimeline(steps: BrowserAutomationStepResult[]): string | undefined {
  if (steps.length === 0) return undefined;
  return steps.map((step) => {
    const output = truncateBrowserFailureText(step.output);
    return `${step.index + 1}. ${step.command} ${step.ok ? "ok" : "failed"}${output ? ` — ${output}` : ""}`;
  }).join("\n");
}

export interface BrowserAutomationRunSuccess {
  steps: BrowserAutomationStepResult[];
  /** The screenshots the steps took, in order. */
  images: BrowserStepImage[];
}

export interface BrowserAutomationRunFailure extends BrowserAutomationRunSuccess {
  error: string;
  failedStep: BrowserAutomationStepResult;
}

function isRef(value: string): boolean {
  return /^@[\w:-]+$/.test(value);
}

/**
 * Try to fix common ref format mistakes:
 *   "e42"        → "@e42"
 *   "[ref=e42]"  → "@e42"
 * Returns the original string if it doesn't look like a misformatted ref.
 */
function autoCorrectRef(value: string): string {
  // Already valid
  if (isRef(value)) return value;
  // Missing @ prefix: "e42" → "@e42" (must start with a letter to distinguish from durations like "5000")
  if (/^[a-zA-Z][\w:-]*$/.test(value) && /\d/.test(value)) return `@${value}`;
  // Snapshot display format: "[ref=e42]" → "@e42"
  const bracketMatch = value.match(/^\[ref=([\w:-]+)\]$/);
  if (bracketMatch) return `@${bracketMatch[1]}`;
  return value;
}

function isPositiveTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateCommand(command: BrowserAutomationCommandInput, index: number): string | null {
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return `commands[${index}].args must be an array of strings`;
  }

  if (command.timeoutMs !== undefined && !isPositiveTimeout(command.timeoutMs)) {
    return `commands[${index}].timeoutMs must be a positive number`;
  }

  if (!STEP_COMMANDS.has(command.command)) {
    return `commands[${index}] "${command.command}" is not a browser step. The Bridge chooses, connects and closes the browser itself; `
      + `the steps are: ${[...STEP_COMMANDS].join(", ")}`;
  }
  const options = STEP_OPTIONS[command.command] ?? [];
  const refused = args.find((arg) => OPTION_SHAPED.test(arg) && !options.includes(arg));
  if (refused !== undefined) {
    return `commands[${index}] ${command.command} cannot take "${refused}": agent-browser would read it as one of its own options`
      + `${options.length ? `, and ${command.command} takes only ${options.join(", ")}` : ""}. `
      + "A text shaped like an option can be typed in pieces (\"-\" first, then the rest with keyboard type).";
  }
  const positional = args.filter((arg) => !OPTION_SHAPED.test(arg));

  switch (command.command) {
    case "open":
      return args.length === 1 ? null : `commands[${index}] open requires exactly 1 URL argument`;
    case "wait":
      if (args.length === 1 && positional.length === 1) return null;
      if (args.length === 2 && (args[0] === "--url" || args[0] === "--text" || args[0] === "--fn")) return null;
      if (args.length === 2 && args[0] === "--load" && args[1] === "networkidle") return null;
      return `commands[${index}] wait supports one selector/duration argument, --load networkidle, --url <pattern>, --text <text> or --fn <js>`;
    case "snapshot":
      if (args.length === 0) return null;
      if (args.length === 1 && args[0] === "-i") return null;
      if (args.length === 3 && args[0] === "-i" && args[1] === "-s") return null;
      return `commands[${index}] snapshot supports [], ['-i'], or ['-i', '-s', selector]`;
    case "click":
    case "check":
      return args.length === 1 && isRef(args[0])
        ? null
        : `commands[${index}] ${command.command} requires exactly 1 element ref like @e42 (matching [ref=e42] from snapshot output). CSS selectors are not supported.`;
    case "fill":
    case "type":
    case "select":
      return args.length === 2 && isRef(args[0])
        ? null
        : `commands[${index}] ${command.command} requires an element ref (e.g. @e42) and a value`;
    case "press":
      return args.length === 1 ? null : `commands[${index}] press requires exactly 1 key argument`;
    case "scroll":
      return args.length === 2 ? null : `commands[${index}] scroll requires direction and amount`;
    case "upload":
      return args.length >= 2 && isRef(args[0]) && args.slice(1).every((file) => file.trim())
        ? null
        : `commands[${index}] upload requires an element ref (e.g. @e42) and at least one file`;
    case "download":
      return args.length === 2 && isRef(args[0]) && args[1].trim()
        ? null
        : `commands[${index}] download requires an element ref (e.g. @e42) and the file to save to`;
    case "screenshot":
      return positional.length <= 2 && (positional.length < 2 || isRef(positional[0]))
        ? null
        : `commands[${index}] screenshot supports an element ref, a file to keep the picture in, --full and --annotate`;
    default:
      return null;
  }
}

/** Commands whose first arg is an element ref that should be auto-corrected. */
const REF_FIRST_ARG_COMMANDS = new Set(["click", "check", "fill", "type", "select", "upload", "download"]);

/** Commands where a later arg is an element ref (get text <ref>). */
const REF_SECOND_ARG_COMMANDS = new Set(["get"]);

/**
 * Commands where the first arg *may* be a ref (wait can take a selector, a
 * duration, or a ref). Only auto-correct when the arg looks ref-shaped.
 */
const REF_FIRST_ARG_OPTIONAL_COMMANDS = new Set(["wait"]);

export function normalizeBrowserAutomationCommands(rawCommands: unknown): Result<BrowserAutomationCommand[]> {
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    return err("commands must be a non-empty array");
  }

  const commands: BrowserAutomationCommand[] = [];
  for (const [index, rawCommand] of rawCommands.entries()) {
    if (!rawCommand || typeof rawCommand !== "object") {
      return err(`commands[${index}] must be an object`);
    }
    const command = rawCommand as BrowserAutomationCommandInput;
    if (typeof command.command !== "string") {
      return err(`commands[${index}].command must be a string`);
    }

    // Auto-correct ref arguments before validation (only for string args)
    const args = [...(command.args ?? [])];
    if (REF_FIRST_ARG_COMMANDS.has(command.command) && args.length >= 1 && typeof args[0] === "string") {
      args[0] = autoCorrectRef(args[0]);
    }
    if (REF_FIRST_ARG_OPTIONAL_COMMANDS.has(command.command) && args.length === 1 && typeof args[0] === "string") {
      const corrected = autoCorrectRef(args[0]);
      if (isRef(corrected)) args[0] = corrected;
    }
    if (REF_SECOND_ARG_COMMANDS.has(command.command) && args.length >= 2 && args[0] === "text" && typeof args[1] === "string") {
      args[1] = autoCorrectRef(args[1]);
    }

    const corrected = { ...command, args };
    const validationError = validateCommand(corrected, index);
    if (validationError) return err(validationError);
    commands.push({
      command: corrected.command,
      args: corrected.args,
      timeoutMs: corrected.timeoutMs,
    });
  }
  if (commands.filter((command) => command.command === "screenshot").length > MAX_SCREENSHOTS_PER_CALL) {
    return err(`commands may take at most ${MAX_SCREENSHOTS_PER_CALL} screenshots in one call`);
  }
  return ok(commands);
}

export function normalizeBrowserAutomationCapture(rawCapture: unknown): Result<BrowserAutomationCaptureInput | undefined> {
  if (rawCapture === undefined) return ok(undefined);
  if (!rawCapture || typeof rawCapture !== "object") {
    return err("capture must be an object");
  }
  const capture = rawCapture as BrowserAutomationCaptureInput;
  for (const key of ["url", "title", "snapshot"] as const) {
    if (capture[key] !== undefined && typeof capture[key] !== "boolean") {
      return err(`capture.${key} must be a boolean`);
    }
  }
  if (capture.selector !== undefined && typeof capture.selector !== "string") {
    return err("capture.selector must be a string");
  }
  if (capture.selector && capture.snapshot !== true) {
    return err("capture.selector requires capture.snapshot to be true");
  }
  return ok(capture);
}

/** The `commands` parameter of the tools that run steps. */
export const BROWSER_COMMANDS_PARAMETER = {
  type: "array",
  description: "Browser steps to run in order. A step is one agent-browser command; the first that fails ends the list.",
  items: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The agent-browser command, for example open, snapshot, click, dblclick, hover, fill, type, select, check, press, " +
          "keyboard, scroll, wait, get, is, drag, mouse, back, forward, reload, tab, eval, screenshot, upload, download, pdf, " +
          "cookies, console. The Bridge chooses and closes the browser, so there is no session, connect or close step.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "The command's arguments as strings. Name elements by the refs of a snapshot, with an @ (e.g. @e42 for an element " +
          "shown as [ref=e42]): click, fill, type, select, check, upload and download take only refs, not CSS selectors. " +
          "get reads ['url'], ['title'], ['text', ref], ['value', ref] or ['attr', ref, name]; drag takes two refs. " +
          "screenshot returns the picture to you: [] for the visible page, [ref] for one element, '--full' for the whole page, " +
          "and a file as last argument keeps the picture. " +
          "upload gives files to a page: the ref of the file input or of the button that opens the file chooser, then the files; " +
          "use upload, not click, on such an element, because a plain click opens a file window nobody can see. " +
          "download clicks a ref and saves what it downloads: [ref, file]. " +
          "Files are absolute paths; a name alone means a file of this chat, such as one the user attached. " +
          "Options are limited to the few a command needs (snapshot -i, wait --text, drag --human and the like); " +
          "an argument that looks like any other option is refused.",
      },
      timeoutMs: { type: "number", description: "Optional time limit for the step in milliseconds" },
    },
    required: ["command"],
  },
} as const;

/** The `capture` parameter of the tools that run steps. */
export const BROWSER_CAPTURE_PARAMETER = {
  type: "object",
  description: "Optional final page state to capture after the command list completes.",
  properties: {
    url: { type: "boolean" },
    title: { type: "boolean" },
    snapshot: { type: "boolean" },
    selector: { type: "string" },
  },
} as const;

async function runStep(
  command: BrowserAutomationCommand,
  commandOptions: NonNullable<Parameters<typeof ab>[2]>,
  files: BrowserStepFiles | undefined,
): Promise<BrowserCommandResult & { image?: BrowserStepImage }> {
  switch (command.command) {
    case "upload":
      return uploadFiles(command.args[0], command.args.slice(1), command.timeoutMs, commandOptions, files);
    case "download":
      return saveDownload(command.args, command.timeoutMs, commandOptions, files);
    case "screenshot":
      return takeScreenshot(command.args, command.timeoutMs, commandOptions, files);
    default:
      return ab([command.command, ...command.args] as BrowserCommand, command.timeoutMs, {
        ...commandOptions,
        // A step that may have acted on the page is not run a second time.
        ...(RERUN_AFTER_RECOVERY.has(command.command) ? {} : { skipRecovery: true }),
      });
  }
}

export async function runBrowserAutomationCommands(
  commands: BrowserAutomationCommand[],
  commandOptions: Parameters<typeof ab>[2],
  files?: BrowserStepFiles,
): Promise<Result<BrowserAutomationRunSuccess, BrowserAutomationRunFailure>> {
  const steps: BrowserAutomationStepResult[] = [];
  const images: BrowserStepImage[] = [];
  for (const [index, command] of commands.entries()) {
    let result = await runStep(command, commandOptions ?? {}, files);
    if (result.image) {
      if (images.reduce((sum, image) => sum + image.data.length, result.image.data.length) > MAX_SCREENSHOT_CHARS_PER_CALL) {
        result = { ok: false, output: "This call's screenshots are too large together. Take the rest in another call." };
      } else {
        images.push(result.image);
      }
    }
    const stepResult: BrowserAutomationStepResult = {
      index,
      command: command.command,
      args: command.args,
      timeoutMs: command.timeoutMs,
      ok: result.ok,
      output: result.output.length > MAX_STEP_OUTPUT_CHARS
        ? `${result.output.slice(0, MAX_STEP_OUTPUT_CHARS)}\n[cut: ${result.output.length - MAX_STEP_OUTPUT_CHARS} more characters]`
        : result.output,
    };
    steps.push(stepResult);
    if (!result.ok) {
      return err({
        error: `Command ${index + 1} failed: ${command.command}`,
        failedStep: stepResult,
        steps,
        images,
      });
    }
  }
  return ok({ steps, images });
}

/** A tool's result with the screenshots its steps took, which reach the model as pictures. */
export function withScreenshots<T>(result: T, images: readonly BrowserStepImage[]): T | Record<string, unknown> {
  if (images.length === 0) return result;
  const binaryResultsForLlm = images.map((image) => ({ type: "image" as const, ...image }));
  return isToolErrorResult(result)
    ? { ...result, binaryResultsForLlm }
    : { textResultForLlm: JSON.stringify(result, null, 2), resultType: "success", binaryResultsForLlm };
}

export async function captureFinalBrowserState(
  capture: BrowserAutomationCaptureInput | undefined,
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

const AGENT_BROWSER_INSTALL_GUIDANCE =
  "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install";

/** The failure a browser tool answers with when the agent-browser CLI is missing; undefined when it is there. */
export async function agentBrowserMissingFailure(): Promise<ReturnType<typeof toolFailure> | undefined> {
  if (await isAgentBrowserInstalled()) return undefined;
  return toolFailure("agent-browser is not installed.", {
    detail: AGENT_BROWSER_INSTALL_GUIDANCE,
    sessionLog: AGENT_BROWSER_INSTALL_GUIDANCE,
  });
}

/**
 * The result of a list of steps that stopped at one that failed. `fields` identify the browser
 * in the result, `logLines` in the session log.
 */
export function browserStepFailure<T extends object>(
  failure: BrowserAutomationRunFailure,
  fields: T,
  pageBlock: PageBlockFields,
  logLines: readonly string[],
) {
  const stepOutput = truncateBrowserFailureText(failure.failedStep.output);
  // A failure reaches the agent as its text alone, so what the page turned out to be goes there.
  const detail = joinFailureSections(
    failure.error,
    stepOutput && stepOutput !== failure.error ? stepOutput : undefined,
    (pageBlock.blocked ?? pageBlock.captcha)?.guidance,
  ) ?? failure.error;
  return toolFailureWithContext(failure.error, {
    ...pageBlock,
    ...fields,
    failedStep: failure.failedStep,
    steps: failure.steps,
  }, {
    detail,
    sessionLog: joinFailureSections(
      ...logLines,
      `Failed step: ${failure.failedStep.index + 1} ${failure.failedStep.command}`,
      formatBrowserStepTimeline(failure.steps),
    ),
  });
}
