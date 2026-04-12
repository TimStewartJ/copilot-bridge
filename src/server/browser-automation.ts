import type { BrowserCommand } from "./agent-browser.js";
import { ab } from "./agent-browser.js";

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

function isRef(value: string): boolean {
  return /^@[\w:-]+$/.test(value);
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

export function normalizeBrowserAutomationCommands(rawCommands: unknown): BrowserAutomationCommand[] | { error: string } {
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    return { error: "commands must be a non-empty array" };
  }

  const commands: BrowserAutomationCommand[] = [];
  for (const [index, rawCommand] of rawCommands.entries()) {
    if (!rawCommand || typeof rawCommand !== "object") {
      return { error: `commands[${index}] must be an object` };
    }
    const command = rawCommand as BrowserAutomationCommandInput;
    if (typeof command.command !== "string") {
      return { error: `commands[${index}].command must be a string` };
    }
    const validationError = validateCommand(command, index);
    if (validationError) return { error: validationError };
    commands.push({
      command: command.command,
      args: command.args ?? [],
      timeoutMs: command.timeoutMs,
    });
  }
  return commands;
}

export function normalizeBrowserAutomationCapture(rawCapture: unknown): BrowserAutomationCaptureInput | { error: string } | undefined {
  if (rawCapture === undefined) return undefined;
  if (!rawCapture || typeof rawCapture !== "object") {
    return { error: "capture must be an object" };
  }
  const capture = rawCapture as BrowserAutomationCaptureInput;
  for (const key of ["url", "title", "snapshot"] as const) {
    if (capture[key] !== undefined && typeof capture[key] !== "boolean") {
      return { error: `capture.${key} must be a boolean` };
    }
  }
  if (capture.selector !== undefined && typeof capture.selector !== "string") {
    return { error: "capture.selector must be a string" };
  }
  if (capture.selector && capture.snapshot !== true) {
    return { error: "capture.selector requires capture.snapshot to be true" };
  }
  return capture;
}

export function toBrowserCommand(input: BrowserAutomationCommand): BrowserCommand {
  return [input.command, ...input.args];
}

export async function runBrowserAutomationCommands(
  commands: BrowserAutomationCommand[],
  commandOptions: Parameters<typeof ab>[2],
): Promise<
  | { steps: BrowserAutomationStepResult[]; failedStep?: undefined; error?: undefined }
  | { steps: BrowserAutomationStepResult[]; failedStep: BrowserAutomationStepResult; error: string }
> {
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
      return {
        error: `Command ${index + 1} failed: ${command.command}`,
        failedStep: stepResult,
        steps,
      };
    }
  }
  return { steps };
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
