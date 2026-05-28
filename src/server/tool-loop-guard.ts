// Detection helpers for tool-only loops and obvious no-op shell calls.
// Emits telemetry signals only — the session runner never blocks on these
// findings. Use detected candidates to monitor whether the protocol-level
// loop-prevention work is sufficient before adding any runtime enforcement.

export interface ToolLoopCandidate {
  reason: "no_op_shell" | "repeated_mutating_call";
  detail: string;
  fingerprint: string;
  count: number;
}

export interface ToolLoopGuardOptions {
  duplicateMutatingThreshold?: number;
}

const DEFAULT_DUPLICATE_MUTATING_THRESHOLD = 3;

const STATUS_OR_READ_TOOL_PATTERNS = [
  /(?:^|[-_])management_job_status$/,
  /(?:^|[-_])read(?:$|[-_])/,
  /(?:^|[-_])list(?:$|[-_])/,
  /(?:^|[-_])view$/,
  /(?:^|[-_])rg$/,
  /(?:^|[-_])glob$/,
  /(?:^|[-_])web_fetch$/,
  /(?:^|[-_])web_search$/,
  /(?:^|[-_])browser_fetch$/,
  /(?:^|[-_])browser_exec$/,
];
const MUTATING_OR_CONTROL_TOOL_PATTERNS = [
  /(?:^|[-_])bash$/,
  /(?:^|[-_])powershell$/,
  /(?:^|[-_])self_restart$/,
  /(?:^|[-_])self_update$/,
  /(?:^|[-_])staging_preview$/,
  /(?:^|[-_])staging_deploy$/,
  /(?:^|[-_])task_(?:create|update|update_momentum|link|unlink)/,
  /(?:^|[-_])task_group_(?:create|update|delete)/,
  /(?:^|[-_])checklist_(?:add|update|remove)/,
  /(?:^|[-_])docs_(?:write|edit|delete|db_create|db_add|db_update|db_delete|snapshot_create|snapshot_restore)/,
  /(?:^|[-_])feed_save$/,
  /(?:^|[-_])tag_(?:create|update|delete)/,
  /(?:^|[-_])schedule_(?:create|update|delete|run|pause|resume)/,
  /(?:^|[-_])defer_(?:create|cancel|loop_create|loop_cancel)/,
];
const NO_OP_INTENTION_PATTERN = /\b(no[-\s]?op|placeholder|marker)\b/i;
const EMPTY_PRINTF_PATTERN = /^printf\s+(?:""|''|["']\\?n["'])$/i;
const SHELL_NO_EFFECT_PATTERN = /^(?::|true|exit\s+0)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeForFingerprint(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

export function getToolLoopFingerprint(toolName: string, args: unknown): string {
  return `${toolName.trim().toLocaleLowerCase()}:${stableStringify(args ?? {})}`;
}

export function getNoOpShellReason(input: {
  toolName?: unknown;
  command?: unknown;
  description?: unknown;
  intention?: unknown;
}): string | undefined {
  const toolName = typeof input.toolName === "string" ? input.toolName.toLocaleLowerCase() : "";
  if (!/(?:^|[-_])(bash|powershell)$/.test(toolName)) return undefined;
  const command = typeof input.command === "string" ? normalizeWhitespace(input.command) : "";
  const intentText = [
    typeof input.description === "string" ? input.description : "",
    typeof input.intention === "string" ? input.intention : "",
  ].join(" ");

  if (NO_OP_INTENTION_PATTERN.test(intentText)) {
    return "shell call is explicitly described as a no-op, placeholder, or marker";
  }
  if (EMPTY_PRINTF_PATTERN.test(command)) {
    return "shell command prints no substantive output";
  }
  if (SHELL_NO_EFFECT_PATTERN.test(command) && !/health|probe|check|test/i.test(intentText)) {
    return "shell command has no side effect or diagnostic value";
  }
  return undefined;
}

function isStatusOrReadTool(toolName: string): boolean {
  return STATUS_OR_READ_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

function isDuplicateGuardedTool(toolName: string): boolean {
  if (isStatusOrReadTool(toolName)) return false;
  return MUTATING_OR_CONTROL_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function createToolLoopGuard(options: ToolLoopGuardOptions = {}) {
  const duplicateMutatingThreshold = options.duplicateMutatingThreshold ?? DEFAULT_DUPLICATE_MUTATING_THRESHOLD;
  const counts = new Map<string, number>();

  return {
    detectCandidate(toolName: string, args: unknown): ToolLoopCandidate | undefined {
      const normalizedToolName = toolName.trim().toLocaleLowerCase();
      const noOpReason = isRecord(args)
        ? getNoOpShellReason({
          toolName: normalizedToolName,
          command: args.command,
          description: args.description,
        })
        : undefined;
      const fingerprint = getToolLoopFingerprint(normalizedToolName, args);
      const count = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, count);

      if (noOpReason) {
        return { reason: "no_op_shell", detail: noOpReason, fingerprint, count };
      }

      if (isDuplicateGuardedTool(normalizedToolName) && count >= duplicateMutatingThreshold) {
        return {
          reason: "repeated_mutating_call",
          detail: `same ${toolName} call repeated ${count}× in this assistant run`,
          fingerprint,
          count,
        };
      }

      return undefined;
    },
  };
}
