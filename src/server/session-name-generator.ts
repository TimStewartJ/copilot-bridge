import { randomUUID } from "node:crypto";
import type { ModelInfo } from "@github/copilot-sdk";

export const DISPOSABLE_TITLE_SESSION_ID_PREFIX = "b17e1000";

const TITLE_SYSTEM_PROMPT = `Generate a short title for a coding session based on the user's message.

Rules:
- Use 2-6 words.
- Use title case.
- Focus on the task, not conversational wording.
- Do not include quotes.
- Do not include leading or trailing punctuation.
- Return only the title inside <session-title></session-title>.`;

function modelMultiplier(model: ModelInfo): number | undefined {
  const multiplier = model.billing?.multiplier;
  return typeof multiplier === "number" && Number.isFinite(multiplier) ? multiplier : undefined;
}

function isPreferredSmallModel(model: ModelInfo): boolean {
  const id = model.id.toLowerCase();
  return id.includes("mini") || id.includes("haiku");
}

function byMultiplierThenId(a: ModelInfo, b: ModelInfo): number {
  return (modelMultiplier(a) ?? Number.POSITIVE_INFINITY) - (modelMultiplier(b) ?? Number.POSITIVE_INFINITY)
    || a.id.localeCompare(b.id);
}

export function createDisposableTitleSessionId(): string {
  const uuid = randomUUID();
  return `${DISPOSABLE_TITLE_SESSION_ID_PREFIX}${uuid.slice(DISPOSABLE_TITLE_SESSION_ID_PREFIX.length)}`;
}

export function isDisposableTitleSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_TITLE_SESSION_ID_PREFIX}-`);
}

export function selectSessionTitleModel(models: ModelInfo[]): string | undefined {
  const freeModels = models.filter((model) => modelMultiplier(model) === 0);
  const preferredFreeModels = freeModels.filter(isPreferredSmallModel).sort(byMultiplierThenId);
  if (preferredFreeModels.length > 0) return preferredFreeModels[0]!.id;
  if (freeModels.length > 0) return [...freeModels].sort(byMultiplierThenId)[0]!.id;

  const cheapPreferredModels = models
    .filter((model) => isPreferredSmallModel(model) && (modelMultiplier(model) ?? Number.POSITIVE_INFINITY) <= 0.5)
    .sort(byMultiplierThenId);
  return cheapPreferredModels[0]?.id;
}

export function buildSessionTitleSystemPrompt(): string {
  return TITLE_SYSTEM_PROMPT;
}

export function buildSessionTitleUserPrompt(userMessages: string[]): string {
  const content = userMessages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-20)
    .join("\n\n");
  return `Generate a session title for this message:

<user_message>
${content}
</user_message>`;
}

export function extractGeneratedSessionTitle(rawOutput: unknown): string | undefined {
  if (typeof rawOutput !== "string") return undefined;
  const tagged = rawOutput.match(/<session-title>\s*([\s\S]*?)\s*<\/session-title>/i);
  const rawTitle = (tagged?.[1] ?? rawOutput).trim();
  const title = rawTitle.replace(/^["']+|["']+$/g, "").trim();
  if (title.length < 3 || title.length > 100) return undefined;
  return title;
}
