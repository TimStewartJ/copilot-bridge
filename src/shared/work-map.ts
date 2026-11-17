import type { EnrichedPR, EnrichedWorkItem } from "../server/providers/types.js";

/** States meaning the work is finished or dropped; the ADO query and the map share this list. */
export const CLOSED_WORK_ITEM_STATES = ["closed", "completed", "done", "removed", "resolved"] as const;

export function isClosedWorkItemState(state: string | null | undefined): boolean {
  return state ? (CLOSED_WORK_ITEM_STATES as readonly string[]).includes(state.toLowerCase()) : false;
}

/** As the source reports it; duplicate: the item copying this; duplicateOf: what this copies. */
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

/** Linked by a task, assigned to the current user, or found through a linked pull request. */
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

/** Which build step is running and how much of it is done; `total` is 0 when not known up front. */
export interface WorkMapProgress {
  label: string;
  /** 1-based. */
  step: number;
  steps: number;
  done: number;
  total: number;
}
