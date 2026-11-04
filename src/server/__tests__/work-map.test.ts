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
    org: "exampleorg",
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

    expect(data).toMatchObject({ enabled: true, org: "exampleorg", project: "One", currentUser: { displayName: "Tim Stewart" }, warnings: [] });
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

  it("maps deep ancestors and all related work once, without duplicating warnings", async () => {
    const related = Array.from({ length: 200 }, (_, index) => String(1000 + index));
    const ado = fakeAdo({
      items: {
        "10": { relations: [
          ["parent", "20"], ["predecessor", "11"], ["child", "12"],
          ...related.map((id): [WorkItemRelationType, string] => ["related", id]),
        ] },
        "20": { relations: [["parent", "30"], ["child", "10"]] },
        "30": { relations: [["parent", "40"]] },
        "40": { relations: [["parent", "50"]] },
        "50": { relations: [["parent", "60"]] },
        "60": { relations: [["parent", "70"]] },
        "70": { relations: [["parent", "80"]] },
        "80": { relations: [["parent", "10"]] },
      },
      warnings: ["Some ADO work items could not be refreshed."],
    });
    const data = await buildWorkMapData({ tasks: [task("t", { workItems: ["10", "11"], pullRequests: [["repo", 20]] })], assignedToMe: false, ado });

    const ancestors = ["20", "30", "40", "50", "60", "70", "80"];
    expect(ids(data.contextWorkItems)).toEqual([...ancestors, ...related]);
    expect(data.contextWorkItems.every((item) => item.title === `Work item ${item.id}`)).toBe(true);
    expect(data.contextWorkItems[0].relations).toEqual([
      { type: "parent", workItemId: "30" }, { type: "child", workItemId: "10" },
    ]);
    expect(ado.fetchWorkItemLinks.mock.calls.map(([asked]) => asked)).toEqual([["10", "11"], ...ancestors.map((id) => [id])]);
    expect(ado.fetchWorkItems).toHaveBeenCalledExactlyOnceWith(["10", "11", ...ancestors, ...related], expect.any(Function));
    expect(data.warnings).toEqual(["Some ADO work items could not be refreshed."]);
  });

  it("adds the open work assigned to the reader, with its pull requests", async () => {
    const ado = fakeAdo({
      assigned: ["13", "10"],
      items: { "13": { pullRequests: ["repo:31"] } },
    });

    const reports: WorkMapProgress[] = [];
    const data = await buildWorkMapData({
      tasks: [task("t", { workItems: ["10", "12"] })], assignedToMe: true, ado, report: (progress) => reports.push(progress),
    });

    const stages = reports.filter((report, i) => report.step !== reports[i - 1]?.step);
    expect(stages.map(({ label }) => label)).toEqual([
      expect.stringMatching(/assign/i), expect.stringMatching(/work item.*link/i),
      expect.stringMatching(/parent/i), expect.stringMatching(/pull request.*work item/i),
    ]);
    expect(stages.map(({ step, steps, done, total }) => [step, steps, done, total])).toEqual([
      [1, 4, 0, 0], [2, 4, 0, 3], [3, 4, 0, 0], [4, 4, 0, 4],
    ]);
    expect(reports).toContainEqual(expect.objectContaining({ step: 2, done: 3, total: 3 }));
    expect(reports).toContainEqual(expect.objectContaining({ step: 4, done: 3, total: 4 }));
    expect(reports.at(-1)).toMatchObject({ step: 4, done: 4, total: 4 });

    expect(data.workItems.map((item) => [item.id, item.assignedToCurrentUser])).toEqual([["13", true], ["10", true], ["12", false]]);
    expect(data.pullRequests).toEqual([expect.objectContaining({ key: "repo:31", title: "PR 31", taskIds: [], workItemIds: ["13"] })]);
    expect(ado.fetchPullRequests).toHaveBeenCalledExactlyOnceWith([{ repoId: "repo", prId: 31, provider: "ado" }], expect.any(Function));
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
