import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_SETTINGS } from "../voice-catalog.js";
import {
  looksLikeEcho,
  VOICE_SAMPLE_RATE,
  VoiceConversation,
  type AgentTurnInput,
  type AgentTurnListener,
  type SpeechSynthesisRequest,
  type VoiceAudioChunk,
  type VoiceEngineApi,
  type VoiceServerEvent,
  type VoiceTimers,
} from "../voice-conversation.js";

class FakeEngine implements VoiceEngineApi {
  pushed = 0;
  probabilities: number[] = [];
  transcripts: string[] = [];
  transcribeCalls: Array<[number, number]> = [];
  synthCalls: SpeechSynthesisRequest[] = [];
  cancelledSynth = 0;

  pushAudio(_streamId: string, pcm: Int16Array): void {
    this.pushed += pcm.length;
  }

  async predictTurn(): Promise<{ probability: number; ms: number }> {
    return { probability: this.probabilities.shift() ?? 0.9, ms: 10 };
  }

  async transcribe(_streamId: string, from: number, to: number): Promise<{ text: string; ms: number }> {
    this.transcribeCalls.push([from, to]);
    return { text: this.transcripts.shift() ?? "", ms: 50 };
  }

  synthesize(request: SpeechSynthesisRequest, onChunk: (pcm: Int16Array, sampleRate: number) => void) {
    this.synthCalls.push(request);
    let cancelled = false;
    const done = Promise.resolve().then(() => {
      if (!cancelled) onChunk(new Int16Array(2_400), 24_000);
      return { firstChunkMs: 5, totalMs: 5 };
    });
    return {
      done,
      cancel: () => {
        cancelled = true;
        this.cancelledSynth++;
      },
    };
  }
}

interface FakeTurn {
  input: AgentTurnInput;
  listener: AgentTurnListener;
  aborted: boolean;
}

class FakeAgent {
  turns: FakeTurn[] = [];

  startTurn(input: AgentTurnInput, listener: AgentTurnListener) {
    const turn: FakeTurn = { input, listener, aborted: false };
    this.turns.push(turn);
    return {
      abort: async () => {
        turn.aborted = true;
        listener.onDone({ aborted: true });
      },
    };
  }

  get last(): FakeTurn {
    return this.turns.at(-1)!;
  }
}

class Sink {
  events: VoiceServerEvent[] = [];
  audio: VoiceAudioChunk[] = [];
  send(event: VoiceServerEvent) {
    this.events.push(event);
  }
  sendAudio(chunk: VoiceAudioChunk) {
    this.audio.push(chunk);
  }
  states(): string[] {
    return this.events.filter((event) => event.type === "state").map((event) => (event as { state: string }).state);
  }
  has(type: VoiceServerEvent["type"]): boolean {
    return this.events.some((event) => event.type === type);
  }
}

const timers: VoiceTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function setup(settings = DEFAULT_VOICE_SETTINGS) {
  const engine = new FakeEngine();
  const agent = new FakeAgent();
  const sink = new Sink();
  const conversation = new VoiceConversation({ streamId: "s1", engine, agent, sink, settings, timers });
  conversation.start({ greet: false });
  let sample = 0;
  const audio = (ms: number) => {
    const samples = Math.round((ms / 1000) * VOICE_SAMPLE_RATE);
    conversation.pushAudio(new Int16Array(samples));
    sample += samples;
    return sample;
  };
  return { engine, agent, sink, conversation, audio, sample: () => sample };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function speakTurn(ctx: ReturnType<typeof setup>, text: string, probability = 0.9) {
  ctx.engine.transcripts.push(text);
  ctx.engine.probabilities.push(probability);
  ctx.conversation.onVad(true, ctx.audio(200));
  ctx.audio(1_000);
  ctx.conversation.onVad(false, ctx.audio(200));
  await advance(10);
}

describe("VoiceConversation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects the end of a turn, asks the agent and speaks the reply", async () => {
    const ctx = setup();
    await speakTurn(ctx, "What's unread?");
    expect(ctx.conversation.state).toBe("thinking");
    expect(ctx.agent.last.input).toEqual({ kind: "user", text: "What's unread?" });
    expect(ctx.sink.events).toContainEqual({ type: "earcon", kind: "commit" });

    ctx.agent.last.listener.onDelta("Two sessions finished. ");
    await advance(10);
    expect(ctx.engine.synthCalls[0]).toMatchObject({ text: "Two sessions finished.", lang: "en-us", sid: 3 });
    expect(ctx.sink.audio).toHaveLength(1);
    expect(ctx.conversation.state).toBe("speaking");

    ctx.agent.last.listener.onDone({ aborted: false });
    await advance(10);
    ctx.conversation.onPlaybackIdle(ctx.sink.audio[0]!.genId);
    expect(ctx.conversation.state).toBe("listening");
    expect(ctx.sink.has("metrics")).toBe(true);
  });

  it("waits through a hesitation until the fallback timer", async () => {
    const ctx = setup();
    ctx.engine.probabilities.push(0.05, 0.05, 0.05, 0.05);
    ctx.engine.transcripts.push("So I was thinking, um");
    ctx.conversation.onVad(true, ctx.audio(200));
    ctx.conversation.onVad(false, ctx.audio(900));
    await advance(1_000);
    expect(ctx.conversation.state).toBe("endpointing");
    expect(ctx.agent.turns).toHaveLength(0);

    // User keeps talking before the fallback fires: the turn continues.
    ctx.engine.transcripts.push("So I was thinking, um, what should I name my assistant?");
    ctx.engine.probabilities.push(0.92);
    ctx.conversation.onVad(true, ctx.audio(100));
    expect(ctx.conversation.state).toBe("hearing");
    ctx.conversation.onVad(false, ctx.audio(1_200));
    await advance(10);
    expect(ctx.agent.turns).toHaveLength(1);
    expect(ctx.agent.last.input.text).toBe("So I was thinking, um, what should I name my assistant?");
    const [firstStart] = ctx.engine.transcribeCalls[0]!;
    const [secondStart] = ctx.engine.transcribeCalls[1]!;
    expect(secondStart).toBe(firstStart);
  });

  it("commits after the fallback when the end-of-turn model is unsure", async () => {
    const ctx = setup();
    ctx.engine.probabilities.push(0.1, 0.2, 0.3, 0.3);
    await speakTurn(ctx, "Will you be my friend?", 0.1);
    await advance(1_300);
    expect(ctx.agent.last.input.text).toBe("Will you be my friend?");
  });

  it("waits longer when every check says the user is clearly mid-thought", async () => {
    const ctx = setup();
    ctx.engine.probabilities.push(0.01, 0.01, 0.01, 0.01, 0.02);
    await speakTurn(ctx, "So I was thinking, um", 0.01);
    await advance(1_300);
    expect(ctx.agent.turns).toHaveLength(0);
    expect(ctx.conversation.state).toBe("endpointing");
    await advance(1_500);
    expect(ctx.agent.last.input.text).toBe("So I was thinking, um");
  });

  it("speaks a short lead-in while tools run and measures the real reply separately", async () => {
    const ctx = setup();
    await speakTurn(ctx, "What's going on?");
    ctx.agent.last.listener.onToolStart({ toolCallId: "t1", name: "bridge_overview" });
    await advance(10);
    expect(ctx.engine.synthCalls[0]!.text).toBe("One sec.");
    expect(ctx.conversation.state).toBe("speaking");
    ctx.agent.last.listener.onDelta("Nothing is waiting on you. ");
    ctx.agent.last.listener.onDone({ aborted: false });
    await advance(10);
    expect(ctx.engine.synthCalls[1]!.text).toBe("Nothing is waiting on you.");
    const metrics = ctx.sink.events.find((event) => event.type === "metrics") as { metrics: Record<string, number> } | undefined;
    expect(metrics?.metrics.fillerMs).toBeTypeOf("number");
    expect(metrics?.metrics.speechEndToFirstAudioMs).toBeTypeOf("number");
  });

  it("removes a held answer from the transcript when the user's continuation replaces it", async () => {
    const ctx = setup();
    await speakTurn(ctx, "So I was thinking um", 0.9);
    ctx.conversation.onVad(true, ctx.audio(100));
    ctx.agent.last.listener.onDelta("Mm-hmm, I'm listening. ");
    await advance(10);
    ctx.engine.transcripts.push("which task should I look at first?");
    ctx.conversation.onVad(false, ctx.audio(900));
    await advance(10);
    expect(ctx.sink.events).toContainEqual({ type: "assistant_discarded", genId: 1 });
    expect(ctx.agent.last.input.kind).toBe("continuation");
  });

  it("holds an answer while the user keeps talking and merges the continuation", async () => {
    const ctx = setup();
    await speakTurn(ctx, "Tell me a joke.");
    const first = ctx.agent.last;
    ctx.conversation.onVad(true, ctx.audio(100));
    expect(ctx.conversation.state).toBe("hearing");

    first.listener.onDelta("Why did the computer go to the doctor? ");
    await advance(10);
    expect(ctx.sink.audio).toHaveLength(0);

    ctx.engine.transcripts.push("about computers");
    ctx.conversation.onVad(false, ctx.audio(800));
    await advance(10);
    expect(first.aborted).toBe(true);
    expect(ctx.agent.last.input).toEqual({ kind: "continuation", text: "about computers" });
  });

  it("releases a held answer when the extra sound was filler", async () => {
    const ctx = setup();
    await speakTurn(ctx, "That's so funny.");
    const first = ctx.agent.last;
    first.listener.onDelta("Glad you liked it! ");
    ctx.conversation.onVad(true, ctx.audio(100));
    await advance(10);
    expect(ctx.sink.audio).toHaveLength(0);

    ctx.engine.transcripts.push("Huh?");
    ctx.conversation.onVad(false, ctx.audio(400));
    await advance(10);
    expect(first.aborted).toBe(false);
    expect(ctx.agent.turns).toHaveLength(1);
    expect(ctx.sink.audio).toHaveLength(1);
    expect(ctx.conversation.state).toBe("speaking");
  });

  it("ignores reactions while speaking", async () => {
    const ctx = setup();
    await speakTurn(ctx, "Explain turn detection.");
    ctx.agent.last.listener.onDelta("I listen for pauses and intonation to decide when you're done. ");
    await advance(10);
    expect(ctx.conversation.state).toBe("speaking");

    ctx.engine.transcripts.push("Yeah.");
    ctx.conversation.onVad(true, ctx.audio(100));
    await advance(300);
    expect(ctx.sink.events).toContainEqual({ type: "duck", on: true });
    ctx.conversation.onVad(false, ctx.audio(300));
    await advance(10);
    expect(ctx.sink.has("stop_audio")).toBe(false);
    expect(ctx.sink.events.at(-1)).toEqual({ type: "duck", on: false });
    expect(ctx.conversation.state).toBe("speaking");
  });

  it("stops for a real interruption and tells the agent what was cut off", async () => {
    const ctx = setup();
    await speakTurn(ctx, "What's running?");
    const first = ctx.agent.last;
    first.listener.onDelta("The Tellus worldgen session is still running. ");
    await advance(10);
    ctx.conversation.onPlaybackStarted(ctx.sink.audio[0]!.genId, 1);

    ctx.engine.transcripts.push("Wait, tell me about the deploy check instead");
    ctx.conversation.onVad(true, ctx.audio(100));
    ctx.audio(700);
    await advance(700);
    expect(ctx.sink.has("stop_audio")).toBe(true);
    expect(first.aborted).toBe(true);
    expect(ctx.conversation.state).toBe("hearing");

    ctx.engine.transcripts.push("Wait, tell me about the deploy check instead.");
    ctx.conversation.onVad(false, ctx.audio(500));
    await advance(10);
    expect(ctx.agent.last.input).toEqual({
      kind: "interrupted",
      text: "Wait, tell me about the deploy check instead.",
      interruptedSpeech: "The Tellus worldgen session is still running.",
    });
  });

  it("sleeps locally and only wakes on the wake phrase", async () => {
    const ctx = setup();
    await speakTurn(ctx, "Okay, go to sleep.");
    expect(ctx.conversation.state).toBe("asleep");
    expect(ctx.agent.turns).toHaveLength(0);
    expect(ctx.engine.synthCalls[0]!.text).toBe("Okay, going quiet.");
    await advance(10);
    ctx.conversation.onPlaybackIdle(ctx.sink.audio[0]!.genId);

    ctx.engine.transcripts.push("I was talking to someone else");
    ctx.conversation.onVad(true, ctx.audio(100));
    ctx.conversation.onVad(false, ctx.audio(900));
    await advance(10);
    expect(ctx.conversation.state).toBe("asleep");

    ctx.engine.transcripts.push("Hey Bridge, what's unread?");
    ctx.conversation.onVad(true, ctx.audio(100));
    ctx.conversation.onVad(false, ctx.audio(900));
    await advance(10);
    expect(ctx.agent.last.input).toEqual({ kind: "user", text: "what's unread?" });
  });

  it("does not fall asleep later after an interrupted goodbye", async () => {
    const ctx = setup();
    await speakTurn(ctx, "Go to sleep.");
    expect(ctx.conversation.state).toBe("asleep");
    ctx.engine.transcripts.push("Hey Bridge");
    ctx.conversation.onVad(true, ctx.audio(100));
    ctx.conversation.onVad(false, ctx.audio(600));
    await advance(10);
    expect(ctx.conversation.state).toBe("listening");

    await speakTurn(ctx, "Change the voice to George.");
    ctx.agent.last.listener.onDelta("Done, George it is. ");
    ctx.agent.last.listener.onDone({ aborted: false });
    await advance(10);
    ctx.conversation.onPlaybackIdle(ctx.sink.audio.at(-1)!.genId);
    expect(ctx.conversation.state).toBe("listening");
  });

  it("strips a leading wake phrase while awake and handles typed text", async () => {
    const ctx = setup();
    await speakTurn(ctx, "Hey Bridge, list my tasks.");
    expect(ctx.agent.last.input.text).toBe("list my tasks.");
    ctx.conversation.submitText("mark everything read");
    expect(ctx.agent.last.input.text).toBe("mark everything read");
    expect(ctx.agent.turns[0]!.aborted).toBe(true);
  });

  it("uses the British espeak voice for British Kokoro voices", async () => {
    const ctx = setup({ ...DEFAULT_VOICE_SETTINGS, voice: "bm_george" });
    await speakTurn(ctx, "Hello there.");
    ctx.agent.last.listener.onDelta("Good evening to you. ");
    await advance(10);
    expect(ctx.engine.synthCalls[0]).toMatchObject({ sid: 26, lang: "en" });
  });

  it("announces queued Bridge updates when idle", async () => {
    const ctx = setup();
    ctx.conversation.enqueueEvent("Session Tellus finished.");
    expect(ctx.agent.last.input).toEqual({ kind: "event", text: "Session Tellus finished." });
  });
});

describe("looksLikeEcho", () => {
  it("flags transcripts that repeat the assistant's own speech", () => {
    expect(looksLikeEcho("the tellus session is still running", "The Tellus worldgen session is still running.")).toBe(true);
    expect(looksLikeEcho("tell me about the deploy", "The Tellus worldgen session is still running.")).toBe(false);
  });
});
