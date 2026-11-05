import { describe, expect, it, vi } from "vitest";
import type { ChatMicSettings } from "../../../shared/chat-mic.js";
import { resolveSpeechModel, type SpeechModel } from "../voice-catalog.js";
import { followSelectedSpeechModel, resolveUsableSpeechModel, type VoiceRuntime } from "../voice-runtime.js";

const ENGLISH = "parakeet-unified-en";
const V3 = "parakeet-v3";

function fakeRuntime(onDisk: string[], { ready = onDisk.length > 0, installResult = Promise.resolve() } = {}) {
  const models = { onDisk };
  const listeners = new Set<(status: unknown) => void>();
  const status = (installing = false) => ({
    installed: ready,
    installing,
    speechModels: [ENGLISH, V3].map((id) => ({ id, installed: models.onDisk.includes(id) })),
  });
  const install = vi.fn(() => installResult);
  const useSpeechModel = vi.fn<(model: SpeechModel) => void>();
  const runtime = {
    installer: {
      getStatus: () => status(),
      onStatus: (listener: (status: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      install,
    },
    engine: { useSpeechModel },
  } as unknown as VoiceRuntime;
  return {
    runtime,
    install,
    finishInstall: (...added: string[]) => {
      models.onDisk = [...models.onDisk, ...added];
      for (const listener of listeners) listener(status());
    },
    modelInUse: () => useSpeechModel.mock.calls.at(-1)?.[0].id,
  };
}

describe("resolveUsableSpeechModel", () => {
  it.each<[string, string[], ChatMicSettings | undefined, string]>([
    ["English by default", [ENGLISH], undefined, ENGLISH],
    ["the old default until English arrives", [V3], undefined, V3],
    ["an explicit choice of v3", [ENGLISH, V3], { speechModel: V3 }, V3],
    ["English when the chosen v3 files are gone", [ENGLISH], { speechModel: V3 }, ENGLISH],
    ["the default before anything is installed", [], undefined, ENGLISH],
  ])("uses %s", (_name, onDisk, settings, expected) => {
    expect(resolveUsableSpeechModel(fakeRuntime(onDisk).runtime, settings).id).toBe(expected);
  });
});

describe("followSelectedSpeechModel", () => {
  it("fetches English onto a setup that only has v3, stays on v3 meanwhile, and switches when it is verified", () => {
    const { runtime, install, finishInstall, modelInUse } = fakeRuntime([V3]);

    followSelectedSpeechModel(runtime, () => undefined);

    expect(install).toHaveBeenCalledExactlyOnceWith([ENGLISH]);
    expect(modelInUse()).toBe(V3);

    finishInstall(ENGLISH);
    expect(modelInUse()).toBe(ENGLISH);
  });

  it("leaves v3 in use and does not fetch English when v3 was chosen", () => {
    const { runtime, install, modelInUse } = fakeRuntime([V3]);

    followSelectedSpeechModel(runtime, () => ({ speechModel: V3 }));

    expect(install).not.toHaveBeenCalled();
    expect(modelInUse()).toBe(V3);
  });

  it("downloads nothing on a machine whose speech engine was never set up", () => {
    const { runtime, install } = fakeRuntime([]);

    followSelectedSpeechModel(runtime, () => undefined);

    expect(install).not.toHaveBeenCalled();
  });

  it("downloads nothing when the chosen model is already here", () => {
    const { runtime, install, modelInUse } = fakeRuntime([ENGLISH, V3]);

    followSelectedSpeechModel(runtime, () => undefined);

    expect(install).not.toHaveBeenCalled();
    expect(modelInUse()).toBe(resolveSpeechModel().id);
  });

  it("starts without a download when the settings cannot be read, on what is on disk", () => {
    const { runtime, install, modelInUse } = fakeRuntime([V3]);

    followSelectedSpeechModel(runtime, () => { throw new Error("settings row unreadable"); });

    expect(install).not.toHaveBeenCalled();
    expect(modelInUse()).toBe(V3);
  });

  it("leaves the voice folder alone when told not to fetch", () => {
    const { runtime, install, modelInUse } = fakeRuntime([V3]);

    followSelectedSpeechModel(runtime, () => undefined, { fetchMissing: false });

    expect(install).not.toHaveBeenCalled();
    expect(modelInUse()).toBe(V3);
  });

  it("keeps working on v3 when the download fails", async () => {
    const { runtime, finishInstall, modelInUse } = fakeRuntime([V3], { installResult: Promise.reject(new Error("offline")) });

    followSelectedSpeechModel(runtime, () => undefined);
    await Promise.resolve();
    finishInstall();

    expect(modelInUse()).toBe(V3);
  });
});
