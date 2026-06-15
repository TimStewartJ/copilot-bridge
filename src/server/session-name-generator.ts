import { randomUUID } from "node:crypto";
import type { AgentModelInfo } from "./agent-backend/index.js";

export const DISPOSABLE_TITLE_SESSION_ID_PREFIX = "b17e1000";

const TITLE_SYSTEM_PROMPT = `Generate a short title for a chat session based on the user's message.

Rules:
- Use 2-6 words.
- Use title case.
- Focus on the task, not conversational wording.
- Do not include quotes.
- Do not include leading or trailing punctuation.
- Return only the title inside <session-title></session-title>.`;

const LEGACY_CHEAP_MODEL_MULTIPLIER_MAX = 0.5;
const TOKEN_PRICE_CHEAP_MODEL_OUTPUT_MAX = 500_000;
const DISALLOWED_TITLE_MODEL_IDS = new Set(["auto"]);
const TOKEN_PRICE_FIELDS = ["inputPrice", "outputPrice", "cachePrice"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function billingRecord(model: AgentModelInfo): Record<string, unknown> | undefined {
  return asRecord(model.billing);
}

function modelMultiplier(model: AgentModelInfo): number | undefined {
  return finiteNumber(billingRecord(model)?.multiplier);
}

function tokenPricesRecord(model: AgentModelInfo): Record<string, unknown> | undefined {
  return asRecord(billingRecord(model)?.tokenPrices);
}

function normalizedTokenPrice(value: unknown, batchSize: number): number | undefined {
  const price = finiteNumber(value);
  if (price === undefined || price < 0) return undefined;
  return price / batchSize;
}

function modelTokenPrices(model: AgentModelInfo): {
  inputPrice?: number;
  outputPrice?: number;
  cachePrice?: number;
} | undefined {
  const tokenPrices = tokenPricesRecord(model);
  if (!tokenPrices) return undefined;

  // A usable price record must declare a positive batch size. A non-positive or
  // missing batch size means the record carries no real billing data, so we
  // treat the model as having unknown pricing rather than inferring it is free.
  const batchSize = finiteNumber(tokenPrices.batchSize);
  if (batchSize === undefined || batchSize <= 0) return undefined;
  const inputPrice = normalizedTokenPrice(tokenPrices.inputPrice, batchSize);
  const outputPrice = normalizedTokenPrice(tokenPrices.outputPrice, batchSize);
  const cachePrice = normalizedTokenPrice(tokenPrices.cachePrice, batchSize);
  if (inputPrice === undefined && outputPrice === undefined && cachePrice === undefined) return undefined;
  return { inputPrice, outputPrice, cachePrice };
}

function modelTokenPriceScore(model: AgentModelInfo): number | undefined {
  const prices = modelTokenPrices(model);
  if (!prices) return undefined;
  return TOKEN_PRICE_FIELDS.reduce((sum, field) => sum + (prices[field] ?? 0), 0);
}

function isFreeModel(model: AgentModelInfo): boolean {
  const multiplier = modelMultiplier(model);
  if (multiplier !== undefined) return multiplier === 0;

  const prices = modelTokenPrices(model);
  if (!prices) return false;
  return TOKEN_PRICE_FIELDS.some((field) => prices[field] !== undefined)
    && TOKEN_PRICE_FIELDS.every((field) => (prices[field] ?? 0) === 0);
}

function hasSelectablePolicy(model: AgentModelInfo): boolean {
  const modelRecord = asRecord(model);
  const policy = asRecord(modelRecord?.policy);
  if (!policy) return true;
  return typeof policy.state === "string" && policy.state.toLowerCase() === "enabled";
}

function isSelectableTitleModel(model: AgentModelInfo): boolean {
  return !!model.id && !DISALLOWED_TITLE_MODEL_IDS.has(model.id.toLowerCase()) && hasSelectablePolicy(model);
}

function isPreferredSmallModel(model: AgentModelInfo): boolean {
  const id = model.id.toLowerCase();
  return id.includes("mini") || id.includes("haiku");
}

function isCheapPreferredModel(model: AgentModelInfo): boolean {
  if (!isPreferredSmallModel(model)) return false;

  const multiplier = modelMultiplier(model);
  if (multiplier !== undefined) return multiplier <= LEGACY_CHEAP_MODEL_MULTIPLIER_MAX;

  const prices = modelTokenPrices(model);
  return prices?.outputPrice !== undefined && prices.outputPrice <= TOKEN_PRICE_CHEAP_MODEL_OUTPUT_MAX;
}

function modelSortScore(model: AgentModelInfo): number {
  return modelMultiplier(model)
    ?? modelTokenPriceScore(model)
    ?? Number.POSITIVE_INFINITY;
}

function byCostThenId(a: AgentModelInfo, b: AgentModelInfo): number {
  return modelSortScore(a) - modelSortScore(b)
    || a.id.localeCompare(b.id);
}

export function createDisposableTitleSessionId(): string {
  const uuid = randomUUID();
  return `${DISPOSABLE_TITLE_SESSION_ID_PREFIX}${uuid.slice(DISPOSABLE_TITLE_SESSION_ID_PREFIX.length)}`;
}

export function isDisposableTitleSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${DISPOSABLE_TITLE_SESSION_ID_PREFIX}-`);
}

export function selectSessionTitleModel(models: AgentModelInfo[]): string | undefined {
  const selectableModels = models.filter(isSelectableTitleModel);
  const freeModels = selectableModels.filter(isFreeModel);
  const preferredFreeModels = freeModels.filter(isPreferredSmallModel).sort(byCostThenId);
  if (preferredFreeModels.length > 0) return preferredFreeModels[0]!.id;
  if (freeModels.length > 0) return [...freeModels].sort(byCostThenId)[0]!.id;

  const cheapPreferredModels = selectableModels
    .filter(isCheapPreferredModel)
    .sort(byCostThenId);
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
