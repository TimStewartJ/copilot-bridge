import { approveAll } from "@github/copilot-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSessionStatePathSegment,
  parseWorkspaceYamlSessionName,
} from "./session-workspace-yaml.js";

export interface SetSessionNameOptions {
  session?: any;
  emit?: boolean;
}

export interface SessionNameRpcDeps {
  withSessionNameRpc<T>(sessionId: string, operation: (session: any) => Promise<T>): Promise<T>;
  getSessionStateDir(sessionId: string): string;
  emitSessionNameChanged(sessionId: string, name: string): void;
}

function normalizeSessionName(name: string): string {
  return name.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ");
}

export function buildSessionNameResumeConfig(): any {
  return {
    onPermissionRequest: approveAll,
    disableResume: true,
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
  if (!isSessionStatePathSegment(sessionId)) return undefined;
  const workspacePath = join(getSessionStateDir(sessionId), "workspace.yaml");
  if (!existsSync(workspacePath)) return undefined;
  const content = readFileSync(workspacePath, "utf-8");
  return parseWorkspaceYamlSessionName(content);
}

export function createSessionNameRpc(deps: SessionNameRpcDeps) {
  const readWorkspaceName = (sessionId: string) => readSessionNameFromWorkspace(deps.getSessionStateDir, sessionId);

  async function getSessionName(sessionId: string): Promise<string | undefined> {
    return deps.withSessionNameRpc(sessionId, async (session) => {
      if (typeof session.rpc?.name?.get !== "function") {
        return readWorkspaceName(sessionId);
      }
      const result = await session.rpc.name.get();
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

    const applyName = async (session: any) => {
      if (typeof session.rpc?.name?.set !== "function") {
        throw new Error("Session name RPC is not available in this Copilot SDK build");
      }
      await session.rpc.name.set({ name: title });
    };

    if (opts.session) await applyName(opts.session);
    else await deps.withSessionNameRpc(sessionId, applyName);

    if (opts.emit !== false) deps.emitSessionNameChanged(sessionId, title);
  }

  return {
    readSessionNameFromWorkspace: readWorkspaceName,
    getSessionName,
    setSessionName,
  };
}

export type SessionNameRpc = ReturnType<typeof createSessionNameRpc>;
