// Shared public URL / tunnel / webhook / git utilities used by both the server
// and staging tools. These are pure utilities with no restart or checkpoint logic.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const TUNNEL_NAME = process.env.BRIDGE_TUNNEL_NAME || "copilot-bridge";
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.BRIDGE_PUBLIC_BASE_URL);
const ENV_TUNNEL_URL = normalizeBaseUrl(process.env.BRIDGE_TUNNEL_URL);
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_TRUST_PROXY || "");

let cachedTunnelUrl: string | undefined;
let cachedObservedPublicOrigin: string | undefined;

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function isPublicOrigin(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]" && !hostname.startsWith("127.");
  } catch {
    return false;
  }
}

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
  return cachedTunnelUrl ?? ENV_TUNNEL_URL;
}

export function setTunnelUrl(url: string): void {
  const normalized = normalizeBaseUrl(url);
  if (normalized) {
    cachedTunnelUrl = normalized;
  }
}

export function shouldTrustProxyHeaders(): boolean {
  return TRUST_PROXY;
}

export function getPublicBaseUrl(): string | undefined {
  return PUBLIC_BASE_URL
    ?? (isPublicOrigin(cachedObservedPublicOrigin) ? cachedObservedPublicOrigin : undefined)
    ?? getTunnelUrl();
}

export function buildPublicUrl(pathname: string): string | undefined {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) return undefined;
  const relativePath = pathname.replace(/^\/+/, "");
  try {
    return new URL(relativePath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return undefined;
  }
}

export function deriveRequestOrigin(req: Pick<Request, "headers" | "protocol" | "get">): string | undefined {
  if (!TRUST_PROXY) return undefined;
  const host = firstForwardedValue(req.headers["x-forwarded-host"]);
  const proto = firstForwardedValue(req.headers["x-forwarded-proto"]) ?? req.protocol;
  if (!host || !proto) return undefined;
  return normalizeBaseUrl(`${proto}://${host}`);
}

export function rememberRequestOrigin(req: Pick<Request, "headers" | "protocol" | "get">): string | undefined {
  const origin = deriveRequestOrigin(req);
  if (origin && isPublicOrigin(origin)) cachedObservedPublicOrigin = origin;
  return origin;
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
