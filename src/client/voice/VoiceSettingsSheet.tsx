import { useEffect, useMemo } from "react";
import { ChevronDown, X } from "lucide-react";
import { useModelsQuery } from "../hooks/queries/useModels";
import { REASONING_EFFORT_LEVELS, resolveSupportedReasoningEffort, sortReasoningEfforts } from "../../shared/reasoning-effort";
import type { VoiceModeController } from "./useVoiceMode";
import type { VoiceSettings } from "./voice-api";
import { DS, cx } from "../design/tokens";

export interface HelmModelPreference {
  value: string;
  onChange(model: string): void;
}

export interface HelmEffortPreference {
  /** What each mode asks for now (settings, else Helm's defaults). */
  typed: string;
  spoken: string;
  /** Model the efforts apply to, when one is known: the open conversation's, else the chosen Helm model. */
  modelId?: string;
  error?: string | null;
  onChange(mode: "typed" | "spoken", effort: string): void;
}

/** Hands-free and Helm settings. Voice changes apply immediately, even mid-conversation. */
export function VoiceSettingsSheet({
  controller,
  helmModel,
  helmEfforts,
  onClose,
}: {
  controller: VoiceModeController;
  helmModel?: HelmModelPreference;
  helmEfforts?: HelmEffortPreference;
  onClose(): void;
}) {
  const { settings, status } = controller;
  const modelsQuery = useModelsQuery({ enabled: Boolean(helmModel || helmEfforts) });
  const models = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => !model.policy || model.policy.state === "enabled"),
    [modelsQuery.data],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const effortModel = helmEfforts?.modelId ? models.find((model) => model.id === helmEfforts.modelId) : undefined;
  const supportedEfforts = effortModel?.supportedReasoningEfforts;
  const effortOptions = (current: string) => {
    const levels = supportedEfforts?.length ? sortReasoningEfforts(supportedEfforts) : [...REASONING_EFFORT_LEVELS];
    // The saved level always shows, even when this model lacks it, so the picker never lies about the setting.
    return levels.includes(current) ? levels : [...levels, current];
  };
  const describeEffort = (current: string) => {
    const used = resolveSupportedReasoningEffort(current, supportedEfforts);
    return used && used !== current ? ` ${effortModel?.name ?? "This model"} doesn't have ${current}, so it uses ${used}.` : "";
  };

  const update = (patch: Partial<VoiceSettings>) => controller.updateSettings(patch);
  const voicesByAccent = ["American", "British"].map((accent) => ({
    accent,
    voices: (status?.voices ?? []).filter((voice) => voice.accent === accent),
  }));
  const label = cx(DS.text.sectionLabel, "font-medium text-text-muted");
  const help = "mt-1 text-[11px] text-text-faint";
  const field = cx(DS.field.input, DS.field.inputSize.md, "min-w-0 appearance-none truncate pl-2.5 pr-9 sm:text-sm");
  const selectArrow = <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Helm settings"
        className="flex h-full min-w-0 w-full flex-col overflow-hidden bg-bg-secondary text-text-primary sm:max-w-sm sm:border-l sm:border-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pt-5" style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}>
          <div className="text-sm font-semibold">Helm settings</div>
          <button type="button" onClick={onClose} aria-label="Close settings" className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}>
          {helmModel && (
            <div>
              <label htmlFor="helm-setting-model" className={label}>Helm model</label>
              <div className="relative mt-1">
                <select id="helm-setting-model" aria-describedby="helm-model-help" className={field} value={helmModel.value} onChange={(event) => helmModel.onChange(event.target.value)}>
                  <option value="">Auto (fast and cheap)</option>
                  {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                {selectArrow}
              </div>
              <div id="helm-model-help" className={help}>Used for new Helm conversations. Helm only coordinates; real work still goes to sessions on your default or chosen models.</div>
            </div>
          )}
          {helmEfforts && (
            <>
              <div className="border-t border-border pt-4 text-xs font-semibold text-text-secondary">Thinking effort</div>
              <div>
                <label htmlFor="helm-setting-typed-effort" className={label}>When you type</label>
                <div className="relative mt-1">
                  <select id="helm-setting-typed-effort" aria-describedby="helm-typed-effort-help" className={field} value={helmEfforts.typed} onChange={(event) => helmEfforts.onChange("typed", event.target.value)}>
                    {effortOptions(helmEfforts.typed).map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                  {selectArrow}
                </div>
                <div id="helm-typed-effort-help" className={help}>Replies you read in the chat, where a few more seconds buy a better answer.{describeEffort(helmEfforts.typed)}</div>
              </div>
              <div>
                <label htmlFor="helm-setting-spoken-effort" className={label}>Hands-free</label>
                <div className="relative mt-1">
                  <select id="helm-setting-spoken-effort" aria-describedby="helm-spoken-effort-help" className={field} value={helmEfforts.spoken} onChange={(event) => helmEfforts.onChange("spoken", event.target.value)}>
                    {effortOptions(helmEfforts.spoken).map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                  {selectArrow}
                </div>
                <div id="helm-spoken-effort-help" className={help}>Replies spoken aloud, including anything you type while hands-free is on. Lower keeps the silence short.{describeEffort(helmEfforts.spoken)}</div>
              </div>
              <div className={help.replace("mt-1 ", "")}>Helm sets the effort at the start of each turn, so a change applies to your next message in the same conversation.</div>
              {helmEfforts.error && <div role="alert" className="text-[11px] text-error">{helmEfforts.error}</div>}
            </>
          )}
          {settings && status ? (
            <>
              <div className="border-t border-border pt-4 text-xs font-semibold text-text-secondary">Hands-free voice</div>
              <div>
                <label htmlFor="voice-setting-voice" className={label}>Voice</label>
                <div className="relative mt-1">
                  <select id="voice-setting-voice" className={field} value={settings.voice} onChange={(event) => update({ voice: event.target.value })}>
                    {voicesByAccent.map(({ accent, voices }) => (
                      <optgroup key={accent} label={accent}>
                        {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.gender}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  {selectArrow}
                </div>
              </div>
              <div>
                <div className={label}>Speaking speed · {settings.speed.toFixed(2)}×</div>
                <input aria-label="Speaking speed" className="mt-2 w-full" type="range" min={0.8} max={1.3} step={0.05} value={settings.speed} onChange={(event) => update({ speed: Number(event.target.value) })} />
              </div>
              <div>
                <div className={label}>Patience</div>
                <input aria-label="Patience" className="mt-2 w-full" type="range" min={0} max={1} step={0.05} value={settings.patience} onChange={(event) => update({ patience: Number(event.target.value) })} />
                <div className="flex justify-between text-[11px] text-text-faint"><span>Answers quickly</span><span>Waits while you think</span></div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={settings.bargeIn} onChange={(event) => update({ bargeIn: event.target.checked })} />
                <span>Interrupt by talking<span className="block text-[11px] text-text-faint">Short reactions like “yeah” won't cut it off.</span></span>
              </label>
              <div>
                <label htmlFor="voice-setting-announce" className={label}>Announce Bridge updates</label>
                <div className="relative mt-1">
                  <select id="voice-setting-announce" aria-describedby="voice-announce-help" className={field} value={settings.announce} onChange={(event) => update({ announce: event.target.value as VoiceSettings["announce"] })}>
                    <option value="watched">Sessions Helm started or messaged</option>
                    <option value="all">All sessions</option>
                    <option value="off">Off</option>
                  </select>
                  {selectArrow}
                </div>
                <div id="voice-announce-help" className={help}>
                  {settings.announce === "watched" ? "Speaks up when a session this conversation dispatched finishes or needs you." : settings.announce === "all" ? "Speaks up when any session finishes or needs you." : "Session announcements are off."}
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={controller.echoSafe} onChange={(event) => controller.setEchoSafe(event.target.checked)} />
                <span>Echo-safe playback<span className="block text-[11px] text-text-faint">Lets it hear you over its own voice without headphones. Applies the next time hands-free starts.</span></span>
              </label>
              <div>
                <label htmlFor="voice-setting-connection" className={label}>Connection</label>
                <div className="relative mt-1">
                  <select id="voice-setting-connection" aria-describedby="voice-connection-help" className={field} value={controller.transportPreference} onChange={(event) => controller.setTransportPreference(event.target.value as "auto" | "websocket" | "http")}>
                    <option value="auto">Automatic</option>
                    <option value="websocket">WebSocket only</option>
                    <option value="http">HTTP streaming</option>
                  </select>
                  {selectArrow}
                </div>
                <div id="voice-connection-help" className={help}>Automatic tries WebSocket, then HTTP. Use HTTP streaming for strict proxies.</div>
              </div>
            </>
          ) : (
            <div className="border-t border-border pt-4 text-xs text-text-muted">Hands-free voice settings appear once the speech engine status has loaded.</div>
          )}
        </div>
      </div>
    </div>
  );
}
