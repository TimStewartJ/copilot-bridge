import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, RotateCw } from "lucide-react";
import { fetchModelAbTestReport, fetchModelRoles, rejudgeModelAbTest, refreshModels, type AppSettings, type ModelInfo } from "../../api";
import { settingsWriter } from "../../hooks/queries/useSettings";
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
import {
  DEFAULT_MODEL_AB_TEST_ARMS,
  MODEL_AB_TEST_ARMS,
  MODEL_COMPARISON_JUDGE_COUNT,
  type ModelAbTestArm,
  type ModelAbTestArmChoice,
  type ModelAbTestRecentPair,
  type ModelAbTestReport,
  type ModelAbTestSettings,
} from "../../../shared/model-ab-test.js";
import { COPILOT_AI_CREDIT_USD } from "../../../shared/copilot-pricing.js";
import { canBeBestModel, modelMaker, modelMakerLabel, resolveBestModels, type BestModels } from "../../../shared/best-models.js";
import { formatDuration } from "../../lib/tool-presentation";
import { formatUsageCount, formatUsageUsd } from "../../lib/usage-presentation";
import { Button, ChoiceButton, Details, Field, FieldList, FormRow, MetaLine, Notice, SegmentedControl, SettingList, SettingRow, Switch } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { SettingsSection } from "./SettingsSection";
import { ModelMoveDisclosure } from "./ModelMoveDisclosure";

const ROLES_KEY = ["models", "roles"] as const;

/** The roles, in the order and groups the page shows them. */
const ROLE_GROUPS: ReadonlyArray<{ label: string; roles: readonly ModelRole[] }> = [
  { label: "Chats", roles: ["chat", "helm", "handsFree"] },
  { label: "Agent work", roles: ["background", "subagents", "reviewers", "helper"] },
];

/** New chats and Trigger workers keep their own model in older settings; empty means this. */
const EMPTY_CUSTOM_LABEL: Partial<Record<ModelRole, string>> = {
  chat: "Copilot's default",
  background: "Cheapest available",
};

interface ModelChoice {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

/** Which tier rubber-duck uses in Claude and GPT chats: the strongest of the other family. */
function describeSecondOpinion(presets: NonNullable<AppSettings["modelPresets"]>, models: readonly ModelInfo[]): string {
  // As on the server: with a model list, a tier whose model is not on it is skipped.
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
  // Unset runs on the default tier; only Reviewers has its own choice ("Same as chat").
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
    formatReasoningEffortLabel(choice.reasoningEffort, models?.find((model) => model.id === choice.model)),
    choice.contextTier === "long_context" ? "long context" : undefined,
  ].filter(Boolean).join(" · ");
}

/** "High · 1M": a tier's effort and context in a few characters, for its tile. */
function shortSetup(choice: Partial<ModelChoice>, model: ModelInfo | undefined): string {
  const context = choice.contextTier === "long_context" ? getContextTierLabel(model, "long_context") : getContextTierLabel(model, "default");
  const size = context?.match(/\(([^)]+)\)/)?.[1];
  return [formatReasoningEffortLabel(choice.reasoningEffort, model) ?? "Model default", size].filter(Boolean).join(" · ");
}

/** emptyLabel names what no model means; without it a model is required. */
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
  // A routed model without levels of its own (plain Auto) chooses everything per request.
  const choosesPerRequest = modelUsesDynamicSelection(model) && !model?.supportedReasoningEfforts?.length;
  const effortOptions = buildReasoningEffortOptions(model?.supportedReasoningEfforts, model);
  // A saved level the model lacks stays visible, so the picker never hides the setting.
  if (value.reasoningEffort && !effortOptions.some((option) => option.value === value.reasoningEffort)) {
    effortOptions.push({ value: value.reasoningEffort, label: formatReasoningEffortLabel(value.reasoningEffort, model) ?? value.reasoningEffort });
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
          {choosesPerRequest
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
      // Custom starts from the current model; new chats and Trigger workers already store theirs.
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
      </div>

      <BestModelsBlock draft={draft} setDraft={setDraft} models={models} />

      <ModelAbTestBlock draft={draft} setDraft={setDraft} models={models} />

      <ModelListFooter presets={presets} />
    </div>
  </SettingsSection>;
}

/** Each maker's best model, which Compare models judges with; the user can change any of them. */
function BestModelsBlock({ draft, setDraft, models }: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
  models: readonly ModelInfo[] | undefined;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const stored: BestModels = draft.bestModels ?? {};
  const resolved = resolveBestModels(models, stored);
  const makers = [...resolved.map((entry) => entry.maker), ...Object.keys(stored).filter((maker) => !resolved.some((entry) => entry.maker === maker))];
  const save = (next: BestModels) => setDraft({ ...draft, bestModels: next });
  const reset = (maker: string) => {
    const { [maker]: _dropped, ...rest } = stored;
    save(rest);
  };
  if (makers.length === 0) return null;
  return (
    <div>
      <h3 className={cx(DS.text.sectionLabel, "mb-1")}>Best model per family</h3>
      <SettingList>
        {makers.map((maker) => {
          const entry = resolved.find((candidate) => candidate.maker === maker);
          const label = modelMakerLabel(maker);
          const choices = (models ?? []).filter((model) => modelMaker(model.id) === maker && canBeBestModel(model));
          const runs = entry ? describeChoice(entry, models) : undefined;
          const open = editing === maker;
          return (
            <SettingRow key={maker} label={label} labelId={`best-model-${maker}`}
              hint={entry ? `${runs}${entry.custom ? "" : " · default"}` : `${modelName(models, stored[maker]!.model)} is not available`}
              control={<div className="flex items-center gap-1">
                {stored[maker] && <Button size="sm" variant="ghost" onClick={() => { reset(maker); setEditing(null); }}>Reset</Button>}
                {entry && <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setEditing(open ? null : maker)}>{open ? "Done" : "Edit"}</Button>}
              </div>}>
              {open && entry && (
                <div className={cx(DS.surface.inset, "space-y-2 p-3")}>
                  <ModelChoiceFields idPrefix={`best-model-${maker}`} name={`${label} best model`} models={choices}
                    value={stored[maker] ?? { model: entry.model, reasoningEffort: entry.reasoningEffort, contextTier: entry.contextTier }}
                    onChange={(choice) => save({ ...stored, [maker]: { model: choice.model, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}), ...(choice.contextTier === "long_context" ? { contextTier: choice.contextTier } : {}) } })} />
                </div>
              )}
            </SettingRow>
          );
        })}
      </SettingList>
    </div>
  );
}

// copy-ok: says which chats the test doubles, a scope and cost the reader cannot see
const AB_TEST_SCOPE = "Chats you start also run on the other arm; two judges compare the first replies.";

type ArmValue = ModelPresetSlot | "custom";

function armLabel(choice: ModelAbTestArmChoice, models: readonly ModelInfo[] | undefined): string {
  return isTierChoice(choice) ? MODEL_TIER_INFO[choice.tier].label : modelName(models, choice.model);
}

/** Runs each chat the user starts on both arms, so the two are compared on the same request. */
function ModelAbTestBlock({ draft, setDraft, models }: {
  draft: AppSettings;
  setDraft: (draft: AppSettings) => void;
  models: readonly ModelInfo[] | undefined;
}) {
  const presets = draft.modelPresets ?? {};
  const available = (models ?? []).filter((model) => model.policy?.state !== "disabled");
  const test: ModelAbTestSettings = draft.modelAbTest ?? { enabled: false, ...DEFAULT_MODEL_AB_TEST_ARMS };
  const pins = test.judges ?? [];
  const queryClient = useQueryClient();
  const report = useQuery({
    queryKey: queryKeys.modelAbTest(test.startedAt ?? null, JSON.stringify([pins, draft.bestModels ?? {}])),
    // Waits for a pin change to save, so the judges shown are the ones that would judge.
    queryFn: async ({ signal }) => { await settingsWriter.whenIdle(); return fetchModelAbTestReport(signal); },
    refetchInterval: (query) => (query.state.data?.rejudge?.running ? 5_000 : false),
  });
  const rejudging = report.data?.rejudge?.running ?? false;
  useEffect(() => {
    if (!rejudging) void queryClient.invalidateQueries({ queryKey: ["model-comparison"] });
  }, [rejudging, queryClient]);
  const rejudge = useMutation({
    mutationFn: async () => { await settingsWriter.whenIdle(); return rejudgeModelAbTest(); },
    onSuccess: () => { void report.refetch(); },
  });
  const [judgeMode, setJudgeMode] = useState<"auto" | "custom">(pins.length > 0 ? "custom" : "auto");
  const setPin = (index: number, id: string) => {
    const next = [...pins];
    next[index] = id;
    save({ judges: [...new Set(next.filter(Boolean))] });
  };
  // A router picks a model per request, so it never judges.
  const judgeOptions = available.filter((model) => !modelUsesDynamicSelection(model));
  const judgeNames = (report.data?.judges ?? []).map((judge) => modelName(models, judge.model)).join(", ");
  const save = (next: Partial<ModelAbTestSettings>) => setDraft({ ...draft, modelAbTest: { ...test, ...next } });
  const runs = (choice: ModelAbTestArmChoice) => (isTierChoice(choice) ? presets[choice.tier]?.model : choice.model);
  const ready = Boolean(runs(test.a) && runs(test.b));
  const setArm = (arm: ModelAbTestArm, value: ArmValue) => {
    const current = test[arm];
    if (value !== "custom") return save({ [arm]: { tier: value } });
    if (!isTierChoice(current)) return;
    const from = presets[current.tier];
    save({ [arm]: from?.model ? { ...from } : { model: available[0]?.id ?? "" } });
  };
  const armOptions = MODEL_PRESET_SLOTS.map((slot) => ({
    value: slot as ArmValue,
    label: MODEL_TIER_INFO[slot].label,
    disabled: !presets[slot]?.model,
    title: presets[slot]?.model ? undefined : "Set this tier first",
  })).concat([{ value: "custom", label: "Custom", disabled: false, title: "Any model, so a new one can be tried" }]);
  return (
    <div>
      <h3 className={cx(DS.text.sectionLabel, "mb-1")}>Compare models</h3>
      <SettingList>
        <SettingRow label="Side by side" htmlFor="model-ab-test" hint={AB_TEST_SCOPE}
          control={<Switch id="model-ab-test" checked={test.enabled} disabled={!test.enabled && !ready}
            onChange={(event) => save({ enabled: event.target.checked })} />} />
        {MODEL_AB_TEST_ARMS.map((arm) => {
          const choice = test[arm];
          return (
            <div key={arm} className="py-3 first:pt-1 last:pb-0">
              <SettingRow label={arm.toUpperCase()} labelId={`model-ab-test-${arm}`}
                control={<SegmentedControl<ArmValue> ariaLabel={`Arm ${arm.toUpperCase()}`} options={armOptions}
                  value={isTierChoice(choice) ? choice.tier : "custom"} disabled={test.enabled} onChange={(value) => setArm(arm, value)} />} />
              {!isTierChoice(choice) && (
                <div className={cx(DS.surface.inset, "mt-2 p-3", test.enabled && "pointer-events-none opacity-60")}>
                  <ModelChoiceFields idPrefix={`model-ab-test-${arm}`} name={`Arm ${arm.toUpperCase()}`} models={available}
                    value={choice} onChange={(next) => save({ [arm]: next })} />
                </div>
              )}
            </div>
          );
        })}
        <div className="py-3 last:pb-0">
          <SettingRow label="Judges" labelId="model-ab-test-judges" hint={judgeNames || undefined}
            control={<SegmentedControl<"auto" | "custom"> ariaLabel="Judges" value={judgeMode}
              options={[{ value: "auto", label: "Automatic" }, { value: "custom", label: "Custom" }]}
              onChange={(mode) => { setJudgeMode(mode); if (mode === "auto") save({ judges: [] }); }} />} />
          {judgeMode === "custom" && (
            <div className={cx(DS.surface.inset, "mt-2 space-y-2 p-3")}>
              {Array.from({ length: MODEL_COMPARISON_JUDGE_COUNT }, (_, index) => (
                <FormRow key={index} label={`Judge ${index + 1}`} htmlFor={`model-ab-test-judge-${index}`}>
                  <LaunchModelSelect id={`model-ab-test-judge-${index}`} ariaLabel={`Judge ${index + 1} model`} models={judgeOptions}
                    value={pins[index] ?? ""} placeholderLabel="Automatic" placeholderDisabled={false}
                    unlistedModelId={pins[index] && !judgeOptions.some((model) => model.id === pins[index]) ? pins[index] : undefined}
                    onChange={(id) => setPin(index, id)} />
                </FormRow>
              ))}
            </div>
          )}
        </div>
      </SettingList>
      {report.data?.startedAt && report.data.startedAt === test.startedAt && (
        <ModelAbTestResults report={report.data} running={test.enabled} models={models}
          onRejudge={() => rejudge.mutate()} rejudgePending={rejudge.isPending} />
      )}
      {rejudge.error && <p role="alert" className="mt-2 text-xs text-error">{rejudge.error instanceof Error ? rejudge.error.message : String(rejudge.error)}</p>}
      {report.error && <p role="alert" className="mt-2 text-xs text-error">{report.error instanceof Error ? report.error.message : String(report.error)}</p>}
    </div>
  );
}

function pairOutcome(pair: ModelAbTestRecentPair): string {
  if (pair.winner) {
    const who = pair.decidedBy === "user" ? "you" : "judges";
    if (pair.winner === "split") return "Judges split";
    return pair.winner === "tie" ? `Tie (${who})` : `${pair.winner.toUpperCase()} won (${who})`;
  }
  if (pair.status === "failed" || pair.status === "incomplete") return "Not compared";
  return "Running";
}

function ModelAbTestResults({ report, running, models, onRejudge, rejudgePending }: {
  report: ModelAbTestReport;
  running: boolean;
  models: readonly ModelInfo[] | undefined;
  onRejudge: () => void;
  rejudgePending: boolean;
}) {
  const progress = report.rejudge;
  return (
    <div className="mt-3">
      <MetaLine items={[
        `Started ${timeAgo(report.startedAt ?? undefined)}`,
        !running && "Stopped",
        formatUsageCount(report.pairs, "pair"),
        report.pending > 0 && `${report.pending} running`,
        report.unusable > 0 && `${report.unusable} not compared`,
      ]} />
      <FieldList className="mt-1">
        {report.arms.map((arm) => (
          <Field key={arm.arm} label={`${arm.arm.toUpperCase()} · ${armLabel(arm.choice, models)}`} stacked>
            <MetaLine items={[
              describeChoice(arm.setup, models),
              arm.decided > 0 && `Won ${arm.wins} of ${arm.decided}`,
              arm.ties > 0 && formatUsageCount(arm.ties, "tie"),
              arm.splits > 0 && formatUsageCount(arm.splits, "split"),
              arm.userWins > 0 && `${arm.userWins} by your vote`,
              arm.medianDurationMs !== undefined && `${formatDuration(arm.medianDurationMs, { wholeSeconds: true })} per reply`,
              arm.medianAiCredits !== undefined && `${formatUsageUsd(arm.medianAiCredits * COPILOT_AI_CREDIT_USD)} per reply`,
            ]} />
          </Field>
        ))}
      </FieldList>
      {report.agreement.length > 0 && (
        <MetaLine className="mt-1" items={report.agreement.map((entry) => `${modelName(models, entry.model)} agreed with you ${entry.agreed} of ${entry.votes}`)} />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon={<RotateCw size={14} />} disabled={rejudgePending || progress?.running || report.pairs === 0}
          onClick={onRejudge}>
          Re-judge all
        </Button>
        {progress && (
          <MetaLine items={[
            progress.running ? `Re-judging ${progress.done + progress.skipped} of ${progress.total}` : `Re-judged ${progress.done} of ${progress.total}`,
            progress.skipped > 0 && `${progress.skipped} kept as they were`,
          ]} />
        )}
      </div>
      {report.recent.length > 0 && (
        <Details label="Recent pairs" className="mt-2">
          <ul className={DS.surface.divided}>
            {report.recent.map((pair) => (
              <li key={pair.id} className="flex min-w-0 items-center gap-2">
                <Link to={`/sessions/${pair.mainSessionId}`} className={cx(DS.row.base, DS.row.interactive, "flex-1")}>
                  <span className={cx(DS.row.detail, "text-text-primary")}>{pair.reason || pair.failure || timeAgo(pair.createdAt)}</span>
                  <span className={DS.row.trailing}>{pairOutcome(pair)}</span>
                </Link>
                {pair.twinSessionId && (
                  <Link to={`/sessions/${pair.twinSessionId}`} title="Open the second chat"
                    className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "shrink-0")}>
                    Y
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
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
function ModelListFooter({ presets }: { presets: NonNullable<AppSettings["modelPresets"]> }) {
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
      // Who would judge depends on the list.
      void queryClient.invalidateQueries({ queryKey: ["model-ab-test"] });
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
      <ModelMoveDisclosure presets={presets} />
    </div>
  );
}
