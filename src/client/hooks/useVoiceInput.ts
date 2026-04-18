import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscriptionStatus, type TranscriptionStatus } from "../api";

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
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  refreshStatus: () => Promise<TranscriptionStatus | null>;
}

type WindowWithWebkitAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function useVoiceInput({ contextKey, onAudioCaptured }: UseVoiceInputOptions): VoiceInputState {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
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
  const recordingRef = useRef(false);
  const transcribingRef = useRef(false);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const sampleRateRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);

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
    if (!browserSupported || recordingRef.current || transcribingRef.current || startingRef.current || stoppingRef.current) return;

    startingRef.current = true;
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
      sampleRateRef.current = audioContext.sampleRate;
      chunksRef.current = [];
      activeContextKeyRef.current = contextKeyRef.current;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const chunk = new Float32Array(input.length);
        chunk.set(input);
        chunksRef.current.push(chunk);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      recordingRef.current = true;
      setIsRecording(true);
    } catch (err) {
      recordingRef.current = false;
      await cleanupRecorder();
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      startingRef.current = false;
    }
  }, [browserSupported, cleanupRecorder, ensureAvailable]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current || transcribingRef.current || startingRef.current || stoppingRef.current) return;

    stoppingRef.current = true;
    const startedContextKey = activeContextKeyRef.current ?? contextKeyRef.current;
    recordingRef.current = false;
    transcribingRef.current = true;
    setIsRecording(false);
    setIsTranscribing(true);
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
      transcribingRef.current = false;
      if (mountedRef.current) {
        setIsTranscribing(false);
      }
      stoppingRef.current = false;
    }
  }, [cleanupRecorder, onAudioCaptured]);

  return {
    browserSupported,
    status,
    statusError,
    isCheckingStatus,
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
    refreshStatus,
  };
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  if (!sampleRate || chunks.length === 0) {
    throw new Error("No audio captured.");
  }

  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (sampleCount === 0) {
    throw new Error("No audio captured.");
  }

  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as WindowWithWebkitAudioContext;
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
}
