import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestEnv } from "./helpers.js";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() => vi.fn<
  (file: string, args: string[], options: unknown, callback: ExecFileCallback) => void
>((_file, _args, _options, callback) => callback(new Error("gh not found"), "", "")));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const originalFetch = globalThis.fetch;
const TOKEN_ENV = {
  BRIDGE_COPILOT_GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
} as Record<string, string | undefined>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ message: "error" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function getFetchMock() {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

function requestedUrls(): string[] {
  return getFetchMock().mock.calls.map((call) => String(call[0]));
}

function authHeader(callIndex = 0): string | undefined {
  const init = getFetchMock().mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

async function loadGitHubModule() {
  vi.resetModules();
  return import("../providers/github.js");
}

/** Runs with all GitHub token env vars cleared unless explicitly overridden. */
function withGitHubEnv<T>(overrides: Record<string, string | undefined>, run: () => T | Promise<T>) {
  return withTestEnv({ ...TOKEN_ENV, ...overrides }, run);
}

const ISSUE_PAYLOAD = {
  title: "Fix the launcher",
  state: "open",
  assignee: { login: "octocat" },
};

const PR_PAYLOAD = {
  title: "Add provider enrichment",
  state: "closed",
  merged_at: "2026-05-01T00:00:00Z",
  user: { login: "octocat" },
  requested_reviewers: [{ login: "hubot" }],
  requested_teams: [{ slug: "reviewers" }],
};

describe("GitHubProvider", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(new Error("gh not found"), "", ""));
    globalThis.fetch = vi.fn() as typeof fetch;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.resetModules();
  });

  it("enriches issues and keeps each caller reference distinct while sharing one request", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo", defaultRepo: "bridge" });

    const result = await withGitHubEnv({}, () => provider.fetchWorkItems([
      "octo/bridge#12",
      "bridge#12",
      "12",
      "https://github.com/octo/bridge/issues/12",
    ]));

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(requestedUrls()[0]).toBe("https://api.github.com/repos/octo/bridge/issues/12");
    expect(result.map((wi) => wi.id)).toEqual([
      "octo/bridge#12",
      "bridge#12",
      "12",
      "https://github.com/octo/bridge/issues/12",
    ]);
    expect(result[0]).toEqual({
      id: "octo/bridge#12",
      provider: "github",
      title: "Fix the launcher",
      state: "Open",
      type: "Issue",
      assignedTo: "octocat",
      areaPath: "octo/bridge",
      url: "https://github.com/octo/bridge/issues/12",
    });
    expect(new Set(result.map((wi) => wi.title))).toEqual(new Set(["Fix the launcher"]));
  });

  it("returns unlinked fallbacks for references it cannot resolve", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const result = await withGitHubEnv({}, () => provider.fetchWorkItems([
      "12",
      "not-a-number",
      "https://evil.example.com/octo/bridge/issues/12",
      "https://github.com/octo/bridge/commit/abc",
    ]));

    expect(getFetchMock()).not.toHaveBeenCalled();
    expect(result.map((wi) => wi.url)).toEqual(["#", "#", "#", "#"]);
    expect(result.every((wi) => wi.title === null && wi.provider === "github")).toBe(true);
    expect(provider.getWorkItemUrl("12")).toBe("#");
    expect(provider.getWorkItemUrl("octo/bridge#12")).toBe("https://github.com/octo/bridge/issues/12");
  });

  it("maps pull request state, author, and pending reviewers", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(PR_PAYLOAD));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...PR_PAYLOAD, state: "open", merged_at: null }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...PR_PAYLOAD, merged_at: null }));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const result = await withGitHubEnv({}, () => provider.fetchPullRequests([
      { repoId: "octo/bridge", prId: 7, provider: "github" },
      { repoId: "bridge", prId: 8, provider: "github" },
      { repoId: "octo/bridge", prId: 9, provider: "github" },
    ]));

    expect(requestedUrls()).toEqual([
      "https://api.github.com/repos/octo/bridge/pulls/7",
      "https://api.github.com/repos/octo/bridge/pulls/8",
      "https://api.github.com/repos/octo/bridge/pulls/9",
    ]);
    expect(result[0]).toEqual({
      repoId: "octo/bridge",
      repoName: "octo/bridge",
      prId: 7,
      provider: "github",
      title: "Add provider enrichment",
      status: "completed",
      createdBy: "octocat",
      reviewerCount: 2,
      url: "https://github.com/octo/bridge/pull/7",
    });
    expect(result.map((pr) => pr.status)).toEqual(["completed", "active", "abandoned"]);
    expect(result[1].repoId).toBe("bridge");
    expect(provider.getPullRequestUrl({ repoId: "bridge", prId: 8, provider: "github" }))
      .toBe("https://github.com/octo/bridge/pull/8");
  });

  it("serves cached data inside the TTL and stale data when a refresh fails transiently", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    const cached = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached[0].title).toBe("Fix the launcher");

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(errorResponse(503));
    const stale = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale[0].title).toBe("Fix the launcher");
  });

  it("treats request timeouts as transient", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));

    vi.advanceTimersByTime(61_000);
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"));
    const stale = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));

    expect(stale[0].title).toBe("Fix the launcher");
  });

  it("backs off after a primary rate limit instead of re-requesting", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(errorResponse(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
    }));
    const limited = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(limited[0].title).toBe("Fix the launcher");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const cooling = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cooling[0].title).toBe("Fix the launcher");
  });

  it("caches the fallback after a definitive failure and never resurrects stale data", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(errorResponse(404));
    const missing = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(missing[0]).toEqual({
      id: "octo/bridge#12",
      provider: "github",
      title: null,
      state: null,
      type: null,
      assignedTo: null,
      areaPath: "octo/bridge",
      url: "https://github.com/octo/bridge/issues/12",
    });

    // The fallback is cached, so refetches inside the TTL do not hit the API again.
    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // And a later transient failure must not bring the pre-404 metadata back.
    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(errorResponse(503));
    const afterEviction = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(afterEviction[0].title).toBeNull();
  });

  it("collapses concurrent loads of the same reference into one request", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(jsonResponse(ISSUE_PAYLOAD)), 50);
    }));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const first = withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    const second = withGitHubEnv({}, () => provider.fetchWorkItems(["OCTO/Bridge#12"]));
    await vi.advanceTimersByTimeAsync(200);

    const [a, b] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a[0].title).toBe("Fix the launcher");
    expect(b[0]).toMatchObject({ id: "OCTO/Bridge#12", title: "Fix the launcher" });
  });

  it("honors Retry-After cooldowns and resumes once they expire", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(errorResponse(429, { "retry-after": "120" }));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cooldown covers other references too.
    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#13"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry-After (120s) outlasts the default cooldown.
    vi.advanceTimersByTime(61_000);
    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const recovered = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered[0].title).toBe("Fix the launcher");
  });

  it("treats a headerless secondary rate limit as transient", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const limited = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(limited[0].title).toBe("Fix the launcher");

    // A cooldown was applied, so the next refetch is suppressed.
    vi.advanceTimersByTime(1_000);
    await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects path-escaping repository segments", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const result = await withGitHubEnv({}, () => provider.fetchWorkItems(["../x#12", "..#12", ".#12"]));

    expect(getFetchMock()).not.toHaveBeenCalled();
    expect(result.map((wi) => wi.url)).toEqual(["#", "#", "#"]);
    expect(provider.getPullRequestUrl({ repoId: "..", prId: 1, provider: "github" })).toBe("#");
  });

  it("isolates failures inside a mixed batch", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/13") ? errorResponse(500) : jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const result = await withGitHubEnv({}, () => provider.fetchWorkItems(["octo/bridge#12", "octo/bridge#13"]));

    expect(result.map((wi) => wi.title)).toEqual(["Fix the launcher", null]);
    expect(result.map((wi) => wi.url)).toEqual([
      "https://github.com/octo/bridge/issues/12",
      "https://github.com/octo/bridge/issues/13",
    ]);
  });

  it("prefers env tokens, falls back to the gh CLI, then to anonymous requests", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));

    const envModule = await loadGitHubModule();
    const envProvider = new envModule.GitHubProvider({ owner: "octo" });
    await withGitHubEnv({
      BRIDGE_COPILOT_GITHUB_TOKEN: " bridge-token ",
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
    }, () => envProvider.fetchWorkItems(["octo/bridge#12"]));
    expect(authHeader()).toBe("Bearer bridge-token");
    expect(execFileMock).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn() as typeof fetch;
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    const fallbackModule = await loadGitHubModule();
    const fallbackProvider = new fallbackModule.GitHubProvider({ owner: "octo" });
    await withGitHubEnv({ GITHUB_TOKEN: "github-token" }, () =>
      fallbackProvider.fetchWorkItems(["octo/bridge#12"]));
    expect(authHeader()).toBe("Bearer github-token");
    expect(execFileMock).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn() as typeof fetch;
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null, "cli-token\n", ""));
    const cliModule = await loadGitHubModule();
    const cliProvider = new cliModule.GitHubProvider({ owner: "octo" });
    await withGitHubEnv({}, () => cliProvider.fetchWorkItems(["octo/bridge#12"]));
    expect(execFileMock).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "github.com"], expect.anything(), expect.any(Function));
    expect(authHeader()).toBe("Bearer cli-token");

    globalThis.fetch = vi.fn() as typeof fetch;
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(new Error("gh missing"), "", ""));
    const anonModule = await loadGitHubModule();
    const anonProvider = new anonModule.GitHubProvider({ owner: "octo" });
    const result = await withGitHubEnv({}, () => anonProvider.fetchWorkItems(["octo/bridge#12"]));
    expect(authHeader()).toBeUndefined();
    expect(result[0].title).toBe("Fix the launcher");
  });

  it("retries once anonymously when a token is rejected", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(errorResponse(401));
    fetchMock.mockResolvedValueOnce(jsonResponse(ISSUE_PAYLOAD));
    const { GitHubProvider } = await loadGitHubModule();
    const provider = new GitHubProvider({ owner: "octo" });

    const result = await withGitHubEnv({ GH_TOKEN: "stale-token" }, () =>
      provider.fetchWorkItems(["octo/bridge#12"]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeader(0)).toBe("Bearer stale-token");
    expect(authHeader(1)).toBeUndefined();
    expect(result[0].title).toBe("Fix the launcher");
  });

  it("canonicalizes GitHub work item references", async () => {
    const { canonicalizeGitHubWorkItemId } = await loadGitHubModule();

    expect(canonicalizeGitHubWorkItemId(" https://github.com/octo/bridge/pull/12/files ")).toBe("octo/bridge#12");
    expect(canonicalizeGitHubWorkItemId("https://github.com/octo/bridge/issues/12")).toBe("octo/bridge#12");
    expect(canonicalizeGitHubWorkItemId("#12")).toBe("12");
    expect(canonicalizeGitHubWorkItemId("octo/bridge#12")).toBe("octo/bridge#12");
    expect(canonicalizeGitHubWorkItemId("ENG-123")).toBe("ENG-123");
    expect(canonicalizeGitHubWorkItemId("https://dev.azure.com/org/proj/_workitems/edit/5")).toBe("https://dev.azure.com/org/proj/_workitems/edit/5");
  });

  it("clearProviderCache resets GitHub caches", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    vi.resetModules();
    const registry = await import("../providers/index.js");
    registry.setSettingsGetter(() => ({ mcpServers: {}, providers: { github: { owner: "octo" } } }) as any);

    await withGitHubEnv({}, () => registry.enrichWorkItems([{ id: "octo/bridge#12", provider: "github" }]));
    await withGitHubEnv({}, () => registry.enrichWorkItems([{ id: "octo/bridge#12", provider: "github" }]));
    expect(getFetchMock()).toHaveBeenCalledTimes(1);

    registry.clearProviderCache();
    await withGitHubEnv({}, () => registry.enrichWorkItems([{ id: "octo/bridge#12", provider: "github" }]));
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it("enriches fully qualified references even when GitHub is not configured", async () => {
    getFetchMock().mockResolvedValue(jsonResponse(ISSUE_PAYLOAD));
    vi.resetModules();
    const registry = await import("../providers/index.js");
    registry.setSettingsGetter(() => ({ mcpServers: {} }) as any);

    const result = await withGitHubEnv({}, () =>
      registry.enrichWorkItems([{ id: "octo/bridge#12", provider: "github" }]));

    expect(result[0].title).toBe("Fix the launcher");
    expect(result[0].url).toBe("https://github.com/octo/bridge/issues/12");
  });
});
