import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  createVoiceConversation,
  fetchVoiceStatus,
  loadStoredVoiceSettings,
  loadTransportPreference,
  startVoiceInstall,
  storeTransportPreference,
  storeVoiceSettings,
  type VoiceConversationTicket,
  type VoiceSettings,
  type VoiceStatus,
  type VoiceTransportPreference,
} from "./voice-api";
import { VoiceAudio } from "./voice-audio";
import { connectVoiceTransport, type VoiceTransport, type VoiceTransportHandlers } from "./voice-transport";
import { initialVoiceViewState, reduceVoiceEvent, type VoiceViewState } from "./voice-view-model";

export type VoiceSessionPhase = "loading" | "setup" | "ready" | "connecting" | "active" | "reconnecting" | "ended" | "error";

type ViewAction = { type: "event"; event: Record<string, any> } | { type: "reset" };

function viewReducer(state: VoiceViewState, action: ViewAction): VoiceViewState {
  if (action.type === "reset") return initialVoiceViewState;
  return reduceVoiceEvent(state, action.event);
}

const RECONNECT_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000, 15_000];
const ECHO_SAFE_STORAGE_KEY = "bridge.voice.echoSafe";

function loadEchoSafe(): boolean {
  try {
    return window.localStorage.getItem(ECHO_SAFE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function useVoiceMode() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<VoiceSessionPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [transportPreference, setTransportPreferenceState] = useState<VoiceTransportPreference>(() => loadTransportPreference());
  const [echoSafe, setEchoSafeState] = useState<boolean>(() => loadEchoSafe());
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

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchVoiceStatus();
      setStatus(next);
      setSettings((current) => current ?? loadStoredVoiceSettings(next.defaults));
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
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

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
    transport = await connectVoiceTransport(ticket, scoped, transportPreference);
    transportRef.current = transport;
    reconnectAttemptRef.current = 0;
    return transport;
  }, [transportPreference]);

  const scheduleReconnect = useCallback(() => {
    if (endedRef.current || !ticketRef.current) return;
    const attempt = reconnectAttemptRef.current++;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setPhase("error");
      setError("Lost the connection to Bridge.");
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

  const start = useCallback(async () => {
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;
    setError(null);
    setEchoWarning(null);
    endedRef.current = false;
    dispatch({ type: "reset" });
    setPhase("connecting");
    const audio = new VoiceAudio({
      echoSafe,
      onFrame: (pcm, level) => {
        micLevelRef.current = level;
        transportRef.current?.sendAudio(pcm);
      },
      onPlaybackStarted: (genId, chunkId) => transportRef.current?.sendControl({ type: "playback", event: "started", genId, chunkId }),
      onPlaybackIdle: (genId) => transportRef.current?.sendControl({ type: "playback", event: "idle", genId }),
    });
    audioRef.current = audio;
    try {
      const result = await audio.start();
      if (echoSafe && !result.echoSafe) {
        setEchoWarning(`Echo-safe playback isn't available (${result.echoSafeError ?? "unsupported"}). Headphones will work best.`);
      }
      audio.earcon("start");
      const ticket = await createVoiceConversation(currentSettings);
      ticketRef.current = ticket;
      const transport = await connect(ticket);
      transport.sendControl({ type: "start", greet: true });
      setPhase("active");
      void acquireWakeLock();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      await teardown();
    }
  }, [acquireWakeLock, connect, echoSafe, teardown]);

  const stop = useCallback(async () => {
    endedRef.current = true;
    transportRef.current?.sendControl({ type: "control", action: "end" });
    audioRef.current?.earcon("end");
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    await teardown();
    ticketRef.current = null;
    setPhase("ended");
  }, [teardown]);

  const control = useCallback((action: "sleep" | "wake" | "stop_speaking") => {
    transportRef.current?.sendControl({ type: "control", action });
  }, []);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed) transportRef.current?.sendControl({ type: "text", text: trimmed });
  }, []);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      storeVoiceSettings(next);
      transportRef.current?.sendControl({ type: "config", settings: next });
      return next;
    });
  }, []);

  const setTransportPreference = useCallback((value: VoiceTransportPreference) => {
    storeTransportPreference(value);
    setTransportPreferenceState(value);
  }, []);

  const setEchoSafe = useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(ECHO_SAFE_STORAGE_KEY, String(value));
    } catch {
      // Ignore storage failures.
    }
    setEchoSafeState(value);
  }, []);

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

  return {
    status,
    phase,
    error,
    settings,
    view,
    echoSafe,
    echoWarning,
    micMuted,
    transportPreference,
    micLevelRef,
    getOutputLevel: () => audioRef.current?.outputLevel() ?? 0,
    refreshStatus,
    install,
    start,
    stop,
    control,
    sendText,
    updateSettings,
    setTransportPreference,
    setEchoSafe,
    toggleMic,
  };
}

export type VoiceModeController = ReturnType<typeof useVoiceMode>;
