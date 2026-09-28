import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  createVoiceConversation,
  fetchVoiceStatus,
  startVoiceInstall,
  type VoiceConversationTicket,
  type VoiceSettings,
  type VoiceStatus,
  type VoiceTransportPreference,
} from "./voice-api";
import { describeVoiceCaptureError } from "../hooks/useVoiceInput";
import { VoiceAudio, type VoiceAudioStartResult } from "./voice-audio";
import { connectVoiceTransport, type VoiceTransport, type VoiceTransportHandlers } from "./voice-transport";
import { initialVoiceViewState, reduceVoiceEvent, type VoiceViewState } from "./voice-view-model";
import { patchHelmSettings, refreshHelmSettings, useHelmPreferences } from "../helm/helm-settings";
import { HELM_SETTINGS_DEFAULTS, type HelmSettingsResponse, type UnifiedHelmSettings } from "../../shared/helm-settings";

export type VoiceSessionPhase = "loading" | "setup" | "ready" | "connecting" | "active" | "reconnecting" | "ended" | "error";

type ViewAction = { type: "event"; event: Record<string, any> } | { type: "reset" };

function viewReducer(state: VoiceViewState, action: ViewAction): VoiceViewState {
  if (action.type === "reset") return initialVoiceViewState;
  return reduceVoiceEvent(state, action.event);
}

const RECONNECT_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000, 15_000];

/**
 * Controller for hands-free voice. It attaches to one Helm conversation at a time and holds
 * no conversation context itself, so starting and stopping it never loses anything.
 */
export function useVoiceMode() {
  const preferences = useHelmPreferences();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<VoiceSessionPhase>("loading");
  const [helmSessionId, setHelmSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [transportPreference, setTransportPreferenceState] = useState<VoiceTransportPreference>(HELM_SETTINGS_DEFAULTS.transport);
  const [echoSafe, setEchoSafeState] = useState(HELM_SETTINGS_DEFAULTS.echoSafe);
  const [micMuted, setMicMuted] = useState(false);
  const [echoWarning, setEchoWarning] = useState<string | null>(null);
  const [view, dispatch] = useReducer(viewReducer, initialVoiceViewState);

  const audioRef = useRef<VoiceAudio | null>(null);
  const transportRef = useRef<VoiceTransport | null>(null);
  const ticketRef = useRef<VoiceConversationTicket | null>(null);
  const micLevelRef = useRef(0);
  const endedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);
  const settingsRef = useRef<VoiceSettings | null>(null);
  const handlersRef = useRef<VoiceTransportHandlers | null>(null);
  // Read at Start and on reconnect, which can run before React re-renders with fresh settings.
  const playbackPreferences = useRef({ echoSafe, transport: transportPreference });

  const applyPreferences = useCallback((data: HelmSettingsResponse) => {
    const { voice, speed, patience, bargeIn, announce, echoSafe: nextEchoSafe, transport } = data.settings;
    const next = { voice, speed, patience, bargeIn, announce };
    settingsRef.current = next;
    setSettings(next);
    playbackPreferences.current = { echoSafe: nextEchoSafe, transport };
    setTransportPreferenceState(transport);
    setEchoSafeState(nextEchoSafe);
    return next;
  }, []);

  useEffect(() => {
    if (preferences.data) applyPreferences(preferences.data);
  }, [preferences.data, applyPreferences]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshStatus = useCallback(async () => {
    try {
      const [next, unified] = await Promise.all([fetchVoiceStatus(), refreshHelmSettings()]);
      setStatus(next);
      applyPreferences(unified);
      setPhase((current) => {
        if (current === "loading" || current === "setup" || current === "ready") {
          return next.install.installed ? "ready" : "setup";
        }
        return current;
      });
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase((current) => (current === "loading" ? "error" : current));
      return null;
    }
  }, [applyPreferences]);

  useEffect(() => {
    if (!status?.install.installing) return;
    const timer = window.setInterval(() => void refreshStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus, status?.install.installing]);

  const install = useCallback(async () => {
    setError(null);
    try {
      await startVoiceInstall();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refreshStatus();
  }, [refreshStatus]);

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      wakeLockRef.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const teardown = useCallback(async () => {
    window.clearTimeout(reconnectTimerRef.current);
    transportRef.current?.close();
    transportRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    await audio?.close();
    await wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const connect = useCallback(async (ticket: VoiceConversationTicket) => {
    transportRef.current?.close();
    transportRef.current = null;
    let transport: VoiceTransport | null = null;
    const scoped: VoiceTransportHandlers = {
      onEvent: (event) => handlersRef.current?.onEvent(event),
      onAudio: (message) => handlersRef.current?.onAudio(message),
      onClose: (reason) => {
        // A replaced or abandoned transport must not tear down its successor.
        if (transport && transportRef.current === transport) handlersRef.current?.onClose(reason);
      },
    };
    transport = await connectVoiceTransport(ticket, scoped, playbackPreferences.current.transport);
    transportRef.current = transport;
    reconnectAttemptRef.current = 0;
    return transport;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (endedRef.current || !ticketRef.current) return;
    const attempt = reconnectAttemptRef.current++;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setPhase("error");
      setError("Lost the connection to Bridge.");
      setHelmSessionId(null);
      ticketRef.current = null;
      void teardown();
      return;
    }
    setPhase("reconnecting");
    reconnectTimerRef.current = window.setTimeout(() => {
      const ticket = ticketRef.current;
      if (!ticket || endedRef.current) return;
      void connect(ticket).then(
        () => setPhase("active"),
        () => scheduleReconnect(),
      );
    }, RECONNECT_DELAYS_MS[attempt]);
  }, [connect, teardown]);

  handlersRef.current = {
    onEvent: (event) => {
      dispatch({ type: "event", event });
      const audio = audioRef.current;
      switch (event.type) {
        case "duck":
          audio?.duck(!!event.on);
          break;
        case "stop_audio":
          audio?.stopGeneration(event.genId);
          break;
        case "earcon":
          audio?.earcon(event.kind);
          break;
        case "ended":
          endedRef.current = true;
          audio?.earcon("end");
          setPhase("ended");
          setHelmSessionId(null);
          ticketRef.current = null;
          window.setTimeout(() => void teardown(), 400);
          break;
      }
    },
    onAudio: (message) => {
      audioRef.current?.playChunk(message.genId, message.chunkId, message.sampleRate, message.pcm);
    },
    onClose: () => {
      transportRef.current = null;
      if (!endedRef.current) scheduleReconnect();
    },
  };

  /**
   * Starts hands-free for a Helm conversation. The id may be a promise-returning function so the
   * caller can create the conversation on demand: audio has to start inside the tap that asked
   * for it (iOS will not resume an AudioContext after a network wait), so that happens first.
   */
  const start = useCallback(async (target: string | (() => Promise<string>)) => {
    if (!settingsRef.current) await refreshStatus();
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;
    setError(null);
    setEchoWarning(null);
    endedRef.current = false;
    dispatch({ type: "reset" });
    setHelmSessionId(typeof target === "string" ? target : null);
    setPhase("connecting");
    const startEchoSafe = playbackPreferences.current.echoSafe;
    const audio = new VoiceAudio({
      echoSafe: startEchoSafe,
      onFrame: (pcm, level) => {
        micLevelRef.current = level;
        transportRef.current?.sendAudio(pcm);
      },
      onPlaybackStarted: (genId, chunkId) => transportRef.current?.sendControl({ type: "playback", event: "started", genId, chunkId }),
      onPlaybackIdle: (genId) => transportRef.current?.sendControl({ type: "playback", event: "idle", genId }),
    });
    audioRef.current = audio;
    try {
      let result: VoiceAudioStartResult;
      try {
        result = await audio.start();
      } catch (err) {
        // Browsers report a missing or blocked microphone in their own words
        // ("The object can not be found here."); say what it means instead.
        throw new Error(describeVoiceCaptureError(err));
      }
      if (startEchoSafe && !result.echoSafe) {
        setEchoWarning(`Echo-safe playback isn't available (${result.echoSafeError ?? "unsupported"}). Headphones will work best.`);
      }
      audio.earcon("start");
      const targetHelmSessionId = typeof target === "string" ? target : await target();
      setHelmSessionId(targetHelmSessionId);
      const ticket = await createVoiceConversation(targetHelmSessionId, currentSettings);
      ticketRef.current = ticket;
      const transport = await connect(ticket);
      // The server greets only a conversation with no history; otherwise it just starts listening.
      transport.sendControl({ type: "start", greet: true });
      setPhase("active");
      void acquireWakeLock();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      setHelmSessionId(null);
      await teardown();
    }
  }, [acquireWakeLock, connect, echoSafe, refreshStatus, teardown]);

  const stop = useCallback(async () => {
    endedRef.current = true;
    transportRef.current?.sendControl({ type: "control", action: "end" });
    audioRef.current?.earcon("end");
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    await teardown();
    ticketRef.current = null;
    setHelmSessionId(null);
    setPhase("ended");
  }, [teardown]);

  const control = useCallback((action: "sleep" | "wake" | "stop_speaking") => {
    transportRef.current?.sendControl({ type: "control", action });
  }, []);

  const savePreferences = useCallback(async (patch: Partial<UnifiedHelmSettings>, live = false) => {
    try {
      const data = await patchHelmSettings(patch);
      const next = applyPreferences(data);
      if (live) transportRef.current?.sendControl({ type: "config", settings: next });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyPreferences]);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    void savePreferences(patch, true);
  }, [savePreferences]);

  const setTransportPreference = useCallback((value: VoiceTransportPreference) => {
    void savePreferences({ transport: value });
  }, [savePreferences]);

  const setEchoSafe = useCallback((value: boolean) => {
    void savePreferences({ echoSafe: value });
  }, [savePreferences]);

  const clearError = useCallback(() => setError(null), []);

  const toggleMic = useCallback(() => {
    setMicMuted((current) => {
      audioRef.current?.setMicMuted(!current);
      return !current;
    });
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && transportRef.current && !wakeLockRef.current) void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [acquireWakeLock]);

  useEffect(() => () => {
    endedRef.current = true;
    transportRef.current?.sendControl({ type: "control", action: "end" });
    void teardown();
  }, [teardown]);

  const active = phase === "connecting" || phase === "active" || phase === "reconnecting";

  return {
    status,
    phase,
    /** True from the moment hands-free starts connecting until it ends. */
    active,
    /** The Helm conversation hands-free is speaking for. */
    helmSessionId,
    error: error ?? preferences.error,
    settings,
    view,
    echoSafe,
    echoWarning,
    micMuted,
    transportPreference,
    micLevelRef,
    getOutputLevel: () => audioRef.current?.outputLevel() ?? 0,
    refreshStatus,
    clearError,
    install,
    start,
    stop,
    control,
    updateSettings,
    setTransportPreference,
    setEchoSafe,
    toggleMic,
  };
}

export type VoiceModeController = ReturnType<typeof useVoiceMode>;
