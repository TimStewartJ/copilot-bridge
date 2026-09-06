import type { DatabaseSync } from "./db.js";
import type { ChecklistItem } from "./checklist-store.js";
import type { FocusLifecycle } from "./focus-details-store.js";

export interface FocusActionSource {
  sourceId: string;
  sourceType: "decision" | "alert" | "event";
  activationId: string;
  title: string;
  lifecycle: FocusLifecycle;
}
export interface FocusLinkedAction {
  actionId: string;
  activationId: string;
  createdAt: string;
  action: ChecklistItem;
}
export function listActionSources(db: DatabaseSync, actionId: string): FocusActionSource[] {
  return db.prepare(`SELECT links.sourceId, links.sourceType, links.activationId,
    COALESCE(d.title, a.title, e.title) AS title, details.lifecycle
    FROM focus_action_links links
    JOIN focus_object_details details ON details.objectId = links.sourceId
    LEFT JOIN decisions d ON d.id = links.sourceId
    LEFT JOIN alerts a ON a.id = links.sourceId
    LEFT JOIN focus_events e ON e.id = links.sourceId
    WHERE links.actionId = ? ORDER BY links.createdAt DESC, links.activationId`).all(actionId) as unknown as FocusActionSource[];
}
export function listLinkedActions(db: DatabaseSync, objectId: string): FocusLinkedAction[] {
  return db.prepare(`SELECT links.actionId, links.activationId, links.createdAt AS linkedAt, c.*
    FROM focus_action_links links JOIN checklist_items c ON c.id = links.actionId
    WHERE links.sourceId = ? ORDER BY links.createdAt DESC, links.activationId`).all(objectId).map((row) => ({
    actionId: String(row.actionId), activationId: String(row.activationId), createdAt: String(row.linkedAt),
    action: {
      id: String(row.id), taskId: row.taskId === null ? null : String(row.taskId), text: String(row.text),
      done: row.done === 1, order: Number(row.order), createdAt: String(row.createdAt),
      ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
      ...(typeof row.deadline === "string" ? { deadline: row.deadline } : {}),
      sources: listActionSources(db, String(row.id)),
    },
  }));
}
