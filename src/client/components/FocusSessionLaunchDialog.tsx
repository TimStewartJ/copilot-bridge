import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchFocusLaunchReceipt, fetchFocusObject, FocusLaunchError, launchFocusSession, startFocusSessionLaunch,
  type FocusLaunchIdentity, type FocusLaunchRequest, type FocusLaunchSource, type FocusObject, type FocusSessionLaunch,
} from "../api";
import { buildFocusItemChatContext, buildFocusItemChatPrompt, resolveFocusActionTaskId } from "../focus-item-helpers";
import { isFocusOpen } from "../focus-view-model";
import { rememberFocusLaunchReceipt, useFocusLaunchReceiptQuery, useFocusMutation } from "../hooks/queries/useFocus";
import { queryKeys } from "../queryClient";
import FocusActionDialog, { type FocusActionSubmitMode } from "./FocusActionDialog";
import FocusDialog from "./FocusDialog";
import type { FocusInteractionProps } from "./FocusInteractions";
import { UI } from "./shared/design-system";

type LaunchOperation = { input: FocusLaunchRequest } | { receiptId: string };
const BUTTON = `${UI.button.secondary} min-h-11 text-xs`;

export function focusLaunchReady(receipt: FocusSessionLaunch): boolean {
  return receipt.status === "ready" && receipt.sessionId !== null && receipt.linkedAt !== null && receipt.promptStatus === "sent";
}

function matchesIdentity(receipt: FocusSessionLaunch, identity: FocusLaunchIdentity): boolean {
  return receipt.objectId === identity.objectId && receipt.activationId === identity.activationId && receipt.source === identity.source;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export default function FocusSessionLaunchDialog({
  object, source, tasks, taskGroups, onSelectSession, onChanged, onClose,
}: Pick<FocusInteractionProps, "tasks" | "taskGroups" | "onSelectSession" | "onChanged"> & {
  object: FocusObject; source: FocusLaunchSource; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const identity = useMemo<FocusLaunchIdentity>(() => ({ objectId: object.id, activationId: object.activationId, source }), [object.id, object.activationId, source]);
  const lookup = useFocusLaunchReceiptQuery(identity);
  const [reviewObject, setReviewObject] = useState(object);
  const [prompt, setPrompt] = useState(source === "launch_prompt" ? object.launchPrompt?.prompt ?? "" : "");
  const defaultTaskId = source === "launch_prompt" ? resolveFocusActionTaskId(object) : object.taskId;
  const explicitOverride = source === "launch_prompt" && object.launchPrompt && Object.prototype.hasOwnProperty.call(object.launchPrompt, "taskId");
  const [destination, setDestination] = useState(() => explicitOverride || object.taskState === "active" || object.taskState === "global"
    ? defaultTaskId ?? "__global__" : "");
  const [lastReceipt, setLastReceipt] = useState<FocusSessionLaunch | null>(null);
  const [working, setWorking] = useState(false);
  const [mode, setMode] = useState<FocusActionSubmitMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const operationRef = useRef(false);
  const mutation = useFocusMutation(`launch:${object.id}:${object.activationId}:${source}`, (operation: LaunchOperation) =>
    "receiptId" in operation ? startFocusSessionLaunch(operation.receiptId) : launchFocusSession(operation.input), true);
  const receipt = lookup.data && (!lastReceipt || lookup.data.version >= lastReceipt.version) ? lookup.data : lastReceipt;
  const receiptMatches = !receipt || matchesIdentity(receipt, identity);
  const visibleTasks = tasks.filter((task) => task.status === "active" && !task.muted);
  const destinationValid = destination === "__global__" || visibleTasks.some((task) => task.id === destination);
  const taskId = destination === "__global__" ? null : destination;
  const task = tasks.find((candidate) => candidate.id === taskId);
  const group = task?.groupId ? taskGroups.find((candidate) => candidate.id === task.groupId) : undefined;
  const promptUncertain = receipt?.promptStatus === "unknown" || receipt?.promptStatus === "sending";
  const canResume = receipt && receiptMatches && receipt.status !== "ready" && receipt.status !== "superseded" && !promptUncertain;

  const remember = (next: FocusSessionLaunch) => {
    if (!matchesIdentity(next, identity)) throw new Error("The launch receipt does not match this object, episode and source. No session was opened.");
    rememberFocusLaunchReceipt(queryClient, next);
    setLastReceipt((previous) => previous && previous.version > next.version ? previous : next);
  };
  const openSession = () => {
    if (!receipt || !receiptMatches || !receipt.sessionId) return;
    onSelectSession(receipt.sessionId, receipt.taskId ?? undefined);
    onClose();
  };

  useEffect(() => {
    if (working || mode !== "foreground" || !receipt || !receiptMatches || !focusLaunchReady(receipt)) return;
    setMode(null);
    onSelectSession(receipt.sessionId!, receipt.taskId ?? undefined);
    onClose();
  }, [working, mode, receipt, receiptMatches, onSelectSession, onClose]);

  const recover = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setWorking(true);
    setError(null);
    try {
      const result = await lookup.refetch({ throwOnError: true });
      if (result.data) remember(result.data);
      setRecoveryBlocked(false);
    } catch (failure) {
      setError(`Receipt recovery failed: ${errorText(failure)}. Do not start an ordinary session as a fallback.`);
      setRecoveryBlocked(true);
    } finally {
      setWorking(false);
      operationRef.current = false;
    }
  };
  const reloadReview = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setWorking(true);
    try {
      const latest = await fetchFocusObject(object.objectType, object.id);
      if (latest.activationId !== identity.activationId) throw new Error("This episode was superseded. Close this preview and inspect the current episode; the old launch identity will not be retargeted.");
      setReviewObject(latest);
      if (source === "launch_prompt") setPrompt(latest.launchPrompt?.prompt ?? "");
      setError(null);
    } catch (failure) { setError(errorText(failure)); }
    finally { setWorking(false); operationRef.current = false; }
  };
  const start = async (nextMode: FocusActionSubmitMode) => {
    if (operationRef.current || !receiptMatches) return;
    operationRef.current = true;
    setWorking(true);
    setMode(nextMode);
    setError(null);
    try {
      let existing = receipt;
      const approvedPrompt = source === "discussion" ? buildFocusItemChatPrompt(buildFocusItemChatContext(reviewObject), prompt) : prompt.trim();
      if (!existing) {
        if (recoveryBlocked || lookup.data === undefined) throw new Error("Recover the episode's launch receipt before starting.");
        if (!destinationValid || !approvedPrompt) throw new Error("Choose a visible destination and a non-empty prompt.");
        existing = await fetchFocusLaunchReceipt(identity);
        if (existing) {
          remember(existing);
          if (existing.prompt !== approvedPrompt || existing.taskId !== taskId) {
            throw new Error("Another client already prepared this episode's launch with a different frozen prompt or destination. Your edits were not submitted; inspect the existing receipt.");
          }
        }
      }
      if (existing) {
        if (!matchesIdentity(existing, identity)) throw new Error("Launch identity changed. No request was sent.");
        remember(existing);
        if (focusLaunchReady(existing)) return;
        if (existing.status === "superseded") throw new Error("This receipt belongs to an episode that can no longer start work.");
        if (existing.promptStatus === "unknown" || existing.promptStatus === "sending") {
          throw new Error("Initial prompt delivery is unconfirmed. Inspect the existing session; do not replay the prompt.");
        }
        const result = await mutation.mutateAsync({ receiptId: existing.id });
        remember(result.receipt);
      } else {
        const latest = await fetchFocusObject(object.objectType, object.id);
        if (latest.activationId !== identity.activationId || latest.details.contentFingerprint !== reviewObject.details.contentFingerprint) {
          throw new Error("This item or episode changed. Reload and review before starting.");
        }
        if (!isFocusOpen(latest.lifecycle)) throw new Error("This episode is no longer open. Existing receipts and sessions remain inspectable; opening this record will not reactivate it.");
        if (source === "launch_prompt" && !latest.launchPrompt) throw new Error("The launch prompt is no longer available.");
        await queryClient.cancelQueries({ queryKey: queryKeys.focusLaunchReceipt(identity) });
        const result = await mutation.mutateAsync({ input: { ...identity, taskId, prompt: approvedPrompt } });
        remember(result.receipt);
      }
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await onChanged();
    } catch (failure) {
      setMode(null);
      if (failure instanceof FocusLaunchError && matchesIdentity(failure.receipt, identity)) {
        remember(failure.receipt);
        setError(failure.message);
      } else {
        let recoveryError: string | null = null;
        try {
          const recovered = await fetchFocusLaunchReceipt(identity);
          if (recovered) {
            remember(recovered);
            setRecoveryBlocked(false);
          } else if (lastReceipt || queryClient.getQueryData(queryKeys.focusLaunchReceipt(identity))) {
            recoveryError = "The server did not return the previously recorded receipt; its cached identity was retained for inspection";
            setRecoveryBlocked(true);
          } else {
            queryClient.setQueryData(queryKeys.focusLaunchReceipt(identity), null);
            setRecoveryBlocked(false);
          }
        } catch (readError) {
          recoveryError = errorText(readError);
          setRecoveryBlocked(true);
        }
        setError(`${errorText(failure)}${recoveryError ? ` Receipt recovery is unavailable: ${recoveryError}. No ordinary-session fallback will run.` : ""}`);
      }
    } finally {
      setWorking(false);
      operationRef.current = false;
    }
  };

  if (receipt) {
    const label = receipt.status === "ready" && focusLaunchReady(receipt) ? "Session ready"
      : receipt.status === "prepared" ? "Launch prepared; not started"
        : receipt.status === "creating" ? "Session creation pending"
          : receipt.status === "created" ? "Session created; launch not yet ready"
            : receipt.status === "superseded" ? "Launch episode superseded or closed"
              : receipt.status === "unknown" ? "Launch outcome unknown" : "Launch needs recovery";
    return <FocusDialog title="Episode-bound session launch" description="This durable receipt is shared across reloads and clients. The destination, prompt and session options are frozen." pending={working} onClose={onClose}>
      <div className="space-y-3 text-sm text-text-secondary">
        <p className="font-semibold">{receipt.objectTitle}</p>
        <p role="status">{label}. Session launch records acknowledgement, not an Action handoff or resolution.</p>
        {object.lifecycle === "handed_off" && <p className="text-xs text-text-muted">The existing handoff belongs to previously accepted Action work; launching this session does not create or change it.</p>}
        {!receiptMatches && <p role="alert" className="text-error">Receipt identity does not match this episode. No mutation or navigation is available.</p>}
        <p className="break-all text-xs text-text-muted">Receipt: {receipt.id} · Episode: {receipt.activationId} · Source: {receipt.source}</p>
        <p>Frozen destination: {receipt.taskTitle ?? (receipt.taskId ? receipt.taskId : "Standalone / Global sessions")}</p>
        <p className="text-xs">Session options: {Object.entries(receipt.creationOptions).map(([key, value]) => `${key}: ${value}`).join("; ") || "Server defaults (not specified in receipt)"}</p>
        <details open={Boolean(canResume)}><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium">Frozen approved prompt</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">{receipt.prompt}</pre></details>
        <p className="text-xs">Initial prompt: {receipt.promptStatus}. The server sends it; the client will not send it again.</p>
        {!receipt.sessionId && <p className="break-all text-xs text-warning">Expected session ID (not yet confirmed): {receipt.expectedSessionId}</p>}
        {promptUncertain && <p className="text-xs text-warning">Prompt delivery is unconfirmed. Inspect the existing session; resending is not offered.</p>}
        {(error || receipt.error || lookup.error) && <p role="alert" className="text-sm text-error">{error ?? receipt.error ?? lookup.error?.message}</p>}
        <div className="flex flex-wrap gap-2">
          {receiptMatches && receipt.sessionId && <button type="button" onClick={openSession} disabled={working} className={BUTTON}>Open existing session</button>}
          {canResume && <button type="button" disabled={working} onClick={() => void start("foreground")} className={`${UI.button.primary} min-h-11 text-xs`}>Resume / reconcile existing launch</button>}
          <button type="button" disabled={working || lookup.isFetching} onClick={() => void recover()} className={BUTTON}>Check launch status</button>
          <button type="button" disabled={working} onClick={onClose} className={BUTTON}>Close</button>
        </div>
      </div>
    </FocusDialog>;
  }
  if (lookup.data === undefined || recoveryBlocked) {
    return <FocusDialog title="Recover episode launch" description="Checking the server for a launch already prepared by this or another client. This read does not create or send anything." pending={working} onClose={onClose}>
      {lookup.isLoading ? <p role="status" className="text-sm text-text-muted">Checking saved launch receipts...</p> : <p role="alert" className="text-sm text-error">{error ?? lookup.error?.message ?? "Launch receipt state is unavailable."}</p>}
      <button type="button" className={`${BUTTON} mt-3`} disabled={working || lookup.isFetching} onClick={() => void recover()}>Recover launch receipt</button>
    </FocusDialog>;
  }
  return <FocusActionDialog
    cardTitle={reviewObject.title} actionLabel={source === "launch_prompt" ? reviewObject.launchPrompt?.label : "Discuss item"}
    description="Start this episode's durable launch once. The server creates, links and sends the approved prompt. Launching records acknowledgement, not an Action handoff or resolution."
    taskId={taskId || null} taskPreview={task ? { id: task.id, title: task.title, group: group ? { name: group.name, color: group.color } : null } : null}
    prompt={prompt} context={source === "discussion" ? buildFocusItemChatContext(reviewObject) : undefined}
    allowEmptyPrompt={source === "discussion"} promptLabel={source === "discussion" ? "Message to send" : "Prompt to send"}
    error={error} submitting={working} submitMode={mode} startDisabled={!destinationValid || !isFocusOpen(reviewObject.lifecycle)}
    onPromptChange={setPrompt} onClose={onClose} onStart={() => void start("foreground")} onStartInBackground={() => void start("background")} onReload={() => void reloadReview()}
    destinationControl={<label className="block space-y-1 text-xs text-text-muted">
      <span>Session destination (required)</span>
      <select value={destination} disabled={working} onChange={(event) => setDestination(event.target.value)} className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-surface p-2 text-sm text-text-primary">
        <option value="">Choose a visible destination</option><option value="__global__">Standalone / Global sessions (explicit)</option>
        {visibleTasks.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
      </select>
      {!isFocusOpen(reviewObject.lifecycle) && <span className="block text-warning">This episode is closed. It was not reactivated by opening this preview.</span>}
    </label>}
  />;
}
