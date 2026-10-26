// Settings › Models: the three tiers (Fast, Standard, Deep) and what each kind of work runs on.
// Tiers are the composer's three presets; this is the only place they are edited.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchModelRoles, type AppSettings, type ModelInfo } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatReasoningEffortLabel, getModelReasoningEfforts } from "../../reasoning-effort";
import { modelSupportsLongContext } from "../../../shared/copilot-context.js";
import { buildContextTierOptions, buildReasoningEffortOptions } from "../../lib/new-session-launch";
import { resolveModelPresetState } from "../../lib/model-presets";
import ModelPresetPicker from "../shared/ModelPresetPicker";
import { LaunchModelSelect, LaunchOptionRow } from "../shared/LaunchOptionControls";
import { MODEL_PRESET_SLOTS, type ModelPresetSlot } from "../../../shared/model-presets.js";
import {
  isTierChoice,
  MODEL_ROLE_INFO,
  MODEL_ROLES,
  MODEL_TIER_INFO,
  type ModelRole,
  type ModelRoleCustom,
  type ModelRoles,
  type ResolvedModelRole,
} from "../../../shared/model-roles.js";
import { pickSecondOpinion } from "../../../shared/subagent-settings.js";
import { getModelFamilyLabel, type ModelFamily } from "../../../shared/model-families.js";
import { Badge, Button, FormRow, Notice, SegmentedControl, SettingList, SettingRow } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { SettingsSection } from "./SettingsSection";

const ROLES_KEY = ["models", "roles"] as const;
/** Roles whose own model is kept in an older setting shown further down this page. */
const OWN_MODEL_BELOW: Partial<Record<ModelRole, string>> = {
  chat: "Its own model (set below)",
  background: "Its own model (set below)",
};
/** Roles that offer no model of their own; Helpers keep "Own" only while one is already saved. */
const NO_OWN_MODEL: ReadonlySet<ModelRole> = new Set(["subagents", "reviewers"]);

/** Says which tier rubber-duck uses in Claude and in GPT chats: the strongest from the other family. */
function describeSecondOpinion(presets: NonNullable<AppSettings["modelPresets"]>, models: readonly ModelInfo[]): string {
  // The same rule the server applies: with a model list, a tier whose model is not on it is skipped.
  const usable = (model: string) => models.length === 0 || models.some((entry) => entry.id === model);
  const tiers = [...MODEL_PRESET_SLOTS].reverse().flatMap((slot) => presets[slot]?.model && usable(presets[slot]!.model) ? [{ slot, model: presets[slot]!.model }] : []);
  const parts = (["claude", "gpt"] as const satisfies readonly ModelFamily[]).flatMap((family) => {
    const pick = pickSecondOpinion(tiers, family);
    if (!pick) return [];
    const name = models.find((model) => model.id === pick.model)?.name ?? pick.model;
    return [`${MODEL_TIER_INFO[pick.slot].label} (${name}) in ${getModelFamilyLabel(family)} chats`];
  });
  if (!parts.length) return "Rubber-duck, the second opinion, runs on Copilot's own pick from another model family.";
  return `Rubber-duck, the second opinion, uses your strongest tier from the other model family: ${parts.join(", ")}. Other chats get Copilot's own pick.`;
}

type RoleValue = ModelPresetSlot | "automatic" | "custom";

function roleValue(draft: AppSettings, role: ModelRole): RoleValue {
  const choice = draft.modelRoles?.[role];
  if (isTierChoice(choice)) return choice.tier;
  if (choice) return "custom";
  if (role === "chat" || role === "background") return "custom";
  if (role === "helm") return draft.helm?.model ? "custom" : "automatic";
  return "automatic";
}

function describeResolved(resolved: ResolvedModelRole | undefined, models: readonly ModelInfo[] | undefined): string | undefined {
  if (!resolved?.model) return undefined;
  const name = models?.find((model) => model.id === resolved.model)?.name ?? resolved.model;
  const effort = formatReasoningEffortLabel(resolved.reasoningEffort);
  return [name, effort && `${effort} effort`, resolved.contextTier === "long_context" ? "long context" : undefined].filter(Boolean).join(" · ");
}

function ModelSelect({ id, label, value, models, onChange }: { id: string; label: string; value: string; models: readonly ModelInfo[]; onChange: (model: string) => void }) {
  return <LaunchModelSelect id={id} ariaLabel={label} models={models} value={value} placeholderLabel="Choose a model" placeholderDisabled
    unlistedModelId={value && !models.some((model) => model.id === value) ? value : undefined} onChange={onChange} />;
}

/** Effort as the new-chat screen shows it: one segment per level the model offers. */
function EffortRow({ label, models, model, value, onChange }: { label: string; models: readonly ModelInfo[]; model: string; value: string | undefined; onChange: (effort: string) => void }) {
  const options = buildReasoningEffortOptions(models.find((entry) => entry.id === model)?.supportedReasoningEfforts);
  return <LaunchOptionRow ariaLabel={label} options={options} selectedValue={value} onChange={(effort) => { if (effort) onChange(effort); }} />;
}

export function ModelsSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const { data: models } = useModelsQuery();
  const available = useMemo(() => (models ?? []).filter((model) => model.policy?.state !== "disabled"), [models]);
  const [editing, setEditing] = useState<ModelPresetSlot>(draft.lastModelPreset ?? "preset2");
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: ({ signal }) => fetchModelRoles(signal) });
  const resolved = new Map((roles.data?.roles ?? []).map((role) => [role.role, role]));
  const savedKey = JSON.stringify([draft.modelPresets, draft.modelRoles, draft.model, draft.reasoningEffort, draft.contextTier, draft.deferWorker, draft.helm?.model]);
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ROLES_KEY }); }, [savedKey, queryClient]);

  const presets = draft.modelPresets ?? {};
  // A tier with no model yet shows (and is saved with) the model the composer would offer for it.
  const tiles = resolveModelPresetState({ models: available, selectedModelId: "", globalDefaultModelId: draft.model, presets }).tiles;
  const editingPreset = presets[editing];
  const editingModelId = editingPreset?.model || tiles.find((tile) => tile.slot === editing)?.model?.id || "";
  const editingModel = available.find((entry) => entry.id === editingModelId);
  const contextOptions = editingModel ? buildContextTierOptions(editingModel) : [];
  const setPreset = (slot: ModelPresetSlot, change: Partial<ModelRoleCustom>) => {
    const current = presets[slot];
    const model = change.model ?? current?.model ?? "";
    const known = available.find((entry) => entry.id === model);
    const next = { ...current, ...change, model };
    if (change.model !== undefined && change.model !== current?.model) {
      // A new model keeps the tier's effort and context only when it offers them.
      if (next.reasoningEffort && !getModelReasoningEfforts(models, model).includes(next.reasoningEffort)) delete next.reasoningEffort;
      if (next.contextTier === "long_context" && !modelSupportsLongContext(known)) delete next.contextTier;
    }
    const nextPresets = { ...presets };
    if (model) nextPresets[slot] = next; else delete nextPresets[slot];
    setDraft({ ...draft, modelPresets: nextPresets });
  };

  const setRole = (role: ModelRole, value: RoleValue) => {
    const nextRoles: ModelRoles = { ...draft.modelRoles };
    let next: AppSettings = { ...draft, modelRoles: nextRoles };
    if (value === "preset1" || value === "preset2" || value === "preset3") {
      nextRoles[role] = { tier: value };
    } else {
      delete nextRoles[role];
      if (role === "helm") next = { ...next, helm: { ...draft.helm, model: value === "automatic" ? "" : draft.helm?.model || available[0]?.id || "" } };
      if (value === "custom" && (role === "helper" || role === "subagents")) {
        const from = resolved.get(role);
        nextRoles[role] = { model: from?.model ?? available[0]?.id ?? "", ...(from?.reasoningEffort ? { reasoningEffort: from.reasoningEffort } : {}) };
      }
    }
    setDraft(next);
  };

  const setCustom = (role: ModelRole, change: Partial<ModelRoleCustom>) => {
    const current = draft.modelRoles?.[role];
    const base = current && !isTierChoice(current) ? current : { model: "" };
    const model = change.model ?? base.model;
    const next: ModelRoleCustom = { ...base, ...change, model };
    if (change.model !== undefined && next.reasoningEffort && !getModelReasoningEfforts(models, model).includes(next.reasoningEffort)) delete next.reasoningEffort;
    setDraft({ ...draft, modelRoles: { ...draft.modelRoles, [role]: next } });
  };

  const allTiersSet = MODEL_PRESET_SLOTS.every((slot) => presets[slot]?.model);
  const recommended = () => {
    const nextRoles: ModelRoles = {};
    for (const role of MODEL_ROLES) {
      const tier = MODEL_ROLE_INFO[role].recommended;
      if (tier) nextRoles[role] = { tier };
    }
    setDraft({ ...draft, modelRoles: nextRoles });
  };

  return <SettingsSection title="Models" description="Three tiers, and which one each kind of work runs on. Change a tier once and everything using it follows.">
    <h3 className={cx(DS.text.sectionLabel, "mb-2")}>Tiers</h3>
    <div className="space-y-4">
      <FormRow label="Tier" hideLabel help={<><span className="font-medium text-text-secondary">{MODEL_TIER_INFO[editing].label}:</span> {MODEL_TIER_INFO[editing].description} Pick a tier to edit it; tap it again, or its arrow, to change its model.</>}>
        <ModelPresetPicker idPrefix="settings-tier" showSlotLabels models={available} presets={presets}
          selectedPresetSlot={editing} selectedModelId={editingModelId} globalDefaultModelId={draft.model}
          onSelectPreset={setEditing}
          onSelectModel={(slot, modelId) => { setEditing(slot); setPreset(slot, { model: modelId }); }} />
      </FormRow>
      {editingModelId && <FormRow label="Effort" hideLabel help={editingPreset?.reasoningEffort ? undefined : "Uses the model's own default effort until you pick one."}>
        <EffortRow label={`${MODEL_TIER_INFO[editing].label} effort`} models={available} model={editingModelId} value={editingPreset?.reasoningEffort}
          onChange={(effort) => setPreset(editing, { model: editingModelId, reasoningEffort: effort })} />
      </FormRow>}
      {contextOptions.length > 0 && <FormRow label="Context" hideLabel>
        <LaunchOptionRow ariaLabel={`${MODEL_TIER_INFO[editing].label} context`} options={contextOptions} selectedValue={editingPreset?.contextTier ?? "default"}
          onChange={(tier) => { if (tier) setPreset(editing, { model: editingModelId, contextTier: tier }); }} />
      </FormRow>}
    </div>

    <div className="mt-5 flex items-center justify-between gap-2">
      <h3 className={DS.text.sectionLabel}>What runs on which tier</h3>
      <Button size="sm" variant="ghost" disabled={!allTiersSet} title={allTiersSet ? undefined : "Set all three tiers first"} onClick={recommended}>Use recommended</Button>
    </div>
    <SettingList>
      {MODEL_ROLES.map((role) => {
        const info = MODEL_ROLE_INFO[role];
        const value = roleValue(draft, role);
        const view = resolved.get(role);
        const custom = draft.modelRoles?.[role];
        const ownBelow = OWN_MODEL_BELOW[role];
        // Helm chat takes its effort from its typed and spoken settings, not the tier.
        const shown = role === "helm" && view ? { ...view, reasoningEffort: undefined } : view;
        const runsOn = describeResolved(shown, models)
          ?? (role === "chat" && value === "custom" ? describeResolved({ role, source: "custom", model: draft.model, reasoningEffort: draft.reasoningEffort, contextTier: draft.contextTier }, models) : undefined)
          ?? (role === "helm" && value === "custom" ? describeResolved({ role, source: "custom", model: draft.helm?.model }, models) : undefined);
        const options = [
          ...MODEL_PRESET_SLOTS.map((slot) => ({ value: slot as RoleValue, label: MODEL_TIER_INFO[slot].label, disabled: !presets[slot]?.model, title: presets[slot]?.model ? undefined : "Set this tier first" })),
          ...(ownBelow ? [] : [{ value: "automatic" as RoleValue, label: info.automaticLabel ?? "Auto", title: info.automaticLabel ? info.automatic : `Automatic: ${info.automatic}` }]),
          ...(NO_OWN_MODEL.has(role) && value !== "custom" ? [] : [{ value: "custom" as RoleValue, label: "Own", title: "Its own model" }]),
        ];
        return <SettingRow key={role} label={info.label} hint={info.description}>
          <SegmentedControl<RoleValue> ariaLabel={`${info.label} runs on`} options={options} value={value} fullWidth onChange={(next) => { if (next !== value) setRole(role, next); }} />
          <p className={cx(DS.text.meta, "mt-2 flex flex-wrap items-center gap-1.5")}>
            {value === "automatic" ? <>{info.automaticLabel ? info.automatic : `Automatic: ${info.automatic}`}</> : runsOn ? <>Runs on {runsOn}</> : value === "custom" && ownBelow ? <>Its own model is set below.</> : null}
            {info.effortNote && value !== "automatic" && <span>· {info.effortNote}</span>}
            {view?.source === "tier" && <Badge>{MODEL_TIER_INFO[view.tier!].label}</Badge>}
          </p>
          {role === "reviewers" && <p className={cx(DS.text.meta, "mt-1")}>{describeSecondOpinion(presets, available)}</p>}
          {view?.warning && <p className="mt-1 text-xs text-warning">{view.warning}</p>}
          {value === "custom" && role === "helm" && (
            <div className="mt-2 sm:max-w-sm"><ModelSelect id="role-helm-model" label="Helm chat model" value={draft.helm?.model ?? ""} models={available} onChange={(model) => setDraft({ ...draft, modelRoles: { ...draft.modelRoles }, helm: { ...draft.helm, model } })} /></div>
          )}
          {value === "custom" && !ownBelow && role !== "helm" && custom && !isTierChoice(custom) && (
            <div className="mt-2 space-y-2">
              <div className="sm:max-w-sm"><ModelSelect id={`role-${role}-model`} label={`${info.label} model`} value={custom.model} models={available} onChange={(model) => setCustom(role, { model })} /></div>
              {role !== "helper" && <EffortRow label={`${info.label} effort`} models={available} model={custom.model} value={custom.reasoningEffort} onChange={(effort) => setCustom(role, { reasoningEffort: effort })} />}
            </div>
          )}
        </SettingRow>;
      })}
    </SettingList>
    {roles.error && <Notice tone="warning" className="mt-3" title="Couldn't check the models in use">{roles.error instanceof Error ? roles.error.message : String(roles.error)}</Notice>}
    <p className={cx(DS.field.help, "mt-3")}>
      {roles.data?.scheduleOverrides ? `${roles.data.scheduleOverrides} schedule${roles.data.scheduleOverrides === 1 ? " chooses its" : "s choose their"} own model; edit those in each schedule. ` : ""}
      Staged previews always run on GPT-6 Luna. The composer's quick switches are these three tiers.
    </p>
  </SettingsSection>;
}
