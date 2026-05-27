import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BRIDGE_MCP_ENDPOINT_ENV } from "./endpoint.js";

export interface BridgeMcpShimOptions {
  endpoint?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export function runBridgeMcpShim(options: BridgeMcpShimOptions = {}): Promise<void> {
  const endpoint = options.endpoint ?? process.env[BRIDGE_MCP_ENDPOINT_ENV];
  if (!endpoint) {
    return Promise.reject(new Error(`${BRIDGE_MCP_ENDPOINT_ENV} is required`));
  }

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      stdin.unpipe(socket);
      socket.unpipe(stdout);
      if (error) reject(error);
      else resolve();
    };

    socket.once("connect", () => {
      stdin.pipe(socket);
      socket.pipe(stdout);
    });
    socket.once("error", (error) => {
      stderr.write(`[bridge-mcp-shim] ${error.message}\n`);
      settle(error);
    });
    socket.once("close", (hadError) => {
      settle(hadError ? new Error("Bridge MCP socket closed after an error") : undefined);
    });
    stdin.once("error", (error) => {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    stdout.once("error", (error) => {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runBridgeMcpShim().catch((error: unknown) => {
    process.stderr.write(`[bridge-mcp-shim] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
