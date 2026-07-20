import type { Request } from "express";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { readTunnelRuntimeState } from "./tunnel-runtime-state.js";

const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.BRIDGE_PUBLIC_BASE_URL);
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_TRUST_PROXY || "");
const DATA_DIR = resolveRuntimePaths(process.env).dataDir;

let observedPublicOrigin: string | undefined;

function tunnelEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.BRIDGE_ENABLE_TUNNEL || "");
}

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
    return hostname !== "localhost"
      && hostname !== "::1"
      && hostname !== "[::1]"
      && !hostname.startsWith("127.");
  } catch {
    return false;
  }
}

export function shouldTrustProxyHeaders(): boolean {
  return TRUST_PROXY;
}

export function getPublicBaseUrl(): string | undefined {
  return PUBLIC_BASE_URL
    ?? (isPublicOrigin(observedPublicOrigin) ? observedPublicOrigin : undefined)
    ?? (tunnelEnabled() ? readTunnelRuntimeState(DATA_DIR)?.url ?? undefined : undefined);
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
  if (origin && isPublicOrigin(origin)) observedPublicOrigin = origin;
  return origin;
}
