// Hands-free settings: the voice, how it listens, announcements, and the names list. One set for
// every chat, saved on this Bridge (and shared with Tether). Voice changes apply at once, even
// mid-conversation. Shown in Settings › Voice and in a sheet from the hands-free dock.
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { VoiceModeController } from "./useVoiceMode";
import type { VoiceSettings } from "./voice-api";
import { patchHelmSettings, useHelmPreferences } from "../helm/helm-settings";
import { DS, cx } from "../design/tokens";

/** The names list: words speech recognition mishears, given to the hands-free layer and to Helm. */
function GlossaryField() {
  const preferences = useHelmPreferences();
  const saved = preferences.data?.settings.glossary ?? "";
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(saved), [saved]);
  const label = cx(DS.text.sectionLabel, "font-medium text-text-muted");
  if (!preferences.data) return null;
  return (
    <div>
      <label htmlFor="hands-free-setting-glossary" className={label}>Names to know</label>
      <textarea
        id="hands-free-setting-glossary"
        aria-describedby="hands-free-glossary-help"
        rows={3}
        maxLength={2000}
        className={cx(DS.field.input, DS.field.textarea, "mt-1 resize-y text-sm")}
        placeholder="timmiepc = my PC (sounds like Timmy PC); Tether = my iPhone app"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() === saved.trim()) return;
          setError(null);
          void patchHelmSettings({ glossary: draft }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
        }}
      />
      <div id="hands-free-glossary-help" className="mt-1 text-[11px] text-text-faint">Names you say, and how they sound.</div>
      {error && <div role="alert" className="text-[11px] text-error">{error}</div>}
    </div>
  );
}

/** Every hands-free setting, for a sheet or a settings page. */
export function HandsFreeSettingsFields({ controller }: { controller: VoiceModeController }) {
  const { settings, status } = controller;
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
    <div className="space-y-5">
      {controller.error && <div role="alert" className="text-xs text-error">{controller.error}</div>}
      {settings && status ? (
        <>
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
            <input aria-label="Speaking speed" className="mt-2 w-full" type="range" min={0.75} max={1.4} step={0.05} value={settings.speed} onChange={(event) => update({ speed: Number(event.target.value) })} />
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
              <select id="voice-setting-announce" className={field} value={settings.announce} onChange={(event) => update({ announce: event.target.value as VoiceSettings["announce"] })}>
                <option value="watched">Chats Helm started or messaged</option>
                <option value="all">All chats</option>
                <option value="off">Off</option>
              </select>
              {selectArrow}
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={controller.echoSafe} onChange={(event) => controller.setEchoSafe(event.target.checked)} />
            <span>Echo-safe playback<span className="block text-[11px] text-text-faint">Browser only. Applies the next time hands-free starts.</span></span>
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
            <div id="voice-connection-help" className={help}>Browser only. Use HTTP streaming for strict proxies.</div>
          </div>
        </>
      ) : (
        <div className="text-xs text-text-muted">Voice settings appear once the speech engine status has loaded.</div>
      )}
      <GlossaryField />
      <p className={help.replace("mt-1 ", "")}>
        Model: Hands-free row in <Link to="/settings?group=chat" className="text-accent hover:underline">Settings › Models</Link>.
      </p>
    </div>
  );
}

/** Hands-free settings in a side sheet, opened from the dock. */
export function VoiceSettingsSheet({ controller, onClose }: { controller: VoiceModeController; onClose(): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Hands-free settings"
        className="flex h-full min-w-0 w-full flex-col overflow-hidden bg-bg-secondary text-text-primary sm:max-w-sm sm:border-l sm:border-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pt-5" style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}>
          <div className="text-sm font-semibold">Hands-free settings</div>
          <button type="button" onClick={onClose} aria-label="Close settings" className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost)}>
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))", paddingLeft: "max(1.25rem, env(safe-area-inset-left))", paddingRight: "max(1.25rem, env(safe-area-inset-right))" }}>
          <p className="mb-5 text-xs text-text-muted">Shared by every chat and Tether.</p>
          <HandsFreeSettingsFields controller={controller} />
        </div>
      </div>
    </div>
  );
}
