// Runs the steps of the browser tools and shapes what a tool answers with. What a step may be
// is in browser-steps.ts.

import type { BrowserCommand, BrowserCommandResult } from "./agent-browser.js";
import { ab, isAgentBrowserInstalled } from "./agent-browser.js";
import type { PageBlockFields } from "./browser-page-check.js";
import { saveDownload, takeScreenshot, type BrowserStepFiles, type BrowserStepImage } from "./browser-step-files.js";
import type { BrowserAutomationCaptureInput, BrowserAutomationCommand } from "./browser-steps.js";
import { uploadFiles } from "./browser-upload.js";
import { err, isToolErrorResult, joinFailureSections, ok, toolFailure, toolFailureWithContext, type Result } from "./tool-results.js";

export interface BrowserAutomationStepResult {
  index: number;
  command: string;
  args: string[];
  timeoutMs?: number;
  ok: boolean;
  output: string;
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

/** The steps that are run again after the Bridge revived a browser that would not start. */
const RERUN_AFTER_RECOVERY = new Set(["open", "wait", "snapshot", "click", "fill", "type", "select", "check", "press", "scroll", "get"]);
/** All of a call's pictures arrive in one tool result, which a chat cannot compact its way out of. */
const MAX_SCREENSHOT_CHARS_PER_CALL = 8_000_000;
/** A page's markup or console can be megabytes; a step's result is for reading. */
const MAX_STEP_OUTPUT_CHARS = 100_000;

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
