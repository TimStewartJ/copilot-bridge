import type { BrowserCommand } from "./agent-browser.js";
import { ab } from "./agent-browser.js";
import { err, ok, type Result } from "./tool-results.js";

export type BrowserAutomationCommandName =
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

export interface BrowserAutomationCommandInput {
  command: BrowserAutomationCommandName;
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
  command: BrowserAutomationCommandName;
  args: string[];
  timeoutMs?: number;
}

export interface BrowserAutomationStepResult {
  index: number;
  command: BrowserAutomationCommandName;
  args: string[];
  timeoutMs?: number;
  ok: boolean;
  output: string;
}

export interface BrowserAutomationRunSuccess {
  steps: BrowserAutomationStepResult[];
}

export interface BrowserAutomationRunFailure {
  error: string;
  failedStep: BrowserAutomationStepResult;
  steps: BrowserAutomationStepResult[];
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
    case "get":
      if (args.length === 1 && (args[0] === "url" || args[0] === "title")) return null;
      if (args.length === 2 && args[0] === "text" && isRef(args[1])) return null;
      return `commands[${index}] get supports ['url'], ['title'], or ['text', ref] where ref is like @e42`;
    default:
      return `commands[${index}] uses unsupported command "${String(command.command)}"`;
  }
}

/** Commands whose first arg is an element ref that should be auto-corrected. */
const REF_FIRST_ARG_COMMANDS = new Set<BrowserAutomationCommandName>([
  "click", "check", "fill", "type", "select",
]);

/** Commands where a later arg is an element ref (get text <ref>). */
const REF_SECOND_ARG_COMMANDS = new Set<BrowserAutomationCommandName>(["get"]);

/**
 * Commands where the first arg *may* be a ref (wait can take a selector, a
 * duration, or a ref). Only auto-correct when the arg looks ref-shaped.
 */
const REF_FIRST_ARG_OPTIONAL_COMMANDS = new Set<BrowserAutomationCommandName>(["wait"]);

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

export function toBrowserCommand(input: BrowserAutomationCommand): BrowserCommand {
  return [input.command, ...input.args];
}

export async function runBrowserAutomationCommands(
  commands: BrowserAutomationCommand[],
  commandOptions: Parameters<typeof ab>[2],
): Promise<Result<BrowserAutomationRunSuccess, BrowserAutomationRunFailure>> {
  const steps: BrowserAutomationStepResult[] = [];
  for (const [index, command] of commands.entries()) {
    const result = await ab(toBrowserCommand(command), command.timeoutMs, commandOptions);
    const stepResult: BrowserAutomationStepResult = {
      index,
      command: command.command,
      args: command.args,
      timeoutMs: command.timeoutMs,
      ok: result.ok,
      output: result.output,
    };
    steps.push(stepResult);
    if (!result.ok) {
      return err({
        error: `Command ${index + 1} failed: ${command.command}`,
        failedStep: stepResult,
        steps,
      });
    }
  }
  return ok({ steps });
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
