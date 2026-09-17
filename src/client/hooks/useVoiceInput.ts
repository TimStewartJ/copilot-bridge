import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../api";
import { encodeWav, SpeechResampler } from "../lib/voice-recording-audio";
import type { VoiceRecorderPhase } from "../lib/voice-ui-state";

const PROCESSOR_BUFFER_SIZE = 4_096;

interface UseVoiceInputOptions {
  contextKey: string;
  onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
}

interface VoiceInputState {
  browserSupported: boolean;
  status: TranscriptionStatus | null;
  statusError: string | null;
  isCheckingStatus: boolean;
  phase: VoiceRecorderPhase;
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  refreshStatus: () => Promise<TranscriptionStatus | null>;
}

type WindowWithWebkitAudioContext = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

export function useVoiceInput({ contextKey, onAudioCaptured }: UseVoiceInputOptions): VoiceInputState {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [phase, setPhase] = useState<VoiceRecorderPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const contextKeyRef = useRef(contextKey);
  const activeContextKeyRef = useRef<string | null>(null);
  const statusRef = useRef<TranscriptionStatus | null>(status);
  const statusErrorRef = useRef<string | null>(statusError);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const phaseRef = useRef<VoiceRecorderPhase>("idle");
  const sampleRateRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);

  const setRecorderPhase = useCallback((nextPhase: VoiceRecorderPhase) => {
    phaseRef.current = nextPhase;
    if (mountedRef.current) {
      setPhase(nextPhase);
    }
  }, []);

  useEffect(() => {
    contextKeyRef.current = contextKey;
  }, [contextKey]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    statusErrorRef.current = statusError;
  }, [statusError]);

  const browserSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return !!getAudioContextCtor() && !!navigator.mediaDevices?.getUserMedia;
  }, []);

  const cleanupRecorder = useCallback(async () => {
    const processor = processorRef.current;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processorRef.current = null;
    }

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext) {
      await audioContext.close().catch(() => {});
    }

    chunksRef.current = [];
    sampleRateRef.current = 0;
    activeContextKeyRef.current = null;
  }, []);

  const refreshStatus = useCallback(async (): Promise<TranscriptionStatus | null> => {
    if (!browserSupported) return null;

    setIsCheckingStatus(true);
    try {
      const nextStatus = await fetchTranscriptionStatus();
      if (!mountedRef.current) return nextStatus;
      setStatus(nextStatus);
      setStatusError(null);
      return nextStatus;
    } catch (err) {
      if (!mountedRef.current) return null;
      setStatusError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current) setIsCheckingStatus(false);
    }
  }, [browserSupported]);

  useEffect(() => {
    if (!browserSupported) return;
    void refreshStatus();
  }, [browserSupported, refreshStatus]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      void cleanupRecorder();
    };
  }, [cleanupRecorder]);

  const ensureAvailable = useCallback(async (): Promise<TranscriptionStatus> => {
    const knownStatus = statusRef.current;
    if (knownStatus?.available) return knownStatus;

    const refreshedStatus = await refreshStatus();
    const nextStatus = refreshedStatus ?? statusRef.current;
    if (!nextStatus?.available) {
      throw new Error(nextStatus?.reason ?? statusErrorRef.current ?? "Voice input is unavailable.");
    }
    return nextStatus;
  }, [refreshStatus]);

  const startRecording = useCallback(async () => {
    if (!browserSupported || phaseRef.current !== "idle") return;

    setRecorderPhase("starting");
    setError(null);
    try {
      await ensureAvailable();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        throw new Error("Voice input is not supported in this browser.");
      }
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);

      sourceRef.current = source;
      processorRef.current = processor;
      const resampler = new SpeechResampler(audioContext.sampleRate);
      sampleRateRef.current = resampler.outputRate;
      chunksRef.current = [];
      activeContextKeyRef.current = contextKeyRef.current;

      processor.onaudioprocess = (event) => {
        chunksRef.current.push(resampler.push(event.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setRecorderPhase("recording");
    } catch (err) {
      await cleanupRecorder();
      setRecorderPhase("idle");
      if (mountedRef.current) {
        setError(describeVoiceCaptureError(err));
      }
    }
  }, [browserSupported, cleanupRecorder, ensureAvailable, setRecorderPhase]);

  const stopRecording = useCallback(async () => {
    if (phaseRef.current !== "recording") return;

    setRecorderPhase("finishing");
    const startedContextKey = activeContextKeyRef.current ?? contextKeyRef.current;
    setError(null);

    try {
      const wavBlob = encodeWav(chunksRef.current, sampleRateRef.current);
      await cleanupRecorder();
      await onAudioCaptured({ audio: wavBlob, contextKey: startedContextKey });
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      await cleanupRecorder();
      setRecorderPhase("idle");
    }
  }, [cleanupRecorder, onAudioCaptured, setRecorderPhase]);

  return {
    browserSupported,
    status,
    statusError,
    isCheckingStatus,
    phase,
    isRecording: phase === "recording",
    isTranscribing: phase === "finishing",
    error,
    startRecording,
    stopRecording,
    refreshStatus,
  };
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as WindowWithWebkitAudioContext;
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
}

export function describeVoiceCaptureError(error: unknown): string {
  const errorLike = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  const name = typeof errorLike.name === "string" ? errorLike.name : "";
  const message = typeof errorLike.message === "string" ? errorLike.message : (error instanceof Error ? error.message : String(error));
  const normalizedMessage = message.toLowerCase();

  if (
    name === "NotFoundError"
    || name === "DevicesNotFoundError"
    || normalizedMessage.includes("object can not be found here")
  ) {
    return "No microphone was found. Check your browser and OS audio input settings, then try again.";
  }

  if (
    name === "NotAllowedError"
    || name === "PermissionDeniedError"
    || name === "SecurityError"
  ) {
    return "Microphone access was denied. Allow microphone access in your browser settings and try again.";
  }

  if (
    name === "NotReadableError"
    || name === "TrackStartError"
    || normalizedMessage.includes("concurrent mic process limit")
    || normalizedMessage.includes("failed to allocate videosource")
  ) {
    return "The microphone is unavailable right now. Close other apps or tabs that might be using it, then try again.";
  }

  return message;
}
