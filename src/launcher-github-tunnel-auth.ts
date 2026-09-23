import { spawn } from "node:child_process";
import type {
  TunnelHostAuth,
  TunnelHostCredential,
  TunnelHostStatus,
} from "./launcher-tunnel-supervisor.js";

const API_VERSION = "2023-09-27-preview";
const GLOBAL_API = "https://global.rel.tunnels.api.visualstudio.com";
const CLUSTER_RE = /^[a-z0-9]{2,20}$/;
const CREDENTIAL_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 15_000;
const USER_AGENT = "copilot-bridge";

export type GitHubTunnelHostAuthDependencies = {
  readGitHubToken: () => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
};

/**
 * Reads the github.com credential Git Credential Manager (or any git credential helper)
 * stores for HTTPS pushes. Prompts are disabled so a missing or expired credential fails
 * instead of opening a sign-in window on an unattended launcher.
 */
export function readGitHubTokenFromGitCredential(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "fill"], {
      env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(token!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`git credential fill timed out after ${CREDENTIAL_TIMEOUT_MS}ms`));
    }, CREDENTIAL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(new Error(`git credential fill failed to start: ${error.message}`)));
    child.once("close", (code) => {
      const token = stdout.split(/\r?\n/).find((line) => line.startsWith("password="))?.slice("password=".length);
      if (code === 0 && token) {
        finish(null, token);
        return;
      }
      const reason = stderr.trim().split(/\r?\n/).pop() || `exit code ${code}`;
      finish(new Error(`No GitHub credential from git credential fill (${reason}). Sign in once with a git command over HTTPS to github.com.`));
    });
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
}

const defaultDependencies: GitHubTunnelHostAuthDependencies = {
  readGitHubToken: readGitHubTokenFromGitCredential,
  fetch,
  now: Date.now,
};

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  authorization: string,
  what: string,
  timeoutMs = API_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: { Authorization: authorization, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return response.json();
}

export function readTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

type TunnelListResponse = {
  value?: Array<{ clusterId?: unknown; value?: Array<{ tunnelId?: unknown; clusterId?: unknown }> }>;
};

function findCluster(list: TunnelListResponse, name: string): string | null {
  for (const region of list.value ?? []) {
    for (const tunnel of region.value ?? []) {
      if (tunnel.tunnelId !== name) continue;
      const cluster = tunnel.clusterId ?? region.clusterId;
      if (typeof cluster === "string" && CLUSTER_RE.test(cluster)) return cluster;
    }
  }
  return null;
}

function clusterApi(cluster: string): string {
  return `https://${cluster}.rel.tunnels.api.visualstudio.com`;
}

/**
 * Host credentials for tunnels owned by a GitHub account. Each launch reads the GitHub
 * credential, finds the tunnel's cluster, and asks the Dev Tunnels API for a host-scoped
 * token; `devtunnel host --access-token` then runs without touching the CLI's login. The
 * short-lived host token also reads the tunnel's host connection count for health checks.
 */
export function createGitHubTunnelHostAuth(
  deps: GitHubTunnelHostAuthDependencies = defaultDependencies,
): TunnelHostAuth {
  return {
    async getCredential(name: string): Promise<TunnelHostCredential> {
      const githubToken = await deps.readGitHubToken();
      const authorization = `github ${githubToken}`;
      const list = await getJson(
        deps.fetch,
        `${GLOBAL_API}/tunnels?global=true&api-version=${API_VERSION}`,
        authorization,
        "Listing the GitHub account's tunnels",
      ) as TunnelListResponse;
      const cluster = findCluster(list, name);
      if (!cluster) {
        throw new Error(`The GitHub account in the git credential store owns no tunnel named "${name}"`);
      }
      const tunnel = await getJson(
        deps.fetch,
        `${clusterApi(cluster)}/tunnels/${name}?tokenScopes=host&api-version=${API_VERSION}`,
        authorization,
        `Requesting a host token for ${name}`,
      ) as { accessTokens?: { host?: unknown } };
      const accessToken = tunnel.accessTokens?.host;
      if (typeof accessToken !== "string" || !accessToken) {
        throw new Error(`Dev Tunnels returned no host token for ${name}`);
      }
      const issuedAt = deps.now();
      return {
        hostName: `${name}.${cluster}`,
        accessToken,
        issuedAt,
        expiresAt: readTokenExpiry(accessToken) ?? issuedAt + 60 * 60_000,
      };
    },

    async inspectHost(credential: TunnelHostCredential, timeoutMs: number): Promise<TunnelHostStatus> {
      const [name, cluster] = credential.hostName.split(".");
      try {
        const tunnel = await getJson(
          deps.fetch,
          `${clusterApi(cluster)}/tunnels/${name}?api-version=${API_VERSION}`,
          `Tunnel ${credential.accessToken}`,
          `Reading ${name} status`,
          timeoutMs,
        ) as { status?: { hostConnectionCount?: unknown } };
        const count = tunnel.status?.hostConnectionCount;
        return { hostConnections: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0 };
      } catch (error) {
        return { hostConnections: null, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
