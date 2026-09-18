import { homedir } from "node:os";
import { join } from "node:path";
import { readCliSessionCatalog } from "./cli-session-store.js";
import type { CliCatalogRead, CliCatalogReadRequest, CopilotCliCatalogSession } from "./cli-session-store-worker.js";

export type { CopilotCliCatalogSession } from "./cli-session-store-worker.js";

/** Read access to the sessions the Copilot CLI has indexed. `undefined` means the catalog could not be read. */
export interface CopilotCliSessionCatalog {
  listSessions(): Promise<CopilotCliCatalogSession[] | undefined>;
  getSession(sessionId: string): Promise<CopilotCliCatalogSession | undefined>;
  hasSession(sessionId: string): Promise<boolean | undefined>;
}

export function createCopilotCliSessionCatalog(deps: {
  copilotHome?: string;
  recordSpan?: (name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>) => void;
} = {}): CopilotCliSessionCatalog {
  const copilotHome = deps.copilotHome ?? join(homedir(), ".copilot");

  async function read(request: CliCatalogReadRequest): Promise<CliCatalogRead | undefined> {
    const start = Date.now();
    const record = (metadata: Record<string, unknown>) =>
      deps.recordSpan?.(`session.cliCatalog.${request.op}`, Date.now() - start, undefined, metadata);
    try {
      const found = await readCliSessionCatalog(request);
      record({ result: found.result, ...(request.op === "list" && found.sessions ? { count: found.sessions.length } : {}) });
      return found;
    } catch (error) {
      record({ result: "error", error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  return {
    listSessions: async () => (await read({ op: "list", copilotHome }))?.sessions,
    getSession: async (sessionId) => (await read({ op: "get", copilotHome, sessionId }))?.sessions?.[0],
    hasSession: async (sessionId) => {
      const result = (await read({ op: "has", copilotHome, sessionId }))?.result;
      return result === "hit" || result === "miss" ? result === "hit" : undefined;
    },
  };
}
