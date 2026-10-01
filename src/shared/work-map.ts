import type { EnrichedPR, EnrichedWorkItem } from "../server/providers/types.js";

/** Work item states that mean the work is finished or dropped. The ADO query and the map share this list. */
export const CLOSED_WORK_ITEM_STATES = ["closed", "completed", "done", "removed", "resolved"] as const;

export function isClosedWorkItemState(state: string | null | undefined): boolean {
  return state ? (CLOSED_WORK_ITEM_STATES as readonly string[]).includes(state.toLowerCase()) : false;
}

/**
 * A link between two work items, as the source item reports it. Parent/child come from the ADO
 * hierarchy; predecessor/successor from dependency links; duplicate names the item that duplicates
 * this one and duplicateOf the item this one duplicates.
 */
export type WorkItemRelationType =
  | "parent"
  | "child"
  | "related"
  | "predecessor"
  | "successor"
  | "duplicate"
  | "duplicateOf";

export interface WorkMapRelation {
  type: WorkItemRelationType;
  workItemId: string;
}

export interface WorkMapTask {
  id: string;
  title: string;
  kind: "task" | "ongoing";
  status: "active" | "archived";
  deferred: boolean;
  priority: number;
  nextAction: string | null;
  waitingOn: string | null;
}

/** A work item a Bridge task links, one assigned to the current user, or one found through a linked pull request. */
export interface WorkMapWorkItem extends EnrichedWorkItem {
  taskIds: string[];
  pullRequestKeys: string[];
  assignedToCurrentUser: boolean;
  relations: WorkMapRelation[];
}

/** A work item that is not on the map but places it: an ancestor or a linked item. */
export interface WorkMapContextWorkItem extends EnrichedWorkItem {
  relations: WorkMapRelation[];
}

export interface WorkMapPullRequest extends EnrichedPR {
  key: string;
  taskIds: string[];
  workItemIds: string[];
}

export interface WorkMapData {
  /** False when Azure DevOps is not configured. */
  enabled: boolean;
  currentUser: { displayName: string } | null;
  org: string | null;
  project: string | null;
  tasks: WorkMapTask[];
  workItems: WorkMapWorkItem[];
  contextWorkItems: WorkMapContextWorkItem[];
  pullRequests: WorkMapPullRequest[];
  warnings: string[];
}

/**
 * How far a build of the map is: which of its steps it is on, and how much of that step is done.
 * `total` is 0 for a step whose size is not known up front.
 */
export interface WorkMapProgress {
  label: string;
  /** 1-based. */
  step: number;
  steps: number;
  done: number;
  total: number;
}
