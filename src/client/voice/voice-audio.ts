// Browser audio for voice mode: 16 kHz microphone capture and echo-cancellable playback.

const CAPTURE_WORKLET_SOURCE = `
class BridgeVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.t = 1;
    this.prev = 0;
    this.frame = new Int16Array(512);
    this.index = 0;
    this.energy = 0;
    this.muted = false;
    this.stages = [];
    if (this.ratio > 1.05) {
      const fc = Math.min(7000, sampleRate * 0.45);
      const w0 = 2 * Math.PI * fc / sampleRate;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      const coefficients = {
        b0: ((1 - cos) / 2) / a0, b1: (1 - cos) / a0, b2: ((1 - cos) / 2) / a0,
        a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
      };
      this.stages = [0, 1].map(() => ({ ...coefficients, x1: 0, x2: 0, y1: 0, y2: 0 }));
    }
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "mute") this.muted = !!event.data.muted;
    };
  }

  emit(value) {
    const sample = this.muted ? 0 : Math.max(-1, Math.min(1, value));
    this.frame[this.index++] = sample * 32767;
    this.energy += sample * sample;
    if (this.index === 512) {
      const level = Math.sqrt(this.energy / 512);
      this.port.postMessage({ pcm: this.frame.buffer, level }, [this.frame.buffer]);
      this.frame = new Int16Array(512);
      this.index = 0;
      this.energy = 0;
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      let y = input[i];
      for (const s of this.stages) {
        const out = s.b0 * y + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
        s.x2 = s.x1; s.x1 = y; s.y2 = s.y1; s.y1 = out;
        y = out;
      }
      while (this.t <= 1) {
        this.emit(this.prev + (y - this.prev) * this.t);
        this.t += this.ratio;
      }
      this.t -= 1;
      this.prev = y;
    }
    return true;
  }
}
registerProcessor("bridge-voice-capture", BridgeVoiceCapture);
`;

type EarconKind = "start" | "commit" | "wake" | "sleep" | "error" | "end";

export interface VoiceAudioOptions {
  echoSafe: boolean;
  onFrame(pcm: Int16Array, level: number): void;
  onPlaybackStarted(genId: number, chunkId: number): void;
  onPlaybackIdle(genId: number): void;
}

export interface VoiceAudioStartResult {
  inputSampleRate: number;
  echoSafe: boolean;
  echoSafeError?: string;
}

interface ScheduledSource {
  genId: number;
  node: AudioBufferSourceNode;
  timer: number;
}

export class VoiceAudio {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private outGain?: GainNode;
  private analyser?: AnalyserNode;
  private player?: HTMLAudioElement;
  private peers?: [RTCPeerConnection, RTCPeerConnection];
  private workletUrl?: string;
  private nextStartTime = 0;
  private stoppedGen = 0;
  private readonly sources = new Set<ScheduledSource>();
  private readonly startedChunks = new Set<string>();
  private readonly levelData = new Float32Array(1024);
  private ducked = false;

  constructor(private readonly options: VoiceAudioOptions) {}

  /** Must run from a user gesture so the browser allows audio playback and capture. */
  async start(): Promise<VoiceAudioStartResult> {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser can't capture audio. Voice mode needs HTTPS (or localhost) and a modern browser.");
    }
    const ctx = new AudioContextCtor({ latencyHint: "interactive" });
    this.ctx = ctx;
    await ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(this.workletUrl);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(ctx, "bridge-voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.capture);
    this.capture.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.options.onFrame(new Int16Array(event.data.pcm), event.data.level);
    };

    this.outGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.outGain.connect(this.analyser);
    let echoSafe = false;
    let echoSafeError: string | undefined;
    if (this.options.echoSafe && typeof RTCPeerConnection !== "undefined") {
      try {
        await this.createLoopback(ctx);
        echoSafe = true;
      } catch (error) {
        echoSafeError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!echoSafe) this.outGain.connect(ctx.destination);
    return { inputSampleRate: ctx.sampleRate, echoSafe, ...(echoSafeError ? { echoSafeError } : {}) };
  }

  // Browser echo cancellation only uses <audio>/WebRTC playback as its reference, so speech is
  // routed through a local peer connection into an <audio> element instead of straight out.
  private async createLoopback(ctx: AudioContext): Promise<void> {
    const destination = ctx.createMediaStreamDestination();
    this.outGain!.connect(destination);
    const sender = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    this.peers = [sender, receiver];
    sender.onicecandidate = (event) => {
      if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => undefined);
    };
    receiver.onicecandidate = (event) => {
      if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => undefined);
    };
    const remote = new Promise<MediaStream>((resolve) => {
      receiver.ontrack = (event) => resolve(event.streams[0] ?? new MediaStream([event.track]));
    });
    for (const track of destination.stream.getAudioTracks()) sender.addTrack(track, destination.stream);
    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    const tuned = answer.sdp?.replace(/(a=fmtp:\d+ [^\r\n]*useinbandfec=1)/, "$1;maxaveragebitrate=128000;stereo=0");
    await receiver.setLocalDescription(tuned ? { type: "answer", sdp: tuned } : answer).catch(() => receiver.setLocalDescription(answer));
    await sender.setRemoteDescription(receiver.localDescription!);
    const stream = await Promise.race([
      remote,
      new Promise<never>((_resolve, reject) => window.setTimeout(() => reject(new Error("audio loopback timed out")), 5_000)),
    ]);
    const player = new Audio();
    player.autoplay = true;
    player.srcObject = stream;
    await player.play();
    this.player = player;
  }

  setMicMuted(muted: boolean): void {
    this.capture?.port.postMessage({ type: "mute", muted });
  }

  playChunk(genId: number, chunkId: number, sampleRate: number, pcm: Int16Array): void {
    const ctx = this.ctx;
    if (!ctx || !this.outGain || genId <= this.stoppedGen || pcm.length === 0) return;
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.outGain);
    const startAt = Math.max(ctx.currentTime + 0.05, this.nextStartTime);
    node.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    const key = `${genId}:${chunkId}`;
    const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
    const timer = window.setTimeout(() => {
      if (genId <= this.stoppedGen || this.startedChunks.has(key)) return;
      this.startedChunks.add(key);
      this.options.onPlaybackStarted(genId, chunkId);
    }, delayMs);
    const scheduled: ScheduledSource = { genId, node, timer };
    this.sources.add(scheduled);
    node.onended = () => {
      this.sources.delete(scheduled);
      if (genId > this.stoppedGen && ![...this.sources].some((entry) => entry.genId === genId)) {
        this.options.onPlaybackIdle(genId);
      }
    };
  }

  stopGeneration(genId: number): void {
    this.stoppedGen = Math.max(this.stoppedGen, genId);
    const ctx = this.ctx;
    const gain = this.outGain;
    if (!ctx || !gain) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0, now, 0.015);
    window.setTimeout(() => {
      for (const entry of [...this.sources]) {
        if (entry.genId > genId) continue;
        window.clearTimeout(entry.timer);
        try {
          entry.node.stop();
        } catch {
          // Already stopped.
        }
        this.sources.delete(entry);
      }
      this.nextStartTime = 0;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(this.ducked ? 0.35 : 1, ctx.currentTime);
    }, 90);
  }

  duck(on: boolean): void {
    this.ducked = on;
    if (!this.ctx || !this.outGain) return;
    this.outGain.gain.setTargetAtTime(on ? 0.35 : 1, this.ctx.currentTime, 0.06);
  }

  outputLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) sum += value * value;
    return Math.sqrt(sum / this.levelData.length);
  }

  earcon(kind: EarconKind): void {
    const ctx = this.ctx;
    if (!ctx || !this.outGain) return;
    const notes: Record<EarconKind, number[]> = {
      start: [523.25, 783.99],
      wake: [659.25, 987.77],
      commit: [1046.5],
      sleep: [587.33, 392],
      error: [311.13, 233.08],
      end: [783.99, 523.25],
    };
    const start = ctx.currentTime + 0.01;
    notes[kind].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const at = start + index * 0.09;
      const duration = kind === "commit" ? 0.07 : 0.2;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(kind === "commit" ? 0.035 : 0.09, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain);
      gain.connect(this.outGain!);
      oscillator.start(at);
      oscillator.stop(at + duration + 0.02);
    });
  }

  async close(): Promise<void> {
    for (const entry of this.sources) window.clearTimeout(entry.timer);
    this.sources.clear();
    this.capture?.port.close();
    this.source?.disconnect();
    this.capture?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.peers?.forEach((peer) => peer.close());
    if (this.player) {
      this.player.pause();
      this.player.srcObject = null;
    }
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }
}
