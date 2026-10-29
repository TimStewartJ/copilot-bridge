// Copilot Fusion is the runtime's `auto` model plus a routing tier: Standard, High or Max. The
// runtime lists the tiers beside its model catalog rather than as models, and takes the choice as
// `autoTier`, never as a reasoning effort. Bridge offers the tiers as the `auto` model's effort
// levels, which is how GitHub presents them, and translates between the two only here, at the
// Copilot backend boundary. The experimental Fusion context limit (Settings › Experimental) is
// translated here too, into the capability override the runtime applies to every Fusion step.
import type { CopilotClient } from "@github/copilot-sdk";
import { isRecord } from "../../shared/is-record.js";
import type { AgentCurrentModel, AgentModelInfo, AgentSetModelOptions } from "./types.js";

type CopilotModelList = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;
type AutoTierMetadata = NonNullable<CopilotModelList["auto"]>;

export const AUTO_MODEL_ID = "auto";
const COPILOT_FUSION_NAME = "Copilot Fusion";
/** The HydraFusion research preview's model, retired by CLI 1.0.104. Its sessions move to Fusion High, as GitHub moved its users. */
const RETIRED_HYDRAFUSION_MODEL_ID = "hydrafusion";
const RETIRED_HYDRAFUSION_TIER = "hydrafusion";

/** The model catalog with the runtime's Auto tiers offered as the `auto` model's effort levels. */
export function modelCatalogFromList(list: CopilotModelList): AgentModelInfo[] {
  return list.models.map((raw) => {
    const model = withCapabilities(raw as unknown as AgentModelInfo);
    return model.id === AUTO_MODEL_ID ? describeAuto(model, list.auto) : model;
  });
}

// The SDK's listModels fills these in, and Bridge reads the catalog that way.
function withCapabilities(model: AgentModelInfo): AgentModelInfo {
  const capabilities: Record<string, unknown> = isRecord(model.capabilities) ? model.capabilities : {};
  const limits: Record<string, unknown> = isRecord(capabilities.limits) ? capabilities.limits : {};
  return {
    ...model,
    capabilities: {
      ...capabilities,
      supports: isRecord(capabilities.supports) ? capabilities.supports : {},
      limits: { ...limits, max_context_window_tokens: typeof limits.max_context_window_tokens === "number" ? limits.max_context_window_tokens : 0 },
    } as AgentModelInfo["capabilities"],
  };
}

function describeAuto(model: AgentModelInfo, auto: AutoTierMetadata | undefined): AgentModelInfo {
  const tiers = (auto?.tiers ?? []).filter((tier) => tier.status?.enabled === true && tier.status.pickerVisible !== false);
  const routed: AgentModelInfo = { ...model, selectionMode: "dynamic" };
  if (tiers.length === 0) return routed;
  const ids = tiers.map((tier) => tier.id);
  return {
    ...routed,
    ...(tiers.some((tier) => tier.fusionTier) ? { name: COPILOT_FUSION_NAME } : {}),
    supportedReasoningEfforts: ids,
    ...(auto?.defaultTier && ids.includes(auto.defaultTier) ? { defaultReasoningEffort: auto.defaultTier } : {}),
    reasoningEffortLabels: Object.fromEntries(tiers.map((tier) => [tier.id, tier.displayName])),
  };
}

/**
 * A create or resume config in the runtime's terms: the retired preview becomes Fusion High, and
 * `auto` carries its effort as the session's Auto tier and the experimental context limit as a
 * capability override. Returns a copy; other models pass through without the limit.
 */
export function toRuntimeSessionConfig(
  config: Record<string, unknown>,
  fusionContextTokens?: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = config.model === RETIRED_HYDRAFUSION_MODEL_ID
    ? { ...config, model: AUTO_MODEL_ID, reasoningEffort: RETIRED_HYDRAFUSION_TIER }
    : { ...config };
  if (next.model !== AUTO_MODEL_ID) return next;
  const { reasoningEffort: tier, ...rest } = next;
  const withContext = fusionContextTokens === undefined
    ? rest
    : { ...rest, modelCapabilities: fusionContextCapabilities(fusionContextTokens) };
  if (typeof tier !== "string" || !tier) return withContext;
  return { ...withContext, capi: { ...(isRecord(rest.capi) ? rest.capi : {}), autoTier: tier } };
}

/**
 * A model switch in the runtime's terms: `auto` takes its effort as the Auto tier to switch to, and
 * the experimental context limit, which the runtime drops on every switch to another model.
 */
export function toRuntimeModelSwitch(
  model: string,
  options: AgentSetModelOptions | undefined,
  fusionContextTokens?: number,
): { modelId: string; options: Record<string, unknown> | undefined } {
  const retired = model === RETIRED_HYDRAFUSION_MODEL_ID;
  const modelId = retired ? AUTO_MODEL_ID : model;
  if (modelId !== AUTO_MODEL_ID) return { modelId, options };
  const { reasoningEffort, ...rest } = options ?? {};
  const tier = retired ? RETIRED_HYDRAFUSION_TIER : reasoningEffort;
  const next = {
    ...rest,
    ...(tier ? { autoTier: tier } : {}),
    ...(fusionContextTokens === undefined ? {} : { modelCapabilities: fusionContextCapabilities(fusionContextTokens) }),
  };
  return { modelId, options: Object.keys(next).length > 0 ? next : undefined };
}

/**
 * Every step keeps its model's output allowance (128K on each model Fusion uses) out of the
 * window, so the window is the limit plus that allowance and each step gets the whole limit.
 */
const FUSION_OUTPUT_ALLOWANCE_TOKENS = 128_000;

/** The runtime's capability override that lets every Fusion step use `tokens` of prompt. */
export function fusionContextCapabilities(tokens: number): { limits: Record<string, number> } {
  return {
    limits: { max_prompt_tokens: tokens, max_context_window_tokens: tokens + FUSION_OUTPUT_ALLOWANCE_TOKENS },
  };
}

/** What a resumed session on the retired preview switches to, or undefined for any other model. */
export function replacementForRetiredModel(modelId: unknown): { modelId: string; autoTier: string } | undefined {
  return modelId === RETIRED_HYDRAFUSION_MODEL_ID ? { modelId: AUTO_MODEL_ID, autoTier: RETIRED_HYDRAFUSION_TIER } : undefined;
}

/**
 * The session's model as Bridge reads it: on `auto`, the tier it will use next (one waiting for the
 * next turn, then one being applied, then the committed one) is its effort.
 */
export function fromRuntimeCurrentModel(current: unknown): AgentCurrentModel | undefined {
  if (!isRecord(current)) return current as AgentCurrentModel | undefined;
  const { autoTier, pendingAutoTier, activatingAutoTier, ...model } = current;
  if (model.modelId !== AUTO_MODEL_ID) return current as AgentCurrentModel;
  const tier = [pendingAutoTier, activatingAutoTier, autoTier].find((value) => value !== undefined);
  return { ...(model as AgentCurrentModel), ...(typeof tier === "string" && tier ? { reasoningEffort: tier } : {}) };
}

/** An Auto tier recorded on a session event, read as the session's effort. */
export function autoTierFromEvent(model: unknown, data: Record<string, unknown>): string | undefined {
  return model === AUTO_MODEL_ID && typeof data.autoTier === "string" && data.autoTier ? data.autoTier : undefined;
}
