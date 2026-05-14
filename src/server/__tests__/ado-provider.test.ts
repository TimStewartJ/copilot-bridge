import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn<
  (cmd: string, options?: { encoding?: string; timeout?: number }) => string
>(() => "token\n"));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(body = "<!DOCTYPE html><html><body>Sign in</body></html>"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function getFetchMock() {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

async function loadAdoModule() {
  vi.resetModules();
  return import("../providers/ado.js");
}

describe("AdoProvider", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("token\n");
    globalThis.fetch = vi.fn() as typeof fetch;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.resetModules();
  });

  it("returns fallback work item data when ADO responds with HTML on the initial fetch", async () => {
    getFetchMock().mockResolvedValue(htmlResponse());
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchWorkItems(["123"]);

    expect(result).toEqual([
      {
        id: "123",
        provider: "ado",
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: "https://msazure.visualstudio.com/One/_workitems/edit/123",
      },
    ]);
  });

  it("returns stale pull request data when a refresh gets an HTML response", async () => {
    const prRef = {
      repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
      repoName: "AzureStack-ZTP-OOBE",
      prId: 15404546,
      provider: "ado" as const,
    };
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      repository: { name: "AzureStack-ZTP-OOBE" },
      title: "Remove eastus2euap from Arc region dropdown",
      status: "completed",
      createdBy: { displayName: "Tim Stewart" },
      reviewers: [{}, {}],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const fresh = await provider.fetchPullRequests([prRef]);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(htmlResponse());
    fetchMock.mockResolvedValueOnce(htmlResponse());

    const stale = await provider.fetchPullRequests([prRef]);

    expect(fresh).toEqual([
      {
        repoId: prRef.repoId,
        repoName: "AzureStack-ZTP-OOBE",
        prId: 15404546,
        provider: "ado",
        title: "Remove eastus2euap from Arc region dropdown",
        status: "completed",
        createdBy: "Tim Stewart",
        reviewerCount: 2,
        url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15404546",
      },
    ]);
    expect(stale).toEqual(fresh);
  });

  it("drops stale work item data after the stale window expires", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      value: [{
        id: 123,
        fields: {
          "System.Title": "ADO work item",
          "System.State": "Active",
          "System.WorkItemType": "Task",
          "System.AssignedTo": { displayName: "Tim Stewart" },
          "System.AreaPath": "One\\Bridge",
        },
      }],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const fresh = await provider.fetchWorkItems(["123"]);
    expect(fresh[0]?.title).toBe("ADO work item");

    vi.advanceTimersByTime((24 * 60 * 60_000) + 61_000);
    fetchMock.mockResolvedValueOnce(htmlResponse());
    fetchMock.mockResolvedValueOnce(htmlResponse());

    const expired = await provider.fetchWorkItems(["123"]);

    expect(expired).toEqual([
      {
        id: "123",
        provider: "ado",
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: "https://msazure.visualstudio.com/One/_workitems/edit/123",
      },
    ]);
  });

  it("does not reuse stale pull request data for permanent 404 responses", async () => {
    const prRef = {
      repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
      repoName: "AzureStack-ZTP-OOBE",
      prId: 15404546,
      provider: "ado" as const,
    };
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      repository: { name: "AzureStack-ZTP-OOBE" },
      title: "Remove eastus2euap from Arc region dropdown",
      status: "completed",
      createdBy: { displayName: "Tim Stewart" },
      reviewers: [{}, {}],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const fresh = await provider.fetchPullRequests([prRef]);
    expect(fresh[0]?.title).toBe("Remove eastus2euap from Arc region dropdown");

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json; charset=utf-8" },
    }));

    const missing = await provider.fetchPullRequests([prRef]);

    expect(missing).toEqual([
      {
        repoId: prRef.repoId,
        repoName: "AzureStack-ZTP-OOBE",
        prId: 15404546,
        provider: "ado",
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15404546",
      },
    ]);
  });

  it("clearProviderCache clears ADO stale caches alongside provider instances", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      value: [{
        id: 123,
        fields: {
          "System.Title": "ADO work item",
          "System.State": "Active",
          "System.WorkItemType": "Task",
          "System.AssignedTo": { displayName: "Tim Stewart" },
          "System.AreaPath": "One\\Bridge",
        },
      }],
    }));
    const { AdoProvider } = await loadAdoModule();
    const providersModule = await import("../providers/index.js");
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const fresh = await provider.fetchWorkItems(["123"]);
    expect(fresh[0]?.title).toBe("ADO work item");

    vi.advanceTimersByTime(61_000);
    providersModule.clearProviderCache();
    fetchMock.mockResolvedValueOnce(htmlResponse());
    fetchMock.mockResolvedValueOnce(htmlResponse());

    const cleared = await provider.fetchWorkItems(["123"]);

    expect(cleared).toEqual([
      {
        id: "123",
        provider: "ado",
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: "https://msazure.visualstudio.com/One/_workitems/edit/123",
      },
    ]);
  });

  it("retries timed out token fetches once with the longer timeout before requesting ADO data", async () => {
    execSyncMock
      .mockImplementationOnce((_cmd, _options) => {
        const err = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });
        throw err;
      })
      .mockReturnValueOnce("retry-token\n");
    getFetchMock().mockResolvedValue(jsonResponse({
      repository: { name: "AzureStack-ZTP-OOBE" },
      title: "Cherry-pick PR",
      status: "completed",
      createdBy: { displayName: "Tim Stewart" },
      reviewers: [{}],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchPullRequests([{
      repoId: "503e1343-325a-43f5-a33b-04405569f3d5",
      repoName: "AzureStack-ZTP-OOBE",
      prId: 15411444,
      provider: "ado",
    }]);

    expect(result[0]?.title).toBe("Cherry-pick PR");
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
    expect(execSyncMock.mock.calls[1]?.[1]).toMatchObject({ timeout: 30_000 });
  });

  it("invalidates the cached token and retries once when ADO returns the sign-in HTML page", async () => {
    execSyncMock
      .mockReturnValueOnce("stale-token\n")
      .mockReturnValueOnce("fresh-token\n");
    const fetchMock = getFetchMock();
    fetchMock
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [{
          id: 123,
          fields: {
            "System.Title": "Recovered work item",
            "System.State": "Active",
            "System.WorkItemType": "Task",
            "System.AssignedTo": { displayName: "Tim Stewart" },
            "System.AreaPath": "One\\Bridge",
          },
        }],
      }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchWorkItems(["123"]);

    expect(result[0]?.title).toBe("Recovered work item");
    expect(result[0]?.state).toBe("Active");
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstAuth = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    const secondAuth = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(firstAuth?.Authorization).toBe("Bearer stale-token");
    expect(secondAuth?.Authorization).toBe("Bearer fresh-token");
  });

  it("falls back when both the initial request and the sign-in HTML retry come back as HTML", async () => {
    execSyncMock
      .mockReturnValueOnce("stale-token\n")
      .mockReturnValueOnce("still-bad-token\n");
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValue(htmlResponse());
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchWorkItems(["123"]);

    expect(result).toEqual([
      {
        id: "123",
        provider: "ado",
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: "https://msazure.visualstudio.com/One/_workitems/edit/123",
      },
    ]);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only triggers one extra token fetch when many parallel requests hit the sign-in HTML page", async () => {
    execSyncMock
      .mockReturnValueOnce("stale-token\n")
      .mockReturnValueOnce("fresh-token\n");
    const fetchMock = getFetchMock();
    // Both initial PR requests get HTML on the first call; both retries succeed.
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === "Bearer stale-token") return htmlResponse();
      return jsonResponse({
        repository: { name: "AzureStack-ZTP-OOBE" },
        title: "Recovered PR",
        status: "active",
        createdBy: { displayName: "Tim Stewart" },
        reviewers: [{}],
      });
    });
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchPullRequests([
      { repoId: "503e1343-325a-43f5-a33b-04405569f3d5", repoName: "AzureStack-ZTP-OOBE", prId: 1, provider: "ado" },
      { repoId: "503e1343-325a-43f5-a33b-04405569f3d5", repoName: "AzureStack-ZTP-OOBE", prId: 2, provider: "ado" },
      { repoId: "503e1343-325a-43f5-a33b-04405569f3d5", repoName: "AzureStack-ZTP-OOBE", prId: 3, provider: "ado" },
    ]);

    expect(result.map((pr) => pr.title)).toEqual(["Recovered PR", "Recovered PR", "Recovered PR"]);
    // 1 stale fetch + 1 fresh fetch — not one az invocation per failing request.
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });
});
