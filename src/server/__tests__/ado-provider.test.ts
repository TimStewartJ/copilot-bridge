import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stands in for the `az` CLI: returns its stdout, or throws the failure it exits with.
const azCommandMock = vi.hoisted(() => vi.fn<
  (cmd: string, options?: { encoding?: string; timeout?: number }) => string
>(() => "token\n"));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // The provider runs `az` through the process host, which calls exec(command, options, callback).
    exec: (
      cmd: string,
      options: { encoding?: string; timeout?: number },
      callback: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      try {
        callback(null, azCommandMock(cmd, options), "");
      } catch (error) {
        callback(error, "", "");
      }
      return {};
    },
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
    azCommandMock.mockReset();
    azCommandMock.mockReturnValue("token\n");
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
      repository: { id: prRef.repoId, name: "AzureStack-ZTP-OOBE" },
      title: "Remove eastus2euap from Arc region dropdown",
      status: "active",
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
        status: "active",
        createdBy: "Tim Stewart",
        reviewerCount: 2,
        url: "https://msazure.visualstudio.com/One/_git/AzureStack-ZTP-OOBE/pullrequest/15404546",
      },
    ]);
    expect(stale).toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
      repository: { id: prRef.repoId, name: "AzureStack-ZTP-OOBE" },
      title: "Remove eastus2euap from Arc region dropdown",
      status: "active",
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

    // The answer is remembered, so the build that reads this pull request twice asks once.
    await expect(provider.fetchPullRequests([prRef])).resolves.toEqual(missing);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    azCommandMock
      .mockImplementationOnce((_cmd, _options) => {
        const err = Object.assign(new Error("Command failed: az account get-access-token"), { killed: true, signal: "SIGTERM" });
        throw err;
      })
      .mockReturnValueOnce("retry-token\n");
    getFetchMock().mockResolvedValue(jsonResponse({
      repository: { id: "503e1343-325a-43f5-a33b-04405569f3d5", name: "AzureStack-ZTP-OOBE" },
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
    expect(azCommandMock).toHaveBeenCalledTimes(2);
    expect(azCommandMock.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
    expect(azCommandMock.mock.calls[1]?.[1]).toMatchObject({ timeout: 30_000 });
  });

  it("invalidates the cached token and retries once when ADO returns the sign-in HTML page", async () => {
    azCommandMock
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
    expect(azCommandMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstAuth = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    const secondAuth = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(firstAuth?.Authorization).toBe("Bearer stale-token");
    expect(secondAuth?.Authorization).toBe("Bearer fresh-token");
  });

  it("falls back when both the initial request and the sign-in HTML retry come back as HTML", async () => {
    azCommandMock
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
    expect(azCommandMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only triggers one extra token fetch when many parallel requests hit the sign-in HTML page", async () => {
    azCommandMock
      .mockReturnValueOnce("stale-token\n")
      .mockReturnValueOnce("fresh-token\n");
    const fetchMock = getFetchMock();
    // Both initial PR requests get HTML on the first call; both retries succeed.
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth === "Bearer stale-token") return htmlResponse();
      return jsonResponse({
        repository: { id: "503e1343-325a-43f5-a33b-04405569f3d5", name: "AzureStack-ZTP-OOBE" },
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
    expect(azCommandMock).toHaveBeenCalledTimes(2);
  });

  it("discovers work item and pull request links in both directions and reuses enriched metadata", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/_apis/wit/workitems?")) {
        return jsonResponse({
          value: [{
            id: 123,
            fields: {
              "System.Title": "Bridge work map",
              "System.State": "Active",
              "System.WorkItemType": "Feature",
              "System.AssignedTo": { displayName: "Tim Stewart" },
              "System.AreaPath": "One\\Bridge",
            },
            relations: [{
              rel: "ArtifactLink",
              url: "vstfs:///Git/PullRequestId/project-id%2Fe428a0f8-c480-4d71-af51-6ecc94225b14%2F42",
              attributes: { name: "Pull Request" },
            }],
          }],
        });
      }
      if (url === "https://dev.azure.com/msazure/_apis/git/repositories/e428a0f8-c480-4d71-af51-6ecc94225b14/pullrequests/42?includeWorkItemRefs=true&api-version=7.1") {
        return jsonResponse({
          repository: { id: "e428a0f8-c480-4d71-af51-6ecc94225b14", name: "copilot-bridge" },
          title: "Add work map",
          status: "active",
          createdBy: { displayName: "Tim Stewart" },
          reviewers: [{}],
          workItemRefs: [{ id: "123" }, { id: "456" }],
        });
      }
      throw new Error(`Unexpected ADO URL: ${url}`);
    });
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    const pr = { repoId: "e428a0f8-c480-4d71-af51-6ecc94225b14", repoName: "copilot-bridge", prId: 42, provider: "ado" as const };

    const [fromWorkItems, fromPullRequests] = await Promise.all([
      provider.fetchWorkItemLinks(["123"]),
      provider.fetchPullRequestWorkItems([pr]),
    ]);

    expect(fromWorkItems).toEqual({
      pullRequests: [{ workItemId: "123", repoId: "e428a0f8-c480-4d71-af51-6ecc94225b14", prId: 42 }],
      relations: [],
      warnings: [],
    });
    expect(fromPullRequests).toEqual({
      links: [
        { workItemId: "123", repoId: "e428a0f8-c480-4d71-af51-6ecc94225b14", prId: 42 },
        { workItemId: "456", repoId: "e428a0f8-c480-4d71-af51-6ecc94225b14", prId: 42 },
      ],
      warnings: [],
    });
    expect((await provider.fetchWorkItems(["123"]))[0]?.title).toBe("Bridge work map");
    expect((await provider.fetchPullRequests([pr]))[0]?.title).toBe("Add work map");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the links between work items from one relations payload and remembers them", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async () => jsonResponse({
      value: [{
        id: 123,
        fields: { "System.Title": "Child task", "System.State": "Active", "System.WorkItemType": "Task" },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/100" },
          { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/124" },
          { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/200" },
          { rel: "System.LinkTypes.Dependency-Reverse", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/201" },
          { rel: "System.LinkTypes.Dependency-Forward", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/202" },
          { rel: "System.LinkTypes.Duplicate-Forward", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/203" },
          { rel: "System.LinkTypes.Duplicate-Reverse", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/204" },
          { rel: "Microsoft.VSTS.Common.TestedBy-Forward", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/205" },
          { rel: "Hyperlink", url: "https://example.test/_apis/wit/workItems/206" },
          { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/msazure/project-guid/_apis/wit/workItems/123" },
        ],
      }],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const first = await provider.fetchWorkItemLinks(["123"]);
    const again = await provider.fetchWorkItemLinks(["123", "123"]);

    expect(first).toEqual({
      pullRequests: [],
      relations: [
        { workItemId: "123", type: "parent", targetId: "100" },
        { workItemId: "123", type: "child", targetId: "124" },
        { workItemId: "123", type: "related", targetId: "200" },
        { workItemId: "123", type: "predecessor", targetId: "201" },
        { workItemId: "123", type: "successor", targetId: "202" },
        { workItemId: "123", type: "duplicate", targetId: "203" },
        { workItemId: "123", type: "duplicateOf", targetId: "204" },
      ],
      warnings: [],
    });
    expect(again).toEqual(first);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://dev.azure.com/msazure/One/_apis/wit/workitems?ids=123&$expand=Relations&errorPolicy=omit&api-version=7.1",
    ]);
  });

  it("fetches pull requests from any project by organization-wide id, including name-only chat links", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const prId = Number(/pullrequests\/(\d+)\?/.exec(url)?.[1]);
      return jsonResponse({
        repository: {
          id: "ccb450bd-2048-42d2-864d-320ac5718687",
          name: "SFFLinux-OS-Composition",
          project: { name: "msk8s" },
        },
        title: prId === 17135261 ? "[SFF][Security] Restrict edgeuser OpenSSL privileges" : "Update SFF 2604 target RPM assets",
        status: prId === 17135261 ? "active" : "completed",
        createdBy: { displayName: "Vibha Negi" },
        reviewers: [{}, {}, {}],
      });
    });
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    const nameOnly = {
      repoId: "SFFLinux-OS-Composition",
      repoName: "SFFLinux-OS-Composition",
      prId: 15553686,
      provider: "ado" as const,
    };

    const result = await provider.fetchPullRequests([
      {
        repoId: "CCB450BD-2048-42D2-864D-320AC5718687",
        repoName: "SFFLinux-OS-Composition",
        prId: 17135261,
        provider: "ado",
      },
      nameOnly,
    ]);

    expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      "https://dev.azure.com/msazure/_apis/git/pullrequests/15553686?api-version=7.1",
      "https://dev.azure.com/msazure/_apis/git/pullrequests/17135261?api-version=7.1",
    ]);
    expect(result).toEqual([
      {
        repoId: "CCB450BD-2048-42D2-864D-320AC5718687",
        repoName: "SFFLinux-OS-Composition",
        prId: 17135261,
        provider: "ado",
        title: "[SFF][Security] Restrict edgeuser OpenSSL privileges",
        status: "active",
        createdBy: "Vibha Negi",
        reviewerCount: 3,
        url: "https://msazure.visualstudio.com/msk8s/_git/SFFLinux-OS-Composition/pullrequest/17135261",
      },
      expect.objectContaining({
        repoId: "SFFLinux-OS-Composition",
        prId: 15553686,
        status: "completed",
        url: "https://msazure.visualstudio.com/msk8s/_git/SFFLinux-OS-Composition/pullrequest/15553686",
      }),
    ]);

    // The route that lists a pull request's work items takes the repository's GUID. Without one,
    // no work items are reported and ADO is not sent a request it would reject.
    await expect(provider.fetchPullRequestWorkItems([nameOnly])).resolves.toEqual({ links: [], warnings: [] });
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/repositories/"))).toEqual([]);
  });

  it("does not show this organization's pull request for a link saved from another one", async () => {
    const fetchMock = getFetchMock();
    // Pull request 29903 exists in this organization too, in a different repository.
    fetchMock.mockResolvedValue(jsonResponse({
      repository: { id: "fb0b6d86-71f7-432d-ae35-cb75e21a97de", name: "AzureStack-Solution-Deploy", project: { name: "One" } },
      title: "Update Test VHD to fix build break",
      status: "completed",
      createdBy: { displayName: "Someone Else" },
      reviewers: [],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    const link = {
      repoId: "b27864cd-e9b9-462b-ab91-a6f00e7f54a4",
      repoName: "https://dev.azure.com/1esgitops/agency/_git/agency",
      prId: 29903,
      provider: "ado" as const,
    };

    const details = await provider.fetchPullRequests([link]);

    expect(details).toEqual([{
      repoId: link.repoId,
      repoName: link.repoName,
      prId: 29903,
      provider: "ado",
      title: null,
      status: null,
      createdBy: null,
      reviewerCount: 0,
      // The saved repository URL still opens the pull request that was linked.
      url: "https://dev.azure.com/1esgitops/agency/_git/agency/pullrequest/29903",
    }]);
    // Not being in this organization is not a failed refresh, and is not asked about again.
    await expect(provider.fetchPullRequestWorkItems([link])).resolves.toEqual({ links: [], warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a pull request ADO cannot find as missing, and any other failure as a refresh to retry", async () => {
    const pr = { repoId: "503e1343-325a-43f5-a33b-04405569f3d5", repoName: "AzureStack-ZTP-OOBE", prId: 7, provider: "ado" as const };
    const respond = (status: number) => new Response(JSON.stringify({ message: "No" }), {
      status,
      statusText: "No",
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async () => respond(404));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    await expect(provider.fetchPullRequestWorkItems([pr])).resolves.toEqual({ links: [], warnings: [] });
    await expect(provider.fetchPullRequestWorkItems([pr])).resolves.toEqual({ links: [], warnings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => respond(503));
    await expect(provider.fetchPullRequestWorkItems([{ ...pr, prId: 8 }])).resolves.toEqual({
      links: [],
      warnings: ["Some ADO pull requests could not be refreshed."],
    });
    await expect(provider.fetchWorkItemLinks(["123"])).resolves.toEqual({
      pullRequests: [],
      relations: [],
      warnings: ["Some ADO work items could not be refreshed."],
    });
  });

  it("leaves a work item ADO does not return as a stub, without failing its batch or warning", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      // With errorPolicy=omit ADO answers with a hole where a work item cannot be read.
      return jsonResponse({
        value: ids.map((id) => (id === "999" ? null : {
          id: Number(id),
          fields: {
            "System.Title": `Work item ${id}`,
            "System.State": "Active",
            "System.WorkItemType": "Task",
          },
          relations: [{
            rel: "ArtifactLink",
            url: `vstfs:///Git/PullRequestId/project-id%2Frepo-id%2F${id}`,
            attributes: { name: "Pull Request" },
          }],
        })),
      });
    });
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchWorkItemLinks(["123", "999", "456"]);

    expect(result.pullRequests.map((link) => link.workItemId)).toEqual(["123", "456"]);
    expect(result.warnings).toEqual([]);
    expect((await provider.fetchWorkItems(["123", "999", "456"])).map((item) => item.title))
      .toEqual(["Work item 123", null, "Work item 456"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("errorPolicy")).toBe("omit");
  });

  it("does not send ADO an id that is not a number", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({
      value: [{ id: 123, fields: { "System.Title": "Real work item", "System.State": "Active" } }],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    const result = await provider.fetchWorkItems(["123", "octo/api#4"]);

    expect(result.map((item) => item.title)).toEqual(["Real work item", null]);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("ids"))).toEqual(["123"]);
  });

  it("reads batches of a hundred side by side and keeps the order that was asked for", async () => {
    const fetchMock = getFetchMock();
    const answers: Array<() => void> = [];
    let allAsked: () => void = () => {};
    const asked = new Promise<void>((resolve) => { allAsked = resolve; });
    fetchMock.mockImplementation((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      const ids = (new URL(String(input)).searchParams.get("ids") ?? "").split(",");
      answers.push(() => resolve(jsonResponse({
        value: ids.map((id) => ({ id: Number(id), fields: { "System.Title": `Work item ${id}`, "System.State": "Active" } })),
      })));
      if (answers.length === 3) allAsked();
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    const ids = Array.from({ length: 250 }, (_, index) => String(index + 1));
    const ticks: number[] = [];

    const reading = provider.fetchWorkItems(ids, (count) => ticks.push(count));
    // All three batches are on their way before any of them is answered.
    await asked;
    for (const answer of answers.reverse()) answer();
    const result = await reading;

    expect(result.map((item) => item.id)).toEqual(ids);
    expect(ticks.reduce((sum, count) => sum + count, 0)).toBe(250);
  });

  it("keeps a completed pull request for hours and asks again about anything that can still change", async () => {
    const repoId = "503e1343-325a-43f5-a33b-04405569f3d5";
    const statuses: Record<string, string> = { "1": "completed", "2": "active", "3": "abandoned" };
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const prId = /pullrequests\/(\d+)\?/.exec(url)?.[1];
      if (prId) {
        return jsonResponse({ repository: { id: repoId, name: "AzureStack-ZTP-OOBE" }, title: `PR ${prId}`, status: statuses[prId], reviewers: [] });
      }
      const ids = (new URL(url).searchParams.get("ids") ?? "").split(",");
      return jsonResponse({
        value: ids.map((id) => ({ id: Number(id), fields: { "System.Title": `Work item ${id}`, "System.State": "Done" } })),
      });
    });
    const asked = () => fetchMock.mock.calls
      .map(([input]) => /pullrequests\/(\d+)\?/.exec(String(input))?.[1] ?? "work item")
      .sort();
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    const prs = ["1", "2", "3"].map((prId) => ({ repoId, repoName: "AzureStack-ZTP-OOBE", prId: Number(prId), provider: "ado" as const }));

    await provider.fetchPullRequests(prs);
    await provider.fetchWorkItems(["10"]);
    vi.advanceTimersByTime(61_000);
    await provider.fetchPullRequests(prs);
    await provider.fetchWorkItems(["10"]);
    // An abandoned pull request can be reactivated and closed work reopened, so each is asked
    // about again. Only the completed pull request is not.
    expect(asked()).toEqual(["1", "2", "2", "3", "3", "work item", "work item"]);

    vi.advanceTimersByTime(6 * 60 * 60_000);
    await provider.fetchPullRequests(prs.slice(0, 1));
    expect(asked()).toEqual(["1", "1", "2", "2", "3", "3", "work item", "work item"]);
  });

  it("asks ADO again after a refresh, keeping the token and the copy that covers a failed read", async () => {
    const pr = { repoId: "503e1343-325a-43f5-a33b-04405569f3d5", repoName: "AzureStack-ZTP-OOBE", prId: 7, provider: "ado" as const };
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      repository: { id: pr.repoId, name: "AzureStack-ZTP-OOBE" },
      title: "Merged long ago",
      status: "completed",
      reviewers: [],
    }));
    const { AdoProvider, expireAdoProviderData } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    await provider.fetchPullRequests([pr]);

    // A completed pull request would be remembered for hours. A refresh asks about it anyway.
    expireAdoProviderData();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Unavailable" }), {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    const refreshed = await provider.fetchPullRequests([pr]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.title).toBe("Merged long ago");
    expect(azCommandMock).toHaveBeenCalledTimes(1);
  });

  it("gives every request a time limit and treats one that runs out as a refresh to retry", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      value: [{ id: 1, fields: { "System.Title": "Slow to refresh", "System.State": "Active" } }],
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    await provider.fetchWorkItems(["1"]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const afterTimeout = await provider.fetchWorkItems(["1"]);

    expect(afterTimeout[0]?.title).toBe("Slow to refresh");
  });

  it("loads and caches the authenticated ADO user's display name", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({
      authenticatedUser: { providerDisplayName: "Tim Stewart" },
    }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    await expect(provider.fetchCurrentUser()).resolves.toEqual({ displayName: "Tim Stewart" });
    await expect(provider.fetchCurrentUser()).resolves.toEqual({ displayName: "Tim Stewart" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks ADO for the open work assigned to the signed-in user and remembers the answer", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({ workItems: [{ id: 12 }, { id: 34 }, { id: 12 }] }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });

    await expect(provider.fetchAssignedWorkItemIds()).resolves.toEqual({ ids: ["12", "34"], warnings: [] });
    await expect(provider.fetchAssignedWorkItemIds()).resolves.toEqual({ ids: ["12", "34"], warnings: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/msazure/One/_apis/wit/wiql?api-version=7.1");
    expect(init.method).toBe("POST");
    const { query } = JSON.parse(String(init.body)) as { query: string };
    expect(query).toContain("[System.AssignedTo] = @Me");
    // Finished work is left out by the query, so the map never reads it only to hide it.
    expect(query).toContain("[System.State] NOT IN ('closed', 'completed', 'done', 'removed', 'resolved')");
    // The az CLI supplies the token and nothing else.
    expect(azCommandMock.mock.calls.map(([command]) => command.includes("get-access-token"))).toEqual([true]);
  });

  it("keeps the last assigned work, with a warning, when the query fails", async () => {
    const fetchMock = getFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [{ id: 12 }] }));
    const { AdoProvider } = await loadAdoModule();
    const provider = new AdoProvider({ org: "msazure", project: "One" });
    await provider.fetchAssignedWorkItemIds();

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValue(jsonResponse({ message: "No list here" }));

    await expect(provider.fetchAssignedWorkItemIds()).resolves.toEqual({
      ids: ["12"],
      warnings: ["Assigned ADO work items could not be refreshed."],
    });
  });
});
