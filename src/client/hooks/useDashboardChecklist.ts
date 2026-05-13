import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createGlobalChecklistItem,
  patchChecklistItem,
  type DashboardChecklistItem,
  type DashboardChecklistData,
} from "../api";
import { describeHomeChecklistIndicator, getHomeChecklistIndicator } from "../checklist-helpers";
import {
  groupChecklistItemsByTask,
  sortChecklistItems,
  type ChecklistSort,
} from "../components/dashboard-checklist-helpers";

const SORT_STORAGE_KEY = "dashboard-checklist-sort";
const COLLAPSE_STORAGE_KEY = "dashboard-checklist-collapsed";

function getSavedSort(): ChecklistSort {
  try {
    const val = localStorage.getItem(SORT_STORAGE_KEY);
    if (val === "deadline" || val === "task") return val;
  } catch {}
  return "deadline";
}

function getCollapsedSet(): Set<string> {
  try {
    const val = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (val) return new Set(JSON.parse(val));
  } catch {}
  return new Set();
}

export function useDashboardChecklist(data: DashboardChecklistData | undefined) {
  const [localOpenChecklistItems, setLocalOpenChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [localCompletedChecklistItems, setLocalCompletedChecklistItems] = useState<DashboardChecklistItem[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [newChecklistItemText, setNewChecklistItemText] = useState("");
  const [checklistSort, setChecklistSort] = useState<ChecklistSort>(getSavedSort);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(getCollapsedSet);
  const lastLocalChange = useRef(0);

  useEffect(() => {
    if (!data) return;
    const recentLocalChange = Date.now() - lastLocalChange.current < 5000;
    if (!recentLocalChange) {
      setLocalOpenChecklistItems(data.openChecklistItems);
      setLocalCompletedChecklistItems(data.completedChecklistItems);
    }
  }, [data]);

  const sortedOpenChecklistItems = useMemo(
    () => sortChecklistItems(localOpenChecklistItems, checklistSort),
    [localOpenChecklistItems, checklistSort],
  );
  const visibleOpenChecklistItems = useMemo(
    () => localOpenChecklistItems.filter((item) => !exitingIds.has(item.id)),
    [localOpenChecklistItems, exitingIds],
  );
  const checklistIndicator = useMemo(
    () => getHomeChecklistIndicator(visibleOpenChecklistItems),
    [visibleOpenChecklistItems],
  );
  const checklistIndicatorLabel = describeHomeChecklistIndicator(checklistIndicator);
  const checklistGroups = useMemo(
    () => groupChecklistItemsByTask(localOpenChecklistItems),
    [localOpenChecklistItems],
  );

  const handleSortChange = (sort: ChecklistSort) => {
    setChecklistSort(sort);
    try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch {}
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const handleAddChecklistItem = async (event: FormEvent) => {
    event.preventDefault();
    const text = newChecklistItemText.trim();
    if (!text) return;

    setNewChecklistItemText("");
    lastLocalChange.current = Date.now();
    const tempId = `temp-${Date.now()}`;
    const optimistic: DashboardChecklistItem = {
      id: tempId,
      taskId: null,
      text,
      done: false,
      order: 0,
      createdAt: new Date().toISOString(),
      taskTitle: null,
      taskGroupColor: null,
      taskOrder: 0,
      taskStatus: null,
      taskGroupId: null,
      taskGroupOrder: null,
    };
    setLocalOpenChecklistItems((prev) => [optimistic, ...prev]);

    try {
      const checklistItem = await createGlobalChecklistItem(text);
      setLocalOpenChecklistItems((prev) => prev.map((item) =>
        item.id === tempId
          ? {
            ...checklistItem,
            taskTitle: null,
            taskGroupColor: null,
            taskOrder: 0,
            taskStatus: null,
            taskGroupId: null,
            taskGroupOrder: null,
          }
          : item,
      ));
    } catch (err) {
      console.error("Failed to create checklist item:", err);
      setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== tempId));
    }
  };

  const moveOpenItemToCompleted = (checklistItem: DashboardChecklistItem) => {
    setExitingIds((prev) => {
      const next = new Set(prev);
      next.delete(checklistItem.id);
      return next;
    });
    setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
    setLocalCompletedChecklistItems((prev) => [{ ...checklistItem, done: true }, ...prev]);
  };

  const updateOpenItem = (updated: Partial<DashboardChecklistItem> & { id: string }) => {
    lastLocalChange.current = Date.now();
    setLocalOpenChecklistItems((prev) => prev.map((item) =>
      item.id === updated.id ? { ...item, ...updated } : item,
    ));
  };

  const updateCompletedItem = (updated: Partial<DashboardChecklistItem> & { id: string }) => {
    lastLocalChange.current = Date.now();
    setLocalCompletedChecklistItems((prev) => prev.map((item) =>
      item.id === updated.id ? { ...item, ...updated } : item,
    ));
  };

  const markOpenItemDone = async (checklistItem: DashboardChecklistItem) => {
    lastLocalChange.current = Date.now();
    setExitingIds((prev) => new Set(prev).add(checklistItem.id));
    await patchChecklistItem(checklistItem.id, { done: true });
  };

  const restoreCompletedItem = async (checklistItem: DashboardChecklistItem) => {
    lastLocalChange.current = Date.now();
    setLocalCompletedChecklistItems((prev) => prev.filter((item) => item.id !== checklistItem.id));
    setLocalOpenChecklistItems((prev) => [...prev, { ...checklistItem, done: false }]);
    await patchChecklistItem(checklistItem.id, { done: false });
  };

  const removeOpenItem = (id: string) => {
    lastLocalChange.current = Date.now();
    setLocalOpenChecklistItems((prev) => prev.filter((item) => item.id !== id));
  };

  const removeCompletedItem = (id: string) => {
    lastLocalChange.current = Date.now();
    setLocalCompletedChecklistItems((prev) => prev.filter((item) => item.id !== id));
  };

  return {
    localOpenChecklistItems,
    localCompletedChecklistItems,
    showCompleted,
    setShowCompleted,
    exitingIds,
    newChecklistItemText,
    setNewChecklistItemText,
    checklistSort,
    collapsedGroups,
    sortedOpenChecklistItems,
    visibleOpenChecklistItems,
    checklistIndicator,
    checklistIndicatorLabel,
    checklistGroups,
    handleSortChange,
    toggleGroupCollapse,
    handleAddChecklistItem,
    moveOpenItemToCompleted,
    updateOpenItem,
    updateCompletedItem,
    markOpenItemDone,
    restoreCompletedItem,
    removeOpenItem,
    removeCompletedItem,
  };
}

export type DashboardChecklistState = ReturnType<typeof useDashboardChecklist>;
