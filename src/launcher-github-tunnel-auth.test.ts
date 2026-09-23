import { describe, expect, it, vi } from "vitest";
import { createGitHubTunnelHostAuth, readTokenExpiry } from "./launcher-github-tunnel-auth.js";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const LIST_URL = "https://global.rel.tunnels.api.visualstudio.com/tunnels?global=true&api-version=2023-09-27-preview";
const HOST_URL = "https://usw3.rel.tunnels.api.visualstudio.com/tunnels/bridge-github?tokenScopes=host&api-version=2023-09-27-preview";
const STATUS_URL = "https://usw3.rel.tunnels.api.visualstudio.com/tunnels/bridge-github?api-version=2023-09-27-preview";

function createAuth(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const route = routes[String(input)];
    return route ? route() : new Response(null, { status: 404 });
  });
  const auth = createGitHubTunnelHostAuth({
    readGitHubToken: async () => "gho_example",
    fetch: fetchMock as typeof fetch,
    now: () => 1_000_000,
  });
  return { auth, fetchMock };
}

const listWithTunnel = () => Response.json({
  value: [{ clusterId: "usw3", value: [{ clusterId: "usw3", tunnelId: "bridge-github" }] }],
});

describe("GitHub tunnel host auth", () => {
  it("finds the tunnel's cluster and returns a host token with its expiry", async () => {
    const hostToken = jwt({ exp: 2_000, scp: "host" });
    const { auth, fetchMock } = createAuth({
      [LIST_URL]: listWithTunnel,
      [HOST_URL]: () => Response.json({ accessTokens: { host: hostToken } }),
    });

    await expect(auth.getCredential("bridge-github")).resolves.toEqual({
      hostName: "bridge-github.usw3",
      accessToken: hostToken,
      issuedAt: 1_000_000,
      expiresAt: 2_000_000,
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).Authorization).toBe("github gho_example");
    }
  });

  it("explains when the GitHub account owns no such tunnel or the API refuses", async () => {
    const missing = createAuth({ [LIST_URL]: () => Response.json({ value: [] }) });
    await expect(missing.auth.getCredential("bridge-github")).rejects.toThrow(
      'owns no tunnel named "bridge-github"',
    );

    const refused = createAuth({ [LIST_URL]: () => new Response(null, { status: 401 }) });
    await expect(refused.auth.getCredential("bridge-github")).rejects.toThrow(
      "Listing the GitHub account's tunnels failed: HTTP 401",
    );

    const noToken = createAuth({ [LIST_URL]: listWithTunnel, [HOST_URL]: () => Response.json({}) });
    await expect(noToken.auth.getCredential("bridge-github")).rejects.toThrow("no host token");
  });

  it("reads host connections with the host token", async () => {
    const credential = { hostName: "bridge-github.usw3", accessToken: "host-token", issuedAt: 0, expiresAt: 1 };
    const hosted = createAuth({ [STATUS_URL]: () => Response.json({ status: { hostConnectionCount: 1 } }) });
    await expect(hosted.auth.inspectHost(credential, 25)).resolves.toEqual({ hostConnections: 1 });
    expect((hosted.fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization)
      .toBe("Tunnel host-token");

    const idle = createAuth({ [STATUS_URL]: () => Response.json({ status: {} }) });
    await expect(idle.auth.inspectHost(credential, 25)).resolves.toEqual({ hostConnections: 0 });

    const failing = createAuth({ [STATUS_URL]: () => new Response(null, { status: 503 }) });
    await expect(failing.auth.inspectHost(credential, 25)).resolves.toEqual({
      hostConnections: null,
      detail: "Reading bridge-github status failed: HTTP 503",
    });
  });

  it("reads a token's expiry and tolerates tokens without one", () => {
    expect(readTokenExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
    expect(readTokenExpiry(jwt({}))).toBeNull();
    expect(readTokenExpiry("not-a-jwt")).toBeNull();
  });
});
