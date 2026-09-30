import type { Task } from "./task-store.js";
import { buildAdoPullRequestUrl } from "../shared/ado-work-reference.js";
import type {
  EnrichedPR,
  EnrichedWorkItem,
  AssignedWorkItemsResult,
  WorkTrackingIdentity,
  WorkItemPullRequestLinksResult,
  WorkItemRelation,
  WorkItemRelationType,
  WorkItemRelationsResult,
} from "./providers/types.js";

/** How far above the linked work the hierarchy is followed, e.g. Task, Feature, Epic, Objective. */
const MAX_ANCESTOR_LEVELS = 5;
/** Related, dependency and duplicate targets that are not on the map get titles, up to this many. */
const MAX_LINKED_CONTEXT_ITEMS = 150;

export interface WorkMapRelation {
  type: WorkItemRelationType;
  workItemId: string;
}

export interface WorkMapTask {
  id: string;
  title: string;
  kind: Task["kind"];
  status: Task["status"];
  deferred: boolean;
  priority: number;
  nextAction: string | null;
  waitingOn: string | null;
}

export interface WorkMapWorkItem extends EnrichedWorkItem {
  taskIds: string[];
  pullRequestKeys: string[];
  assignedToCurrentUser: boolean;
  relations: WorkMapRelation[];
}

/** A work item that is not linked to Bridge work but places it: an ancestor or a linked item. */
export interface WorkMapContextWorkItem extends EnrichedWorkItem {
  relations: WorkMapRelation[];
}

export interface WorkMapPullRequest extends EnrichedPR {
  key: string;
  taskIds: string[];
  workItemIds: string[];
}

export interface WorkMapData {
  enabled: boolean;
  includeArchived: boolean;
  assignedToMe: boolean;
  currentUser: WorkTrackingIdentity | null;
  org: string | null;
  project: string | null;
  generatedAt: string;
  tasks: WorkMapTask[];
  workItems: WorkMapWorkItem[];
  contextWorkItems: WorkMapContextWorkItem[];
  pullRequests: WorkMapPullRequest[];
  warnings: string[];
}

interface BuildWorkMapOptions {
  tasks: Task[];
  includeArchived?: boolean;
  assignedToMe?: boolean;
  adoConfig?: { org: string; project: string };
  enrichWorkItems: (refs: Array<{ id: string; provider: "ado" }>) => Promise<EnrichedWorkItem[]>;
  enrichPullRequests: (refs: Array<{
    repoId: string;
    repoName?: string;
    prId: number;
    provider: "ado";
  }>) => Promise<EnrichedPR[]>;
  fetchRelationships: (
    workItemIds: string[],
    pullRequests: Array<{
      repoId: string;
      repoName?: string;
      prId: number;
      provider: "ado";
    }>,
  ) => Promise<WorkItemPullRequestLinksResult>;
  fetchWorkItemRelations: (workItemIds: string[]) => Promise<WorkItemRelationsResult>;
  fetchCurrentUser: () => Promise<WorkTrackingIdentity | null>;
  fetchAssignedWorkItemIds: () => Promise<AssignedWorkItemsResult>;
  now?: () => string;
}

function prKey(repoId: string, prId: number): string {
  return `${repoId}:${prId}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function uniqueInOrder(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function buildPullRequestFallback(
  config: { org: string; project: string },
  pr: { repoId: string; repoName?: string; prId: number },
): EnrichedPR {
  return {
    repoId: pr.repoId,
    repoName: pr.repoName ?? null,
    prId: pr.prId,
    provider: "ado",
    title: null,
    status: null,
    createdBy: null,
    reviewerCount: 0,
    url: buildAdoPullRequestUrl({
      org: config.org,
      project: config.project,
      repository: pr.repoName ?? pr.repoId,
      prId: pr.prId,
    }),
  };
}

const PARENT_RELATION: ReadonlySet<WorkItemRelationType> = new Set(["parent"]);
const NON_HIERARCHY_RELATIONS: ReadonlySet<WorkItemRelationType> = new Set([
  "related",
  "predecessor",
  "successor",
  "duplicate",
  "duplicateOf",
]);

/**
 * Reads the links of every work item on the map, then follows parent links upward so the client
 * can place Bridge work in the ADO hierarchy. Ancestors and linked items become context items.
 */
async function discoverHierarchy(input: {
  mapIds: string[];
  alreadyFetched: string[];
  initialRelations: WorkItemRelation[];
  fetchWorkItemRelations: (workItemIds: string[]) => Promise<WorkItemRelationsResult>;
}): Promise<{
  relationsByItem: Map<string, WorkMapRelation[]>;
  contextIds: string[];
  warnings: string[];
}> {
  const relations = new Map<string, Map<string, WorkMapRelation>>();
  const addRelations = (list: WorkItemRelation[]) => {
    for (const relation of list) {
      const byKey = relations.get(relation.workItemId) ?? new Map<string, WorkMapRelation>();
      byKey.set(`${relation.type}:${relation.targetId}`, {
        type: relation.type,
        workItemId: relation.targetId,
      });
      relations.set(relation.workItemId, byKey);
    }
  };
  const targetsOf = (id: string, types: ReadonlySet<WorkItemRelationType>) =>
    [...(relations.get(id)?.values() ?? [])]
      .filter((relation) => types.has(relation.type))
      .map((relation) => relation.workItemId);

  addRelations(input.initialRelations);
  const warnings: string[] = [];
  const fetched = new Set(input.alreadyFetched);
  const fetchRelations = async (ids: string[]) => {
    const pending = ids.filter((id) => !fetched.has(id));
    if (pending.length === 0) return;
    for (const id of pending) fetched.add(id);
    const result = await input.fetchWorkItemRelations(pending);
    addRelations(result.relations);
    warnings.push(...result.warnings);
  };

  // Work items found only through a pull request have not had their own links read yet.
  await fetchRelations(input.mapIds);

  const known = new Set(input.mapIds);
  const ancestorIds: string[] = [];
  let frontier = input.mapIds;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && frontier.length > 0; level++) {
    const parents = uniqueInOrder(frontier.flatMap((id) => targetsOf(id, PARENT_RELATION)))
      .filter((id) => !known.has(id));
    for (const id of parents) known.add(id);
    ancestorIds.push(...parents);
    await fetchRelations(parents);
    frontier = parents;
  }

  const linkedIds = uniqueInOrder(input.mapIds.flatMap((id) => targetsOf(id, NON_HIERARCHY_RELATIONS)))
    .filter((id) => !known.has(id))
    .slice(0, MAX_LINKED_CONTEXT_ITEMS);

  return {
    relationsByItem: new Map([...relations].map(([id, byKey]) => [id, [...byKey.values()]])),
    contextIds: [...ancestorIds, ...linkedIds],
    warnings,
  };
}

export async function buildWorkMapData(options: BuildWorkMapOptions): Promise<WorkMapData> {
  const generatedAt = (options.now ?? (() => new Date().toISOString()))();
  if (!options.adoConfig) {
    return {
      enabled: false,
      includeArchived: options.includeArchived ?? false,
      assignedToMe: options.assignedToMe ?? false,
      currentUser: null,
      org: null,
      project: null,
      generatedAt,
      tasks: [],
      workItems: [],
      contextWorkItems: [],
      pullRequests: [],
      warnings: [],
    };
  }

  const taskById = new Map<string, Task>();
  const taskIdsByWorkItem = new Map<string, Set<string>>();
  const taskIdsByPullRequest = new Map<string, Set<string>>();
  const pullRequestRefs = new Map<string, {
    repoId: string;
    repoName?: string;
    prId: number;
    provider: "ado";
  }>();

  for (const task of options.tasks) {
    const adoWorkItems = task.workItems.filter((item) => item.provider === "ado");
    const adoPullRequests = task.pullRequests.filter((pr) => pr.provider === "ado");
    if (adoWorkItems.length === 0 && adoPullRequests.length === 0) continue;
    taskById.set(task.id, task);

    for (const item of adoWorkItems) {
      const taskIds = taskIdsByWorkItem.get(item.id) ?? new Set<string>();
      taskIds.add(task.id);
      taskIdsByWorkItem.set(item.id, taskIds);
    }
    for (const pr of adoPullRequests) {
      const key = prKey(pr.repoId, pr.prId);
      pullRequestRefs.set(key, { ...pr, provider: "ado" });
      const taskIds = taskIdsByPullRequest.get(key) ?? new Set<string>();
      taskIds.add(task.id);
      taskIdsByPullRequest.set(key, taskIds);
    }
  }

  const explicitWorkItemIds = [...taskIdsByWorkItem.keys()];
  const explicitPullRequests = [...pullRequestRefs.values()];
  const [assignedResult, currentUser] = await Promise.all([
    options.assignedToMe
      ? options.fetchAssignedWorkItemIds()
      : Promise.resolve({ ids: [], warnings: [] }),
    options.fetchCurrentUser(),
  ]);
  const workItemIdsForDiscovery = options.assignedToMe
    ? uniqueInOrder([...assignedResult.ids, ...explicitWorkItemIds])
    : uniqueSorted(explicitWorkItemIds);
  const assignedWorkItemIds = new Set(assignedResult.ids);
  const relationshipResult = await options.fetchRelationships(
    workItemIdsForDiscovery,
    explicitPullRequests,
  );

  const pullRequestKeysByWorkItem = new Map<string, Set<string>>();
  const workItemIdsByPullRequest = new Map<string, Set<string>>();
  for (const link of relationshipResult.links) {
    const key = prKey(link.repoId, link.prId);
    if (!pullRequestRefs.has(key)) {
      pullRequestRefs.set(key, { repoId: link.repoId, prId: link.prId, provider: "ado" });
    }
    const pullRequestKeys = pullRequestKeysByWorkItem.get(link.workItemId) ?? new Set<string>();
    pullRequestKeys.add(key);
    pullRequestKeysByWorkItem.set(link.workItemId, pullRequestKeys);

    const workItemIds = workItemIdsByPullRequest.get(key) ?? new Set<string>();
    workItemIds.add(link.workItemId);
    workItemIdsByPullRequest.set(key, workItemIds);
  }

  const allWorkItemIds = uniqueInOrder([
    ...workItemIdsForDiscovery,
    ...relationshipResult.links.map((link) => link.workItemId),
  ]);
  const allPullRequestRefs = [...pullRequestRefs.values()];
  const pullRequestRefsForEnrichment = options.assignedToMe
    ? allPullRequestRefs.filter((pr) =>
        (taskIdsByPullRequest.get(prKey(pr.repoId, pr.prId))?.size ?? 0) > 0)
    : allPullRequestRefs;
  const hierarchy = await discoverHierarchy({
    mapIds: allWorkItemIds,
    alreadyFetched: workItemIdsForDiscovery,
    initialRelations: relationshipResult.workItemRelations ?? [],
    fetchWorkItemRelations: options.fetchWorkItemRelations,
  });
  const [enrichedWorkItems, enrichedPullRequestDetails, enrichedContextItems] = await Promise.all([
    options.enrichWorkItems(allWorkItemIds.map((id) => ({ id, provider: "ado" as const }))),
    options.enrichPullRequests(pullRequestRefsForEnrichment),
    hierarchy.contextIds.length > 0
      ? options.enrichWorkItems(hierarchy.contextIds.map((id) => ({ id, provider: "ado" as const })))
      : Promise.resolve([]),
  ]);
  const enrichedPullRequestByKey = new Map(
    enrichedPullRequestDetails.map((pr) => [prKey(pr.repoId, pr.prId), pr]),
  );

  const workItems = enrichedWorkItems.map((item) => ({
    ...item,
    taskIds: uniqueSorted(taskIdsByWorkItem.get(item.id) ?? []),
    pullRequestKeys: uniqueSorted(pullRequestKeysByWorkItem.get(item.id) ?? []),
    assignedToCurrentUser: assignedWorkItemIds.has(item.id),
    relations: hierarchy.relationsByItem.get(item.id) ?? [],
  }));
  const contextWorkItems = enrichedContextItems.map((item) => ({
    ...item,
    relations: hierarchy.relationsByItem.get(item.id) ?? [],
  }));
  const pullRequests = allPullRequestRefs.map((ref) => {
    const key = prKey(ref.repoId, ref.prId);
    const pr = enrichedPullRequestByKey.get(key) ?? buildPullRequestFallback(options.adoConfig!, ref);
    return {
      ...pr,
      key,
      taskIds: uniqueSorted(taskIdsByPullRequest.get(key) ?? []),
      workItemIds: uniqueSorted(workItemIdsByPullRequest.get(key) ?? []),
    };
  });
  const tasks = [...taskById.values()].map((task) => ({
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    deferred: task.deferred,
    priority: task.priority,
    nextAction: task.nextAction ?? null,
    waitingOn: task.waitingOn ?? null,
  }));

  return {
    enabled: true,
    includeArchived: options.includeArchived ?? false,
    assignedToMe: options.assignedToMe ?? false,
    currentUser,
    org: options.adoConfig.org,
    project: options.adoConfig.project,
    generatedAt,
    tasks,
    workItems,
    contextWorkItems,
    pullRequests,
    warnings: uniqueInOrder([
      ...assignedResult.warnings,
      ...relationshipResult.warnings,
      ...hierarchy.warnings,
    ]),
  };
}
