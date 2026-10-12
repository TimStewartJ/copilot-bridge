import { execFile } from "node:child_process";

export type TunnelConnectCredential = {
  accessToken: string;
  expiresAt: number;
};

export type TunnelProbeResult = {
  kind: "healthy" | "auth" | "network" | "timeout" | "transport" | "forwarding";
  durationMs: number;
  detail?: string;
};

export function readTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function isTunnelAuthRedirect(status: number, location: string | null | undefined): boolean {
  if (![301, 302, 303, 307, 308].includes(status) || !location) return false;
  try {
    const target = new URL(location);
    return target.protocol === "https:"
      && /(?:^|\.)rel\.tunnels\.api\.visualstudio\.com$/i.test(target.hostname)
      && /^\/auth(?:\/|$)/i.test(target.pathname);
  } catch {
    return false;
  }
}

export function parseTunnelConnectCredential(
  accessToken: unknown,
  expiration?: unknown,
): TunnelConnectCredential {
  if (typeof accessToken !== "string" || !accessToken) throw new Error("No tunnel connect token returned");
  const expiresAt = readTokenExpiry(accessToken)
    ?? (typeof expiration === "string" ? Date.parse(expiration) : NaN);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Tunnel connect token has no valid future expiry");
  }
  return { accessToken, expiresAt };
}

export function getCliTunnelConnectCredential(name: string): Promise<TunnelConnectCredential> {
  return new Promise((resolve, reject) => {
    execFile("devtunnel", ["token", name, "--scopes", "connect", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        // execFile errors include stdout/stderr, which may contain the token.
        reject(new Error(error.killed
          ? "devtunnel connect-token command timed out after 30000ms"
          : `devtunnel connect-token command failed (${error.code ?? "unknown"})`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as { token?: unknown; expiration?: unknown };
        resolve(parseTunnelConnectCredential(result.token, result.expiration));
      } catch {
        reject(new Error("devtunnel returned an invalid connect token or expiry"));
      }
    });
  });
}

export async function probeTunnelHealth(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  options: { accessToken?: string; frontDoor?: boolean } = {},
): Promise<TunnelProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const result = (kind: TunnelProbeResult["kind"], detail?: string): TunnelProbeResult =>
    ({ kind, durationMs: Date.now() - startedAt, ...(detail ? { detail } : {}) });
  try {
    if (options.accessToken) {
      const target = new URL(url);
      if (target.protocol !== "https:" || !target.hostname.endsWith(".devtunnels.ms")) {
        return result("auth", "Refusing to send a connect token outside an HTTPS Dev Tunnel");
      }
    }
    const response = await fetchFn(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: options.accessToken ? { "X-Tunnel-Authorization": `tunnel ${options.accessToken}` } : undefined,
    });
    const authRedirect = isTunnelAuthRedirect(response.status, response.headers.get("location"));
    if (options.frontDoor || response.status !== 200) {
      await response.body?.cancel();
      if (options.frontDoor && (response.ok || authRedirect)) return result("healthy");
      return result(response.status === 401 || response.status === 403 || authRedirect ? "auth" : "forwarding",
        `HTTP ${response.status}`);
    }
    try {
      const body: unknown = await response.json();
      return body !== null && typeof body === "object" && "ok" in body && body.ok === true
        ? result("healthy")
        : result("forwarding", "HTTP 200 without Bridge health ok=true");
    } catch {
      return controller.signal.aborted
        ? result("timeout", `timed out after ${timeoutMs}ms reading Bridge health`)
        : result("forwarding", "HTTP 200 without valid Bridge health JSON");
    }
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : error;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
    if (code && /CONNECT_TIMEOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|CERT|TLS/.test(code)) {
      return result("network", `connection establishment failed (${code})`);
    }
    if (controller.signal.aborted) return result("timeout", `timed out after ${timeoutMs}ms`);
    if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") {
      return result("transport", `connection reset before Bridge health (${code})`);
    }
    return result("network", `network request failed (${code ?? (error instanceof Error ? error.name : "unknown")})`);
  } finally {
    clearTimeout(timeout);
  }
}
