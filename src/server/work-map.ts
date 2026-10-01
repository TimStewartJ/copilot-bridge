import type { Task } from "./task-store.js";
import type { AdoProvider } from "./providers/ado.js";
import type { PRRef, WorkItemRelation, WorkItemRelationType } from "./providers/types.js";
import type { WorkMapData, WorkMapProgress, WorkMapRelation, WorkMapTask } from "../shared/work-map.js";

/** What the work map reads from Azure DevOps. AdoProvider is the implementation. */
export type WorkMapSource = Pick<
  AdoProvider,
  | "org"
  | "project"
  | "fetchCurrentUser"
  | "fetchAssignedWorkItemIds"
  | "fetchWorkItemLinks"
  | "fetchPullRequestWorkItems"
  | "fetchWorkItems"
  | "fetchPullRequests"
>;

export interface BuildWorkMapOptions {
  tasks: Task[];
  /** Adds the open work items assigned to the signed-in ADO user. */
  assignedToMe: boolean;
  /** Null when Azure DevOps is not configured. */
  ado: WorkMapSource | null;
  report?: (progress: WorkMapProgress) => void;
}

const prKey = (pr: { repoId: string; prId: number }) => `${pr.repoId}:${pr.prId}`;
/** Connect, read links, follow parents, read details. A waiting client shows which one the build is on. */
const BUILD_STEPS = 4;

function add<K>(map: Map<K, string[]>, key: K, value: string): void {
  const values = map.get(key);
  if (!values) map.set(key, [value]);
  else if (!values.includes(value)) values.push(value);
}

/** The part of the tasks the map is built from: each task that links ADO work, and what it links. */
function linkedWork(tasks: Task[]): Array<{ task: WorkMapTask; workItemIds: string[]; pullRequests: PRRef[] }> {
  return tasks.flatMap((task) => {
    const workItemIds = task.workItems.filter((item) => item.provider === "ado").map((item) => item.id);
    const pullRequests = task.pullRequests.filter((pr) => pr.provider === "ado");
    if (workItemIds.length === 0 && pullRequests.length === 0) return [];
    return [{
      task: {
        id: task.id,
        title: task.title,
        kind: task.kind,
        status: task.status,
        deferred: task.deferred,
        priority: task.priority,
        nextAction: task.nextAction ?? null,
        waitingOn: task.waitingOn ?? null,
      },
      workItemIds,
      pullRequests,
    }];
  });
}

/**
 * Joins the Bridge tasks that link ADO work with what ADO says about that work: the pull requests
 * linked to each work item, and the work items above and beside it in the ADO hierarchy.
 */
export async function buildWorkMapData(options: BuildWorkMapOptions): Promise<WorkMapData> {
  const { ado } = options;
  if (!ado) {
    return {
      enabled: false,
      currentUser: null,
      org: null,
      project: null,
      tasks: [],
      workItems: [],
      contextWorkItems: [],
      pullRequests: [],
      warnings: [],
    };
  }
  let stepNumber = 0;
  /** Names the step the build is on and returns the counter for work done in it. */
  const step = (label: string, total = 0) => {
    const progress = { label, step: ++stepNumber, steps: BUILD_STEPS, done: 0, total };
    options.report?.({ ...progress });
    return (count: number) => options.report?.({ ...progress, done: (progress.done += count) });
  };

  const linked = linkedWork(options.tasks);
  const taskIdsByWorkItem = new Map<string, string[]>();
  const taskIdsByPullRequest = new Map<string, string[]>();
  const pullRequests = new Map<string, PRRef>();
  for (const { task, workItemIds, pullRequests: taskPullRequests } of linked) {
    for (const id of workItemIds) add(taskIdsByWorkItem, id, task.id);
    for (const pr of taskPullRequests) {
      pullRequests.set(prKey(pr), pr);
      add(taskIdsByPullRequest, prKey(pr), task.id);
    }
  }

  step(options.assignedToMe ? "Finding the work assigned to you" : "Connecting to Azure DevOps");
  const [assigned, currentUser] = await Promise.all([
    options.assignedToMe ? ado.fetchAssignedWorkItemIds() : { ids: [], warnings: [] },
    ado.fetchCurrentUser(),
  ]);
  const linkedIds = [...new Set([...assigned.ids, ...taskIdsByWorkItem.keys()])];
  const taskPullRequests = [...pullRequests.values()];

  const linksRead = step("Reading work items and their links", linkedIds.length + taskPullRequests.length);
  const [itemLinks, pullRequestLinks] = await Promise.all([
    ado.fetchWorkItemLinks(linkedIds, linksRead),
    ado.fetchPullRequestWorkItems(taskPullRequests, linksRead),
  ]);
  const warnings = [...assigned.warnings, ...itemLinks.warnings, ...pullRequestLinks.warnings];

  const pullRequestKeysByWorkItem = new Map<string, string[]>();
  const workItemIdsByPullRequest = new Map<string, string[]>();
  for (const link of [...pullRequestLinks.links, ...itemLinks.pullRequests]) {
    const key = prKey(link);
    if (!pullRequests.has(key)) pullRequests.set(key, { repoId: link.repoId, prId: link.prId, provider: "ado" });
    add(pullRequestKeysByWorkItem, link.workItemId, key);
    add(workItemIdsByPullRequest, key, link.workItemId);
  }
  // A work item found only through a task's pull request is on the map too.
  const mapIds = [...new Set([...linkedIds, ...pullRequestLinks.links.map((link) => link.workItemId)])];

  const relations = new Map<string, WorkMapRelation[]>();
  const record = (list: WorkItemRelation[]) => {
    for (const relation of list) {
      const ofItem = relations.get(relation.workItemId) ?? [];
      ofItem.push({ type: relation.type, workItemId: relation.targetId });
      relations.set(relation.workItemId, ofItem);
    }
  };
  record(itemLinks.relations);
  const known = new Set(mapIds);
  /** The work items that `ids` link to in the wanted way and that are not on the map yet. */
  const targets = (ids: string[], wanted: (type: WorkItemRelationType) => boolean) => [...new Set(
    ids.flatMap((id) => (relations.get(id) ?? []).filter((relation) => wanted(relation.type)).map((relation) => relation.workItemId)),
  )].filter((id) => !known.has(id));

  // Follow parent links to the top, one level per read. Each work item is read once, so a cycle
  // in ADO ends the walk instead of repeating it.
  step("Following parent links");
  const ancestorIds: string[] = [];
  const linkedIdSet = new Set(linkedIds);
  let level = mapIds;
  let unread = mapIds.filter((id) => !linkedIdSet.has(id));
  for (;;) {
    if (unread.length > 0) {
      const links = await ado.fetchWorkItemLinks(unread);
      record(links.relations);
      warnings.push(...links.warnings);
    }
    const parents = targets(level, (type) => type === "parent");
    if (parents.length === 0) break;
    for (const id of parents) known.add(id);
    ancestorIds.push(...parents);
    level = unread = parents;
  }
  // Related, dependency and duplicate targets that are not on the map still get a title.
  const contextIds = [...ancestorIds, ...targets(mapIds, (type) => type !== "parent" && type !== "child")];

  const allPullRequests = [...pullRequests.values()];
  const detailsRead = step(
    "Reading pull requests and linked work items",
    mapIds.length + contextIds.length + allPullRequests.length,
  );
  const [items, pullRequestDetails] = await Promise.all([
    ado.fetchWorkItems([...mapIds, ...contextIds], detailsRead),
    ado.fetchPullRequests(allPullRequests, detailsRead),
  ]);

  const assignedIds = new Set(assigned.ids);
  const withRelations = <T extends { id: string }>(item: T) => ({ ...item, relations: relations.get(item.id) ?? [] });
  return {
    enabled: true,
    currentUser,
    org: ado.org,
    project: ado.project,
    tasks: linked.map(({ task }) => task),
    workItems: items.slice(0, mapIds.length).map((item) => ({
      ...withRelations(item),
      taskIds: taskIdsByWorkItem.get(item.id) ?? [],
      pullRequestKeys: pullRequestKeysByWorkItem.get(item.id) ?? [],
      assignedToCurrentUser: assignedIds.has(item.id),
    })),
    contextWorkItems: items.slice(mapIds.length).map(withRelations),
    pullRequests: pullRequestDetails.map((pr) => ({
      ...pr,
      key: prKey(pr),
      taskIds: taskIdsByPullRequest.get(prKey(pr)) ?? [],
      workItemIds: workItemIdsByPullRequest.get(prKey(pr)) ?? [],
    })),
    warnings: [...new Set(warnings)],
  };
}

interface WorkMapBuild {
  inputs: string;
  data: Promise<WorkMapData>;
  progress: () => WorkMapProgress | null;
}

/**
 * Runs builds of the map. Requests that ask for the same map while it is being built share that
 * build, and a waiting client can ask how far the build for its filters is.
 */
export function createWorkMapBuilds() {
  const builds = new Map<string, WorkMapBuild>();
  return {
    /** `filters` names the client's filter combination. `fresh` never joins a build that is already running. */
    run(filters: string, options: Omit<BuildWorkMapOptions, "report">, fresh = false): Promise<WorkMapData> {
      // A build started before a task changed, or for another ADO project, does not answer this request.
      const inputs = JSON.stringify([options.ado?.org, options.ado?.project, options.assignedToMe, linkedWork(options.tasks)]);
      const running = builds.get(filters);
      if (running && !fresh && running.inputs === inputs) return running.data;

      let progress: WorkMapProgress | null = null;
      const build: WorkMapBuild = {
        inputs,
        progress: () => progress,
        data: buildWorkMapData({ ...options, report: (next) => { progress = next; } }).finally(() => {
          if (builds.get(filters) === build) builds.delete(filters);
        }),
      };
      builds.set(filters, build);
      return build.data;
    },
    progress(filters: string): WorkMapProgress | null {
      return builds.get(filters)?.progress() ?? null;
    },
  };
}
