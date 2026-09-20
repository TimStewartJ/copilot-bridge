import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceJob, transcribeAudio } from "./api";

class FakeXhr {
  static last: FakeXhr;
  upload: {
    onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  method = "";
  url = "";
  body: FormData | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: FormData) {
    this.body = body;
  }

  abort() {
    this.onabort?.();
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe("recording upload client API", () => {
  const audio = new Blob(["voice"], { type: "audio/wav" });

  beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the recording with its job details and reports upload progress", async () => {
    const onUploadProgress = vi.fn();
    const pending = createVoiceJob({ composerKey: "session-1", sessionId: "session-1" }, audio, { onUploadProgress });
    const xhr = FakeXhr.last;

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("/api/voice-jobs");
    expect(xhr.body?.get("composerKey")).toBe("session-1");
    expect(xhr.body?.get("sessionId")).toBe("session-1");
    expect((xhr.body?.get("audio") as File).name).toBe("voice-input.wav");

    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 20 });
    xhr.upload.onload?.();
    expect(onUploadProgress.mock.calls).toEqual([[0.25], [1]]);

    xhr.respond(202, { id: "voice-job-1", status: "accepted" });
    await expect(pending).resolves.toEqual({ id: "voice-job-1", status: "accepted" });
  });

  it("surfaces the server's reason when a recording is refused", async () => {
    const pending = transcribeAudio(audio);
    expect(FakeXhr.last.url).toContain("/api/transcribe");
    FakeXhr.last.respond(400, { error: "Audio exceeds 300 seconds." });
    await expect(pending).rejects.toThrow("Audio exceeds 300 seconds.");
  });

  it("fails when the server cannot be reached or the upload is cancelled", async () => {
    const unreachable = transcribeAudio(audio);
    FakeXhr.last.onerror?.();
    await expect(unreachable).rejects.toThrow("The upload could not reach the server.");

    const controller = new AbortController();
    const cancelled = createVoiceJob({ composerKey: "session-1" }, audio, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow("The upload was cancelled.");

    const alreadyCancelled = createVoiceJob({ composerKey: "session-1" }, audio, { signal: controller.signal });
    await expect(alreadyCancelled).rejects.toThrow("The upload was cancelled.");
  });
});
