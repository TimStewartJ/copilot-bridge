import { approveAll } from "@github/copilot-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentSession } from "./agent-backend/index.js";
import {
  isSessionStatePathSegment,
  parseWorkspaceYamlSessionNameMetadata,
  parseWorkspaceYamlSessionName,
  type WorkspaceSessionNameMetadata,
} from "./session-workspace-yaml.js";

export interface SetSessionNameOptions {
  session?: AgentSession;
  emit?: boolean;
}

export interface SessionNameRpcDeps {
  withSessionNameRpc<T>(sessionId: string, operation: (session: AgentSession) => Promise<T>): Promise<T>;
  getSessionStateDir(sessionId: string): string;
  emitSessionNameChanged(sessionId: string, name: string): void;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_SESSION_NAME_RETRY_DELAYS_MS = [0, 50, 100, 250, 500, 1000, 2000, 4000] as const;

function normalizeSessionName(name: string): string {
  return name.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ");
}

function workspaceYamlPath(
  getSessionStateDir: (sessionId: string) => string,
  sessionId: string,
): string | undefined {
  if (!isSessionStatePathSegment(sessionId)) return undefined;
  return join(getSessionStateDir(sessionId), "workspace.yaml");
}

export function buildSessionNameResumeConfig(): any {
  return {
    onPermissionRequest: approveAll,
    suppressResumeEvent: true,
    continuePendingWork: false,
    tools: [],
    availableTools: [],
    excludedTools: ["*"],
    mcpServers: {},
    enableConfigDiscovery: false,
    skillDirectories: [],
    instructionDirectories: [],
  };
}

export function readSessionNameFromWorkspace(
  getSessionStateDir: (sessionId: string) => string,
  sessionId: string,
): string | undefined {
  const workspacePath = workspaceYamlPath(getSessionStateDir, sessionId);
  if (!workspacePath) return undefined;
  if (!existsSync(workspacePath)) return undefined;
  const content = readFileSync(workspacePath, "utf-8");
  return parseWorkspaceYamlSessionName(content);
}

export function readSessionNameMetadataFromWorkspace(
  getSessionStateDir: (sessionId: string) => string,
  sessionId: string,
): WorkspaceSessionNameMetadata | undefined {
  const workspacePath = workspaceYamlPath(getSessionStateDir, sessionId);
  if (!workspacePath) return undefined;
  if (!existsSync(workspacePath)) return undefined;
  const content = readFileSync(workspacePath, "utf-8");
  return parseWorkspaceYamlSessionNameMetadata(content);
}

function normalizeRpcSessionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeSessionName(value);
  return normalized || undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSessionNameRpc(deps: SessionNameRpcDeps) {
  const readWorkspaceName = (sessionId: string) => readSessionNameFromWorkspace(deps.getSessionStateDir, sessionId);
  const readWorkspaceNameMetadata = (sessionId: string) =>
    readSessionNameMetadataFromWorkspace(deps.getSessionStateDir, sessionId);
  const retryDelaysMs = deps.retryDelaysMs?.length ? deps.retryDelaysMs : DEFAULT_SESSION_NAME_RETRY_DELAYS_MS;

  const applyNameWithRetry = async (sessionId: string, session: AgentSession, title: string): Promise<void> => {
    if (typeof session.setName !== "function" || typeof session.getName !== "function") {
      throw new Error("Session name RPC is not available in this Copilot SDK build");
    }

    let observedName: string | undefined;
    let lastError: unknown;
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        await session.setName({ name: title });
        lastError = undefined;
      } catch (error) {
        lastError = error;
        continue;
      }

      try {
        const result = await session.getName();
        observedName = normalizeRpcSessionName(result?.name);
        if (observedName === title) return;
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError
      ? `last error: ${formatError(lastError)}`
      : observedName
        ? `last observed title: "${observedName}"`
        : "name.get returned no title";
    throw new Error(`Session rename did not verify for ${sessionId} after ${retryDelaysMs.length} attempt(s): ${detail}`);
  };

  async function getSessionName(sessionId: string): Promise<string | undefined> {
    const workspaceName = readWorkspaceName(sessionId);
    if (workspaceName) return workspaceName;

    return deps.withSessionNameRpc(sessionId, async (session) => {
      if (typeof session.getName !== "function") {
        return readWorkspaceName(sessionId);
      }
      const result = await session.getName();
      return typeof result?.name === "string" && result.name.trim() ? result.name.trim() : undefined;
    });
  }

  async function setSessionName(
    sessionId: string,
    name: string,
    opts: SetSessionNameOptions = {},
  ): Promise<void> {
    const title = normalizeSessionName(name);
    if (!title) throw new Error("Session name is required");
    if (title.length > 100) throw new Error("Session name is too long");

    if (opts.session) await applyNameWithRetry(sessionId, opts.session, title);
    else await deps.withSessionNameRpc(sessionId, (session) => applyNameWithRetry(sessionId, session, title));

    if (opts.emit !== false) deps.emitSessionNameChanged(sessionId, title);
  }

  return {
    readSessionNameFromWorkspace: readWorkspaceName,
    readSessionNameMetadataFromWorkspace: readWorkspaceNameMetadata,
    getSessionName,
    setSessionName,
  };
}

export type SessionNameRpc = ReturnType<typeof createSessionNameRpc>;
