// What hands-free looks like now that it lives inside the app instead of taking it over: a
// dock above the Helm composer, and a small pill everywhere else. The transcript is the chat.
import { useState } from "react";
import { AlertTriangle, AudioLines, Download, Loader2, Mic, MicOff, Moon, PhoneOff, ShipWheel, Sun, VolumeX } from "lucide-react";
import type { VoiceModeController } from "./useVoiceMode";
import { VoiceOrb } from "./VoiceOrb";
import { formatBytes, VOICE_STATE_LABELS, type VoiceTurnMetrics } from "./voice-view-model";
import { DS, cx } from "../design/tokens";

function resolveOrbState(controller: VoiceModeController) {
  const { phase, view } = controller;
  if (phase === "connecting") return "starting" as const;
  if (phase === "active" || phase === "reconnecting") return view.voiceState;
  return phase === "ended" ? "ended" as const : "idle" as const;
}

export function describeHandsFreeState(controller: VoiceModeController): string {
  const { phase, view } = controller;
  if (phase === "reconnecting") return "Reconnecting…";
  if (phase === "connecting") return view.engine.state === "starting" ? "Loading speech models…" : "Connecting…";
  const activity = view.activity.at(-1)?.label;
  if (activity && view.voiceState === "thinking") return `${activity}…`;
  return VOICE_STATE_LABELS[resolveOrbState(controller)];
}

function CountPill({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={cx(DS.badge.base, "items-center gap-1.5 border-border bg-bg-surface text-text-secondary", value === 0 ? "opacity-50" : "")}>
      <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", tone)} />
      {value} {label}
    </span>
  );
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
    <div className="mt-2 rounded-lg border border-border bg-bg-surface p-2 text-[11px] text-text-muted">
      {rows.filter(([, value]) => typeof value === "number").map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4">
          <span>{label}</span>
          <span className="tabular-nums text-text-secondary">{Math.round(value!)} ms</span>
        </div>
      ))}
      {metrics.smartTurn.length > 0 && <div className="mt-1 text-text-faint">turn scores {metrics.smartTurn.join(" → ")} ({metrics.reason})</div>}
    </div>
  );
}

const ROUND_BUTTON = cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "min-w-10 gap-1.5");
const NEUTRAL_BUTTON = cx(ROUND_BUTTON, "border-border bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary");

function HandsFreeControls({ controller, onEnd, compact = false }: { controller: VoiceModeController; onEnd(): void; compact?: boolean }) {
  const { view } = controller;
  const asleep = view.voiceState === "asleep";
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={controller.toggleMic}
        aria-label={controller.micMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={controller.micMuted}
        className={controller.micMuted ? cx(ROUND_BUTTON, DS.button.variant.danger, "text-error") : NEUTRAL_BUTTON}
      >
        {controller.micMuted ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
      {view.voiceState === "speaking" && (
        <button type="button" onClick={() => controller.control("stop_speaking")} aria-label="Stop speaking" className={NEUTRAL_BUTTON}>
          <VolumeX size={15} />
        </button>
      )}
      {!compact && (
        <button type="button" onClick={() => controller.control(asleep ? "wake" : "sleep")} className={NEUTRAL_BUTTON}>
          {asleep ? <Sun size={14} /> : <Moon size={14} />}
          {asleep ? "Wake" : "Sleep"}
        </button>
      )}
      <button
        type="button"
        onClick={onEnd}
        aria-label="End hands-free"
        title="End hands-free and keep chatting"
        className={cx(ROUND_BUTTON, DS.button.variant.danger, "text-error hover:bg-error/20")}
      >
        <PhoneOff size={14} />
        {!compact && "End"}
      </button>
    </div>
  );
}

/** The full dock, shown above the Helm composer while hands-free is on. */
export function HandsFreeDock({ controller, onEnd }: { controller: VoiceModeController; onEnd(): void }) {
  const { view } = controller;
  const [showMetrics, setShowMetrics] = useState(false);
  const caption = view.caption;
  return (
    <section
      aria-label="Hands-free voice"
      data-hands-free-dock={resolveOrbState(controller)}
      className="shrink-0 border-t border-border bg-bg-secondary/95 px-3 py-2 backdrop-blur sm:px-4"
    >
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-[radial-gradient(circle_at_35%_35%,#1a2147_0%,#06070d_75%)] sm:h-16 sm:w-16">
          <VoiceOrb
            state={resolveOrbState(controller)}
            turnProbability={view.turnProbability}
            getMicLevel={() => controller.micLevelRef.current}
            getOutputLevel={controller.getOutputLevel}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary" role="status" aria-live="polite">
            {controller.phase === "connecting" && <Loader2 size={12} className="animate-spin" />}
            <span>{describeHandsFreeState(controller)}</span>
            {view.transport === "http" && <span className="text-[10px] font-normal text-text-faint">http</span>}
          </div>
          <div className="mt-0.5 line-clamp-2 min-h-[1.25rem] text-sm leading-snug text-text-primary">
            {caption
              ? <span className={caption.speaker === "user" ? "text-accent" : undefined}>{caption.speaker === "user" ? `“${caption.text}”` : caption.text}</span>
              : <span className="text-text-faint">Just talk. Pause mid-thought and it waits; talk over it to interrupt.</span>}
          </div>
        </div>
        <HandsFreeControls controller={controller} onEnd={onEnd} />
      </div>
      <div className="mx-auto mt-1.5 flex w-full max-w-4xl flex-wrap items-center gap-1.5">
        {view.counts && (
          <>
            <CountPill label="waiting" value={view.counts.waiting} tone="bg-warning" />
            <CountPill label="running" value={view.counts.running} tone="bg-info" />
            <CountPill label="unread" value={view.counts.unread} tone="bg-success" />
          </>
        )}
        {view.metrics && (
          <button
            type="button"
            onClick={() => setShowMetrics((value) => !value)}
            aria-expanded={showMetrics}
            className={cx("ml-auto rounded-md px-2 py-0.5 text-[11px]", showMetrics ? cx(DS.button.base, DS.button.size.sm, "bg-bg-hover text-text-primary") : cx(DS.button.base, DS.button.size.sm, "text-text-faint hover:bg-bg-hover hover:text-text-secondary"))}
          >
            Latency
          </button>
        )}
      </div>
      <div className="mx-auto w-full max-w-4xl">
        {showMetrics && view.metrics && <MetricsPanel metrics={view.metrics} />}
        {view.notice && (
          <div role={view.notice.level === "error" ? "alert" : "status"} className={cx("mt-1.5 text-[11px]", view.notice.level === "error" ? "text-error" : view.notice.level === "warning" ? "text-warning" : "text-text-muted")}>
            {view.notice.text}
          </div>
        )}
        {controller.echoWarning && <div className="mt-1.5 text-[11px] text-warning">{controller.echoWarning}</div>}
      </div>
    </section>
  );
}

/** Shown on every other page while hands-free is on, so you can keep talking as you browse. */
export function HandsFreePill({ controller, onOpenHelm, onEnd, bottomOffset }: {
  controller: VoiceModeController;
  onOpenHelm(): void;
  onEnd(): void;
  /** Distance from the viewport bottom, clearing the mobile navigation bar when it is shown. */
  bottomOffset: string;
}) {
  const caption = controller.view.caption;
  return (
    <div
      role="region"
      aria-label="Hands-free voice"
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-3"
      style={{ bottom: bottomOffset }}
    >
      <div className={cx(DS.surface.floating, "pointer-events-auto flex max-w-full items-center gap-2 py-1.5 pl-1.5 pr-2 backdrop-blur")}>
        <button
          type="button"
          onClick={onOpenHelm}
          title="Back to Helm"
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "min-w-0 gap-2 pr-1 text-left hover:opacity-90")}
        >
          <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[radial-gradient(circle_at_35%_35%,#1a2147_0%,#06070d_75%)]">
            <VoiceOrb
              state={resolveOrbState(controller)}
              turnProbability={controller.view.turnProbability}
              getMicLevel={() => controller.micLevelRef.current}
              getOutputLevel={controller.getOutputLevel}
            />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1 text-[11px] font-medium text-text-secondary">
              <ShipWheel size={11} aria-hidden="true" />
              {describeHandsFreeState(controller)}
            </span>
            {caption && <span className="block max-w-[38vw] truncate text-xs text-text-primary sm:max-w-xs">{caption.text}</span>}
          </span>
        </button>
        <HandsFreeControls controller={controller} onEnd={onEnd} compact />
      </div>
    </div>
  );
}

/** One-time speech engine install, offered the first time hands-free is requested. */
export function HandsFreeSetupPanel({ controller, onClose }: { controller: VoiceModeController; onClose(): void }) {
  const install = controller.status?.install;
  const progress = install?.progress;
  return (
    <section aria-label="Set up hands-free voice" className="shrink-0 border-t border-border bg-bg-secondary px-3 py-3 sm:px-4">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-start gap-3">
          <AudioLines size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary">Set up hands-free voice</div>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              Speech recognition, turn detection and voices all run on the computer hosting Bridge. Nothing you say leaves it except the text sent to your Copilot model. The same one-time setup also powers the chat mic.
            </p>
            {!install ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-text-muted"><Loader2 size={13} className="animate-spin" /> Checking the speech engine…</div>
            ) : !install.supported ? (
              <p className="mt-3 text-xs text-warning">Hands-free isn't supported on this host ({install.target}).</p>
            ) : install.installing && progress ? (
              <div className="mt-3 max-w-md">
                <div className="flex justify-between text-xs text-text-muted">
                  <span className="truncate">{progress.phase === "downloading" ? "Downloading" : progress.phase === "verifying" ? "Verifying" : "Unpacking"} {progress.label}</span>
                  <span className="tabular-nums">{Math.round(progress.overallFraction * 100)}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.overallFraction * 100)}>
                  <div className={cx(DS.meter.fill, "transition-[width] duration-500")} style={{ width: `${Math.max(2, progress.overallFraction * 100)}%` }} />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void controller.install()}
                disabled={install.installing}
                className={cx(DS.button.base, DS.button.size.md, DS.button.variant.primary, "mt-3 gap-2 disabled:opacity-60")}
              >
                {install.installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Download and set up ({formatBytes(install.remainingBytes || install.totalBytes)})
              </button>
            )}
            {(install?.error || controller.error) && (
              <p className="mt-2 flex items-start gap-1.5 break-words text-xs text-error"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{install?.error ?? controller.error}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}>Not now</button>
        </div>
      </div>
    </section>
  );
}
