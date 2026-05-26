// CopilotBackend — AgentBackend implementation that delegates 1:1 to
// `@github/copilot-sdk`.
//
// Step 1 design rule: this file is the ONLY place outside of
// agent-backend/index.ts that imports the Copilot SDK on the server
// side (apart from the per-tool defineTool calls and SDK-specific helpers
// which Step 2 owns). SessionManager and SessionRunner consume AgentBackend
// / AgentSession from this module and never reach for CopilotClient again.

import { CopilotClient } from "@github/copilot-sdk";

import type {
  AgentBackend,
  AgentCapabilities,
  AgentModelInfo,
  AgentSendArgs,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEventHandler,
  AgentSessionSummary,
  AgentSetModelOptions,
} from "./types.js";

const COPILOT_CAPABILITIES: AgentCapabilities = {
  resumeSession: true,
  streamingToolInput: true,
  costUsage: true,
  subAgents: true,
  images: true,
  // The Copilot SDK does not expose a stdin-write API to the Bridge today.
  // Claude Code (Step 3) will flip this to `true`.
  bidirectionalStdin: false,
  externalToolEvents: true,
  forkBoundaries: true,
};

/**
 * Wraps a CopilotSession so the rest of the Bridge talks to AgentSession.
 * Method signatures intentionally mirror the SDK 1:1 — every call passes
 * its arguments through unchanged.
 */
class CopilotAgentSession implements AgentSession {
  constructor(private readonly session: any) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  get rpc(): any {
    return this.session.rpc;
  }

  send(args: AgentSendArgs): Promise<unknown> {
    return this.session.send(args);
  }

  abort(): Promise<unknown> {
    return this.session.abort();
  }

  setModel(model: string, opts?: AgentSetModelOptions): Promise<unknown> {
    return this.session.setModel(model, opts);
  }

  disconnect(): Promise<unknown> | void {
    return this.session.disconnect?.();
  }

  on(handler: AgentSessionEventHandler): () => void {
    return this.session.on(handler);
  }

  getEvents(): Promise<unknown> {
    if (typeof this.session.getEvents !== "function") {
      return Promise.reject(new Error("Copilot SDK session event API is not available"));
    }
    return this.session.getEvents();
  }

  /**
   * Escape hatch for SessionManager helpers that still need direct access
   * to the underlying CopilotSession (e.g. caching by reference identity,
   * passing into truncateQuietIntervalDeferTail which structurally types
   * against the SDK shape). Step 3 should remove these last call sites.
   */
  get raw(): any {
    return this.session;
  }
}

/**
 * Wraps a CopilotClient as an AgentBackend. Constructor takes a
 * pre-built client so the factory can apply env / options resolution
 * in one place.
 */
export class CopilotBackend implements AgentBackend {
  readonly id = "copilot" as const;
  readonly capabilities: AgentCapabilities = COPILOT_CAPABILITIES;

  constructor(private readonly client: CopilotClient) {}

  get rpc(): any {
    return (this.client as any).rpc;
  }

  start(): Promise<unknown> {
    return this.client.start();
  }

  stop(): Promise<unknown> {
    return this.client.stop();
  }

  forceStop(): Promise<unknown> {
    const fn = (this.client as any).forceStop;
    if (typeof fn !== "function") return Promise.resolve();
    return fn.call(this.client);
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const models = await this.client.listModels();
    return models as AgentModelInfo[];
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    const sessions = await this.client.listSessions();
    return sessions as unknown as AgentSessionSummary[];
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = await this.client.createSession(config as any);
    return new CopilotAgentSession(session);
  }

  async resumeSession(sessionId: string, config: AgentSessionConfig): Promise<AgentSession> {
    const session = await this.client.resumeSession(sessionId, config as any);
    return new CopilotAgentSession(session);
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.client.deleteSession(sessionId) as Promise<unknown>;
  }

  getSessionMetadata(sessionId: string): Promise<unknown> {
    return this.client.getSessionMetadata(sessionId) as Promise<unknown>;
  }

  /**
   * Bridge between the structural `AgentSession` shape and the SessionManager
   * helpers that still expect to cache the raw SDK session object (notably
   * `cacheResumedSession`, `replaceCachedSession`, and the
   * `truncateQuietIntervalDeferTail` consumer which structurally types
   * against `getEvents` + `rpc.history.truncate`).
   *
   * Step 1 keeps these helpers working with the underlying CopilotSession
   * because the AgentSession wrapper is invisible to them. Use this when
   * the call site needs to compare by identity or pass through to a
   * structurally-typed helper. Step 3 will fold the remaining call sites
   * back through the AgentSession interface.
   */
  static unwrapSession(session: AgentSession): any {
    if (session instanceof CopilotAgentSession) {
      return (session as any).raw;
    }
    return session;
  }
}
