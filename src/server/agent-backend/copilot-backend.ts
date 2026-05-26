// CopilotBackend — AgentBackend implementation that delegates to
// `@github/copilot-sdk`.
//
// This file is the only place outside of agent-backend/index.ts that
// imports the Copilot SDK on the server side (apart from the per-tool
// defineTool calls and SDK-specific helpers which Step 2 owns).
// SessionManager and SessionRunner consume AgentBackend / AgentSession
// from this module and never reach for CopilotClient again.
//
// All previously-exposed rpc escape hatches (`backend.rpc`, `session.rpc`)
// are now hidden behind typed methods. Callers reach for typed methods like
// `forkSession`, `truncateHistory`, `getName`, etc.; this file knows about
// the underlying SDK rpc namespaces.

import { CopilotClient } from "@github/copilot-sdk";

import type {
  AgentBackend,
  AgentCapabilities,
  AgentMcpOauthLoginOptions,
  AgentMcpServerStatus,
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
 * Method signatures intentionally mirror the SDK 1:1 — every typed method
 * delegates to the underlying rpc namespace, returning `undefined` when
 * the namespace is missing on older SDK builds.
 */
class CopilotAgentSession implements AgentSession {
  constructor(private readonly session: any) {}

  get sessionId(): string {
    return this.session.sessionId;
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

  async setSendMode(opts: { mode: string }): Promise<unknown> {
    const setMode = this.session?.rpc?.mode?.set;
    if (typeof setMode !== "function") {
      throw new Error("Session mode switching is not available in this Copilot SDK build");
    }
    return setMode.call(this.session.rpc.mode, opts);
  }

  async startFleet(opts: { prompt: string }): Promise<unknown> {
    const start = this.session?.rpc?.fleet?.start;
    if (typeof start !== "function") {
      throw new Error("Fleet mode is not available in this Copilot SDK build");
    }
    return start.call(this.session.rpc.fleet, opts);
  }

  async getCurrentModel(): Promise<{ modelId?: string } | undefined> {
    const get = this.session?.rpc?.model?.getCurrent;
    if (typeof get !== "function") return undefined;
    return get.call(this.session.rpc.model);
  }

  async truncateHistory(opts: { eventId: string }): Promise<{ eventsRemoved?: number } | undefined> {
    const truncate = this.session?.rpc?.history?.truncate;
    if (typeof truncate !== "function") return undefined;
    return truncate.call(this.session.rpc.history, opts);
  }

  async listMcpServers(): Promise<{ servers?: AgentMcpServerStatus[] } | undefined> {
    const list = this.session?.rpc?.mcp?.list;
    if (typeof list !== "function") return undefined;
    return list.call(this.session.rpc.mcp);
  }

  async startMcpOauthLogin(opts: AgentMcpOauthLoginOptions): Promise<unknown> {
    const login = this.session?.rpc?.mcp?.oauth?.login;
    if (typeof login !== "function") {
      throw new Error("MCP OAuth login is not available in this Copilot SDK build");
    }
    return login.call(this.session.rpc.mcp.oauth, opts);
  }

  async getName(): Promise<{ name?: string } | undefined> {
    const get = this.session?.rpc?.name?.get;
    if (typeof get !== "function") return undefined;
    return get.call(this.session.rpc.name);
  }

  async setName(opts: { name: string }): Promise<unknown> {
    const set = this.session?.rpc?.name?.set;
    if (typeof set !== "function") {
      throw new Error("Session name RPC is not available in this Copilot SDK build");
    }
    return set.call(this.session.rpc.name, opts);
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

  async forkSession(
    sourceSessionId: string,
    opts?: { toEventId?: string },
  ): Promise<{ sessionId: string }> {
    const fork = (this.client as any).rpc?.sessions?.fork;
    if (typeof fork !== "function") {
      throw new Error("Session fork is not available in this Copilot SDK build");
    }
    const params = opts?.toEventId
      ? { sessionId: sourceSessionId, toEventId: opts.toEventId }
      : { sessionId: sourceSessionId };
    return fork.call((this.client as any).rpc.sessions, params);
  }
}
