import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../api";
import { encodeWav, SpeechResampler } from "../lib/voice-recording-audio";
import { holdVoiceCapture } from "../lib/voice-capture-guard";
import type { VoiceRecorderPhase } from "../lib/voice-ui-state";

const PROCESSOR_BUFFER_SIZE = 4_096;

interface UseVoiceInputOptions {
  contextKey: string;
  onAudioCaptured: (capture: { audio: Blob; contextKey: string }) => Promise<void>;
  /** The recording reached the server's length limit and took no more audio. Defaults to stopping it. */
  onMaxDurationReached?: () => void;
}

interface VoiceInputState {
  browserSupported: boolean;
  status: TranscriptionStatus | null;
  statusError: string | null;
  isCheckingStatus: boolean;
  phase: VoiceRecorderPhase;
  isRecording: boolean;
  isTranscribing: boolean;
  /** Whole seconds of audio captured by the recording in progress. */
  elapsedSeconds: number;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  refreshStatus: () => Promise<TranscriptionStatus | null>;
}

type WindowWithWebkitAudioContext = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

export function useVoiceInput({ contextKey, onAudioCaptured, onMaxDurationReached }: UseVoiceInputOptions): VoiceInputState {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [phase, setPhase] = useState<VoiceRecorderPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
  const releaseCaptureRef = useRef<(() => void) | null>(null);
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});
  const maxDurationReachedRef = useRef<() => void>(() => {});

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

  /** Lets go of the capture hold; only once the audio is stored or deliberately dropped. */
  const releaseCapture = useCallback(() => {
    releaseCaptureRef.current?.();
    releaseCaptureRef.current = null;
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the view ends a recording in progress; what it captured is submitted, not dropped.
      if (phaseRef.current === "recording") void stopRecordingRef.current();
      else void cleanupRecorder();
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
    setElapsedSeconds(0);
    try {
      const { maxDurationSeconds } = await ensureAvailable();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        throw new Error("Voice input is not supported in this browser.");
      }
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;
      await audioContext.resume();
      // The view can go away while the microphone is still being opened; nothing may be left running.
      if (!mountedRef.current) throw new Error("Voice input closed before recording started.");
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);

      sourceRef.current = source;
      processorRef.current = processor;
      const resampler = new SpeechResampler(audioContext.sampleRate);
      sampleRateRef.current = resampler.outputRate;
      chunksRef.current = [];
      activeContextKeyRef.current = contextKeyRef.current;

      // The server rejects audio past its limit, so capture ends exactly there instead of
      // letting a finished recording fail on upload.
      const maxSamples = maxDurationSeconds * resampler.outputRate;
      let capturedSamples = 0;
      processor.onaudioprocess = (event) => {
        const room = maxSamples - capturedSamples;
        if (room <= 0) return;
        const chunk = resampler.push(event.inputBuffer.getChannelData(0));
        chunksRef.current.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        capturedSamples += Math.min(chunk.length, room);
        if (mountedRef.current) setElapsedSeconds(Math.floor(capturedSamples / resampler.outputRate));
        if (capturedSamples >= maxSamples) maxDurationReachedRef.current();
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      releaseCaptureRef.current = holdVoiceCapture();
      setRecorderPhase("recording");
    } catch (err) {
      await cleanupRecorder();
      releaseCapture();
      setRecorderPhase("idle");
      if (mountedRef.current) {
        setError(describeVoiceCaptureError(err));
      }
    }
  }, [browserSupported, cleanupRecorder, ensureAvailable, releaseCapture, setRecorderPhase]);

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
      releaseCapture();
      setRecorderPhase("idle");
    }
  }, [cleanupRecorder, onAudioCaptured, releaseCapture, setRecorderPhase]);

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
    maxDurationReachedRef.current = onMaxDurationReached ?? (() => void stopRecording());
  }, [onMaxDurationReached, stopRecording]);

  return {
    browserSupported,
    status,
    statusError,
    isCheckingStatus,
    phase,
    isRecording: phase === "recording",
    isTranscribing: phase === "finishing",
    elapsedSeconds,
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
