import { DEFAULT_SEND_MODE, encodeSendMode, type SendMode } from "../shared/send-mode.js";
import type { AppContext } from "./app-context.js";
import { isBackendUnavailableError } from "./backend-availability.js";
import { queueChatMessageDelivery } from "./chat-message-outbox.js";
import { CHAT_MESSAGE_DELIVERY_ID_PREFIX } from "./deferred-prompt-store.js";
import { PROMPT_DELIVERY_ABORTED_MESSAGE } from "./prompt-delivery-errors.js";
import type { StartWorkAttachment } from "./session-attachment-routing.js";
import { parseSlashCommandPrompt } from "./slash-command.js";

/** How long a message sent right after Stop waits for the stopped run to let go of the chat. */
export const SETTLING_SESSION_WAIT_MS = 45_000;

/** A message id the browser reused with a different message. */
export class ChatMessageIdConflictError extends Error {
  constructor() {
    super("This message id was already used for a different message");
    this.name = "ChatMessageIdConflictError";
  }
}

/** Browser messages being admitted, by session and id, so a repeat gets the first's outcome. */
type Admission = { prompt: string; mode?: SendMode; outcome: Promise<ChatMessageDelivery> };
const admittingMessages = new Map<string, Map<string, Admission>>();

function assertSameMinimums(first: SendMode | undefined, next: SendMode | undefined): void {
  if ((typeof first === "object" || typeof next === "object")
    && encodeSendMode(first ?? DEFAULT_SEND_MODE) !== encodeSendMode(next ?? DEFAULT_SEND_MODE)) {
    throw new ChatMessageIdConflictError();
  }
}

export interface ChatMessageDeliveryOptions {
  attachments?: StartWorkAttachment[];
  mode?: SendMode;
  clientMessageId?: string;
  waitForDelivery?: boolean;
  queue?: "none" | "on_failure" | "before_send";
  signal?: AbortSignal;
  /** A person's message: kept as not sent if its run ends first; sent once per clientMessageId. */
  keepUndelivered?: boolean;
  /** Typed while the agent waited on a question: skip the question so the message arrives now. */
  skipOpenQuestions?: boolean;
}

export interface ChatMessageDelivery {
  /** "stopped": Stop came before the agent had it; the chat keeps it as not sent. */
  delivery: "started" | "accepted" | "steered" | "command" | "queued" | "stopped";
  deliveryId?: string;
}

export type ChatMessageDeliveryContext = Pick<AppContext,
  "sessionManager" | "sessionMetaStore" | "globalBus" | "deferredPromptStore" | "deferredPromptRunner"
> & Partial<Pick<AppContext, "chatMessageIdStore" | "unsentMessageStore" | "eventBusRegistry">>;

/** The earlier outcome for this message id, or undefined if new; throws if the id was reused. */
function findPreviousDelivery(
  ctx: ChatMessageDeliveryContext,
  sessionId: string,
  clientMessageId: string,
  prompt: string,
  mode: SendMode | undefined,
): ChatMessageDelivery | undefined {
  const sameMessage = (content: string) => {
    if (content !== prompt) throw new ChatMessageIdConflictError();
  };
  const kept = ctx.unsentMessageStore?.get(sessionId, clientMessageId);
  if (kept) assertSameMinimums(kept.mode, mode);
  const live = ctx.eventBusRegistry?.getBus(sessionId)?.findUserMessage(clientMessageId);
  if (live) {
    sameMessage(live.content);
    return { delivery: live.undelivered?.state === "stopped" ? "stopped" : "accepted" };
  }
  if (kept) {
    sameMessage(kept.content);
    return { delivery: kept.storedState === "stopped" ? "stopped" : "accepted" };
  }
  const queued = ctx.deferredPromptStore?.get(`${CHAT_MESSAGE_DELIVERY_ID_PREFIX}${clientMessageId}`);
  if (queued && queued.sessionId === sessionId) {
    assertSameMinimums(undefined, mode);
    sameMessage(queued.prompt);
    return { delivery: queued.status === "completed" ? "accepted" : "queued", deliveryId: queued.id };
  }
  if (ctx.chatMessageIdStore?.hasClientMessageId(sessionId, clientMessageId)) return { delivery: "accepted" };
  return undefined;
}

export async function sendChatMessage(
  ctx: ChatMessageDeliveryContext,
  sessionId: string,
  prompt: string,
  options: ChatMessageDeliveryOptions = {},
): Promise<ChatMessageDelivery> {
  const manager = ctx.sessionManager;
  const store = ctx.deferredPromptStore;
  const { attachments, mode, clientMessageId, waitForDelivery, signal } = options;
  const keepUndelivered = options.keepUndelivered === true && Boolean(clientMessageId);
  if (keepUndelivered && clientMessageId) {
    const admitting = admittingMessages.get(sessionId) ?? new Map<string, Admission>();
    const inFlight = admitting.get(clientMessageId);
    if (inFlight) {
      if (inFlight.prompt !== prompt) throw new ChatMessageIdConflictError();
      assertSameMinimums(inFlight.mode, mode);
      return inFlight.outcome;
    }
    const previous = findPreviousDelivery(ctx, sessionId, clientMessageId, prompt, mode);
    if (previous) return previous;
    // Held until its run starts: a repeat arriving meanwhile shares its outcome.
    const outcome = deliver();
    admitting.set(clientMessageId, { prompt, mode, outcome });
    admittingMessages.set(sessionId, admitting);
    try {
      return await outcome;
    } finally {
      admitting.delete(clientMessageId);
      if (admitting.size === 0 && admittingMessages.get(sessionId) === admitting) admittingMessages.delete(sessionId);
    }
  }
  return deliver();

  async function deliver(): Promise<ChatMessageDelivery> {
    const queuePolicy = options.queue ?? (waitForDelivery ? "none" : "on_failure");
    const canKeep = (!Array.isArray(attachments) || attachments.length === 0)
      && (mode === undefined || mode === DEFAULT_SEND_MODE)
      && !parseSlashCommandPrompt(prompt);

    function restore(): void {
      if (!ctx.sessionMetaStore.getMeta(sessionId)?.archived) return;
      ctx.sessionMetaStore.setArchived(sessionId, false);
      ctx.globalBus.emit({ type: "session:archived", sessionId, archived: false });
    }

    function queue(reason: string): ChatMessageDelivery {
      signal?.throwIfAborted();
      if (!store || !canKeep) throw new Error(reason);
      const deliveryId = queueChatMessageDelivery(store, sessionId, prompt, clientMessageId);
      try {
        restore();
      } catch (error) {
        store.cancelById(deliveryId);
        throw error;
      }
      console.log(`[chat] [${sessionId.slice(0, 8)}] Queued message until the session is free: ${reason}`);
      if (manager.getSessionHold(sessionId)) {
        const unsubscribe = manager.subscribeSessionHold(sessionId, () => {
          if (manager.getSessionHold(sessionId)) return;
          unsubscribe();
          ctx.deferredPromptRunner?.poke();
        });
      }
      ctx.deferredPromptRunner?.poke();
      return { delivery: "queued", deliveryId };
    }

    signal?.throwIfAborted();
    if (queuePolicy === "before_send") {
      const previous = clientMessageId ? store?.get(`${CHAT_MESSAGE_DELIVERY_ID_PREFIX}${clientMessageId}`) : undefined;
      if (previous) {
        if (previous.sessionId !== sessionId || previous.prompt !== prompt) {
          throw new Error("This message delivery ID already belongs to a different target or message");
        }
        if (previous.status === "failed" || previous.status === "cancelled") {
          throw new Error(`The previous queued message is ${previous.status}: ${previous.lastError ?? "not delivered"}`);
        }
        restore();
        return {
          delivery: previous.status === "completed" ? "accepted" : "queued",
          deliveryId: previous.id,
        };
      }
      // A refused SDK send may already have arrived. Native tools only queue before trying it.
      const unavailable = manager.getBackendUnavailableReason()
        ?? (manager.getSessionHold(sessionId) || (manager.isSessionBusy(sessionId) && !manager.hasRunInFlight(sessionId))
          ? "Session is held or reconnecting"
          : manager.getSessionRunState(sessionId) === "stalled"
            ? "Session is stalled"
            : manager.getSessionCapacityWait(sessionId));
      if (unavailable) return queue(unavailable);
    }
    restore();
    // Just after Stop or while loading, the chat cannot be steered or run yet; wait briefly.
    if (manager.isSessionSettling(sessionId)) {
      await manager.waitWhileSessionSettles(sessionId, SETTLING_SESSION_WAIT_MS);
      signal?.throwIfAborted();
    }
    const busyAtSend = manager.isSessionBusy(sessionId);
    try {
      if (busyAtSend) {
        if (typeof mode === "object") throw new Error("Not accepting steering with minimums. Wait for this run to finish.");
        const isCommand = Boolean(parseSlashCommandPrompt(prompt));
        // A person writing instead of answering sets the open questions aside; a command does not.
        const steerOptions = options.skipOpenQuestions && !isCommand ? { skipOpenQuestions: true } : undefined;
        if (steerOptions) {
          await manager.steerSession(sessionId, prompt, attachments, clientMessageId, steerOptions);
        } else if (clientMessageId) {
          await manager.steerSession(sessionId, prompt, attachments, clientMessageId);
        } else {
          await manager.steerSession(sessionId, prompt, attachments);
        }
        return { delivery: isCommand ? "command" : "steered" };
      }
      const launchOptions = mode || clientMessageId ? {
        ...(mode ? { mode } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(keepUndelivered ? { keepUndelivered: true } : {}),
      } : undefined;
      if (waitForDelivery) {
        try {
          await manager.startWorkAndWaitForDelivery(sessionId, prompt, attachments, launchOptions);
        } catch (error) {
          // Stopping is not a failure to deliver: the chat keeps the message, marked not sent.
          if (keepUndelivered && error instanceof Error && error.message === PROMPT_DELIVERY_ABORTED_MESSAGE) {
            return { delivery: "stopped" };
          }
          throw error;
        }
        return { delivery: "accepted" };
      }
      if (launchOptions) {
        manager.startWork(sessionId, prompt, attachments, launchOptions);
      } else {
        manager.startWork(sessionId, prompt, attachments);
      }
      return { delivery: "started" };
    } catch (error) {
      if (
        queuePolicy === "on_failure" && store && canKeep
        && (busyAtSend || manager.isSessionBusy(sessionId) || isBackendUnavailableError(error))
      ) {
        try {
          return queue(error instanceof Error ? error.message : String(error));
        } catch (queueError) {
          console.warn("[chat] Could not queue message:", queueError instanceof Error ? queueError.message : queueError);
        }
      }
      throw error;
    }
  }
}
