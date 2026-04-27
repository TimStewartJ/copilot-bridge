import { useState, useEffect, useCallback } from "react";
import type { Task, TaskGroup, Session, RelatedDoc } from "../api";
import { fetchRelatedDocs } from "../api";
import { isChecklistItemsReadyForFocus } from "../task-detail-focus";
import { useTaskEnrichment } from "./useTaskEnrichment";
import { useTaskSchedules } from "./useTaskSchedules";
import { useScheduleDetail } from "./useScheduleDetail";
import { useNotesSheet } from "./useNotesSheet";
import {
  useTaskChecklistItemsQuery,
  useCreateChecklistItemMutation,
  useChecklistItemCacheUpdaters,
} from "./queries/useChecklistItems";
import { useTaskGitStatusQuery } from "./queries/useTaskGitStatus";

/**
 * Consolidates shared setup for TaskPanel and TaskDashboard:
 * enrichment, schedules, schedule detail sheet, notes sheet,
 * checklist items, linked sessions, effective tags, and related docs.
 */
export function useTaskWorkspace(
  task: Task | undefined,
  taskGroups: TaskGroup[],
  sessions: Session[],
) {
  // ── Enrichment ──────────────────────────────────────────────
  const { enrichedWIs, enrichedPRs, reload: reloadEnriched } = useTaskEnrichment(
    task?.id, task?.workItems.length ?? 0, task?.pullRequests.length ?? 0,
  );

  // ── Schedules ───────────────────────────────────────────────
  const sched = useTaskSchedules(task?.id);
  const schedDetail = useScheduleDetail();

  // ── Notes ───────────────────────────────────────────────────
  const notes = useNotesSheet(task?.id);

  // ── Checklist items ──────────────────────────────────────────
  const {
    data: checklistItems = [],
    refetch: refetchChecklistItems,
    isFetched,
    isFetchedAfterMount,
    isFetching,
    isStale,
    isSuccess,
  } = useTaskChecklistItemsQuery(task?.id);
  const checklistItemsReady = isChecklistItemsReadyForFocus({
    isFetched,
    isFetchedAfterMount,
    isStale,
    isFetching,
    isSuccess,
  });
  const checklistLoaded = isFetched;
  const createChecklistItemMutation = useCreateChecklistItemMutation(task?.id);
  const {
    onUpdate: onChecklistItemUpdate,
    onDelete: onChecklistItemDelete,
  } = useChecklistItemCacheUpdaters(task?.id);
  const [newChecklistItemText, setNewChecklistItemText] = useState("");
  // ── Git status ───────────────────────────────────────────────
  const { data: taskGitStatus, refetch: refetchTaskGitStatus } = useTaskGitStatusQuery(
    task?.id,
    !!task?.cwd,
  );

  // ── Linked sessions ─────────────────────────────────────────
  const linkedSessions = sessions.filter((s) =>
    task?.sessionIds.includes(s.sessionId),
  );

  // ── Effective tags (own + group, deduplicated) ──────────────
  const taskOwnTags = task?.tags ?? [];
  const taskGroup = taskGroups.find((g) => g.id === task?.groupId);
  const groupTags = taskGroup?.tags ?? [];
  const inheritedTagIds = new Set(groupTags.map((t) => t.id));
  const effectiveTags = [
    ...taskOwnTags,
    ...groupTags.filter((gt) => !taskOwnTags.some((tt) => tt.id === gt.id)),
  ];

  // ── Related docs ────────────────────────────────────────────
  const [relatedDocs, setRelatedDocs] = useState<RelatedDoc[]>([]);
  const effectiveTagKey = effectiveTags.map((t) => t.id).join(",");

  useEffect(() => {
    const tagIds = effectiveTags.map((t) => t.id);
    if (tagIds.length === 0) { setRelatedDocs([]); return; }
    fetchRelatedDocs(tagIds).then(setRelatedDocs).catch(() => setRelatedDocs([]));
  }, [effectiveTagKey]);

  // ── Refresh ─────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const work = [
      reloadEnriched(),
      refetchChecklistItems(),
      sched.reload(),
    ];
    if (task?.cwd) work.push(refetchTaskGitStatus());
    await Promise.all(work);
  }, [reloadEnriched, refetchChecklistItems, refetchTaskGitStatus, sched.reload, task?.cwd]);

  return {
    // Enrichment
    enrichedWIs,
    enrichedPRs,
    reloadEnriched,
    // Schedules
    sched,
    schedDetail,
    // Notes
    notes,
    // Checklist items
    checklistItems,
    checklistItemsReady,
    checklistLoaded,
    createChecklistItemMutation,
    onChecklistItemUpdate,
    onChecklistItemDelete,
    newChecklistItemText,
    setNewChecklistItemText,
    // Git status
    taskGitStatus,
    // Sessions
    linkedSessions,
    // Tags
    taskOwnTags,
    taskGroup,
    groupTags,
    inheritedTagIds,
    effectiveTags,
    // Docs
    relatedDocs,
    // Actions
    refresh,
  };
}
