import { useState } from "react";
import type { FocusActionPromotionResult, FocusObject, FocusPromotionInput, Task } from "../api";
import FocusDialog from "./FocusDialog";
import FocusEvidenceValidity from "./FocusEvidenceValidity";
import { DS, cx } from "../design/tokens";


interface FocusPromotionDialogProps {
  object: FocusObject;
  tasks: Task[];
  pending: boolean;
  error: string | null;
  nowMs?: number;
  result: FocusActionPromotionResult | null;
  onClose: () => void;
  onReload: () => void;
  onSubmit: (input: FocusPromotionInput) => void;
  onSelectTask: (id: string, options?: { checklistItemId?: string }) => void;
  onInspectAction: (id: string) => void;
}

export default function FocusPromotionDialog({ object, tasks, pending, error, result, nowMs, onClose, onReload, onSubmit, onSelectTask, onInspectAction }: FocusPromotionDialogProps) {
  const existing = object.linkedActions.find((link) => !link.action.done)?.action;
  const visibleTasks = tasks.filter((task) => task.status === "active" && !task.muted);
  const defaultDestination = existing
    ? existing.taskId === null && !existing.orphanedAt ? "__global__"
      : visibleTasks.some((task) => task.id === existing.taskId) ? existing.taskId! : ""
    : object.taskState === "active" && visibleTasks.some((task) => task.id === object.taskId) ? object.taskId! : "";
  const [destination, setDestination] = useState(defaultDestination);
  const [text, setText] = useState(existing?.text ?? object.title);
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const destinationValid = destination === "__global__" || visibleTasks.some((task) => task.id === destination);
  const moving = Boolean(existing && destinationValid && (destination === "__global__" ? null : destination) !== existing.taskId);
  const destinationLabel = (taskId: string | null) => taskId ? tasks.find((task) => task.id === taskId)?.title ?? taskId : "Global Actions";
  const currentDestinationLabel = existing?.orphanedAt ? "Removed task (not Global Actions)" : destinationLabel(existing?.taskId ?? null);

  return (
    <FocusDialog title="Hand off / Create Action" description="Accept executable work in a visible destination. Handoff leaves the source unresolved." pending={pending} onClose={onClose}>
      {result ? (
        <div className="space-y-4">
          <div role="status" className={cx(DS.notice.surface, "p-3 text-sm text-text-primary")}>
            <p className="font-semibold">{result.created ? "Action created" : "Linked existing Action"}</p>
            <p className="mt-1 break-words">{result.action.text}</p>
            <p className="mt-2">Work is {result.action.done ? "complete" : "open"}. The source is {result.object.lifecycle.replaceAll("_", " ")}, not resolved by this handoff.</p>
            {!result.created && text.trim() !== result.action.text && <p className="mt-2">The existing Action text was preserved. Edit that Action in its destination if needed.</p>}
            <p className="mt-2">Destination: {result.action.taskId ? tasks.find((task) => task.id === result.action.taskId)?.title ?? result.action.taskId : "Global Actions"}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)} onClick={() => {
              if (result.action.taskId) onSelectTask(result.action.taskId, { checklistItemId: result.action.id });
              else onInspectAction(result.action.id);
              onClose();
            }}>Open Action</button>
            <button type="button" className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary)} onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (destinationValid && text.trim() && (!moving || moveConfirmed)) onSubmit({ text: text.trim(), taskId: destination === "__global__" ? null : destination, expectedActivationId: object.activationId });
        }}>
          <p className="break-words text-sm font-medium text-text-primary">Source: {object.title}</p>
          <p className="break-all text-xs text-text-faint">Episode: {object.activationId}</p>
          {object.objectType === "decision" && <FocusEvidenceValidity details={object.details} nowMs={nowMs} materialOnly />}
          {object.taskState !== "active" && <p className="text-sm text-warning">Source context: {object.taskState}. Choose an active task or explicitly select Global Actions; nothing will be placed in hidden work.</p>}
          {existing && <div className="space-y-1 text-sm text-text-muted">
            <p>An open Action already exists. It will be linked, not duplicated or renamed. Changing the destination moves that existing Action.</p>
            <p>Current Action destination: {currentDestinationLabel}.</p>
          </div>}
          <label className="block space-y-1.5 text-sm text-text-secondary">
            <span>Executable Action text (required)</span>
            {!existing && <span className="block text-xs text-text-muted">State what to do and how to know it is complete, rather than copying an unresolved question.</span>}
            <textarea required value={text} readOnly={Boolean(existing)} disabled={pending} onChange={(event) => setText(event.target.value)}
              className={cx(DS.field.input, DS.field.textarea, DS.focus, "min-h-28")} />
          </label>
          <label className="block space-y-1.5 text-sm text-text-secondary">
            <span>Destination (required)</span>
            <select required value={destination} disabled={pending} onChange={(event) => { setDestination(event.target.value); setMoveConfirmed(false); }}
              className={cx(DS.field.input, DS.field.inputSize.md, DS.focus, "min-h-11 min-w-0")}>
              <option value="">Choose a visible destination</option>
              <option value="__global__">Global Actions (explicit)</option>
              {visibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
          </label>
          {moving && existing && <label className="flex min-h-11 items-start gap-2 rounded-lg border border-warning/25 p-3 text-sm text-warning">
            <input type="checkbox" className="mt-1" checked={moveConfirmed} disabled={pending} onChange={(event) => setMoveConfirmed(event.target.checked)} />
            <span>Move this existing Action from {currentDestinationLabel} to {destinationLabel(destination === "__global__" ? null : destination)}. I confirm this destination change.</span>
          </label>}
          {error && <div role="alert" className="text-sm text-error">{error}<button type="button" disabled={pending} onClick={onReload} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "ml-2 underline")}>Reload item</button></div>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={pending} onClick={onClose} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)}>Cancel</button>
            <button type="submit" disabled={pending || !destinationValid || !text.trim() || (moving && !moveConfirmed)} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary, "disabled:opacity-50")}>
              {pending ? "Saving..." : existing ? "Link existing Action" : "Create Action"}
            </button>
          </div>
        </form>
      )}
    </FocusDialog>
  );
}
