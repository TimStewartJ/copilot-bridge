interface ChecklistIdentity {
  id: string;
}

export interface TaskDashboardNavigationOptions {
  section?: "sessions" | "checklist";
  checklistItemId?: string;
}

export interface TaskFocusRequest {
  section: "sessions" | "checklist";
  checklistItemId?: string;
}

interface ResolveTaskDashboardFocusArgs {
  focusedSection: string | null;
  focusedChecklistItemId: string | null;
  checklistItems: ChecklistIdentity[];
  checklistItemsReady: boolean;
}

interface ResolveTaskPanelChecklistHighlightArgs {
  focusedChecklistItemId: string | null;
  checklistItems: ChecklistIdentity[];
  checklistItemsReady: boolean;
}

interface ChecklistFocusReadinessArgs {
  isFetched: boolean;
  isFetchedAfterMount: boolean;
  isStale: boolean;
  isFetching: boolean;
  isSuccess: boolean;
}

export function buildTaskDashboardSearch(options?: TaskDashboardNavigationOptions): string {
  if (!options) return "";

  const params = new URLSearchParams();
  if (options.section) params.set("section", options.section);
  if (options.checklistItemId) params.set("checklistItem", options.checklistItemId);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function isChecklistItemsReadyForFocus({
  isFetched,
  isFetchedAfterMount,
  isStale,
  isFetching,
  isSuccess,
}: ChecklistFocusReadinessArgs): boolean {
  if (!isSuccess) return false;
  if (isFetchedAfterMount && !isFetching) return true;
  return isFetched && !isStale;
}

export function resolveTaskDashboardFocus({
  focusedSection,
  focusedChecklistItemId,
  checklistItems,
  checklistItemsReady,
}: ResolveTaskDashboardFocusArgs): {
  request: TaskFocusRequest | null;
  consumeParams: boolean;
} {
  const section = focusedChecklistItemId
    ? "checklist"
    : focusedSection === "sessions" || focusedSection === "checklist"
      ? focusedSection
      : null;

  if (!section) {
    return {
      request: null,
      consumeParams: false,
    };
  }

  if (!focusedChecklistItemId) {
    return {
      request: { section },
      consumeParams: true,
    };
  }

  if (!checklistItemsReady) {
    return {
      request: null,
      consumeParams: false,
    };
  }

  return {
    request: checklistItems.some((item) => item.id === focusedChecklistItemId)
      ? { section, checklistItemId: focusedChecklistItemId }
      : { section },
    consumeParams: true,
  };
}

export function resolveTaskPanelChecklistHighlight({
  focusedChecklistItemId,
  checklistItems,
  checklistItemsReady,
}: ResolveTaskPanelChecklistHighlightArgs): {
  highlightId: string | null;
  consumeParam: boolean;
} {
  if (!focusedChecklistItemId) {
    return {
      highlightId: null,
      consumeParam: false,
    };
  }

  if (!checklistItemsReady) {
    return {
      highlightId: null,
      consumeParam: false,
    };
  }

  return {
    highlightId: checklistItems.some((item) => item.id === focusedChecklistItemId)
      ? focusedChecklistItemId
      : null,
    consumeParam: true,
  };
}
