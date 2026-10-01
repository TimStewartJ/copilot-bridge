import { describe, expect, it, vi } from "vitest";
import type { EnrichedPR, EnrichedWorkItem, PRRef, WorkItemRelationType } from "../providers/types.js";
import type { Task } from "../task-store.js";
import type { WorkMapProgress } from "../../shared/work-map.js";
import { buildWorkMapData, createWorkMapBuilds, type WorkMapSource } from "../work-map.js";

interface FakeWorkItem {
  state?: string;
  relations?: Array<[WorkItemRelationType, string]>;
  /** Pull requests the work item links, as `repoId:prId`. */
  pullRequests?: string[];
}

/** An ADO made of work items and the work items each pull request reports. */
function fakeAdo(graph: {
  items?: Record<string, FakeWorkItem>;
  pullRequestWorkItems?: Record<string, string[]>;
  assigned?: string[];
  warnings?: string[];
}) {
  const items = graph.items ?? {};
  const tick = (count: number, report?: (count: number) => void) => report?.(count);
  const ado = {
    org: "msazure",
    project: "One",
    fetchCurrentUser: vi.fn(async () => ({ displayName: "Tim Stewart" })),
    fetchAssignedWorkItemIds: vi.fn(async () => ({ ids: graph.assigned ?? [], warnings: [] })),
    fetchWorkItemLinks: vi.fn(async (ids: string[], report?: (count: number) => void) => {
      tick(ids.length, report);
      return {
        pullRequests: ids.flatMap((id) => (items[id]?.pullRequests ?? []).map((key) => {
          const [repoId, prId] = key.split(":");
          return { workItemId: id, repoId, prId: Number(prId) };
        })),
        relations: ids.flatMap((id) => (items[id]?.relations ?? []).map(([type, targetId]) => ({ workItemId: id, type, targetId }))),
        warnings: graph.warnings ?? [],
      };
    }),
    fetchPullRequestWorkItems: vi.fn(async (prs: PRRef[], report?: (count: number) => void) => {
      tick(prs.length, report);
      return {
        links: prs.flatMap((pr) => (graph.pullRequestWorkItems?.[`${pr.repoId}:${pr.prId}`] ?? [])
          .map((workItemId) => ({ workItemId, repoId: pr.repoId, prId: pr.prId }))),
        warnings: graph.warnings ?? [],
      };
    }),
    fetchWorkItems: vi.fn(async (ids: string[], report?: (count: number) => void): Promise<EnrichedWorkItem[]> => {
      tick(ids.length, report);
      return ids.map((id) => ({
        id,
        provider: "ado",
        title: `Work item ${id}`,
        state: items[id]?.state ?? "Active",
        type: "Task",
        assignedTo: null,
        areaPath: null,
        url: `https://example.test/workitems/${id}`,
      }));
    }),
    fetchPullRequests: vi.fn(async (prs: PRRef[], report?: (count: number) => void): Promise<EnrichedPR[]> => {
      tick(prs.length, report);
      return prs.map((pr) => ({
        repoId: pr.repoId,
        repoName: pr.repoName ?? "bridge",
        prId: pr.prId,
        provider: "ado",
        title: `PR ${pr.prId}`,
        status: "active",
        createdBy: null,
        reviewerCount: 0,
        url: `https://example.test/pullrequests/${pr.prId}`,
      }));
    }),
  };
  return ado satisfies WorkMapSource;
}

function task(id: string, links: { workItems?: string[]; pullRequests?: Array<[string, number]>; status?: Task["status"]; title?: string } = {}): Task {
  return {
    id,
    title: links.title ?? `Task ${id}`,
    kind: "task",
    muted: false,
    deferred: false,
    status: links.status ?? "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    sessionIds: [],
    workItems: (links.workItems ?? []).map((workItemId) => ({ id: workItemId, provider: "ado" })),
    pullRequests: (links.pullRequests ?? []).map(([repoId, prId]) => ({ repoId, repoName: "bridge", prId, provider: "ado" })),
  };
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

describe("buildWorkMapData", () => {
  it("is disabled, and reads nothing, when Azure DevOps is not configured", async () => {
    await expect(buildWorkMapData({ tasks: [task("t1", { workItems: ["10"] })], assignedToMe: true, ado: null })).resolves.toEqual({
      enabled: false,
      currentUser: null,
      org: null,
      project: null,
      tasks: [],
      workItems: [],
      contextWorkItems: [],
      pullRequests: [],
      warnings: [],
    });
  });

  it("joins the tasks with ADO's links in both directions", async () => {
    const ado = fakeAdo({
      // Work item 10 links pull request 30, which no task links. Pull request 20 reports 10 and 11.
      items: { "10": { pullRequests: ["repo:30"] } },
      pullRequestWorkItems: { "repo:20": ["10", "11"] },
    });
    const tasks = [
      task("feature", { workItems: ["10"] }),
      task("review", { pullRequests: [["repo", 20]] }),
      task("also-feature", { workItems: ["10"] }),
      // Links only GitHub work, so it is not part of the ADO map.
      { ...task("elsewhere"), workItems: [{ id: "octo/api#4", provider: "github" as const }] },
    ];

    const data = await buildWorkMapData({ tasks, assignedToMe: false, ado });

    expect(data).toMatchObject({ enabled: true, org: "msazure", project: "One", currentUser: { displayName: "Tim Stewart" }, warnings: [] });
    expect(ids(data.tasks)).toEqual(["feature", "review", "also-feature"]);
    expect(data.workItems).toEqual([
      expect.objectContaining({ id: "10", taskIds: ["feature", "also-feature"], pullRequestKeys: ["repo:20", "repo:30"], assignedToCurrentUser: false }),
      // Found only through the review task's pull request.
      expect.objectContaining({ id: "11", taskIds: [], pullRequestKeys: ["repo:20"] }),
    ]);
    expect(data.pullRequests).toEqual([
      expect.objectContaining({ key: "repo:20", title: "PR 20", taskIds: ["review"], workItemIds: ["10", "11"] }),
      expect.objectContaining({ key: "repo:30", title: "PR 30", taskIds: [], workItemIds: ["10"] }),
    ]);
    expect(ado.fetchAssignedWorkItemIds).not.toHaveBeenCalled();
    // Work item 11 was found through a pull request, so its own links are read once the map is known.
    expect(ado.fetchWorkItemLinks.mock.calls.map(([asked]) => asked)).toEqual([["10"], ["11"]]);
  });

  it("follows parent links to the top, however deep, reading each work item once", async () => {
    const ado = fakeAdo({
      items: {
        "10": { relations: [["parent", "20"]] },
        "20": { relations: [["parent", "30"], ["child", "10"]] },
        "30": { relations: [["parent", "40"]] },
        "40": { relations: [["parent", "50"]] },
        "50": { relations: [["parent", "60"]] },
        "60": { relations: [["parent", "70"]] },
        "70": { relations: [["parent", "80"]] },
        // A cycle in ADO: the top of the chain names the bottom as its parent.
        "80": { relations: [["parent", "10"]] },
      },
    });

    const data = await buildWorkMapData({ tasks: [task("t", { workItems: ["10"] })], assignedToMe: false, ado });

    expect(ids(data.contextWorkItems)).toEqual(["20", "30", "40", "50", "60", "70", "80"]);
    expect(data.contextWorkItems[0].relations).toEqual([
      { type: "parent", workItemId: "30" },
      { type: "child", workItemId: "10" },
    ]);
    expect(ado.fetchWorkItemLinks.mock.calls.map(([asked]) => asked)).toEqual([
      ["10"], ["20"], ["30"], ["40"], ["50"], ["60"], ["70"], ["80"],
    ]);
  });

  it("gives every linked work item a title, without a limit", async () => {
    const linked = Array.from({ length: 200 }, (_, index) => String(1000 + index));
    const ado = fakeAdo({
      items: {
        "10": { relations: [...linked.map((id): [WorkItemRelationType, string] => ["related", id]), ["predecessor", "11"], ["child", "12"]] },
        "11": {},
      },
    });

    const data = await buildWorkMapData({ tasks: [task("t", { workItems: ["10", "11"] })], assignedToMe: false, ado });

    // Linked items are context. One that is already on the map is not repeated, and a child that
    // nobody tracks stays a count on its parent.
    expect(ids(data.contextWorkItems)).toEqual(linked);
    expect(ado.fetchWorkItems).toHaveBeenCalledExactlyOnceWith(["10", "11", ...linked], expect.any(Function));
  });

  it("adds the open work assigned to the reader, with its pull requests", async () => {
    const ado = fakeAdo({
      assigned: ["13", "10"],
      items: { "13": { pullRequests: ["repo:31"] } },
    });

    const data = await buildWorkMapData({ tasks: [task("t", { workItems: ["10", "12"] })], assignedToMe: true, ado });

    expect(data.workItems.map((item) => [item.id, item.assignedToCurrentUser])).toEqual([["13", true], ["10", true], ["12", false]]);
    expect(data.pullRequests).toEqual([expect.objectContaining({ key: "repo:31", title: "PR 31", taskIds: [], workItemIds: ["13"] })]);
    expect(ado.fetchPullRequests).toHaveBeenCalledExactlyOnceWith([{ repoId: "repo", prId: 31, provider: "ado" }], expect.any(Function));
  });

  it("reports each step it is on and how much of it is done", async () => {
    const ado = fakeAdo({
      items: { "10": { relations: [["parent", "20"], ["related", "21"]], pullRequests: ["repo:30"] } },
      pullRequestWorkItems: { "repo:20": ["10"] },
    });
    const reports: WorkMapProgress[] = [];

    await buildWorkMapData({
      tasks: [task("t", { workItems: ["10"], pullRequests: [["repo", 20]] })],
      assignedToMe: true,
      ado,
      report: (progress) => reports.push(progress),
    });

    expect(reports).toEqual([
      { label: "Finding the work assigned to you", step: 1, steps: 4, done: 0, total: 0 },
      // One work item and one pull request the task links.
      { label: "Reading work items and their links", step: 2, steps: 4, done: 0, total: 2 },
      { label: "Reading work items and their links", step: 2, steps: 4, done: 1, total: 2 },
      { label: "Reading work items and their links", step: 2, steps: 4, done: 2, total: 2 },
      { label: "Following parent links", step: 3, steps: 4, done: 0, total: 0 },
      // The work item, its parent, the related item, and both pull requests.
      { label: "Reading pull requests and linked work items", step: 4, steps: 4, done: 0, total: 5 },
      { label: "Reading pull requests and linked work items", step: 4, steps: 4, done: 3, total: 5 },
      { label: "Reading pull requests and linked work items", step: 4, steps: 4, done: 5, total: 5 },
    ]);
  });

  it("passes on each warning once", async () => {
    const ado = fakeAdo({
      items: { "10": { relations: [["parent", "20"]] } },
      warnings: ["Some ADO work items could not be refreshed."],
    });

    const data = await buildWorkMapData({ tasks: [task("t", { workItems: ["10"], pullRequests: [["repo", 20]] })], assignedToMe: false, ado });

    expect(data.warnings).toEqual(["Some ADO work items could not be refreshed."]);
  });
});

describe("createWorkMapBuilds", () => {
  /** An ADO whose first answer waits until the test lets it through. */
  function heldAdo() {
    const ado = fakeAdo({});
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    ado.fetchCurrentUser.mockImplementation(async () => {
      await held;
      return { displayName: "Tim Stewart" };
    });
    return { ado, release };
  }

  it("shares one build between requests for the same map and says how far it is", async () => {
    const builds = createWorkMapBuilds();
    const { ado, release } = heldAdo();
    const options = { tasks: [task("t", { workItems: ["10"] })], assignedToMe: false, ado };

    const first = builds.run("false:false", options);
    // The same task list read again for a second request is a new array of new objects.
    const second = builds.run("false:false", { ...options, tasks: [task("t", { workItems: ["10"] })] });

    expect(second).toBe(first);
    expect(builds.progress("false:false")).toEqual({ label: "Connecting to Azure DevOps", step: 1, steps: 4, done: 0, total: 0 });
    expect(builds.progress("true:false")).toBeNull();

    release();
    await first;
    expect(ado.fetchCurrentUser).toHaveBeenCalledTimes(1);
    expect(builds.progress("false:false")).toBeNull();
  });

  it("builds again when a task changed, when asked for a fresh map, and for other filters", async () => {
    const builds = createWorkMapBuilds();
    const { ado, release } = heldAdo();
    const options = { tasks: [task("t", { workItems: ["10"] })], assignedToMe: false, ado };

    const first = builds.run("false:false", options);
    const renamed = builds.run("false:false", { ...options, tasks: [task("t", { workItems: ["10"], title: "Renamed" })] });
    const fresh = builds.run("false:false", { ...options, tasks: [task("t", { workItems: ["10"], title: "Renamed" })] }, true);
    const archived = builds.run("true:false", options);
    release();
    const results = await Promise.all([first, renamed, fresh, archived]);

    expect(new Set([first, renamed, fresh, archived]).size).toBe(4);
    expect(results.map((data) => data.tasks[0].title)).toEqual(["Task t", "Renamed", "Renamed", "Task t"]);
    expect(ado.fetchCurrentUser).toHaveBeenCalledTimes(4);
    expect(builds.progress("false:false")).toBeNull();
  });

  it("forgets a build that failed, so the next request tries again", async () => {
    const builds = createWorkMapBuilds();
    const ado = fakeAdo({});
    ado.fetchCurrentUser.mockRejectedValueOnce(new Error("ADO is unreachable"));
    const options = { tasks: [], assignedToMe: false, ado };

    await expect(builds.run("false:false", options)).rejects.toThrow("ADO is unreachable");
    await expect(builds.run("false:false", options)).resolves.toMatchObject({ enabled: true });
  });
});
