import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task, TaskGroup, Session } from "../api";
import { fetchRelatedDocs } from "../api";
import { queryKeys } from "../queryClient";
import { isChecklistItemsReadyForFocus } from "../task-detail-focus";
import { useTaskEnrichment } from "./useTaskEnrichment";
import { useTaskTriggers } from "./useTaskTriggers";
import { useTriggerDetail } from "./useTriggerDetail";
import { useNotesSheet } from "./useNotesSheet";
import {
  useTaskChecklistItemsQuery,
  useCreateChecklistItemMutation,
  useChecklistItemCacheUpdaters,
} from "./queries/useChecklistItems";
import { useTaskGitStatusQuery } from "./queries/useTaskGitStatus";
import { isSessionLinkedToTask } from "../lib/task-session-links";

/** Setup shared by TaskPanel and TaskDashboard. */
export function useTaskWorkspace(
  task: Task | undefined,
  taskGroups: TaskGroup[],
  sessions: Session[],
) {
  // ── Enrichment ──────────────────────────────────────────────
  const { enrichedWIs, enrichedPRs, reload: reloadEnriched } = useTaskEnrichment(
    task?.id, task?.workItems.length ?? 0, task?.pullRequests.length ?? 0,
  );

  // ── Triggers ────────────────────────────────────────────────
  const triggers = useTaskTriggers(task?.id);
  const triggerDetail = useTriggerDetail();

  // ── Notes ───────────────────────────────────────────────────
  const notes = useNotesSheet(task?.id);
  const instructionsSheet = useNotesSheet(task?.id, "instructions");
  const historySheet = useNotesSheet(task?.id, "history");

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
  const linkedSessions = task ? sessions.filter((s) => isSessionLinkedToTask(task, s)) : [];

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
  const effectiveTagIds = effectiveTags.map((t) => t.id);
  const relatedDocsQuery = useQuery({
    queryKey: queryKeys.relatedDocs(effectiveTagIds),
    queryFn: () => fetchRelatedDocs(effectiveTagIds),
    enabled: effectiveTagIds.length > 0,
  });
  const relatedDocs = effectiveTagIds.length > 0 ? relatedDocsQuery.data ?? [] : [];
  const relatedDocsSettled = effectiveTagIds.length === 0 || !relatedDocsQuery.isPending;

  // ── Refresh ─────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const work: Array<Promise<unknown> | void> = [
      reloadEnriched(),
      refetchChecklistItems(),
      triggers.reload(),
    ];
    if (effectiveTagIds.length > 0) work.push(relatedDocsQuery.refetch());
    if (task?.cwd) work.push(refetchTaskGitStatus());
    await Promise.all(work);
  }, [reloadEnriched, refetchChecklistItems, refetchTaskGitStatus, triggers.reload, relatedDocsQuery.refetch, effectiveTagIds.length, task?.cwd]);

  return {
    // Enrichment
    enrichedWIs,
    enrichedPRs,
    reloadEnriched,
    // Triggers
    triggers,
    triggerDetail,
    // Notes
    notes,
    instructionsSheet,
    historySheet,
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
    relatedDocsSettled,
    // Actions
    refresh,
  };
}
