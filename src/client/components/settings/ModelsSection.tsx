// Settings › Models: the three tiers (Fast, Standard, Deep) and what each kind of work runs on.
// Tiers are the composer's three presets; this is the only place they are edited. Every role picks
// a tier or a model of its own ("Custom"), edited in the same place for every role.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";
import { fetchModelRoles, refreshModels, type AppSettings, type ModelInfo } from "../../api";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { useModelClientInfoQuery } from "../../hooks/queries/useModelClientInfo";
import { queryKeys } from "../../queryClient";
import { timeAgo } from "../../time";
import { formatReasoningEffortLabel } from "../../reasoning-effort";
import { buildContextTierOptions, buildReasoningEffortOptions } from "../../lib/new-session-launch";
import {
  getContextTierLabel,
  modelSupportsLongContext,
  modelUsesDynamicSelection,
  type CopilotContextTier,
} from "../../../shared/copilot-context.js";
import { LaunchModelSelect, LaunchOptionRow } from "../shared/LaunchOptionControls";
import { MODEL_PRESET_SLOTS, type ModelPresetSlot } from "../../../shared/model-presets.js";
import {
  defaultRoleTier,
  isTierChoice,
  MODEL_ROLE_INFO,
  MODEL_TIER_INFO,
  type ModelRole,
  type ModelRoleCustom,
  type ModelRoles,
  type ResolvedModelRole,
} from "../../../shared/model-roles.js";
import { pickSecondOpinion } from "../../../shared/subagent-settings.js";
import { getModelFamilyLabel, type ModelFamily } from "../../../shared/model-families.js";
import { Button, ChoiceButton, Details, FormRow, Notice, SegmentedControl, SettingList } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { SettingsSection } from "./SettingsSection";
import { ModelMoveDisclosure } from "./ModelMoveDisclosure";

const ROLES_KEY = ["models", "roles"] as const;

/** The roles, in the order and groups the page shows them. */
const ROLE_GROUPS: ReadonlyArray<{ label: string; roles: readonly ModelRole[] }> = [
  { label: "Chats", roles: ["chat", "helm", "handsFree"] },
  { label: "Agent work", roles: ["background", "subagents", "reviewers", "helper"] },
];

/** New chats and Background checks keep a model of their own in their older settings; empty means this. */
const EMPTY_CUSTOM_LABEL: Partial<Record<ModelRole, string>> = {
  chat: "Copilot's default",
  background: "Cheapest available",
};

interface ModelChoice {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

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
  if (!parts.length) return "Rubber-duck runs on Copilot's pick from another model family.";
  return `Rubber-duck uses your strongest tier from the other family: ${parts.join(", ")}. Otherwise Copilot's pick.`;
}

type RoleValue = ModelPresetSlot | "automatic" | "custom";

function roleValue(draft: AppSettings, role: ModelRole): RoleValue {
  const choice = draft.modelRoles?.[role];
  if (isTierChoice(choice)) return choice.tier;
  if (choice) return "custom";
  if (role === "chat" || role === "background") return "custom";
  // Nobody chose: it runs on its default tier. Only Reviewers has a choice of its own ("Same as chat").
  return defaultRoleTier(role) ?? "automatic";
}

/** The model, effort and context a custom role is set to, wherever that role keeps them. */
function customChoice(draft: AppSettings, role: ModelRole): ModelChoice {
  if (role === "chat") return { model: draft.model ?? "", reasoningEffort: draft.reasoningEffort, contextTier: draft.contextTier };
  if (role === "background") return { model: draft.deferWorker?.model ?? "", reasoningEffort: draft.deferWorker?.reasoningEffort, contextTier: draft.deferWorker?.contextTier };
  const choice = draft.modelRoles?.[role];
  return choice && !isTierChoice(choice) ? { ...choice } : { model: "" };
}

function modelName(models: readonly ModelInfo[] | undefined, id: string): string {
  return models?.find((model) => model.id === id)?.name ?? id;
}

/** "Claude Opus 5.5 · High · long context" */
function describeChoice(choice: Partial<ModelChoice> | undefined, models: readonly ModelInfo[] | undefined): string | undefined {
  if (!choice?.model) return undefined;
  return [
    modelName(models, choice.model),
    formatReasoningEffortLabel(choice.reasoningEffort),
    choice.contextTier === "long_context" ? "long context" : undefined,
  ].filter(Boolean).join(" · ");
}

/** "High · 1M": a tier's effort and context in a few characters, for its tile. */
function shortSetup(choice: Partial<ModelChoice>, model: ModelInfo | undefined): string {
  const context = choice.contextTier === "long_context" ? getContextTierLabel(model, "long_context") : getContextTierLabel(model, "default");
  const size = context?.match(/\(([^)]+)\)/)?.[1];
  return [formatReasoningEffortLabel(choice.reasoningEffort) ?? "Model default", size].filter(Boolean).join(" · ");
}

/**
 * Model, effort and context: a tier's, or a role's own. Effort and context are button rows, one
 * button per level the model offers. A new model keeps the effort and context only when it
 * offers them. `emptyLabel` names what no model means; without it a model is required.
 */
function ModelChoiceFields({ idPrefix, name, models, value, onChange, emptyLabel, showEffort = true }: {
  idPrefix: string;
  name: string;
  models: readonly ModelInfo[];
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  emptyLabel?: string;
  showEffort?: boolean;
}) {
  const model = models.find((entry) => entry.id === value.model);
  const dynamic = modelUsesDynamicSelection(model);
  const effortOptions = buildReasoningEffortOptions(model?.supportedReasoningEfforts);
  // A saved level the model lacks stays visible, so the picker never hides the setting.
  if (value.reasoningEffort && !effortOptions.some((option) => option.value === value.reasoningEffort)) {
    effortOptions.push({ value: value.reasoningEffort, label: formatReasoningEffortLabel(value.reasoningEffort) ?? value.reasoningEffort });
  }
  const contextOptions = buildContextTierOptions(model);
  const setModel = (id: string) => {
    const next = models.find((entry) => entry.id === id);
    const supported = next?.supportedReasoningEfforts ?? [];
    onChange({
      model: id,
      ...(value.reasoningEffort && supported.includes(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
      ...(value.contextTier === "long_context" && modelSupportsLongContext(next) ? { contextTier: "long_context" as const } : {}),
    });
  };
  return (
    <div className="space-y-2">
      <FormRow label="Model" htmlFor={`${idPrefix}-model`}>
        <LaunchModelSelect id={`${idPrefix}-model`} ariaLabel={`${name} model`} models={models} value={value.model}
          placeholderLabel={emptyLabel ?? "Choose a model"} placeholderDisabled={!emptyLabel}
          unlistedModelId={value.model && !model ? value.model : undefined} onChange={setModel} />
      </FormRow>
      {showEffort && (
        <FormRow label="Effort">
          {dynamic
            ? <p className={cx(DS.text.meta, "pt-2")}>Chosen per request by this model.</p>
            : <LaunchOptionRow ariaLabel={`${name} effort`} options={effortOptions} selectedValue={value.reasoningEffort}
              onChange={(effort) => { if (effort) onChange({ ...value, reasoningEffort: effort }); }} />}
        </FormRow>
      )}
      {contextOptions.length > 0 && (
        <FormRow label="Context">
          <LaunchOptionRow<CopilotContextTier> ariaLabel={`${name} context`} options={contextOptions}
            selectedValue={value.contextTier ?? "default"}
            onChange={(tier) => { if (tier) onChange({ ...value, contextTier: tier }); }} />
        </FormRow>
      )}
    </div>
  );
}

export function ModelsSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const { data: models } = useModelsQuery();
  const available = useMemo(() => (models ?? []).filter((model) => model.policy?.state !== "disabled"), [models]);
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: ({ signal }) => fetchModelRoles(signal) });
  const resolved = new Map((roles.data?.roles ?? []).map((role) => [role.role, role]));
  const savedKey = JSON.stringify([draft.modelPresets, draft.modelRoles, draft.model, draft.reasoningEffort, draft.contextTier, draft.deferWorker]);
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ROLES_KEY }); }, [savedKey, queryClient]);

  const presets = draft.modelPresets ?? {};
  const [editing, setEditing] = useState<ModelPresetSlot>(draft.lastModelPreset ?? "preset2");
  const setPreset = (slot: ModelPresetSlot, choice: ModelChoice) => {
    const nextPresets = { ...presets };
    if (choice.model) nextPresets[slot] = { ...choice }; else delete nextPresets[slot];
    setDraft({ ...draft, modelPresets: nextPresets });
  };

  const setRole = (role: ModelRole, value: RoleValue) => {
    const nextRoles: ModelRoles = { ...draft.modelRoles };
    if (value === "preset1" || value === "preset2" || value === "preset3") {
      nextRoles[role] = { tier: value };
    } else {
      delete nextRoles[role];
      // Custom starts from what the role runs on now. New chats and Background checks already
      // hold it in their own settings, which a tier keeps up to date.
      if (value === "custom" && role !== "chat" && role !== "background") {
        const from = resolved.get(role);
        const tier = from?.tier ? presets[from.tier] : undefined;
        nextRoles[role] = {
          model: from?.model ?? available[0]?.id ?? "",
          ...(from?.reasoningEffort ? { reasoningEffort: from.reasoningEffort } : {}),
          ...(tier?.contextTier ?? from?.contextTier ? { contextTier: tier?.contextTier ?? from?.contextTier } : {}),
        };
      }
    }
    setDraft({ ...draft, modelRoles: nextRoles });
  };

  const setCustom = (role: ModelRole, choice: ModelChoice) => {
    if (role === "chat") {
      setDraft({ ...draft, model: choice.model || undefined, reasoningEffort: choice.reasoningEffort, contextTier: choice.contextTier });
      return;
    }
    if (role === "background") {
      setDraft({ ...draft, deferWorker: { ...choice, model: choice.model || undefined } });
      return;
    }
    const next: ModelRoleCustom = {
      model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      ...(choice.contextTier === "long_context" ? { contextTier: choice.contextTier } : {}),
    };
    setDraft({ ...draft, modelRoles: { ...draft.modelRoles, [role]: next } });
  };

  const allTiersSet = MODEL_PRESET_SLOTS.every((slot) => presets[slot]?.model);
  const recommended = () => {
    const nextRoles: ModelRoles = {};
    for (const group of ROLE_GROUPS) {
      for (const role of group.roles) {
        const tier = MODEL_ROLE_INFO[role].recommended;
        if (tier) nextRoles[role] = { tier };
      }
    }
    setDraft({ ...draft, modelRoles: nextRoles });
  };

  return <SettingsSection title="Models">
    <div className="space-y-6">
      <div>
        <h3 className={cx(DS.text.sectionLabel, "mb-2")}>Tiers</h3>
        <div role="group" aria-label="Tiers" className="grid grid-cols-3 gap-2">
          {MODEL_PRESET_SLOTS.map((slot) => {
            const preset = presets[slot];
            const model = available.find((entry) => entry.id === preset?.model);
            return <ChoiceButton key={slot} selected={editing === slot} onClick={() => setEditing(slot)}
              aria-label={`${MODEL_TIER_INFO[slot].label}: ${preset?.model ? modelName(models, preset.model) : "no model yet"}`}
              className="min-w-0 flex-col items-start gap-0 py-2">
              <span className={DS.text.meta}>{MODEL_TIER_INFO[slot].label}</span>
              <span className="w-full truncate font-semibold text-text-primary">{preset?.model ? modelName(models, preset.model) : "Choose a model"}</span>
              {preset?.model && <span className={cx(DS.text.meta, "w-full truncate")}>{shortSetup(preset, model)}</span>}
            </ChoiceButton>;
          })}
        </div>
        <div className={cx(DS.surface.inset, "mt-2 space-y-3 p-3")}>
          <h4 className="text-[13px] font-semibold text-text-primary">{MODEL_TIER_INFO[editing].label} tier</h4>
          <ModelChoiceFields key={editing} idPrefix={`tier-${editing}`} name={`${MODEL_TIER_INFO[editing].label} tier`} models={available}
            value={{ model: presets[editing]?.model ?? "", reasoningEffort: presets[editing]?.reasoningEffort, contextTier: presets[editing]?.contextTier }}
            onChange={(choice) => setPreset(editing, choice)} />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className={DS.text.sectionLabel}>What runs on which tier</h3>
          <Button size="sm" variant="ghost" disabled={!allTiersSet} title={allTiersSet ? undefined : "Set all three tiers first"} onClick={recommended}>Use recommended</Button>
        </div>
        <div className="space-y-5">
          {ROLE_GROUPS.map((group) => <section key={group.label} aria-labelledby={`role-group-${group.label}`}>
            <h4 id={`role-group-${group.label}`} className="mb-1 text-xs font-medium text-text-secondary">{group.label}</h4>
            <SettingList>
              {group.roles.map((role) => <RoleRow key={role} role={role} draft={draft} view={resolved.get(role)} models={models} available={available}
                onRole={(value) => setRole(role, value)} onCustom={(choice) => setCustom(role, choice)} />)}
            </SettingList>
          </section>)}
        </div>
        {roles.error && <Notice tone="warning" className="mt-3" title="Couldn't check the models in use">{roles.error instanceof Error ? roles.error.message : String(roles.error)}</Notice>}
        {!!roles.data?.scheduleOverrides && (
          <p className={cx(DS.field.help, "mt-3")}>
            {`${roles.data.scheduleOverrides} schedule${roles.data.scheduleOverrides === 1 ? " chooses its" : "s choose their"} own model.`}
          </p>
        )}
      </div>

      <ModelListFooter />
    </div>
  </SettingsSection>;
}

function RoleRow({ role, draft, view, models, available, onRole, onCustom }: {
  role: ModelRole;
  draft: AppSettings;
  view: ResolvedModelRole | undefined;
  models: readonly ModelInfo[] | undefined;
  available: readonly ModelInfo[];
  onRole: (value: RoleValue) => void;
  onCustom: (choice: ModelChoice) => void;
}) {
  const info = MODEL_ROLE_INFO[role];
  const value = roleValue(draft, role);
  const presets = draft.modelPresets ?? {};
  const custom = value === "custom" ? customChoice(draft, role) : undefined;
  const emptyLabel = EMPTY_CUSTOM_LABEL[role];
  const options = [
    ...MODEL_PRESET_SLOTS.map((slot) => ({ value: slot as RoleValue, label: MODEL_TIER_INFO[slot].label, disabled: !presets[slot]?.model, title: presets[slot]?.model ? undefined : "Set this tier first" })),
    ...(info.automaticLabel ? [{ value: "automatic" as RoleValue, label: info.automaticLabel, title: info.automatic }] : []),
    ...(role === "reviewers" ? [] : [{ value: "custom" as RoleValue, label: "Custom", title: "A model of its own" }]),
  ];
  const runsOn = value === "automatic"
    ? info.automatic
    : custom
      ? describeChoice(custom, models) ?? (emptyLabel ? `${emptyLabel}` : undefined)
      : describeChoice(view, models);
  // On a tier and no warning: whether anybody chose it is the only thing worth adding.
  const note = value !== "custom" && view?.source !== "automatic" && info.effortNote;
  return (
    <div className="@container/role min-w-0 py-3 first:pt-1 last:pb-0">
      <div className="flex min-w-0 flex-col gap-2 @[42rem]/role:flex-row @[42rem]/role:items-start @[42rem]/role:justify-between @[42rem]/role:gap-6">
        <div className="min-w-0">
          <div className={DS.setting.label}>{info.label}</div>
          <div className={DS.setting.hint}>{info.description}</div>
        </div>
        <div className="w-full shrink-0 @[42rem]/role:w-[22rem]">
          <SegmentedControl<RoleValue> ariaLabel={`${info.label} runs on`} options={options} value={value} fullWidth
            onChange={(next) => { if (next !== value) onRole(next); }} />
        </div>
      </div>
      {view?.warning
        ? <p className="mt-2 flex items-start gap-1.5 text-xs text-warning"><AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />{view.warning}</p>
        : runsOn && <p className={cx(DS.text.meta, "mt-2")}>
          {value === "automatic" ? runsOn : `Runs on ${runsOn}`}{view?.isDefault && value !== "custom" ? " · default" : ""}{note ? `. ${note}` : ""}
        </p>}
      {role === "reviewers" && (
        <Details label="Second opinion" className="mt-1">
          <p className={cx(DS.text.meta, "pt-1")}>{describeSecondOpinion(presets, available)}</p>
        </Details>
      )}
      {custom && (
        <div className={cx(DS.surface.inset, "mt-3 space-y-2 p-3")}>
          <ModelChoiceFields idPrefix={`role-${role}`} name={info.label} models={available} value={custom} onChange={onCustom}
            emptyLabel={emptyLabel} showEffort={role !== "helper"} />
        </div>
      )}
    </div>
  );
}

/** Refreshing the model list, and moving chats off a model. */
function ModelListFooter() {
  const { data: clientInfo } = useModelClientInfoQuery();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const loadedAt = clientInfo?.createdAt && Number.isFinite(Date.parse(clientInfo.createdAt)) ? clientInfo.createdAt : null;
  useEffect(() => {
    if (!loadedAt) return;
    const interval = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(interval);
  }, [loadedAt]);
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.models, await refreshModels());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
      // The client may have rotated even if listing models afterward failed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelClientInfo });
    }
  };
  return (
    <div className="space-y-2">
      <h3 className={DS.text.sectionLabel}>Model list</h3>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={DS.field.help}>
          {loadedAt ? `Loaded ${timeAgo(loadedAt)}` : ""}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}
          icon={<RotateCw size={13} className={refreshing ? "animate-spin" : undefined} />}>
          {refreshing ? "Refreshing" : "Refresh models"}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      <ModelMoveDisclosure />
    </div>
  );
}
