import { isRecord } from "../shared/is-record.js";
import type { ChatTurnDetails, ChatTurnModelUsage } from "../shared/chat-turn-details.js";
import { fusionPhasesFromEvents } from "./fusion-turn-details.js";
import { getSdkEventId, isSdkAgentUserMessage } from "./sdk-event-identity.js";

export interface TranscriptTurnBoundary {
  startedAt: number;
  finalMessageId?: string;
  finalModel?: string;
  finalMessageAt?: number;
  endedAt?: number;
}

/** Details keyed to the final assistant event for each user-visible turn. */
export function transcriptTurnDetails(events: readonly unknown[]): Map<string, ChatTurnDetails> {
  const result = new Map<string, ChatTurnDetails>();
  let turn: TranscriptTurnBoundary | undefined;
  let turnEvents: unknown[] = [];

  const finish = () => {
    if (!turn?.finalMessageId) return;
    const finishedAt = turn.endedAt ?? turn.finalMessageAt;
    const durationMs = finishedAt !== undefined && finishedAt >= turn.startedAt
      ? finishedAt - turn.startedAt
      : undefined;
    const models = modelUsage(turnEvents);
    if (models.length === 0) return;
    if (turn.finalModel && !models.some((entry) => entry.model === turn!.finalModel)) {
      models.push({ model: turn.finalModel, requests: 0, meteredRequests: 0, meteredAiCredits: 0 });
    }
    const phases = fusionPhasesFromEvents(turnEvents);
    result.set(turn.finalMessageId, {
      sourceMessageId: turn.finalMessageId,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(turn.finalModel ? { finalModel: turn.finalModel } : {}),
      models,
      ...(phases ? { phases } : {}),
    });
  };

  for (const raw of events) {
    const next = advanceTranscriptTurnBoundary(turn, raw);
    if (isRecord(raw) && raw.type === "user.message" && next !== turn) {
      finish();
      turnEvents = [];
    }
    turn = next;
    if (turn) turnEvents.push(raw);
  }
  finish();
  return result;
}

/** Shared by full transforms and the disk reader's lightweight byte-window checkpoints. */
export function advanceTranscriptTurnBoundary(
  turn: TranscriptTurnBoundary | undefined,
  raw: unknown,
): TranscriptTurnBoundary | undefined {
  if (!isRecord(raw)) return turn;
  if (raw.type === "user.message" && isVisibleUserMessage(raw)) {
    // A follow-up can steer work before the runtime commits an answer.
    if (turn && !turn.finalMessageId && turn.endedAt === undefined) return turn;
    const timestamp = parseTime(raw.timestamp);
    return timestamp === undefined ? undefined : { startedAt: timestamp };
  }
  if (!turn || (typeof raw.agentId === "string" && raw.agentId)) return turn;

  if (raw.type === "assistant.turn_start" && turn.endedAt !== undefined) {
    return { ...turn, endedAt: undefined };
  }
  if (
    raw.type === "assistant.message"
    && isRecord(raw.data)
    && !raw.data.parentToolCallId
  ) {
    const messageId = getSdkEventId(raw);
    if (messageId && typeof raw.data.content === "string" && raw.data.content.trim()) {
      return {
        ...turn,
        finalMessageId: messageId,
        finalModel: typeof raw.data.model === "string" && raw.data.model ? raw.data.model : undefined,
        finalMessageAt: parseTime(raw.timestamp),
        endedAt: undefined,
      };
    }
  }
  if (isTurnEnd(raw) && (raw.type === "assistant.turn_end" || turn.endedAt === undefined)) {
    return { ...turn, endedAt: parseTime(raw.timestamp) ?? turn.endedAt };
  }
  return turn;
}

function modelUsage(events: readonly unknown[]): ChatTurnModelUsage[] {
  const byModel = new Map<string, ChatTurnModelUsage>();
  const seen = new Set<string>();
  for (const raw of events) {
    if (!isRecord(raw) || raw.type !== "session.usage_record") continue;
    const data = isRecord(raw.data) ? raw.data : {};
    const usage = isRecord(data.usage) ? data.usage : data;
    const model = typeof usage.model === "string" && usage.model.trim()
      ? usage.model.trim()
      : typeof usage.responseModel === "string" && usage.responseModel.trim()
        ? usage.responseModel.trim()
        : undefined;
    if (!model) continue;

    const copilotUsage = isRecord(usage.copilotUsage) ? usage.copilotUsage : undefined;
    const accounting = isRecord(usage.accounting) ? usage.accounting : undefined;
    const requestId = typeof accounting?.usageId === "string"
      ? accounting.usageId
      : typeof usage.apiCallId === "string"
        ? usage.apiCallId
        : getSdkEventId(raw);
    if (requestId && seen.has(requestId)) continue;
    if (requestId) seen.add(requestId);

    const row = byModel.get(model) ?? {
      model,
      ...(typeof usage.modelDisplayName === "string" && usage.modelDisplayName.trim()
        ? { displayName: usage.modelDisplayName.trim() }
        : {}),
      requests: 0,
      meteredRequests: 0,
      meteredAiCredits: 0,
    };
    row.requests += 1;
    const nanoAiu = copilotUsage?.totalNanoAiu ?? usage.totalNanoAiu;
    if (typeof nanoAiu === "number" && Number.isFinite(nanoAiu) && nanoAiu >= 0) {
      row.meteredRequests += 1;
      row.meteredAiCredits += nanoAiu / 1_000_000_000;
    }
    byModel.set(model, row);
  }
  return [...byModel.values()].sort((left, right) => (
    right.meteredAiCredits - left.meteredAiCredits
    || right.requests - left.requests
    || left.model.localeCompare(right.model)
  ));
}

function isTurnEnd(event: Record<string, unknown>): boolean {
  return event.type === "assistant.turn_end"
    || event.type === "session.idle"
    || event.type === "abort"
    || event.type === "session.shutdown";
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isVisibleUserMessage(event: Record<string, unknown>): boolean {
  const data = isRecord(event.data) ? event.data : {};
  const source = typeof data.source === "string" ? data.source.trim().toLowerCase() : "";
  if (source === "system" || /^skill(?:[-:]|$)/i.test(source) || isSdkAgentUserMessage(event)) return false;
  if (data.isAutopilotContinuation === true) return false;
  const content = data.content ?? data.prompt;
  const hasContent = typeof content === "string" && content.trim().length > 0;
  const hasAttachments = Array.isArray(data.attachments) && data.attachments.length > 0;
  if (!hasContent && !hasAttachments) return false;
  const agentMode = data.agentMode === "autopilot";
  return !(agentMode && !hasContent && !hasAttachments);
}
