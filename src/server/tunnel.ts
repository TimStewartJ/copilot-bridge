// Shared tunnel/webhook/git utilities used by both the server and staging tools.
// These are pure utilities with no restart or checkpoint logic.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const TUNNEL_NAME = process.env.BRIDGE_TUNNEL_NAME || "copilot-bridge";
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";

let cachedTunnelUrl: string | undefined;

export function discoverTunnelUrl(): string | undefined {
  try {
    const output = execSync(`devtunnel show ${TUNNEL_NAME}`, { encoding: "utf-8", timeout: 10_000 });
    const match = output.match(/(https:\/\/\S+)/);
    const url = match?.[1]?.replace(/\/$/, "");
    if (url) cachedTunnelUrl = url;
    return url;
  } catch { return undefined; }
}

export function getTunnelUrl(): string | undefined {
  return cachedTunnelUrl ?? process.env.BRIDGE_TUNNEL_URL ?? undefined;
}

export function setTunnelUrl(url: string): void {
  cachedTunnelUrl = url;
}

export function gitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
  } catch { return "unknown"; }
}

export async function notifyWebhook(message: string, url?: string): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, url }),
    });
    if (!res.ok) {
      console.log(`[webhook] Notification failed: ${res.status}`);
    }
  } catch (err) {
    console.log(`[webhook] Notification error: ${err}`);
  }
}
