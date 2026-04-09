import type { ToolArgs } from "../api";

interface ToolArgSummaryOptions {
  maxLength?: number;
  separator?: string;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function isToolArgObject(args: ToolArgs): args is { [key: string]: ToolArgs } {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

function stringifyArg(value: ToolArgs, maxLength: number): string {
  if (typeof value === "string") return truncate(value, maxLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return truncate(JSON.stringify(value), maxLength);
}

export function hasToolArgs(args: ToolArgs | undefined): boolean {
  if (args === undefined || args === null) return false;
  if (typeof args === "string") return args.length > 0;
  if (typeof args === "number" || typeof args === "boolean") return true;
  if (Array.isArray(args)) return args.length > 0;
  return Object.keys(args).length > 0;
}

export function summarizeToolArgs(args: ToolArgs | undefined, options: ToolArgSummaryOptions = {}): string {
  const { maxLength = 80, separator = "  " } = options;
  if (!hasToolArgs(args)) return "";
  if (!isToolArgObject(args)) return stringifyArg(args, maxLength);

  const path = args.path;
  if (typeof path === "string") return path.replace(/\\/g, "/").split("/").slice(-3).join("/");

  const preferredKeys = ["pattern", "command", "query", "prompt", "url"] as const;
  for (const key of preferredKeys) {
    const value = args[key];
    if (value !== undefined && value !== null) return stringifyArg(value, maxLength);
  }

  return Object.entries(args)
    .filter(([key]) => key !== "intent")
    .map(([, value]) => stringifyArg(value, maxLength))
    .join(separator);
}

export function formatToolArgsDetails(args: ToolArgs | undefined): string {
  if (!hasToolArgs(args)) return "";
  if (typeof args === "string") return args;
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  if (args === null) return "null";
  return JSON.stringify(args, null, 2);
}
