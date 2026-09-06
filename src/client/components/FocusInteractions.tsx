import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import {
  deleteFocusObject, fetchFocusObject, promoteFocusObjectToAction, reactivateFocusObject, transitionFocusObject,
  type FocusActionPromotionResult, type FocusHistoryFilter, type FocusLaunchSource, type FocusObject,
  type FocusPromotionInput, type FocusSnapshot, type Task, type TaskGroup,
} from "../api";
import { useFocusMutation } from "../hooks/queries/useFocus";
import { queryKeys } from "../queryClient";
import FocusDialog from "./FocusDialog";
import FocusLifecycleDialog, { type FocusLifecycleIntent } from "./FocusLifecycleDialog";
import FocusPromotionDialog from "./FocusPromotionDialog";
import FocusSessionLaunchDialog from "./FocusSessionLaunchDialog";
import { UI } from "./shared/design-system";

export interface FocusInteractionProps {
  tasks: Task[];
  taskGroups: TaskGroup[];
  onSelectTask: (id: string, options?: { checklistItemId?: string }) => void;
  onSelectSession: (id: string, taskId?: string) => void;
  onStartPromptSession?: (prompt: string, taskId?: string, options?: { navigateOnError?: boolean }) => Promise<string>;
  onChanged: () => Promise<unknown>;
  onInspectHistory?: (id: string) => void;
  onInspectHistoryFilter?: (filter: FocusHistoryFilter) => void;
}

type Dialog =
  | { kind: "lifecycle"; object: FocusObject; intent: FocusLifecycleIntent }
  | { kind: "promotion"; object: FocusObject; result: FocusActionPromotionResult | null }
  | { kind: "session"; object: FocusObject; source: FocusLaunchSource }
  | { kind: "delete"; object: FocusObject };

interface FocusInteractions extends FocusInteractionProps {
  snapshot?: FocusSnapshot;
  nowMs: number;
  pending: boolean;
  lifecycle: (object: FocusObject, intent: FocusLifecycleIntent | "acknowledged") => void;
  promote: (object: FocusObject) => void;
  launch: (object: FocusObject, source: FocusLaunchSource) => void;
  remove: (object: FocusObject) => void;
}

const Context = createContext<FocusInteractions | null>(null);
export function useFocusInteractions() { return useContext(Context); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function FocusInteractionProvider({
  children, snapshot, nowMs = Date.now(), ...props
}: FocusInteractionProps & { children?: ReactNode; snapshot?: FocusSnapshot; nowMs?: number }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mutation = useFocusMutation("interaction", (operation: () => Promise<void>) => operation(), true);
  const pending = useIsMutating({ mutationKey: queryKeys.focusMutation("interaction") }) > 0;
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current || queryClient.isMutating({ mutationKey: queryKeys.focusMutation("interaction") })) return;
    busyRef.current = true;
    setError(null);
    setNotice(null);
    try {
      await mutation.mutateAsync(operation);
      try { await props.onChanged(); }
      catch (failure) { setError(`Change saved, but Focus could not refresh: ${errorText(failure)}`); }
    } catch (failure) { setError(errorText(failure)); }
    finally { busyRef.current = false; }
  };
  const rememberObject = (object: FocusObject) => queryClient.setQueryData(queryKeys.focusObject(object.objectType, object.id), object);
  const revalidate = async (object: FocusObject) => {
    const latest = await fetchFocusObject(object.objectType, object.id);
    rememberObject(latest);
    if (latest.activationId !== object.activationId || latest.details.contentFingerprint !== object.details.contentFingerprint) {
      throw new Error("This item or episode changed. Reload it and review the current state before continuing.");
    }
    return latest;
  };
  const close = () => { if (!busyRef.current) { setDialog(null); setError(null); } };
  const open = (next: Dialog) => {
    if (busyRef.current || pending) return;
    setError(null);
    setNotice(null);
    setDialog(next);
  };
  const reload = () => {
    if (!dialog) return;
    const previous = dialog;
    void run(async () => {
      const latest = await fetchFocusObject(previous.object.objectType, previous.object.id);
      rememberObject(latest);
      setDialog({ ...previous, object: latest });
      setNotice("Current item loaded. Review it before submitting.");
    });
  };
  const lifecycle = (object: FocusObject, intent: FocusLifecycleIntent | "acknowledged") => {
    if (intent !== "acknowledged") { open({ kind: "lifecycle", object, intent }); return; }
    void run(async () => {
      await revalidate(object);
      rememberObject(await transitionFocusObject(object.objectType, object.id, { lifecycle: "acknowledged", expectedActivationId: object.activationId }));
      setNotice(`Acknowledged "${object.title}". The source remains open.`);
    });
  };
  const submitLifecycle = (reason: string, outcome: string) => {
    if (dialog?.kind !== "lifecycle") return;
    const { object, intent } = dialog;
    void run(async () => {
      await revalidate(object);
      const result = intent === "reactivate"
        ? await reactivateFocusObject(object.objectType, object.id, { episodeReason: reason, expectedActivationId: object.activationId })
        : await transitionFocusObject(object.objectType, object.id, {
          lifecycle: intent, lifecycleReason: reason, ...(outcome ? { outcome } : {}), expectedActivationId: object.activationId,
        });
      rememberObject(result);
      setDialog(null);
      setNotice(intent === "reactivate" ? `New episode opened for "${object.title}".` : `Recorded ${result.lifecycle.replaceAll("_", " ")} for "${object.title}". Linked work was not changed.`);
    });
  };
  const submitPromotion = (input: FocusPromotionInput) => {
    if (dialog?.kind !== "promotion") return;
    const { object } = dialog;
    void run(async () => {
      const latest = await revalidate(object);
      const previousAction = object.linkedActions.find((link) => !link.action.done)?.action;
      const currentAction = latest.linkedActions.find((link) => !link.action.done)?.action;
      if (previousAction?.id !== currentAction?.id || previousAction?.taskId !== currentAction?.taskId || previousAction?.text !== currentAction?.text) {
        throw new Error("The linked Action or its destination changed. Reload and review before handing off.");
      }
      const result = await promoteFocusObjectToAction(object.objectType, object.id, input);
      rememberObject(result.object);
      setDialog({ kind: "promotion", object, result });
    });
  };
  const value: FocusInteractions = {
    ...props, snapshot, nowMs, pending, lifecycle,
    launch: (object, source) => open({ kind: "session", object, source }),
    promote: (object) => open({ kind: "promotion", object, result: null }),
    remove: (object) => open({ kind: "delete", object }),
  };
  return <Context.Provider value={value}>
    {(notice || (error && !dialog)) && <div role={error ? "alert" : "status"} className={`mb-4 rounded-xl border p-3 text-sm ${error ? "border-error/25 text-error" : "border-info-border text-text-secondary"}`}>{error ?? notice}</div>}
    {children}
    {dialog?.kind === "lifecycle" && <FocusLifecycleDialog key={`${dialog.object.activationId}:${dialog.object.details.contentFingerprint}:${dialog.intent}`}
      object={dialog.object} intent={dialog.intent} nowMs={nowMs} pending={pending} error={error} onClose={close} onReload={reload} onSubmit={submitLifecycle} />}
    {dialog?.kind === "promotion" && <FocusPromotionDialog key={`${dialog.object.activationId}:${dialog.object.details.contentFingerprint}`}
      object={dialog.object} tasks={props.tasks} nowMs={nowMs} pending={pending} error={error} result={dialog.result} onClose={close} onReload={reload} onSubmit={submitPromotion}
      onSelectTask={props.onSelectTask} onInspectAction={props.onInspectHistory ?? (() => document.getElementById("focus-actions")?.scrollIntoView())} />}
    {dialog?.kind === "session" && <FocusSessionLaunchDialog key={`${dialog.object.id}:${dialog.object.activationId}:${dialog.source}`}
      object={dialog.object} source={dialog.source} tasks={props.tasks} taskGroups={props.taskGroups}
      onSelectSession={props.onSelectSession} onChanged={props.onChanged} onClose={close} />}
    {dialog?.kind === "delete" && <FocusDialog title="Delete record" description="The record will be deleted, not resolved. Its transition history remains available." pending={pending} onClose={close}>
      <p className="mb-4 break-words text-sm text-text-primary">{dialog.object.title}</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={pending} className={`${UI.button.secondary} min-h-11`} onClick={close}>Cancel</button>
        <button type="button" disabled={pending} className={`${UI.button.secondary} min-h-11 text-error`} onClick={() => {
          const object = dialog.object;
          void run(async () => { await revalidate(object); await deleteFocusObject(object.objectType, object.id); setDialog(null); setNotice("Record deleted. History is retained."); });
        }}>Delete record</button>
      </div>
    </FocusDialog>}
  </Context.Provider>;
}
