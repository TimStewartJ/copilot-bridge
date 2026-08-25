import matter from "gray-matter";
import type { CustomAgentConfig } from "@github/copilot-sdk";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface TaskAgentDefinitionSummary {
  taskId: string;
  name: string;
  displayName?: string;
  description: string;
  /** null means all tools; an empty array means no tools. */
  tools: string[] | null;
  infer: boolean;
  userInvocable: boolean;
  fileName: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAgentDefinition extends TaskAgentDefinitionSummary {
  prompt: string;
  frontmatter: Record<string, unknown>;
  raw: string;
}

export interface CreateTaskAgentDefinitionInput {
  taskId: string;
  name: string;
  displayName?: string;
  description: string;
  prompt: string;
  tools?: string[] | null;
  infer?: boolean;
  createdBySessionId?: string;
}

export class TaskAgentDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskAgentDefinitionValidationError";
  }
}

export class TaskAgentDefinitionAlreadyExistsError extends Error {
  constructor(taskId: string, name: string) {
    super(`Agent definition "${name}" already exists for task ${taskId}`);
    this.name = "TaskAgentDefinitionAlreadyExistsError";
  }
}

export class TaskAgentDefinitionReadError extends Error {
  constructor(taskId: string, name: string, reason: string) {
    super(`Agent definition "${name}" for task ${taskId} is unreadable: ${reason}`);
    this.name = "TaskAgentDefinitionReadError";
  }
}

const RESERVED_AGENT_NAMES = new Set([
  "code-review",
  "explore",
  "general-purpose",
  "research",
  "rubber-duck",
  "security-review",
  "task",
]);
const WINDOWS_RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_FILE_SUFFIX = ".agent.md";
const MAX_TASK_ID_LENGTH = 200;
const MAX_AGENT_NAME_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_PROMPT_LENGTH = 30_000;
const MAX_PROFILE_BYTES = 128 * 1024;
const STALE_TEMP_FILE_AGE_MS = 5 * 60_000;
const MAX_TOOLS = 100;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_DEFINITIONS_PER_TASK = 16;

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskAgentDefinitionValidationError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TaskAgentDefinitionValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TaskAgentDefinitionValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new TaskAgentDefinitionValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

export function normalizeTaskAgentTaskId(value: unknown): string {
  const taskId = normalizeRequiredText(value, "taskId", MAX_TASK_ID_LENGTH);
  if (
    taskId === "."
    || taskId === ".."
    || !SAFE_PATH_SEGMENT_PATTERN.test(taskId)
  ) {
    throw new TaskAgentDefinitionValidationError(
      "taskId must be a single path-safe identifier",
    );
  }
  return taskId;
}

function normalizeTaskAgentDefinitionNameSyntax(value: unknown): string {
  const name = normalizeRequiredText(value, "name", MAX_AGENT_NAME_LENGTH);
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new TaskAgentDefinitionValidationError(
      "name must contain only lowercase letters, numbers, and single hyphens",
    );
  }
  if (WINDOWS_RESERVED_FILE_NAMES.test(name)) {
    throw new TaskAgentDefinitionValidationError(`name "${name}" is reserved by Windows`);
  }
  return name;
}

export function normalizeTaskAgentDefinitionName(value: unknown): string {
  const name = normalizeTaskAgentDefinitionNameSyntax(value);
  if (RESERVED_AGENT_NAMES.has(name)) {
    throw new TaskAgentDefinitionValidationError(`name "${name}" is reserved by a built-in Copilot agent`);
  }
  return name;
}

function normalizeTools(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const entries = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value)
      ? value
      : null;
  if (!entries) {
    throw new TaskAgentDefinitionValidationError("tools must be null, a comma-separated string, or an array");
  }
  if (entries.length > MAX_TOOLS) {
    throw new TaskAgentDefinitionValidationError(`tools must contain at most ${MAX_TOOLS} entries`);
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const tool = normalizeRequiredText(entry, "each tool name", MAX_TOOL_NAME_LENGTH);
    if (seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

function normalizeCreateInput(input: CreateTaskAgentDefinitionInput): CreateTaskAgentDefinitionInput & {
  tools: string[] | null;
  infer: boolean;
} {
  if (typeof input.infer !== "undefined" && typeof input.infer !== "boolean") {
    throw new TaskAgentDefinitionValidationError("infer must be a boolean");
  }
  return {
    taskId: normalizeTaskAgentTaskId(input.taskId),
    name: normalizeTaskAgentDefinitionName(input.name),
    displayName: normalizeOptionalText(input.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH),
    description: normalizeRequiredText(input.description, "description", MAX_DESCRIPTION_LENGTH),
    prompt: normalizeRequiredText(input.prompt, "prompt", MAX_PROMPT_LENGTH),
    tools: normalizeTools(input.tools),
    infer: input.infer === true,
    createdBySessionId: normalizeOptionalText(input.createdBySessionId, "createdBySessionId", 200),
  };
}

function directChild(root: string, segment: string): string {
  const target = resolve(root, segment);
  if (dirname(target) !== root) {
    throw new TaskAgentDefinitionValidationError("Resolved task agent path escaped its managed root");
  }
  return target;
}

function getTaskDirectory(root: string, taskId: string): string {
  return directChild(root, normalizeTaskAgentTaskId(taskId));
}

function getAgentFilePath(root: string, taskId: string, name: string): string {
  const taskDir = getTaskDirectory(root, taskId);
  const fileName = `${normalizeTaskAgentDefinitionNameSyntax(name)}${AGENT_FILE_SUFFIX}`;
  const target = resolve(taskDir, fileName);
  if (dirname(target) !== taskDir) {
    throw new TaskAgentDefinitionValidationError("Resolved agent definition path escaped its task directory");
  }
  return target;
}

function fileTimes(filePath: string): { createdAt: string; updatedAt: string } {
  const stats = statSync(filePath);
  const updatedAt = stats.mtime.toISOString();
  const created = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
    ? stats.birthtime
    : stats.mtime;
  return { createdAt: created.toISOString(), updatedAt };
}

function parseDefinition(root: string, taskId: string, filePath: string): TaskAgentDefinition {
  const fileName = basename(filePath);
  const name = fileName.slice(0, -AGENT_FILE_SUFFIX.length);
  const stats = statSync(filePath);
  if (stats.size > MAX_PROFILE_BYTES) {
    throw new TaskAgentDefinitionReadError(taskId, name, `profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  }
  const raw = readFileSync(filePath, "utf-8");
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (error) {
    throw new TaskAgentDefinitionReadError(
      taskId,
      name,
      error instanceof Error ? error.message : String(error),
    );
  }
  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
  const description = normalizeRequiredText(frontmatter.description, "description", MAX_DESCRIPTION_LENGTH);
  const prompt = normalizeRequiredText(parsed.content, "prompt", MAX_PROMPT_LENGTH);
  const displayName = normalizeOptionalText(frontmatter.name, "name", MAX_DISPLAY_NAME_LENGTH);
  const tools = Object.prototype.hasOwnProperty.call(frontmatter, "tools")
    ? normalizeTools(frontmatter.tools)
    : null;
  const disableModelInvocation = frontmatter["disable-model-invocation"];
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean") {
    throw new TaskAgentDefinitionValidationError("disable-model-invocation must be a boolean");
  }
  const userInvocable = frontmatter["user-invocable"];
  if (userInvocable !== undefined && typeof userInvocable !== "boolean") {
    throw new TaskAgentDefinitionValidationError("user-invocable must be a boolean");
  }
  const infer = disableModelInvocation !== true;
  return {
    taskId,
    name,
    displayName,
    description,
    prompt,
    tools,
    infer,
    userInvocable: userInvocable !== false,
    fileName,
    ...fileTimes(filePath),
    frontmatter,
    raw,
  };
}

export function toCopilotCustomAgentConfig(definition: TaskAgentDefinition): CustomAgentConfig {
  return {
    name: definition.name,
    ...(definition.displayName ? { displayName: definition.displayName } : {}),
    description: definition.description,
    prompt: definition.prompt,
    tools: definition.tools,
    infer: definition.infer,
  };
}

export function getTaskAgentDefinitionsRoot(dataDir: string): string {
  return join(resolve(dataDir), "task-agent-definitions");
}

export function createTaskAgentDefinitionStore(options: {
  dataDir: string;
  logger?: Pick<Console, "warn" | "info">;
}) {
  const root = getTaskAgentDefinitionsRoot(options.dataDir);
  const logger = options.logger ?? console;

  function cleanupStaleTempFiles(taskDir: string): void {
    const cutoff = Date.now() - STALE_TEMP_FILE_AGE_MS;
    for (const entry of readdirSync(taskDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(".") || !entry.name.endsWith(".tmp")) continue;
      const tempPath = join(taskDir, entry.name);
      try {
        if (statSync(tempPath).mtimeMs <= cutoff) unlinkSync(tempPath);
      } catch (error) {
        logger.warn(`[task-agent-definitions] Failed to remove stale temp file ${tempPath}.`, error);
      }
    }
  }

  function listTaskAgentDefinitions(taskIdInput: string): TaskAgentDefinition[] {
    const taskId = normalizeTaskAgentTaskId(taskIdInput);
    const taskDir = getTaskDirectory(root, taskId);
    if (!existsSync(taskDir)) return [];
    const taskDirStats = lstatSync(taskDir);
    if (!taskDirStats.isDirectory() || taskDirStats.isSymbolicLink()) {
      logger.warn(`[task-agent-definitions] Ignoring unsafe task agent directory: ${taskDir}`);
      return [];
    }
    cleanupStaleTempFiles(taskDir);
    const definitions: TaskAgentDefinition[] = [];
    const entries = readdirSync(taskDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(AGENT_FILE_SUFFIX))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = join(taskDir, entry.name);
      try {
        definitions.push(parseDefinition(root, taskId, filePath));
      } catch (error) {
        logger.warn(
          `[task-agent-definitions] Skipping unreadable definition "${entry.name}" for task ${taskId}.`,
          error,
        );
      }
    }
    return definitions;
  }

  function getTaskAgentDefinition(taskId: string, name: string): TaskAgentDefinition | undefined {
    const normalizedName = normalizeTaskAgentDefinitionNameSyntax(name);
    return listTaskAgentDefinitions(taskId)
      .find((definition) => definition.name === normalizedName);
  }

  function createTaskAgentDefinition(input: CreateTaskAgentDefinitionInput): TaskAgentDefinition {
    const normalized = normalizeCreateInput(input);
    const existing = listTaskAgentDefinitions(normalized.taskId);
    if (existing.some((definition) => definition.name === normalized.name)) {
      throw new TaskAgentDefinitionAlreadyExistsError(normalized.taskId, normalized.name);
    }
    if (existing.length >= MAX_DEFINITIONS_PER_TASK) {
      throw new TaskAgentDefinitionValidationError(
        `Task ${normalized.taskId} already has the maximum of ${MAX_DEFINITIONS_PER_TASK} agent definitions`,
      );
    }
    mkdirSync(root, { recursive: true });
    const taskDir = getTaskDirectory(root, normalized.taskId);
    if (existsSync(taskDir)) {
      const taskDirStats = lstatSync(taskDir);
      if (!taskDirStats.isDirectory() || taskDirStats.isSymbolicLink()) {
        throw new TaskAgentDefinitionValidationError("Task agent directory is not a safe real directory");
      }
    } else {
      mkdirSync(taskDir, { recursive: false });
    }
    const filePath = getAgentFilePath(root, normalized.taskId, normalized.name);
    if (existsSync(filePath)) {
      throw new TaskAgentDefinitionAlreadyExistsError(normalized.taskId, normalized.name);
    }
    const metadata: Record<string, string> = {
      "bridge-scope": "task",
      "bridge-task-id": normalized.taskId,
    };
    if (normalized.createdBySessionId) {
      metadata["bridge-created-by-session"] = normalized.createdBySessionId;
    }
    const frontmatter: Record<string, unknown> = {
      name: normalized.displayName ?? normalized.name,
      description: normalized.description,
      ...(normalized.tools === null ? {} : { tools: normalized.tools }),
      "disable-model-invocation": !normalized.infer,
      "user-invocable": true,
      metadata,
    };
    const raw = matter.stringify(`${normalized.prompt}\n`, frontmatter);
    const tempPath = join(taskDir, `.${normalized.name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, raw, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        // Preserve the original write/rename error.
      }
      throw error;
    }
    return parseDefinition(root, normalized.taskId, filePath);
  }

  function removeTaskAgentDefinition(taskIdInput: string, nameInput: string): boolean {
    const taskId = normalizeTaskAgentTaskId(taskIdInput);
    const name = normalizeTaskAgentDefinitionNameSyntax(nameInput);
    const filePath = getAgentFilePath(root, taskId, name);
    if (!existsSync(filePath)) return false;
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new TaskAgentDefinitionValidationError("Agent definition path is not a safe regular file");
    }
    unlinkSync(filePath);
    const taskDir = getTaskDirectory(root, taskId);
    cleanupStaleTempFiles(taskDir);
    if (readdirSync(taskDir).length === 0) {
      const taskDirStats = lstatSync(taskDir);
      if (!taskDirStats.isDirectory() || taskDirStats.isSymbolicLink()) {
        throw new TaskAgentDefinitionValidationError("Task agent directory is not a safe real directory");
      }
      rmSync(taskDir, { recursive: true, force: true });
    }
    return true;
  }

  function removeTaskAgentDefinitions(taskIdInput: string): boolean {
    const taskId = normalizeTaskAgentTaskId(taskIdInput);
    const taskDir = getTaskDirectory(root, taskId);
    if (!existsSync(taskDir)) return false;
    const stats = lstatSync(taskDir);
    if (stats.isSymbolicLink()) {
      unlinkSync(taskDir);
      return true;
    }
    if (!stats.isDirectory()) {
      throw new TaskAgentDefinitionValidationError("Task agent path is not a directory");
    }
    rmSync(taskDir, { recursive: true, force: true });
    return true;
  }

  function sweepOrphanedTaskAgentDirectories(liveTaskIds: ReadonlySet<string>): {
    removed: number;
    skipped: boolean;
  } {
    if (!existsSync(root)) return { removed: 0, skipped: false };
    if (liveTaskIds.size === 0) {
      logger.warn("[task-agent-definitions] Skipping orphan sweep because no live task IDs were supplied.");
      return { removed: 0, skipped: true };
    }
    let removed = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!SAFE_PATH_SEGMENT_PATTERN.test(entry.name) || liveTaskIds.has(entry.name)) continue;
      try {
        if (removeTaskAgentDefinitions(entry.name)) removed += 1;
      } catch (error) {
        logger.warn(
          `[task-agent-definitions] Failed to remove orphaned task agent directory "${entry.name}".`,
          error,
        );
      }
    }
    if (removed > 0) {
      logger.info(`[task-agent-definitions] Removed ${removed} orphaned task agent director${removed === 1 ? "y" : "ies"}.`);
    }
    return { removed, skipped: false };
  }

  return {
    root,
    listTaskAgentDefinitions,
    getTaskAgentDefinition,
    createTaskAgentDefinition,
    removeTaskAgentDefinition,
    removeTaskAgentDefinitions,
    sweepOrphanedTaskAgentDirectories,
  };
}

export type TaskAgentDefinitionStore = ReturnType<typeof createTaskAgentDefinitionStore>;
