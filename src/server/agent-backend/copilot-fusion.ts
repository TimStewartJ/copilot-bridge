// Bridge shows Fusion tiers as `auto` effort levels; only this file maps them to runtime terms.
import type { CopilotClient } from "@github/copilot-sdk";
import { isRecord } from "../../shared/is-record.js";
import type { AgentCurrentModel, AgentModelInfo, AgentSetModelOptions } from "./types.js";

type CopilotModelList = Awaited<ReturnType<CopilotClient["rpc"]["models"]["list"]>>;
type AutoTierMetadata = NonNullable<CopilotModelList["auto"]>;

export const AUTO_MODEL_ID = "auto";
const COPILOT_FUSION_NAME = "Copilot Fusion";
/** The retired HydraFusion preview's model; its sessions move to Fusion High, as GitHub's did. */
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

/** Auto tier id to the Fusion name a request uses for it, for tiers that are Fusion tiers. */
export type FusionTierNames = ReadonlyMap<string, string>;

export function fusionTierNamesFromList(list: CopilotModelList): FusionTierNames {
  return new Map((list.auto?.tiers ?? []).flatMap((tier) => tier.fusionTier ? [[tier.id, tier.fusionTier] as const] : []));
}

/** How a request asks for an Auto tier: by its Fusion name when it has one, else by the tier id. */
function autoTierRequest(tier: string, names: FusionTierNames | undefined): { autoTier: string } | { fusionTier: string } {
  const fusionTier = names?.get(tier);
  return fusionTier ? { fusionTier } : { autoTier: tier };
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

/** Create/resume config in runtime terms: `auto`'s effort becomes its autoTier. Returns a copy. */
export function toRuntimeSessionConfig(
  config: Record<string, unknown>,
  fusionContextTokens?: number,
  fusionTiers?: FusionTierNames,
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
  return { ...withContext, capi: { ...(isRecord(rest.capi) ? rest.capi : {}), ...autoTierRequest(tier, fusionTiers) } };
}

/** A runtime model switch: `auto` gets effort as its tier and the context limit a switch drops. */
export function toRuntimeModelSwitch(
  model: string,
  options: AgentSetModelOptions | undefined,
  fusionContextTokens?: number,
  fusionTiers?: FusionTierNames,
): { modelId: string; options: Record<string, unknown> | undefined } {
  const retired = model === RETIRED_HYDRAFUSION_MODEL_ID;
  const modelId = retired ? AUTO_MODEL_ID : model;
  if (modelId !== AUTO_MODEL_ID) return { modelId, options };
  const { reasoningEffort, ...rest } = options ?? {};
  const tier = retired ? RETIRED_HYDRAFUSION_TIER : reasoningEffort;
  const next = {
    ...rest,
    ...(tier ? autoTierRequest(tier, fusionTiers) : {}),
    ...(fusionContextTokens === undefined ? {} : { modelCapabilities: fusionContextCapabilities(fusionContextTokens) }),
  };
  return { modelId, options: Object.keys(next).length > 0 ? next : undefined };
}

/** Each step reserves this output allowance, so the window is the limit plus it. */
const FUSION_OUTPUT_ALLOWANCE_TOKENS = 128_000;

/** The runtime's capability override that lets every Fusion step use `tokens` of prompt. */
export function fusionContextCapabilities(tokens: number): { limits: Record<string, number> } {
  return {
    limits: { max_prompt_tokens: tokens, max_context_window_tokens: tokens + FUSION_OUTPUT_ALLOWANCE_TOKENS },
  };
}

/** The request that switches a live session to an Auto tier, by its Fusion name when it has one. */
export function autoTierSwitch(tier: string, names: FusionTierNames | undefined):
  { method: "switchAutoTier"; params: { autoTier: string } } | { method: "switchFusionTier"; params: { fusionTier: string } } {
  const request = autoTierRequest(tier, names);
  return "fusionTier" in request
    ? { method: "switchFusionTier", params: request }
    : { method: "switchAutoTier", params: request };
}

/** What a resumed session on the retired preview switches to, or undefined for any other model. */
export function replacementForRetiredModel(modelId: unknown): { modelId: string; autoTier: string } | undefined {
  return modelId === RETIRED_HYDRAFUSION_MODEL_ID ? { modelId: AUTO_MODEL_ID, autoTier: RETIRED_HYDRAFUSION_TIER } : undefined;
}

/** The session's model; on `auto`, its next tier (pending, applying, committed) is the effort. */
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
