import { isRecord } from "../shared/is-record.js";
import type { ChatTurnPhase } from "../shared/chat-turn-details.js";

const MAX_REPLACED_ANSWER_CHARS = 12_000;

/** Optional translation of runtime routing events into details the transcript can render. */
export function fusionPhasesFromEvents(events: readonly unknown[]): ChatTurnPhase[] | undefined {
  const resolvedIds = new Set<string>();
  const finalPhaseIds = new Set<string>();
  const phaseEvents: Array<{ phaseId: string; data: Record<string, unknown> }> = [];

  for (const raw of events) {
    if (!isRecord(raw) || !isRecord(raw.data)) continue;
    if (typeof raw.agentId === "string" && raw.agentId) continue;
    const data = raw.data;
    if (raw.type === "session.fusion_resolved" && typeof data.fusionId === "string") {
      resolvedIds.add(data.fusionId);
      continue;
    }
    if (raw.type === "session.fusion_completed" && typeof data.finalSourcePhaseId === "string") {
      finalPhaseIds.add(data.finalSourcePhaseId);
      continue;
    }
    if (raw.type !== "assistant.fusion_phase_completed") continue;
    if (
      typeof data.fusionId !== "string"
      || (resolvedIds.size > 0 && !resolvedIds.has(data.fusionId))
      || typeof data.phaseId !== "string"
    ) continue;
    phaseEvents.push({ phaseId: data.phaseId, data });
  }

  const phases = phaseEvents.flatMap(({ phaseId, data }) => {
    if (typeof data.model !== "string" || typeof data.phaseKind !== "string") return [];
    const phase: ChatTurnPhase = {
      model: data.model,
      label: phaseLabel(data.phaseKind),
      final: finalPhaseIds.has(phaseId),
      ...(typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0
        ? { durationMs: data.durationMs }
        : {}),
      ...(typeof data.verdict === "string" && data.verdict ? { outcome: data.verdict } : {}),
    };
    if (isReviewPhase(data.phaseKind) && typeof data.content === "string") {
      const rationale = reviewRationale(data.content);
      if (rationale) phase.note = rationale;
    } else if (!phase.final && isDraftPhase(data.phaseKind) && typeof data.content === "string") {
      phase.replacedAnswer = data.content.length > MAX_REPLACED_ANSWER_CHARS
        ? `${data.content.slice(0, MAX_REPLACED_ANSWER_CHARS)}…`
        : data.content;
    }
    return [phase];
  });

  if (!phases.length) return undefined;
  return phases;
}

function phaseLabel(kind: string): string {
  switch (kind) {
    case "primary":
    case "draft":
      return "Draft";
    case "critic":
    case "judge":
      return "Review";
    case "revision":
    case "repair":
      return "Redo";
    default:
      return "Answer";
  }
}

function isReviewPhase(kind: string): boolean {
  return kind === "critic" || kind === "judge";
}

function isDraftPhase(kind: string): boolean {
  return kind === "primary" || kind === "draft";
}

function reviewRationale(content: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
