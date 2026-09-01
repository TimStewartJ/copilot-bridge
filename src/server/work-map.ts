import type { Task } from "./task-store.js";
import type {
  EnrichedPR,
  EnrichedWorkItem,
  WorkTrackingIdentity,
  WorkItemPullRequestLinksResult,
} from "./providers/types.js";

export interface WorkMapTask {
  id: string;
  title: string;
  kind: Task["kind"];
  status: Task["status"];
  priority: number;
  nextAction: string | null;
  waitingOn: string | null;
}

export interface WorkMapWorkItem extends EnrichedWorkItem {
  taskIds: string[];
  pullRequestKeys: string[];
}

export interface WorkMapPullRequest extends EnrichedPR {
  key: string;
  taskIds: string[];
  workItemIds: string[];
}

export interface WorkMapData {
  enabled: boolean;
  includeArchived: boolean;
  currentUser: WorkTrackingIdentity | null;
  org: string | null;
  project: string | null;
  generatedAt: string;
  tasks: WorkMapTask[];
  workItems: WorkMapWorkItem[];
  pullRequests: WorkMapPullRequest[];
  warnings: string[];
}

interface BuildWorkMapOptions {
  tasks: Task[];
  includeArchived?: boolean;
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
  fetchCurrentUser: () => Promise<WorkTrackingIdentity | null>;
  now?: () => string;
}

function prKey(repoId: string, prId: number): string {
  return `${repoId}:${prId}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function buildWorkMapData(options: BuildWorkMapOptions): Promise<WorkMapData> {
  const generatedAt = (options.now ?? (() => new Date().toISOString()))();
  if (!options.adoConfig) {
    return {
      enabled: false,
      includeArchived: options.includeArchived ?? false,
      currentUser: null,
      org: null,
      project: null,
      generatedAt,
      tasks: [],
      workItems: [],
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
  const [relationshipResult, currentUser] = await Promise.all([
    options.fetchRelationships(explicitWorkItemIds, explicitPullRequests),
    options.fetchCurrentUser(),
  ]);

  const pullRequestKeysByWorkItem = new Map<string, Set<string>>();
  const workItemIdsByPullRequest = new Map<string, Set<string>>();
  for (const link of relationshipResult.links) {
    const key = prKey(link.repoId, link.prId);
    const repoCandidates = new Set([link.repoId, ...link.repoAliases]);
    let repoName: string | undefined;
    const taskIds = new Set(taskIdsByPullRequest.get(key) ?? []);
    for (const [existingKey, existingRef] of [...pullRequestRefs.entries()]) {
      if (existingRef.prId !== link.prId) continue;
      if (!repoCandidates.has(existingRef.repoId)
        && (!existingRef.repoName || !repoCandidates.has(existingRef.repoName))) {
        continue;
      }
      repoName ??= existingRef.repoName
        ?? (existingRef.repoId !== link.repoId ? existingRef.repoId : undefined);
      for (const taskId of taskIdsByPullRequest.get(existingKey) ?? []) taskIds.add(taskId);
      if (existingKey !== key) {
        pullRequestRefs.delete(existingKey);
        taskIdsByPullRequest.delete(existingKey);
      }
    }
    pullRequestRefs.set(key, {
      repoId: link.repoId,
      ...(repoName ? { repoName } : {}),
      prId: link.prId,
      provider: "ado",
    });
    if (taskIds.size > 0) taskIdsByPullRequest.set(key, taskIds);
    const pullRequestKeys = pullRequestKeysByWorkItem.get(link.workItemId) ?? new Set<string>();
    pullRequestKeys.add(key);
    pullRequestKeysByWorkItem.set(link.workItemId, pullRequestKeys);

    const workItemIds = workItemIdsByPullRequest.get(key) ?? new Set<string>();
    workItemIds.add(link.workItemId);
    workItemIdsByPullRequest.set(key, workItemIds);
  }

  const allWorkItemIds = uniqueSorted([
    ...explicitWorkItemIds,
    ...relationshipResult.links.map((link) => link.workItemId),
  ]);
  const allPullRequestRefs = [...pullRequestRefs.values()];
  const [enrichedWorkItems, enrichedPullRequests] = await Promise.all([
    options.enrichWorkItems(allWorkItemIds.map((id) => ({ id, provider: "ado" as const }))),
    options.enrichPullRequests(allPullRequestRefs),
  ]);

  const workItems = enrichedWorkItems.map((item) => ({
    ...item,
    taskIds: uniqueSorted(taskIdsByWorkItem.get(item.id) ?? []),
    pullRequestKeys: uniqueSorted(pullRequestKeysByWorkItem.get(item.id) ?? []),
  }));
  const pullRequests = enrichedPullRequests.map((pr) => {
    const key = prKey(pr.repoId, pr.prId);
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
    priority: task.priority,
    nextAction: task.nextAction ?? null,
    waitingOn: task.waitingOn ?? null,
  }));

  return {
    enabled: true,
    includeArchived: options.includeArchived ?? false,
    currentUser,
    org: options.adoConfig.org,
    project: options.adoConfig.project,
    generatedAt,
    tasks,
    workItems,
    pullRequests,
    warnings: relationshipResult.warnings,
  };
}
