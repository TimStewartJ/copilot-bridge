export const TASK_PANEL_DISCLOSURE_STORAGE_KEY = "bridge-task-panel-disclosures";

export type TaskPanelDisclosureId = "work-items" | "pull-requests" | "docs" | "schedules";

type DisclosureStore = Record<string, Partial<Record<TaskPanelDisclosureId, boolean>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDisclosureStore(): DisclosureStore {
  try {
    const raw = localStorage.getItem(TASK_PANEL_DISCLOSURE_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const store: DisclosureStore = {};
    for (const [taskId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;

      const taskState: Partial<Record<TaskPanelDisclosureId, boolean>> = {};
      for (const disclosureId of ["work-items", "pull-requests", "docs", "schedules"] as const) {
        if (typeof value[disclosureId] === "boolean") {
          taskState[disclosureId] = value[disclosureId];
        }
      }
      if (Object.keys(taskState).length > 0) store[taskId] = taskState;
    }
    return store;
  } catch {
    return {};
  }
}

export function getTaskPanelDisclosureExpanded(
  taskId: string,
  disclosureId: TaskPanelDisclosureId,
): boolean {
  return readDisclosureStore()[taskId]?.[disclosureId] === true;
}

export function setTaskPanelDisclosureExpanded(
  taskId: string,
  disclosureId: TaskPanelDisclosureId,
  expanded: boolean,
): void {
  try {
    const store = readDisclosureStore();
    const taskState = { ...store[taskId] };

    if (expanded) {
      taskState[disclosureId] = true;
    } else {
      delete taskState[disclosureId];
    }

    if (Object.keys(taskState).length > 0) {
      store[taskId] = taskState;
    } else {
      delete store[taskId];
    }

    localStorage.setItem(TASK_PANEL_DISCLOSURE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Expansion persistence is best-effort when storage is unavailable.
  }
}
