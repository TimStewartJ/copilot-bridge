import { useState, useEffect, useCallback } from "react";
import type { Task, TaskGroup, Session, RelatedDoc } from "../api";
import { fetchRelatedDocs } from "../api";
import { useTaskEnrichment } from "./useTaskEnrichment";
import { useTaskSchedules } from "./useTaskSchedules";
import { useScheduleDetail } from "./useScheduleDetail";
import { useNotesSheet } from "./useNotesSheet";
import { useTaskTodosQuery, useCreateTodoMutation, useTodoCacheUpdaters } from "./queries/useTodos";

/**
 * Consolidates shared setup for TaskPanel and TaskDashboard:
 * enrichment, schedules, schedule detail sheet, notes sheet,
 * todos, linked sessions, effective tags, and related docs.
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

  // ── Todos ───────────────────────────────────────────────────
  const { data: todos = [], refetch: refetchTodos } = useTaskTodosQuery(task?.id);
  const createTodoMutation = useCreateTodoMutation(task?.id);
  const { onUpdate: onTodoUpdate, onDelete: onTodoDelete } = useTodoCacheUpdaters(task?.id);
  const [newTodoText, setNewTodoText] = useState("");

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
    await Promise.all([
      reloadEnriched(),
      refetchTodos(),
      sched.reload(),
    ]);
  }, [reloadEnriched, refetchTodos, sched.reload]);

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
    // Todos
    todos,
    createTodoMutation,
    onTodoUpdate,
    onTodoDelete,
    newTodoText,
    setNewTodoText,
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
