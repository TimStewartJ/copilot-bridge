import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { patchTask, type TaskPatch } from "../api";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { outcomePatches, OUTCOME_DONE, setAsidePatches, type TaskOutcome } from "../lib/task-state-ui";
import { claimTaskCompletionFeedback } from "../lib/task-completion-feedback";

export interface OutcomeReceipt { message: string; undo: Array<{ id: string; patch: TaskPatch }> }

/** Applies quiet-task outcomes through the normal task PATCH, keeping an exact undo of the prior values. */
export function useTaskOutcomes() {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<OutcomeReceipt | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: ["tasks"] }),
      client.invalidateQueries({ queryKey: ["task"] })]);
  }, [client]);

  const apply = useCallback(async (rows: TaskOverviewRow[], outcome: TaskOutcome, revisitAt?: string) => {
    if (!rows.length) return;
    setPending(true); setError("");
    const undo: OutcomeReceipt["undo"] = [];
    try {
      for (const row of rows) {
        const patches = outcome === "set_aside" ? setAsidePatches(row, revisitAt) : outcomePatches(row, outcome);
        // This hook shows its own receipt with a full undo; keep the global toast from offering a partial one.
        if (outcome === "finished") claimTaskCompletionFeedback([row.id]);
        await patchTask(row.id, patches.apply);
        undo.push({ id: row.id, patch: patches.undo });
      }
      const subject = rows.length === 1 ? `“${rows[0].title}”` : `${rows.length} tasks`;
      setReceipt({ message: `${OUTCOME_DONE[outcome]}: ${subject}`, undo });
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : String(cause)}${undo.length ? ` (${undo.length} of ${rows.length} changed)` : ""}`);
      if (undo.length) setReceipt({ message: `${OUTCOME_DONE[outcome]}: ${undo.length} of ${rows.length} tasks`, undo });
    } finally {
      setPending(false);
      await refresh();
    }
  }, [refresh]);

  const undoLast = useCallback(async () => {
    if (!receipt) return;
    setPending(true); setError("");
    try {
      for (const entry of receipt.undo) await patchTask(entry.id, entry.patch);
      setReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
      await refresh();
    }
  }, [receipt, refresh]);

  return { apply, undoLast, pending, receipt, error, dismiss: () => { setReceipt(null); setError(""); } };
}
