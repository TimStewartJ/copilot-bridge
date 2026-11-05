// The local speech engine shared by voice mode and chat mic transcription: one install,
// one engine process, one set of models.
import type { RuntimePaths } from "../runtime-paths.js";
import type { ChatMicSettings, SpeechModelId } from "../../shared/chat-mic.js";
import { resolveSpeechModel, resolveVoicePaths, type SpeechModel, type VoicePaths } from "./voice-catalog.js";
import { VoiceEngine } from "./voice-engine.js";
import { VoiceInstaller } from "./voice-installer.js";

export interface VoiceRuntime {
  readonly paths: VoicePaths;
  readonly installer: VoiceInstaller;
  readonly engine: VoiceEngine;
}

export function createVoiceRuntime(runtimePaths: Pick<RuntimePaths, "dataDir" | "env">): VoiceRuntime {
  const paths = resolveVoicePaths(runtimePaths);
  return {
    paths,
    installer: new VoiceInstaller({ paths, env: runtimePaths.env }),
    engine: new VoiceEngine({ paths, env: runtimePaths.env }),
  };
}

/** The chosen recognizer when its files are here, otherwise whichever recognizer is. */
export function resolveUsableSpeechModel(runtime: Pick<VoiceRuntime, "installer">, settings: ChatMicSettings | undefined): SpeechModel {
  const chosen = resolveSpeechModel(settings?.speechModel);
  const onDisk = runtime.installer.getStatus().speechModels.filter((asset) => asset.installed);
  if (onDisk.length === 0 || onDisk.some((asset) => asset.id === chosen.id)) return chosen;
  return resolveSpeechModel(onDisk[0]!.id as SpeechModelId);
}

export function applySelectedSpeechModel(runtime: VoiceRuntime, settings: ChatMicSettings | undefined): void {
  runtime.engine.useSpeechModel(resolveUsableSpeechModel(runtime, settings));
}

/**
 * Keeps the engine on the chosen recognizer, and gets that recognizer onto a machine set up without
 * it, such as one installed when another model was the default. Whatever is on disk keeps working
 * until the new model is verified. A failed download is logged by the installer and tried again at
 * the next start.
 */
export function followSelectedSpeechModel(
  runtime: VoiceRuntime,
  getSettings: () => ChatMicSettings | undefined,
  { fetchMissing = true }: { fetchMissing?: boolean } = {},
): void {
  // The settings API reports a settings row it cannot read. Starting the server has to survive one.
  const read = (): { settings: ChatMicSettings | undefined } | undefined => {
    try {
      return { settings: getSettings() };
    } catch {
      return undefined;
    }
  };
  const apply = () => applySelectedSpeechModel(runtime, read()?.settings);
  apply();
  runtime.installer.onStatus((status) => {
    if (!status.installing) apply();
  });
  const current = read();
  if (!fetchMissing || !current) return;
  const status = runtime.installer.getStatus();
  const chosen = resolveSpeechModel(current.settings?.speechModel);
  if (!status.installed || status.speechModels.some((asset) => asset.id === chosen.id && asset.installed)) return;
  void runtime.installer.install([chosen.id]).catch(() => undefined);
}
