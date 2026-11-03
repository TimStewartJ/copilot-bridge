import { DEFAULT_SEND_MODE, type SendMode } from "../shared/send-mode.js";
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

/**
 * Browser messages being admitted right now, by session and id, so a repeat of one is not run
 * twice: it gets the first one's outcome.
 */
const admittingMessages = new Map<string, Map<string, { prompt: string; outcome: Promise<ChatMessageDelivery> }>>();

export interface ChatMessageDeliveryOptions {
  attachments?: StartWorkAttachment[];
  mode?: SendMode;
  clientMessageId?: string;
  waitForDelivery?: boolean;
  queue?: "none" | "on_failure" | "before_send";
  signal?: AbortSignal;
  /**
   * A person's chat message: kept in the chat as not sent if its run ends before the agent has it,
   * and sent at most once per `clientMessageId` (a repeat answers with what became of the first).
   */
  keepUndelivered?: boolean;
  /**
   * The user typed this in the chat while the agent waited on a question: the question is answered
   * as skipped so the message reaches the agent now.
   */
  skipOpenQuestions?: boolean;
}

export interface ChatMessageDelivery {
  /** "stopped": Stop came before the agent had it; the chat keeps it as not sent. */
  delivery: "started" | "accepted" | "steered" | "command" | "queued" | "stopped";
  deliveryId?: string;
}

type ChatMessageDeliveryContext = Pick<AppContext,
  "sessionManager" | "sessionMetaStore" | "globalBus" | "deferredPromptStore" | "deferredPromptRunner"
> & Partial<Pick<AppContext, "chatMessageIdStore" | "unsentMessageStore" | "eventBusRegistry">>;

/**
 * What became of a browser message already sent under this id, or undefined for a new one.
 * Throws when the id was used for a different message.
 */
function findPreviousDelivery(
  ctx: ChatMessageDeliveryContext,
  sessionId: string,
  clientMessageId: string,
  prompt: string,
): ChatMessageDelivery | undefined {
  const sameMessage = (content: string) => {
    if (content !== prompt) throw new ChatMessageIdConflictError();
  };
  const live = ctx.eventBusRegistry?.getBus(sessionId)?.findUserMessage(clientMessageId);
  if (live) {
    sameMessage(live.content);
    return { delivery: live.undelivered?.state === "stopped" ? "stopped" : "accepted" };
  }
  const kept = ctx.unsentMessageStore?.get(sessionId, clientMessageId);
  if (kept) {
    sameMessage(kept.content);
    return { delivery: kept.storedState === "stopped" ? "stopped" : "accepted" };
  }
  const queued = ctx.deferredPromptStore?.get(`${CHAT_MESSAGE_DELIVERY_ID_PREFIX}${clientMessageId}`);
  if (queued && queued.sessionId === sessionId) {
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
    const admitting = admittingMessages.get(sessionId) ?? new Map<string, { prompt: string; outcome: Promise<ChatMessageDelivery> }>();
    const inFlight = admitting.get(clientMessageId);
    if (inFlight) {
      if (inFlight.prompt !== prompt) throw new ChatMessageIdConflictError();
      return inFlight.outcome;
    }
    const previous = findPreviousDelivery(ctx, sessionId, clientMessageId, prompt);
    if (previous) return previous;
    // Held from here to the start of its run: a repeat arriving while this one waits shares its outcome.
    const outcome = deliver();
    admitting.set(clientMessageId, { prompt, outcome });
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
    // Right after Stop the stopped run may still be letting go of the chat (or the chat is still
    // loading): neither steering nor a new run is possible yet, but a new run will be in a moment.
    if (manager.isSessionSettling(sessionId)) {
      await manager.waitWhileSessionSettles(sessionId, SETTLING_SESSION_WAIT_MS);
      signal?.throwIfAborted();
    }
    const busyAtSend = manager.isSessionBusy(sessionId);
    try {
      if (busyAtSend) {
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
