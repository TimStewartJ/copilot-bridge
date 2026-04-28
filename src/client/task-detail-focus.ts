interface ChecklistIdentity {
  id: string;
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
