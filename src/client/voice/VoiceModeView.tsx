import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
  Mic,
  MicOff,
  Moon,
  PhoneOff,
  Send,
  Settings2,
  Sun,
  VolumeX,
  X,
  AlertTriangle,
  Download,
} from "lucide-react";
import { useModelsQuery } from "../hooks/queries/useModels";
import { getAppAbsoluteUrl } from "../lib/app-url";
import { APP_PROSE } from "../components/shared/prose-classes";
import { useVoiceMode, type VoiceModeController } from "./useVoiceMode";
import { VoiceOrb } from "./VoiceOrb";
import { formatBytes, VOICE_STATE_LABELS, type VoiceItem, type VoiceTurnMetrics } from "./voice-view-model";
import type { VoiceSettings } from "./voice-api";

function CountPill({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/80 ${value === 0 ? "opacity-50" : ""}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {value} {label}
    </span>
  );
}

function TranscriptItem({ item }: { item: VoiceItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end max-w-[88%] rounded-2xl rounded-br-md border border-cyan-300/25 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-50">
          {item.text}
          {item.handled && <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-cyan-200/60">handled locally · {item.handled}</span>}
        </div>
      );
    case "assistant":
      return (
        <div className={`self-start max-w-[92%] rounded-2xl rounded-bl-md border border-fuchsia-300/15 bg-fuchsia-400/[0.07] px-3 py-2 text-sm text-white/90 ${item.interrupted ? "opacity-70" : ""}`}>
          {item.text || <span className="text-white/40">…</span>}
          {item.interrupted && <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-white/40">interrupted</span>}
        </div>
      );
    case "tool":
      return (
        <div className="self-start inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70">
          {item.status === "running" ? <Loader2 size={11} className="animate-spin" /> : item.status === "done" ? <Check size={11} className="text-emerald-300" /> : <X size={11} className="text-rose-300" />}
          {item.label}
        </div>
      );
    case "notice":
      return (
        <div className={`self-center text-center text-[11px] ${item.level === "error" ? "text-rose-300" : item.level === "warning" ? "text-amber-200" : "text-white/45"}`}>
          {item.text}
        </div>
      );
    case "card":
      return (
        <div className="self-stretch rounded-xl border border-white/15 bg-white/[0.06] p-3 shadow-lg shadow-black/30">
          <div className="text-sm font-semibold text-white">{item.title}</div>
          <div className={`${APP_PROSE} mt-1 max-w-none text-white/85 prose-pre:bg-black/40 prose-th:bg-black/30`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
          </div>
          {item.links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.links.map((link) => (
                <a
                  key={link.path}
                  href={getAppAbsoluteUrl(link.path).toString()}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-white/80 hover:bg-white/10"
                >
                  {link.label}
                  <ExternalLink size={10} />
                </a>
              ))}
            </div>
          )}
        </div>
      );
  }
}

function MetricsPanel({ metrics }: { metrics: VoiceTurnMetrics }) {
  const rows: Array<[string, number | undefined]> = [
    ["End of turn", metrics.endpointMs],
    ["Transcription", metrics.sttMs],
    ["Copilot first words", metrics.llmFirstTextMs],
    ["Voice first audio", metrics.ttsFirstMs],
    ["You stopped → it spoke", metrics.speechEndToFirstAudioMs],
  ];
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-2 text-[11px] text-white/60">
      {rows.filter(([, value]) => typeof value === "number").map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4">
          <span>{label}</span>
          <span className="tabular-nums text-white/80">{Math.round(value!)} ms</span>
        </div>
      ))}
      {metrics.smartTurn.length > 0 && <div className="mt-1 text-white/40">turn scores {metrics.smartTurn.join(" → ")} ({metrics.reason})</div>}
    </div>
  );
}

function SetupPanel({ controller }: { controller: VoiceModeController }) {
  const install = controller.status?.install;
  if (!install) return null;
  const progress = install.progress;
  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.05] p-5 text-white/85 backdrop-blur">
      <div className="text-base font-semibold text-white">Set up hands-free voice</div>
      <p className="mt-2 text-sm text-white/70">
        Speech recognition, turn detection and voices all run on the computer hosting Bridge. Nothing you say leaves it except the text sent to your Copilot model. The same one-time setup also powers the chat mic.
      </p>
      {!install.supported ? (
        <p className="mt-3 text-sm text-amber-200">Voice mode isn't supported on this host ({install.target}).</p>
      ) : install.installing && progress ? (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-white/60">
            <span className="truncate">{progress.phase === "downloading" ? "Downloading" : progress.phase === "verifying" ? "Verifying" : "Unpacking"} {progress.label}</span>
            <span className="tabular-nums">{Math.round(progress.overallFraction * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-400 transition-[width] duration-500" style={{ width: `${Math.max(2, progress.overallFraction * 100)}%` }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void controller.install()}
          disabled={install.installing}
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-cyan-400/15 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-400/25 disabled:opacity-60"
        >
          {install.installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Download and set up ({formatBytes(install.remainingBytes || install.totalBytes)})
        </button>
      )}
      {(install.error || controller.error) && <p className="mt-3 text-xs text-rose-300">{install.error ?? controller.error}</p>}
    </div>
  );
}

function SettingsSheet({ controller, onClose }: { controller: VoiceModeController; onClose(): void }) {
  const { settings, status } = controller;
  const modelsQuery = useModelsQuery();
  const models = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => !model.policy || model.policy.state === "enabled"),
    [modelsQuery.data],
  );
  if (!settings || !status) return null;
  const update = (patch: Partial<VoiceSettings>) => controller.updateSettings(patch);
  const voicesByAccent = ["American", "British"].map((accent) => ({
    accent,
    voices: status.voices.filter((voice) => voice.accent === accent),
  }));
  const label = "text-[11px] font-medium uppercase tracking-wide text-white/50";
  const field = "mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-sm text-white";
  return (
    <div className="absolute inset-0 z-20 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full max-w-sm overflow-y-auto border-l border-white/10 bg-[#0b0d18] p-5 text-white" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Voice settings</div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="mt-5 space-y-5">
          <div>
            <div className={label}>Voice</div>
            <select className={field} value={settings.voice} onChange={(event) => update({ voice: event.target.value })}>
              {voicesByAccent.map(({ accent, voices }) => (
                <optgroup key={accent} label={accent}>
                  {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.gender}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <div className={label}>Speaking speed · {settings.speed.toFixed(2)}×</div>
            <input className="mt-2 w-full" type="range" min={0.8} max={1.3} step={0.05} value={settings.speed} onChange={(event) => update({ speed: Number(event.target.value) })} />
          </div>
          <div>
            <div className={label}>Patience</div>
            <input className="mt-2 w-full" type="range" min={0} max={1} step={0.05} value={settings.patience} onChange={(event) => update({ patience: Number(event.target.value) })} />
            <div className="flex justify-between text-[11px] text-white/40"><span>Answers quickly</span><span>Waits while you think</span></div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={settings.bargeIn} onChange={(event) => update({ bargeIn: event.target.checked })} />
            <span>Interrupt by talking<span className="block text-[11px] text-white/45">Short reactions like “yeah” won't cut it off.</span></span>
          </label>
          <div>
            <div className={label}>Announce Bridge updates</div>
            <select className={field} value={settings.announce} onChange={(event) => update({ announce: event.target.value as VoiceSettings["announce"] })}>
              <option value="watched">Sessions I start or message by voice</option>
              <option value="all">Every session that finishes or needs me</option>
              <option value="off">Off</option>
            </select>
          </div>
          <div>
            <div className={label}>Assistant model</div>
            <select className={field} value={settings.model ?? ""} onChange={(event) => update({ model: event.target.value || undefined })}>
              <option value="">Auto (fast and cheap)</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            <div className="mt-1 text-[11px] text-white/40">Applies next time voice mode starts. Real work is still sent to sessions with your default or chosen models.</div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={controller.echoSafe} onChange={(event) => controller.setEchoSafe(event.target.checked)} />
            <span>Echo-safe playback<span className="block text-[11px] text-white/45">Lets it hear you over its own voice without headphones. Applies on next start.</span></span>
          </label>
          <div>
            <div className={label}>Connection</div>
            <select className={field} value={controller.transportPreference} onChange={(event) => controller.setTransportPreference(event.target.value as "auto" | "websocket" | "http")}>
              <option value="auto">Automatic (WebSocket, then HTTP)</option>
              <option value="websocket">WebSocket only</option>
              <option value="http">HTTP streaming (for strict proxies)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VoiceModeView() {
  const controller = useVoiceMode();
  const navigate = useNavigate();
  const { phase, view, status } = controller;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [view.items]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const exit = () => {
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    void controller.stop().finally(() => (historyIndex > 0 ? navigate(-1) : navigate("/")));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    controller.sendText(draft);
    setDraft("");
  };

  const active = phase === "active" || phase === "reconnecting";
  const orbState = phase === "connecting" ? "starting" : active ? view.voiceState : phase === "ended" ? "ended" : "idle";
  const stateLabel = phase === "reconnecting"
    ? "Reconnecting…"
    : phase === "connecting"
      ? view.engine.state === "starting" ? "Loading speech models…" : "Connecting…"
      : VOICE_STATE_LABELS[orbState];

  return (
    <div className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-[radial-gradient(1200px_800px_at_35%_40%,#131836_0%,#06070d_60%)] text-white">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={exit} aria-label="Leave voice mode" className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
            <ArrowLeft size={18} />
          </button>
          <div className="truncate text-sm font-semibold tracking-wide">Bridge Voice</div>
          {view.model && <span className="hidden truncate text-[11px] text-white/40 sm:inline">· {view.model}{view.transport === "http" ? " · http" : ""}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {view.counts && (
            <div className="hidden items-center gap-1.5 sm:flex">
              <CountPill label="waiting" value={view.counts.waiting} tone="bg-amber-300" />
              <CountPill label="running" value={view.counts.running} tone="bg-sky-300" />
              <CountPill label="unread" value={view.counts.unread} tone="bg-emerald-300" />
            </div>
          )}
          <button type="button" onClick={() => setShowMetrics((value) => !value)} className={`hidden rounded-md px-2 py-1 text-[11px] sm:block ${showMetrics ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10"}`}>
            Latency
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Voice settings" className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="relative flex min-h-[46vh] flex-1 flex-col items-center justify-center px-4">
          <div className="absolute inset-0">
            <VoiceOrb
              state={orbState}
              turnProbability={view.turnProbability}
              getMicLevel={() => controller.micLevelRef.current}
              getOutputLevel={controller.getOutputLevel}
            />
          </div>
          <div className="relative z-10 mt-auto flex w-full flex-col items-center gap-3 pb-6" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
            <div className="min-h-[3.5rem] max-w-2xl px-2 text-center text-lg leading-snug text-white [text-shadow:0_2px_18px_rgba(0,0,0,0.8)] sm:text-xl">
              {view.caption && active && (
                <span className={view.caption.speaker === "user" ? "text-cyan-100" : "text-white"}>
                  {view.caption.speaker === "user" ? `“${view.caption.text}”` : view.caption.text}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-white/55">
              {phase === "connecting" && <Loader2 size={12} className="animate-spin" />}
              <span>{stateLabel}</span>
            </div>

            {phase === "loading" && <Loader2 className="animate-spin text-white/60" />}
            {phase === "setup" && <SetupPanel controller={controller} />}
            {(phase === "ready" || phase === "ended" || phase === "error") && (
              <div className="flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={() => void controller.start()}
                  className="rounded-full border border-cyan-300/50 bg-cyan-400/15 px-7 py-3 text-base font-medium text-white shadow-[0_0_40px_rgba(56,189,248,0.25)] backdrop-blur hover:bg-cyan-400/25"
                >
                  {phase === "ended" ? "Start again" : "Start voice mode"}
                </button>
                {phase === "ready" && <div className="max-w-sm text-center text-xs text-white/45">One tap, then just talk. Pause mid-thought and it waits. Talk over it to interrupt. Say “go to sleep” to pause and “Hey Bridge” to wake it.</div>}
                {phase === "ended" && view.ended && <div className="text-xs text-white/45">{view.ended}</div>}
                {controller.error && <div className="flex max-w-md items-center gap-2 text-xs text-rose-300"><AlertTriangle size={13} />{controller.error}</div>}
              </div>
            )}
            {active && (
              <div className="flex items-center gap-2">
                <button type="button" onClick={controller.toggleMic} aria-label={controller.micMuted ? "Unmute microphone" : "Mute microphone"} className={`rounded-full border px-3 py-2 ${controller.micMuted ? "border-rose-300/40 bg-rose-400/15 text-rose-100" : "border-white/15 bg-white/5 text-white/80 hover:bg-white/10"}`}>
                  {controller.micMuted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                {view.voiceState === "speaking" && (
                  <button type="button" onClick={() => controller.control("stop_speaking")} aria-label="Stop speaking" className="rounded-full border border-white/15 bg-white/5 px-3 py-2 text-white/80 hover:bg-white/10">
                    <VolumeX size={16} />
                  </button>
                )}
                <button type="button" onClick={() => controller.control(view.voiceState === "asleep" ? "wake" : "sleep")} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10">
                  {view.voiceState === "asleep" ? <Sun size={14} /> : <Moon size={14} />}
                  {view.voiceState === "asleep" ? "Wake" : "Sleep"}
                </button>
                <button type="button" onClick={exit} className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100 hover:bg-rose-400/20">
                  <PhoneOff size={14} />
                  End
                </button>
              </div>
            )}
            {controller.echoWarning && active && <div className="max-w-md text-center text-[11px] text-amber-200/80">{controller.echoWarning}</div>}
          </div>
        </section>

        <aside className="flex max-h-[42vh] min-h-0 w-full shrink-0 flex-col border-t border-white/10 bg-black/20 md:max-h-none md:w-[400px] md:border-l md:border-t-0">
          <div className="flex items-center justify-between px-4 pb-2 pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">Conversation</div>
            {view.counts && (
              <div className="flex items-center gap-1.5 sm:hidden">
                <CountPill label="waiting" value={view.counts.waiting} tone="bg-amber-300" />
                <CountPill label="unread" value={view.counts.unread} tone="bg-emerald-300" />
              </div>
            )}
          </div>
          <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-3">
            {view.items.length === 0 && (
              <div className="mt-6 text-center text-xs text-white/35">
                Try “what's new?”, “read me the Tellus reply”, or “have Opus fix the flaky test in the Star Realms task”.
              </div>
            )}
            {view.items.map((item) => <TranscriptItem key={item.id} item={item} />)}
            {showMetrics && view.metrics && <MetricsPanel metrics={view.metrics} />}
          </div>
          {active && (
            <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-white/10 p-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Or type to it…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/35"
              />
              <button type="submit" aria-label="Send" className="rounded-lg border border-white/15 bg-white/5 p-2 text-white/80 hover:bg-white/10">
                <Send size={15} />
              </button>
            </form>
          )}
        </aside>
      </main>

      {settingsOpen && status && <SettingsSheet controller={controller} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
