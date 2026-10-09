import { DEFAULT_SEND_MODE, type SendMode } from "../shared/send-mode.js";
import type { AppContext } from "./app-context.js";
import { isBackendUnavailableError } from "./backend-availability.js";
import { queueChatMessageDelivery } from "./chat-message-outbox.js";
import { CHAT_MESSAGE_DELIVERY_ID_PREFIX } from "./deferred-prompt-store.js";
import type { StartWorkAttachment } from "./session-attachment-routing.js";
import { parseSlashCommandPrompt } from "./slash-command.js";

export interface ChatMessageDeliveryOptions {
  attachments?: StartWorkAttachment[];
  mode?: SendMode;
  clientMessageId?: string;
  waitForDelivery?: boolean;
  queue?: "none" | "on_failure" | "before_send";
  signal?: AbortSignal;
}

export interface ChatMessageDelivery {
  delivery: "started" | "accepted" | "steered" | "command" | "queued";
  deliveryId?: string;
}

type ChatMessageDeliveryContext = Pick<AppContext,
  "sessionManager" | "sessionMetaStore" | "globalBus" | "deferredPromptStore" | "deferredPromptRunner"
>;

export async function sendChatMessage(
  ctx: ChatMessageDeliveryContext,
  sessionId: string,
  prompt: string,
  options: ChatMessageDeliveryOptions = {},
): Promise<ChatMessageDelivery> {
  const manager = ctx.sessionManager;
  const store = ctx.deferredPromptStore;
  const { attachments, mode, clientMessageId, waitForDelivery, signal } = options;
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
  const busyAtSend = manager.isSessionBusy(sessionId);
  try {
    if (busyAtSend) {
      if (clientMessageId) {
        await manager.steerSession(sessionId, prompt, attachments, clientMessageId);
      } else {
        await manager.steerSession(sessionId, prompt, attachments);
      }
      return { delivery: parseSlashCommandPrompt(prompt) ? "command" : "steered" };
    }
    const launchOptions = mode || clientMessageId ? {
      ...(mode ? { mode } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    } : undefined;
    if (waitForDelivery) {
      await manager.startWorkAndWaitForDelivery(sessionId, prompt, attachments, launchOptions);
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
