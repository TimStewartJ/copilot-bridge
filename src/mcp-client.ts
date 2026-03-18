// Direct JSON-RPC client for the Teams MCP server
// No LLM involved — just raw HTTP calls to read/write Teams messages

import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.js";

let mcpProcess: ChildProcess | null = null;

// ── JSON-RPC helpers ──────────────────────────────────────────────

let rpcId = 0;

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = ++rpcId;
  const res = await fetch(config.teamsMcp.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  // The MCP server may return SSE format (data: {...}) or plain JSON
  const text = await res.text();
  let jsonStr = text;

  // Parse SSE: collect all `data:` lines and use the last JSON-RPC response
  if (text.includes("data: ")) {
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    jsonStr = dataLines[dataLines.length - 1] || text;
  }

  const json = JSON.parse(jsonStr) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(
      `MCP RPC error (${json.error.code}): ${json.error.message}`,
    );
  }
  return json.result as T;
}

// ── MCP tool call wrapper ─────────────────────────────────────────

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return rpc<ToolCallResult>("tools/call", { name, arguments: args });
}

// ── Teams-specific wrappers ───────────────────────────────────────

export interface TeamsMessage {
  id: string;
  content: string;
  from: string;
  createdDateTime: string;
  // Thread root message ID (for replies)
  replyToId?: string;
}

export async function listChannelMessages(
  teamId: string,
  channelId: string,
): Promise<string> {
  const result = await callTool("ListChannelMessages", {
    teamId,
    channelId,
  });
  return result.content.map((c) => c.text).join("\n");
}

export async function postChannelMessage(
  teamId: string,
  channelId: string,
  content: string,
): Promise<string> {
  const result = await callTool("PostChannelMessage", {
    teamId,
    channelId,
    content,
    contentType: "text",
  });
  return result.content.map((c) => c.text).join("\n");
}

export async function replyToChannelMessage(
  teamId: string,
  channelId: string,
  messageId: string,
  content: string,
): Promise<string> {
  const result = await callTool("ReplyToChannelMessage", {
    teamId,
    channelId,
    messageId,
    content,
    contentType: "text",
  });
  return result.content.map((c) => c.text).join("\n");
}

// ── MCP server lifecycle ──────────────────────────────────────────

export async function startTeamsMcp(): Promise<void> {
  const port = config.teamsMcp.port;
  console.log(`[mcp] Starting Teams MCP server on port ${port}...`);

  mcpProcess = spawn("mcp-remote", ["mcp", "teams", "--transport", "http", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  // Wait for the server to be ready by polling
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await rpc("tools/list", {});
      console.log(`[mcp] Teams MCP server ready on port ${port}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  throw new Error(`Teams MCP server failed to start after ${maxAttempts}s`);
}

export function stopTeamsMcp(): void {
  if (mcpProcess) {
    console.log("[mcp] Stopping Teams MCP server...");
    mcpProcess.kill();
    mcpProcess = null;
  }
}
